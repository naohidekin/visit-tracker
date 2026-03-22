require('dotenv').config();
const express    = require('express');
const { google } = require('googleapis');
const fs         = require('fs');
const path       = require('path');
const bcrypt     = require('bcryptjs');
const csession   = require('cookie-session');
const cron       = require('node-cron');

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
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ─── 定数 ──────────────────────────────────────────────────────
const SPREADSHEET_ID  = process.env.SPREADSHEET_ID;
const DATA_DIR        = process.env.DATA_DIR || __dirname;
const STAFF_PATH      = path.join(DATA_DIR, 'staff.json');
const REGISTRY_PATH   = path.join(DATA_DIR, 'spreadsheet-registry.json');
const SCHEDULES_PATH  = path.join(DATA_DIR, 'schedules.json');
const MONTHS          = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
const HEADER_ROW      = 4;
const DATA_START_ROW  = 5;
const WD              = ['日','月','火','水','木','金','土'];

// ─── スプレッドシートレジストリ（年 → ID） ─────────────────────
function loadRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    const year = String(new Date().getFullYear());
    const reg  = { [year]: SPREADSHEET_ID };
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
    return reg;
  }
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}
function saveRegistry(reg) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}
function getSpreadsheetIdForYear(year) {
  const reg = loadRegistry();
  return reg[String(year)] || SPREADSHEET_ID;
}

// ─── 新年スプレッドシート作成 ───────────────────────────────────
function buildSheetHeaderRow(staffList) {
  if (staffList.length === 0) return ['日付', '曜日'];
  const maxIdx = Math.max(
    ...staffList.map(s => s.type === 'nurse' ? colToIdx(s.iryo_col) : colToIdx(s.col))
  );
  const row = new Array(maxIdx + 1).fill('');
  row[0] = '日付'; row[1] = '曜日';
  for (const s of staffList) {
    if (s.type === 'nurse') {
      row[colToIdx(s.kaigo_col)] = `${s.name}(介護)`;
      row[colToIdx(s.iryo_col)]  = `${s.name}(医療)`;
    } else {
      row[colToIdx(s.col)] = s.name;
    }
  }
  return row;
}

async function createSpreadsheetForYear(year) {
  const registry = loadRegistry();
  if (registry[String(year)]) {
    throw new Error(`already_exists:${registry[String(year)]}`);
  }

  const api       = await getSheets();
  const staffData = loadStaff();
  const headerRow = buildSheetHeaderRow(staffData.staff);

  const created = await api.spreadsheets.create({
    requestBody: {
      properties: { title: `訪問件数カウント ${year}` },
      sheets: MONTHS.map((title, i) => ({ properties: { title, sheetId: i, index: i } })),
    },
  });
  const newId = created.data.spreadsheetId;

  const batchData = [];
  for (let mi = 0; mi < MONTHS.length; mi++) {
    const m           = mi + 1;
    const daysInMonth = new Date(year, m, 0).getDate();
    const values      = [
      [`${year}年 ${MONTHS[mi]} 訪問件数`], [], [],
      headerRow,
    ];
    for (let d = 1; d <= daysInMonth; d++) {
      values.push([d, WD[new Date(year, m - 1, d).getDay()],
        ...new Array(Math.max(0, headerRow.length - 2)).fill('')]);
    }
    batchData.push({ range: `${MONTHS[mi]}!A1`, values });
  }
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: newId,
    requestBody: { valueInputOption: 'USER_ENTERED', data: batchData },
  });

  registry[String(year)] = newId;
  saveRegistry(registry);
  console.log(`✅ ${year}年スプレッドシートを作成しました: ${newId}`);
  return newId;
}

// ─── ユーティリティ ─────────────────────────────────────────────
function loadStaff() {
  return JSON.parse(fs.readFileSync(STAFF_PATH, 'utf8'));
}
function saveStaff(data) {
  fs.writeFileSync(STAFF_PATH, JSON.stringify(data, null, 2));
}

function loadSchedules() {
  if (!fs.existsSync(SCHEDULES_PATH)) return { schedules: [] };
  return JSON.parse(fs.readFileSync(SCHEDULES_PATH, 'utf8'));
}
function saveSchedules(data) {
  fs.writeFileSync(SCHEDULES_PATH, JSON.stringify(data, null, 2));
}
function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
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

// ─── 起動時：未ハッシュPWをハッシュ化 & 旧 'rehab' 職種を 'PT' に移行 ──
async function ensurePasswordsHashed() {
  const data = loadStaff();
  let changed = false;
  for (const s of data.staff) {
    if (!s.password_hash && s.initial_pw) {
      s.password_hash = await bcrypt.hash(s.initial_pw, 10);
      changed = true;
    }
    // 旧データの 'rehab' を 'PT' に移行（PT/OT/ST 細分化対応）
    if (s.type === 'rehab') {
      s.type = 'PT';
      changed = true;
    }
  }
  if (changed) { saveStaff(data); console.log('✅ スタッフデータを更新しました'); }
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
app.get('/history', (req, res) => {
  if (!req.session.staffId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'history.html'));
});
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
  if (newPassword.length < 4 || newPassword.length > 20)
    return res.status(400).json({ error: 'パスワードは4〜20文字で設定してください' });
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
  const year  = d.getFullYear();
  const month = d.getMonth() + 1;
  const row   = DATA_START_ROW + d.getDate() - 1;
  const sid   = getSpreadsheetIdForYear(year);

  const data  = loadStaff();
  const staff = data.staff.find(s => s.id === req.session.staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  try {
    const api = await getSheets();
    if (staff.type === 'nurse') {
      const resp = await api.spreadsheets.values.get({
        spreadsheetId: sid,
        range: `${month}月!${staff.kaigo_col}${row}:${staff.iryo_col}${row}`,
      });
      const vals = resp.data.values?.[0] ?? [];
      res.json({ kaigo: vals[0] ?? null, iryo: vals[1] ?? null });
    } else {
      const resp = await api.spreadsheets.values.get({
        spreadsheetId: sid,
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

  const year  = d.getFullYear();
  const month = d.getMonth() + 1;
  const row   = DATA_START_ROW + d.getDate() - 1;
  const sid   = getSpreadsheetIdForYear(year);

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
        spreadsheetId: sid,
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
        spreadsheetId: sid,
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

// ─── API: 予定管理 ──────────────────────────────────────────────
app.get('/api/schedules', requireStaff, (req, res) => {
  const data = loadSchedules();
  res.json(data.schedules.filter(s => s.staffId === req.session.staffId));
});

app.post('/api/schedules', requireStaff, (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'パラメータが不足しています' });
  const today = new Date(); today.setHours(23, 59, 59, 999);
  const schedDate = new Date(date + 'T00:00:00');
  if (schedDate <= today) return res.status(400).json({ error: '予定登録は翌日以降の日付のみ可能です' });

  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === req.session.staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  const data = loadSchedules();
  // 同一スタッフ・同一日付の予定は上書き
  data.schedules = data.schedules.filter(s => !(s.staffId === req.session.staffId && s.date === date));

  const id = `${req.session.staffId}-${date}-${Date.now()}`;
  const entry = {
    id,
    staffId: req.session.staffId,
    staffName: req.session.staffName,
    jobType: staff.type,
    date,
    kaigo: null, iryo: null, units: null,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  if (staff.type === 'nurse') {
    const { kaigo, iryo } = req.body;
    entry.kaigo = (kaigo !== '' && kaigo !== null && kaigo !== undefined) ? Number(kaigo) : null;
    entry.iryo  = (iryo  !== '' && iryo  !== null && iryo  !== undefined) ? Number(iryo)  : null;
  } else {
    const { value } = req.body;
    entry.units = (value !== '' && value !== null && value !== undefined) ? Number(value) : null;
  }

  data.schedules.push(entry);
  saveSchedules(data);
  res.json({ success: true, schedule: entry });
});

app.post('/api/schedules/:id/confirm', requireStaff, async (req, res) => {
  const data = loadSchedules();
  const idx = data.schedules.findIndex(s => s.id === req.params.id && s.staffId === req.session.staffId);
  if (idx === -1) return res.status(404).json({ error: '予定が見つかりません' });
  const schedule = data.schedules[idx];

  const today = new Date(); today.setHours(23, 59, 59, 999);
  const schedDate = new Date(schedule.date + 'T00:00:00');
  if (schedDate > today) return res.status(400).json({ error: 'まだ確定できません（翌日以降の予定です）' });

  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === schedule.staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  const d     = new Date(schedule.date + 'T00:00:00');
  const year  = d.getFullYear();
  const month = d.getMonth() + 1;
  const row   = DATA_START_ROW + d.getDate() - 1;
  const sid   = getSpreadsheetIdForYear(year);

  try {
    const api = await getSheets();
    if (staff.type === 'nurse') {
      const kVal = schedule.kaigo != null ? schedule.kaigo : '';
      const iVal = schedule.iryo  != null ? schedule.iryo  : '';
      await api.spreadsheets.values.batchUpdate({
        spreadsheetId: sid,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${month}月!${staff.kaigo_col}${row}`, values: [[kVal]] },
            { range: `${month}月!${staff.iryo_col}${row}`,  values: [[iVal]] },
          ],
        },
      });
    } else {
      const val = schedule.units != null ? schedule.units : '';
      await api.spreadsheets.values.update({
        spreadsheetId: sid,
        range: `${month}月!${staff.col}${row}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[val]] },
      });
    }
    data.schedules.splice(idx, 1);
    saveSchedules(data);
    res.json({ success: true });
  } catch (e) {
    const detail = e.response?.data?.error?.message || e.message;
    res.status(500).json({ error: detail });
  }
});

app.delete('/api/schedules/:id', requireStaff, (req, res) => {
  const data = loadSchedules();
  const idx = data.schedules.findIndex(s => s.id === req.params.id && s.staffId === req.session.staffId);
  if (idx === -1) return res.status(404).json({ error: '予定が見つかりません' });
  data.schedules.splice(idx, 1);
  saveSchedules(data);
  res.json({ success: true });
});

app.get('/api/admin/schedules', requireAdmin, (_req, res) => {
  res.json(loadSchedules().schedules);
});

app.delete('/api/admin/schedules/:id', requireAdmin, (req, res) => {
  const data = loadSchedules();
  const idx = data.schedules.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '予定が見つかりません' });
  data.schedules.splice(idx, 1);
  saveSchedules(data);
  res.json({ success: true });
});

// ─── API: 月別実績 ──────────────────────────────────────────────
app.get('/api/monthly-stats', requireStaff, async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'パラメータが不足しています' });

  const daysInMonth = new Date(Number(year), Number(month), 0).getDate();
  const endRow      = DATA_START_ROW + daysInMonth - 1;
  const sid         = getSpreadsheetIdForYear(Number(year));

  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === req.session.staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  try {
    const api = await getSheets();
    if (staff.type === 'nurse') {
      const resp = await api.spreadsheets.values.get({
        spreadsheetId: sid,
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
      const iDef = staffData.incentive_defaults || { nurse: 3.5, rehab: 20.0 };
      const iline = (staff.incentive_line != null) ? staff.incentive_line : iDef.nurse;
      const avg = working_days > 0 ? (total_kaigo + total_iryo) / working_days : 0;
      res.json({ total_kaigo, total_iryo, total: total_kaigo + total_iryo, working_days,
                 incentive_line: iline, incentive_triggered: avg > iline });
    } else {
      const resp = await api.spreadsheets.values.get({
        spreadsheetId: sid,
        range: `${month}月!${staff.col}${DATA_START_ROW}:${staff.col}${endRow}`,
      });
      const rows = resp.data.values ?? [];
      let total_units = 0, working_days = 0;
      for (const r of rows) {
        const v = parseFloat(r?.[0]) || 0;
        total_units += v;
        if (v > 0) working_days++;
      }
      const iDef2 = staffData.incentive_defaults || { nurse: 3.5, rehab: 20.0 };
      const iline2 = (staff.incentive_line != null) ? staff.incentive_line : iDef2.rehab;
      const avg2 = working_days > 0 ? total_units / working_days : 0;
      res.json({ total_units, working_days,
                 incentive_line: iline2, incentive_triggered: avg2 > iline2 });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: 診断 ──────────────────────────────────────────────────
app.get('/api/debug/sheets', requireAdmin, async (_req, res) => {
  const debugSid = getSpreadsheetIdForYear(new Date().getFullYear());
  try {
    const api = await getSheets();
    const meta = await api.spreadsheets.get({ spreadsheetId: debugSid });
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
        spreadsheetId: debugSid,
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

// ─── API: 月別日別明細 ──────────────────────────────────────────
app.get('/api/monthly-detail', requireStaff, async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'パラメータ不足' });

  const y   = Number(year), m = Number(month);
  const sid = getSpreadsheetIdForYear(y);
  const daysInMonth = new Date(y, m, 0).getDate();
  const endRow = DATA_START_ROW + daysInMonth - 1;

  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === req.session.staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  const iDef = staffData.incentive_defaults || { nurse: 3.5, rehab: 20.0 };

  try {
    const api = await getSheets();
    if (staff.type === 'nurse') {
      const resp = await api.spreadsheets.values.get({
        spreadsheetId: sid,
        range: `${m}月!${staff.kaigo_col}${DATA_START_ROW}:${staff.iryo_col}${endRow}`,
      });
      const rows = resp.data.values ?? [];
      let total_kaigo = 0, total_iryo = 0, working_days = 0;
      const days = [];
      for (let d = 1; d <= daysInMonth; d++) {
        const row = rows[d - 1] ?? [];
        const kaigo = (row[0] !== undefined && row[0] !== '') ? parseFloat(row[0]) : null;
        const iryo  = (row[1] !== undefined && row[1] !== '') ? parseFloat(row[1]) : null;
        if (kaigo != null) total_kaigo += kaigo;
        if (iryo  != null) total_iryo  += iryo;
        if (kaigo != null || iryo != null) working_days++;
        const total = (kaigo != null || iryo != null) ? (kaigo || 0) + (iryo || 0) : null;
        days.push({ day: d, weekday: WD[new Date(y, m - 1, d).getDay()], kaigo, iryo, total });
      }
      const total = total_kaigo + total_iryo;
      const iline = (staff.incentive_line != null) ? staff.incentive_line : iDef.nurse;
      const avg = working_days > 0 ? total / working_days : 0;
      res.json({ type: 'nurse', year: y, month: m, days,
        stats: { total_kaigo, total_iryo, total, working_days,
                 incentive_line: iline, incentive_triggered: avg > iline } });
    } else {
      const resp = await api.spreadsheets.values.get({
        spreadsheetId: sid,
        range: `${m}月!${staff.col}${DATA_START_ROW}:${staff.col}${endRow}`,
      });
      const rows = resp.data.values ?? [];
      let total_units = 0, working_days = 0;
      const days = [];
      for (let d = 1; d <= daysInMonth; d++) {
        const row = rows[d - 1] ?? [];
        const value = (row[0] !== undefined && row[0] !== '') ? parseFloat(row[0]) : null;
        if (value != null) { total_units += value; working_days++; }
        days.push({ day: d, weekday: WD[new Date(y, m - 1, d).getDay()], value });
      }
      const iline = (staff.incentive_line != null) ? staff.incentive_line : iDef.rehab;
      const avg = working_days > 0 ? total_units / working_days : 0;
      res.json({ type: 'rehab', year: y, month: m, days,
        stats: { total_units, working_days,
                 incentive_line: iline, incentive_triggered: avg > iline } });
    }
  } catch (e) {
    console.error('monthly-detail error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── API: 管理者用 月別日別明細 ────────────────────────────────
app.get('/api/admin/monthly-detail', requireAdmin, async (req, res) => {
  const { staffId, year, month } = req.query;
  if (!staffId || !year || !month) return res.status(400).json({ error: 'パラメータ不足' });

  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  const y   = Number(year), m = Number(month);
  const sid = getSpreadsheetIdForYear(y);
  const daysInMonth = new Date(y, m, 0).getDate();
  const endRow = DATA_START_ROW + daysInMonth - 1;
  const iDef = staffData.incentive_defaults || { nurse: 3.5, rehab: 20.0 };

  try {
    const api = await getSheets();
    if (staff.type === 'nurse') {
      const resp = await api.spreadsheets.values.get({
        spreadsheetId: sid,
        range: `${m}月!${staff.kaigo_col}${DATA_START_ROW}:${staff.iryo_col}${endRow}`,
      });
      const rows = resp.data.values ?? [];
      let total_kaigo = 0, total_iryo = 0, working_days = 0;
      const days = [];
      for (let d = 1; d <= daysInMonth; d++) {
        const row = rows[d - 1] ?? [];
        const kaigo = (row[0] !== undefined && row[0] !== '') ? parseFloat(row[0]) : null;
        const iryo  = (row[1] !== undefined && row[1] !== '') ? parseFloat(row[1]) : null;
        if (kaigo != null) total_kaigo += kaigo;
        if (iryo  != null) total_iryo  += iryo;
        if (kaigo != null || iryo != null) working_days++;
        const total = (kaigo != null || iryo != null) ? (kaigo || 0) + (iryo || 0) : null;
        days.push({ day: d, weekday: WD[new Date(y, m - 1, d).getDay()], kaigo, iryo, total });
      }
      const total = total_kaigo + total_iryo;
      const iline = (staff.incentive_line != null) ? staff.incentive_line : iDef.nurse;
      const avg = working_days > 0 ? total / working_days : 0;
      res.json({ type: 'nurse', year: y, month: m, days,
        stats: { total_kaigo, total_iryo, total, working_days,
                 incentive_line: iline, incentive_triggered: avg > iline } });
    } else {
      const resp = await api.spreadsheets.values.get({
        spreadsheetId: sid,
        range: `${m}月!${staff.col}${DATA_START_ROW}:${staff.col}${endRow}`,
      });
      const rows = resp.data.values ?? [];
      let total_units = 0, working_days = 0;
      const days = [];
      for (let d = 1; d <= daysInMonth; d++) {
        const row = rows[d - 1] ?? [];
        const value = (row[0] !== undefined && row[0] !== '') ? parseFloat(row[0]) : null;
        if (value != null) { total_units += value; working_days++; }
        days.push({ day: d, weekday: WD[new Date(y, m - 1, d).getDay()], value });
      }
      const iline = (staff.incentive_line != null) ? staff.incentive_line : iDef.rehab;
      const avg = working_days > 0 ? total_units / working_days : 0;
      res.json({ type: 'rehab', year: y, month: m, days,
        stats: { total_units, working_days,
                 incentive_line: iline, incentive_triggered: avg > iline } });
    }
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// ─── API: 管理者用 記録書き込み ─────────────────────────────────
app.post('/api/admin/record', requireAdmin, async (req, res) => {
  const { staffId, date } = req.body;
  if (!staffId || !date) return res.status(400).json({ error: 'パラメータ不足' });

  const d     = new Date(date);
  const year  = d.getFullYear();
  const month = d.getMonth() + 1;
  const row   = DATA_START_ROW + d.getDate() - 1;
  const sid   = getSpreadsheetIdForYear(year);

  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  try {
    const api = await getSheets();
    if (staff.type === 'nurse') {
      const { kaigo, iryo } = req.body;
      const kVal = (kaigo !== null && kaigo !== undefined) ? Number(kaigo) : '';
      const iVal = (iryo  !== null && iryo  !== undefined) ? Number(iryo)  : '';
      await api.spreadsheets.values.batchUpdate({
        spreadsheetId: sid,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${month}月!${staff.kaigo_col}${row}`, values: [[kVal]] },
            { range: `${month}月!${staff.iryo_col}${row}`, values: [[iVal]] },
          ],
        },
      });
    } else {
      const { value } = req.body;
      const val = (value !== null && value !== undefined) ? Number(value) : '';
      await api.spreadsheets.values.update({
        spreadsheetId: sid,
        range: `${month}月!${staff.col}${row}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[val]] },
      });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// ─── API: インセンティブ設定 ────────────────────────────────────
app.get('/api/admin/incentive', requireAdmin, (_req, res) => {
  const data = loadStaff();
  res.json({
    defaults: data.incentive_defaults || { nurse: 3.5, rehab: 20.0 },
    staff: data.staff.map(s => ({
      id: s.id, name: s.name, type: s.type,
      incentive_line: s.incentive_line ?? null,
    })),
  });
});

app.post('/api/admin/incentive/defaults', requireAdmin, (req, res) => {
  const { nurse, rehab } = req.body;
  if (nurse == null || rehab == null) return res.status(400).json({ error: 'パラメータ不足' });
  const data = loadStaff();
  data.incentive_defaults = { nurse: Number(nurse), rehab: Number(rehab) };
  saveStaff(data);
  res.json({ success: true });
});

app.post('/api/admin/staff/:id/incentive', requireAdmin, (req, res) => {
  const data  = loadStaff();
  const staff = data.staff.find(s => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });
  const { line } = req.body;
  staff.incentive_line = (line != null) ? Number(line) : null;
  saveStaff(data);
  res.json({ success: true });
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

    // 全登録済みスプレッドシートIDを取得
    const registry  = loadRegistry();
    const allSids   = [...new Set([SPREADSHEET_ID, ...Object.values(registry)])];

    let newEntry;
    if (type === 'nurse') {
      // C(index 2) + 看護師人数 × 2列 = 新看護師の介護列
      const nurseCount = data.staff.filter(s => s.type === 'nurse').length;
      const kaigoIdx = 2 + nurseCount * 2;
      const kaigoCol = idxToCol(kaigoIdx);
      const iryoCol  = idxToCol(kaigoIdx + 1);

      for (const ssId of allSids) {
        const ss = await api.spreadsheets.get({ spreadsheetId: ssId });
        const sm = {};
        for (const s of ss.data.sheets) sm[s.properties.title] = s.properties.sheetId;
        const vm = MONTHS.filter(m => sm[m] !== undefined);
        await api.spreadsheets.batchUpdate({
          spreadsheetId: ssId,
          requestBody: { requests: vm.map(m => ({
            insertDimension: { range: { sheetId: sm[m], dimension: 'COLUMNS',
              startIndex: kaigoIdx, endIndex: kaigoIdx + 2 }, inheritFromBefore: false },
          })) },
        });
        await api.spreadsheets.values.batchUpdate({
          spreadsheetId: ssId,
          requestBody: { valueInputOption: 'USER_ENTERED', data: vm.map(m => ({
            range: `${m}!${kaigoCol}${HEADER_ROW}:${iryoCol}${HEADER_ROW}`,
            values: [[`${name}(介護)`, `${name}(医療)`]],
          })) },
        });
      }
      for (const s of data.staff)
        if (s.type !== 'nurse') s.col = idxToCol(colToIdx(s.col) + 2);

      newEntry = { id: loginId, name,
        furigana_family: furigana_family || '', furigana_given: furigana_given || '',
        type: 'nurse', kaigo_col: kaigoCol, iryo_col: iryoCol,
        seq: nextSeq, initial_pw: initialPw,
        password_hash: await bcrypt.hash(initialPw, 10) };

    } else {
      // C(index 2) + 看護師人数 × 2列 + リハビリ人数 = 新リハビリの列
      const nurseCount = data.staff.filter(s => s.type === 'nurse').length;
      const rehabCount = data.staff.filter(s => s.type !== 'nurse').length;
      const newColIdx = 2 + nurseCount * 2 + rehabCount;
      const newCol    = idxToCol(newColIdx);

      for (const ssId of allSids) {
        const ss = await api.spreadsheets.get({ spreadsheetId: ssId });
        const sm = {};
        for (const s of ss.data.sheets) sm[s.properties.title] = s.properties.sheetId;
        const vm = MONTHS.filter(m => sm[m] !== undefined);
        await api.spreadsheets.batchUpdate({
          spreadsheetId: ssId,
          requestBody: { requests: vm.map(m => ({
            insertDimension: { range: { sheetId: sm[m], dimension: 'COLUMNS',
              startIndex: newColIdx, endIndex: newColIdx + 1 }, inheritFromBefore: false },
          })) },
        });
        await api.spreadsheets.values.batchUpdate({
          spreadsheetId: ssId,
          requestBody: { valueInputOption: 'USER_ENTERED', data: vm.map(m => ({
            range: `${m}!${newCol}${HEADER_ROW}`, values: [[name]],
          })) },
        });
      }
      newEntry = { id: loginId, name,
        furigana_family: furigana_family || '', furigana_given: furigana_given || '',
        type: type, col: newCol,
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

app.patch('/api/admin/staff/:id', requireAdmin, (req, res) => {
  const { name, furigana_family, furigana_given } = req.body;
  if (!name) return res.status(400).json({ error: '氏名は必須です' });
  const data  = loadStaff();
  const staff = data.staff.find(s => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });
  staff.name             = name;
  staff.furigana_family  = furigana_family  ?? staff.furigana_family;
  staff.furigana_given   = furigana_given   ?? staff.furigana_given;
  saveStaff(data);
  res.json({ success: true, staff: data.staff });
});

app.delete('/api/admin/staff/:id', requireAdmin, async (req, res) => {
  const data = loadStaff();
  const idx  = data.staff.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'スタッフが見つかりません' });
  const [removed] = data.staff.splice(idx, 1);

  try {
    const api      = await getSheets();
    const registry = loadRegistry();
    const allSids  = [...new Set([SPREADSHEET_ID, ...Object.values(registry)])];

    if (removed.type === 'nurse') {
      const delStart = colToIdx(removed.kaigo_col);
      // 全スプレッドシートから介護・医療の2列を削除
      for (const ssId of allSids) {
        const ss = await api.spreadsheets.get({ spreadsheetId: ssId });
        const sm = {};
        for (const s of ss.data.sheets) sm[s.properties.title] = s.properties.sheetId;
        const vm = MONTHS.filter(m => sm[m] !== undefined);
        await api.spreadsheets.batchUpdate({
          spreadsheetId: ssId,
          requestBody: { requests: vm.map(m => ({
            deleteDimension: { range: { sheetId: sm[m], dimension: 'COLUMNS',
              startIndex: delStart, endIndex: delStart + 2 } },
          })) },
        });
      }
      // 削除列より後ろの看護師の列を -2 シフト
      for (const s of data.staff) {
        if (s.type === 'nurse' && colToIdx(s.kaigo_col) > delStart) {
          s.kaigo_col = idxToCol(colToIdx(s.kaigo_col) - 2);
          s.iryo_col  = idxToCol(colToIdx(s.iryo_col)  - 2);
        }
      }
      // 全リハビリの列を -2 シフト（リハビリは常に看護師の後ろ）
      for (const s of data.staff) {
        if (s.type !== 'nurse') s.col = idxToCol(colToIdx(s.col) - 2);
      }
    } else {
      const delIdx = colToIdx(removed.col);
      // 全スプレッドシートから1列を削除
      for (const ssId of allSids) {
        const ss = await api.spreadsheets.get({ spreadsheetId: ssId });
        const sm = {};
        for (const s of ss.data.sheets) sm[s.properties.title] = s.properties.sheetId;
        const vm = MONTHS.filter(m => sm[m] !== undefined);
        await api.spreadsheets.batchUpdate({
          spreadsheetId: ssId,
          requestBody: { requests: vm.map(m => ({
            deleteDimension: { range: { sheetId: sm[m], dimension: 'COLUMNS',
              startIndex: delIdx, endIndex: delIdx + 1 } },
          })) },
        });
      }
      // 削除列より後ろのリハビリの列を -1 シフト
      for (const s of data.staff) {
        if (s.type !== 'nurse' && colToIdx(s.col) > delIdx) {
          s.col = idxToCol(colToIdx(s.col) - 1);
        }
      }
    }

    saveStaff(data);
    res.json({ success: true, removed, staff: data.staff });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/staff/:id/reset-password', requireAdmin, async (req, res) => {
  const data  = loadStaff();
  const staff = data.staff.find(s => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });
  staff.password_hash = await bcrypt.hash(staff.initial_pw, 10);
  saveStaff(data);
  res.json({ success: true, initial_pw: staff.initial_pw });
});

// ─── API: 翌年スプレッドシート作成 ─────────────────────────────
app.post('/api/admin/create-next-year-sheet', requireAdmin, async (_req, res) => {
  const nextYear = new Date().getFullYear() + 1;
  try {
    const newId = await createSpreadsheetForYear(nextYear);
    res.json({
      success: true, year: nextYear, spreadsheetId: newId,
      url: `https://docs.google.com/spreadsheets/d/${newId}`,
    });
  } catch (e) {
    if (e.message.startsWith('already_exists:')) {
      const existingId = e.message.slice('already_exists:'.length);
      return res.json({
        success: false, already_exists: true, year: nextYear, spreadsheetId: existingId,
        url: `https://docs.google.com/spreadsheets/d/${existingId}`,
      });
    }
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// ─── API: スプレッドシートレジストリ取得 ───────────────────────
app.get('/api/admin/registry', requireAdmin, (_req, res) => {
  const reg = loadRegistry();
  res.json(Object.entries(reg).map(([year, id]) => ({
    year, spreadsheetId: id,
    url: `https://docs.google.com/spreadsheets/d/${id}`,
  })));
});

// ─── 起動 ──────────────────────────────────────────────────────
async function ensureDataDir() {
  if (DATA_DIR === __dirname) return;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  // staff.json が DATA_DIR になければ git リポジトリのものをコピー
  if (!fs.existsSync(STAFF_PATH)) {
    const src = path.join(__dirname, 'staff.json');
    if (fs.existsSync(src)) fs.copyFileSync(src, STAFF_PATH);
  }
  // spreadsheet-registry.json も同様
  if (!fs.existsSync(REGISTRY_PATH)) {
    const src = path.join(__dirname, 'spreadsheet-registry.json');
    if (fs.existsSync(src)) fs.copyFileSync(src, REGISTRY_PATH);
  }
  // schedules.json も同様
  if (!fs.existsSync(SCHEDULES_PATH)) {
    const src = path.join(__dirname, 'schedules.json');
    if (fs.existsSync(src)) fs.copyFileSync(src, SCHEDULES_PATH);
    else fs.writeFileSync(SCHEDULES_PATH, JSON.stringify({ schedules: [] }, null, 2));
  }
}

async function main() {
  await ensureDataDir();
  await ensurePasswordsHashed();

  // 毎年12/31 23:00に翌年スプレッドシートを自動作成
  cron.schedule('0 23 31 12 *', async () => {
    const nextYear = new Date().getFullYear() + 1;
    console.log(`[cron] ${nextYear}年スプレッドシートを自動作成します...`);
    try {
      const id = await createSpreadsheetForYear(nextYear);
      console.log(`[cron] ✅ 完了: ${id}`);
    } catch (e) {
      if (e.message.startsWith('already_exists:')) {
        console.log(`[cron] ${nextYear}年スプレッドシートは既に存在します`);
      } else {
        console.error('[cron] ❌ エラー:', e.message);
      }
    }
  });
  console.log('📅 自動作成スケジュール: 毎年 12/31 23:00 に翌年スプレッドシートを作成');

  app.listen(PORT, () => console.log(`✅ Server → http://localhost:${PORT}`));
}
main().catch(e => { console.error(e); process.exit(1); });
