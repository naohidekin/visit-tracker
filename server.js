require('dotenv').config();
const express    = require('express');
const { google } = require('googleapis');
const fs         = require('fs');
const path       = require('path');
const bcrypt     = require('bcryptjs');
const csession   = require('cookie-session');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json());
app.use(csession({
  name:    'visit_sess',
  keys:    [process.env.SESSION_SECRET || 'dev-secret-please-change'],
  maxAge:  7 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
}));
app.use(express.static(path.join(__dirname, 'public')));

// ─── 定数 ──────────────────────────────────────────────────────
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const STAFF_PATH     = path.join(__dirname, 'staff.json');
const MONTHS         = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
const HEADER_ROW     = 4;
const DATA_START_ROW = 5;

// ─── ユーティリティ ─────────────────────────────────────────────
function loadStaff() {
  return JSON.parse(fs.readFileSync(STAFF_PATH, 'utf8'));
}
function saveStaff(data) {
  fs.writeFileSync(STAFF_PATH, JSON.stringify(data, null, 2));
}

function colToIdx(col) {
  let n = 0;
  for (const c of col.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}
function idxToCol(idx) {
  let result = '', n = idx + 1;
  while (n > 0) {
    result = String.fromCharCode(64 + ((n - 1) % 26 + 1)) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

// ─── Google Sheets ──────────────────────────────────────────────
function getAuth() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}
async function getSheets() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

// ─── 起動時：未ハッシュPWをハッシュ化 ──────────────────────────
async function ensurePasswordsHashed() {
  const data = loadStaff();
  let changed = false;
  for (const s of data.staff) {
    if (!s.password_hash && s.initial_pw) {
      s.password_hash = await bcrypt.hash(s.initial_pw, 10);
      changed = true;
    }
  }
  if (changed) { saveStaff(data); console.log('✅ パスワードをハッシュ化しました'); }
}

// ─── 認証ミドルウェア ───────────────────────────────────────────
function requireStaff(req, res, next) {
  if (!req.session.staffId) return res.status(401).json({ error: 'ログインが必要です' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(401).json({ error: '管理者権限が必要です' });
  next();
}

// ─── HTMLルーティング ───────────────────────────────────────────
app.get('/login',           (_r, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/change-password', (req, res) => {
  if (!req.session.staffId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'change-password.html'));
});
app.get('/admin',           (_r, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/', (req, res) => {
  if (!req.session.staffId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── API: スタッフ認証 ──────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { loginId, password } = req.body;
  if (!loginId || !password)
    return res.status(400).json({ error: 'IDとパスワードを入力してください' });

  const data  = loadStaff();
  const staff = data.staff.find(s => s.id === loginId);
  if (!staff)
    return res.status(401).json({ error: 'IDまたはパスワードが正しくありません' });

  const ok = await bcrypt.compare(password, staff.password_hash);
  if (!ok)
    return res.status(401).json({ error: 'IDまたはパスワードが正しくありません' });

  req.session.staffId   = staff.id;
  req.session.staffName = staff.name;
  req.session.staffType = staff.type;
  res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session.staffId) return res.status(401).json({ error: '未ログイン' });
  res.json({ id: req.session.staffId, name: req.session.staffName, type: req.session.staffType });
});

// ─── API: パスワード変更 ────────────────────────────────────────
app.post('/api/change-password', requireStaff, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: 'パラメータが不足しています' });
  if (newPassword.length < 4)
    return res.status(400).json({ error: 'パスワードは4文字以上にしてください' });
  if (newPassword !== confirmPassword)
    return res.status(400).json({ error: '新しいパスワードが一致しません' });

  const data  = loadStaff();
  const staff = data.staff.find(s => s.id === req.session.staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  const ok = await bcrypt.compare(currentPassword, staff.password_hash);
  if (!ok) return res.status(401).json({ error: '現在のパスワードが正しくありません' });

  staff.password_hash = await bcrypt.hash(newPassword, 10);
  saveStaff(data);
  res.json({ success: true });
});

// ─── API: 記録の取得（上書きチェック用） ────────────────────────
app.get('/api/record', requireStaff, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'パラメータが不足しています' });

  const d     = new Date(date);
  const month = d.getMonth() + 1;
  const row   = DATA_START_ROW + d.getDate() - 1;

  const data  = loadStaff();
  const staff = data.staff.find(s => s.id === req.session.staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  try {
    const api = await getSheets();
    if (staff.type === 'nurse') {
      const resp = await api.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${month}月!${staff.kaigo_col}${row}:${staff.iryo_col}${row}`,
      });
      const vals = resp.data.values?.[0] ?? [];
      res.json({ kaigo: vals[0] ?? null, iryo: vals[1] ?? null });
    } else {
      const resp = await api.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${month}月!${staff.col}${row}`,
      });
      res.json({ value: resp.data.values?.[0]?.[0] ?? null });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: 記録の送信 ─────────────────────────────────────────────
app.post('/api/record', requireStaff, async (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'パラメータが不足しています' });

  // 未来日付チェック
  const d = new Date(date);
  const today = new Date(); today.setHours(23, 59, 59, 999);
  if (d > today) return res.status(400).json({ error: '未来の日付には記録できません' });

  const month = d.getMonth() + 1;
  const row   = DATA_START_ROW + d.getDate() - 1;

  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === req.session.staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  try {
    const api = await getSheets();
    if (staff.type === 'nurse') {
      const { kaigo, iryo } = req.body;
      const kVal = (kaigo !== '' && kaigo !== null && kaigo !== undefined) ? Number(kaigo) : '';
      const iVal = (iryo  !== '' && iryo  !== null && iryo  !== undefined) ? Number(iryo)  : '';
      await api.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${month}月!${staff.kaigo_col}${row}`, values: [[kVal]] },
            { range: `${month}月!${staff.iryo_col}${row}`,  values: [[iVal]] },
          ],
        },
      });
      res.json({ success: true, kaigo: kVal, iryo: iVal });
    } else {
      const { value } = req.body;
      const val = (value !== '' && value !== null && value !== undefined) ? Number(value) : '';
      await api.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${month}月!${staff.col}${row}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[val]] },
      });
      res.json({ success: true, value: val });
    }
  } catch (e) {
    const detail = e.response?.data?.error?.message || e.message;
    console.error('❌ record POST error:', JSON.stringify(e.response?.data ?? e.message));
    res.status(500).json({ error: detail });
  }
});

// ─── API: 月別実績 ──────────────────────────────────────────────
app.get('/api/monthly-stats', requireStaff, async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'パラメータが不足しています' });

  const daysInMonth = new Date(Number(year), Number(month), 0).getDate();
  const endRow      = DATA_START_ROW + daysInMonth - 1;

  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === req.session.staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  try {
    const api = await getSheets();
    if (staff.type === 'nurse') {
      const resp = await api.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${month}月!${staff.kaigo_col}${DATA_START_ROW}:${staff.iryo_col}${endRow}`,
      });
      const rows = resp.data.values ?? [];
      let total_kaigo = 0, total_iryo = 0, working_days = 0;
      for (const r of rows) {
        const k = parseFloat(r?.[0]) || 0;
        const i = parseFloat(r?.[1]) || 0;
        total_kaigo += k;
        total_iryo  += i;
        if (k > 0 || i > 0) working_days++;
      }
      res.json({ total_kaigo, total_iryo, total: total_kaigo + total_iryo, working_days });
    } else {
      const resp = await api.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${month}月!${staff.col}${DATA_START_ROW}:${staff.col}${endRow}`,
      });
      const rows = resp.data.values ?? [];
      let total_units = 0, working_days = 0;
      for (const r of rows) {
        const v = parseFloat(r?.[0]) || 0;
        total_units += v;
        if (v > 0) working_days++;
      }
      res.json({ total_units, working_days });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: 診断 ──────────────────────────────────────────────────
app.get('/api/debug/sheets', requireAdmin, async (_req, res) => {
  try {
    const api = await getSheets();
    const meta = await api.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const mimeType = meta.data.spreadsheetId ? 'google-sheets' : 'unknown';
    const sheets = meta.data.sheets.map(s => ({
      title: s.properties.title,
      sheetId: s.properties.sheetId,
      merges: s.merges?.length ?? 0,
    }));
    // 1月シートの3月1日行をテスト読み取り
    let readTest = null;
    try {
      const r = await api.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: '1月!A5:M5',
      });
      readTest = r.data.values;
    } catch (re) {
      readTest = re.response?.data?.error?.message || re.message;
    }
    res.json({ mimeType, sheets, readTest });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// ─── API: 管理者認証 ────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'パスワードが正しくありません' });
  }
});
app.post('/api/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.json({ success: true });
});

// ─── API: スタッフ管理 ──────────────────────────────────────────
app.get('/api/admin/staff', requireAdmin, (_req, res) => {
  res.json(loadStaff().staff);
});

app.post('/api/admin/staff', requireAdmin, async (req, res) => {
  const { name, furigana_family, furigana_given, type, loginId, initialPw } = req.body;
  if (!name || !type || !loginId || !initialPw)
    return res.status(400).json({ error: 'パラメータが不足しています' });

  const data = loadStaff();
  if (data.staff.find(s => s.id === loginId))
    return res.status(400).json({ error: 'そのログインIDは既に使用されています' });

  const nextSeq = Math.max(0, ...data.staff.map(s => s.seq || 0)) + 1;

  try {
    const api = await getSheets();
    const spreadsheet = await api.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheetMap = {};
    for (const s of spreadsheet.data.sheets)
      sheetMap[s.properties.title] = s.properties.sheetId;
    const validMonths = MONTHS.filter(m => sheetMap[m] !== undefined);

    let newEntry;
    if (type === 'nurse') {
      const nurses       = data.staff.filter(s => s.type === 'nurse');
      const lastNurseIdx = nurses.length > 0
        ? Math.max(...nurses.map(s => colToIdx(s.iryo_col))) : colToIdx('B');
      const kaigoIdx = lastNurseIdx + 1;
      const kaigoCol = idxToCol(kaigoIdx);
      const iryoCol  = idxToCol(kaigoIdx + 1);

      await api.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: validMonths.map(m => ({
            insertDimension: {
              range: { sheetId: sheetMap[m], dimension: 'COLUMNS',
                       startIndex: kaigoIdx, endIndex: kaigoIdx + 2 },
              inheritFromBefore: false,
            },
          })),
        },
      });
      await api.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: validMonths.map(m => ({
            range: `${m}!${kaigoCol}${HEADER_ROW}:${iryoCol}${HEADER_ROW}`,
            values: [[`${name}(介護)`, `${name}(医療)`]],
          })),
        },
      });
      for (const s of data.staff)
        if (s.type === 'rehab') s.col = idxToCol(colToIdx(s.col) + 2);

      newEntry = { id: loginId, name,
        furigana_family: furigana_family || '', furigana_given: furigana_given || '',
        type: 'nurse', kaigo_col: kaigoCol, iryo_col: iryoCol,
        seq: nextSeq, initial_pw: initialPw,
        password_hash: await bcrypt.hash(initialPw, 10) };

    } else {
      const rehabs      = data.staff.filter(s => s.type === 'rehab');
      const nurses      = data.staff.filter(s => s.type === 'nurse');
      const baseIdx     = rehabs.length > 0
        ? Math.max(...rehabs.map(s => colToIdx(s.col)))
        : (nurses.length > 0 ? Math.max(...nurses.map(s => colToIdx(s.iryo_col))) : colToIdx('J'));
      const newColIdx = baseIdx + 1;
      const newCol    = idxToCol(newColIdx);

      await api.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: validMonths.map(m => ({
            insertDimension: {
              range: { sheetId: sheetMap[m], dimension: 'COLUMNS',
                       startIndex: newColIdx, endIndex: newColIdx + 1 },
              inheritFromBefore: false,
            },
          })),
        },
      });
      await api.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: validMonths.map(m => ({
            range: `${m}!${newCol}${HEADER_ROW}`,
            values: [[name]],
          })),
        },
      });
      newEntry = { id: loginId, name,
        furigana_family: furigana_family || '', furigana_given: furigana_given || '',
        type: 'rehab', col: newCol,
        seq: nextSeq, initial_pw: initialPw,
        password_hash: await bcrypt.hash(initialPw, 10) };
    }

    data.staff.push(newEntry);
    saveStaff(data);
    res.json({ success: true, staff: data.staff });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/staff/:id', requireAdmin, (req, res) => {
  const data = loadStaff();
  const idx  = data.staff.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'スタッフが見つかりません' });
  const [removed] = data.staff.splice(idx, 1);
  saveStaff(data);
  res.json({ success: true, removed, staff: data.staff });
});

app.post('/api/admin/staff/:id/reset-password', requireAdmin, async (req, res) => {
  const data  = loadStaff();
  const staff = data.staff.find(s => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });
  staff.password_hash = await bcrypt.hash(staff.initial_pw, 10);
  saveStaff(data);
  res.json({ success: true, initial_pw: staff.initial_pw });
});

// ─── 起動 ──────────────────────────────────────────────────────
async function main() {
  await ensurePasswordsHashed();
  app.listen(PORT, () => console.log(`✅ Server → http://localhost:${PORT}`));
}
main().catch(e => { console.error(e); process.exit(1); });
