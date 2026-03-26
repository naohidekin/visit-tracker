require('dotenv').config();
const express    = require('express');
const { google } = require('googleapis');
const fs         = require('fs');
const path       = require('path');
const bcrypt     = require('bcryptjs');
const csession   = require('cookie-session');
const cron       = require('node-cron');
const multer     = require('multer');
const XLSX       = require('xlsx');
const { generateRegistrationOptions, verifyRegistrationResponse,
        generateAuthenticationOptions, verifyAuthenticationResponse } = require('@simplewebauthn/server');
const { isoBase64URL } = require('@simplewebauthn/server/helpers');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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
const NOTICES_PATH    = path.join(DATA_DIR, 'notices.json');
const EXCEL_RESULTS_PATH = path.join(DATA_DIR, 'excel-results.json');
const LEAVE_PATH         = path.join(DATA_DIR, 'leave-requests.json');
const ONCALL_PATH        = path.join(DATA_DIR, 'oncall-records.json');
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
      [`${year}年${m}月実績表`], [], [],
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

  // タイトル行（行1）を中央揃えに設定
  await api.spreadsheets.batchUpdate({
    spreadsheetId: newId,
    requestBody: {
      requests: MONTHS.map((_, i) => ({
        repeatCell: {
          range: { sheetId: i, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
          cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
          fields: 'userEnteredFormat.horizontalAlignment',
        },
      })),
    },
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
function loadNotices() {
  if (!fs.existsSync(NOTICES_PATH)) return { notices: [], readStatus: {} };
  const data = JSON.parse(fs.readFileSync(NOTICES_PATH, 'utf8'));
  if (!data.readStatus) data.readStatus = {};
  return data;
}
function saveNotices(data) {
  fs.writeFileSync(NOTICES_PATH, JSON.stringify(data, null, 2));
}
function loadLeave() {
  if (!fs.existsSync(LEAVE_PATH)) return { requests: [] };
  return JSON.parse(fs.readFileSync(LEAVE_PATH, 'utf8'));
}
function saveLeave(data) {
  fs.writeFileSync(LEAVE_PATH, JSON.stringify(data, null, 2));
}
function loadOncall() {
  if (!fs.existsSync(ONCALL_PATH)) return { records: [] };
  return JSON.parse(fs.readFileSync(ONCALL_PATH, 'utf8'));
}
function saveOncall(data) {
  fs.writeFileSync(ONCALL_PATH, JSON.stringify(data, null, 2));
}

// Yuw connect 有給付与テーブル（10→12→14→16→18→20、毎年+2）
const LEAVE_GRANT_TABLE = [
  { years: 0.5, days: 10 },
  { years: 1.5, days: 12 },
  { years: 2.5, days: 14 },
  { years: 3.5, days: 16 },
  { years: 4.5, days: 18 },
  { years: 5.5, days: 20 },
];

// 現在の付与日数を計算
function calcLeaveGrantDays(hireDate) {
  if (!hireDate) return 0;
  const hire = new Date(hireDate);
  const now  = new Date(getTodayJST());
  const diffMs = now - hire;
  const diffYears = diffMs / (365.25 * 24 * 60 * 60 * 1000);
  if (diffYears < 0.5) return 0;
  let granted = 0;
  for (const t of LEAVE_GRANT_TABLE) {
    if (diffYears >= t.years) granted = t.days;
  }
  return granted;
}

// 次回有給付与日・付与日数・お祝い休暇情報を計算
function calcNextGrant(hireDate) {
  if (!hireDate) return null;
  const hire = new Date(hireDate);
  const now  = new Date(getTodayJST());
  const diffMs = now - hire;
  const diffYears = diffMs / (365.25 * 24 * 60 * 60 * 1000);

  // お祝い休暇（入職〜6ヶ月）
  const celebrationExpiry = new Date(hire);
  celebrationExpiry.setMonth(celebrationExpiry.getMonth() + 6);
  const celebrationActive = now < celebrationExpiry;

  // 次回付与を探す
  for (const t of LEAVE_GRANT_TABLE) {
    if (diffYears < t.years) {
      const nextDate = new Date(hire);
      const months = Math.round(t.years * 12);
      nextDate.setMonth(nextDate.getMonth() + months);
      const daysUntil = Math.ceil((nextDate - now) / (24 * 60 * 60 * 1000));
      return {
        next_grant_date: toDateStr(nextDate),
        next_grant_days: t.days,
        days_until_next: daysUntil,
        celebration_expiry: toDateStr(celebrationExpiry),
        celebration_active: celebrationActive,
        celebration_days_left: celebrationActive ? Math.ceil((celebrationExpiry - now) / (24 * 60 * 60 * 1000)) : 0,
      };
    }
  }
  // 既に最大付与(20日)に到達
  const lastEntry = LEAVE_GRANT_TABLE[LEAVE_GRANT_TABLE.length - 1];
  const lastMonths = Math.round(lastEntry.years * 12);
  const yearsSinceMax = diffYears - lastEntry.years;
  const completedYears = Math.floor(yearsSinceMax);
  const nextDate = new Date(hire);
  nextDate.setMonth(nextDate.getMonth() + lastMonths + (completedYears + 1) * 12);
  const daysUntil = Math.ceil((nextDate - now) / (24 * 60 * 60 * 1000));
  return {
    next_grant_date: toDateStr(nextDate),
    next_grant_days: lastEntry.days,
    days_until_next: daysUntil,
    celebration_expiry: toDateStr(celebrationExpiry),
    celebration_active: false,
    celebration_days_left: 0,
  };
}

// スタッフの有給残日数を計算（承認済み使用日数を考慮）
function calcLeaveBalance(staff) {
  const leaveData = loadLeave();
  const approved = leaveData.requests.filter(r =>
    r.staffId === staff.id && r.status === 'approved'
  );
  let usedDays = 0;
  for (const r of approved) {
    const perDate = (r.type === 'half_am' || r.type === 'half_pm') ? 0.5 : 1;
    usedDays += r.dates.length * perDate;
  }
  const granted = staff.leave_granted || 0;
  const carriedOver = staff.leave_carried_over || 0;
  const manualAdj = staff.leave_manual_adjustment || 0;
  return granted + carriedOver + manualAdj - usedDays;
}

function loadExcelResults() {
  if (!fs.existsSync(EXCEL_RESULTS_PATH)) return {};
  return JSON.parse(fs.readFileSync(EXCEL_RESULTS_PATH, 'utf8'));
}
function saveExcelResults(data) {
  fs.writeFileSync(EXCEL_RESULTS_PATH, JSON.stringify(data, null, 2));
}
function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
// JST（UTC+9）での今日の日付文字列を返す
function getTodayJST() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}
// JST での現在日時（Dateオブジェクト）
function getNowJST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
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

// ─── 起動時：有給フィールドがないスタッフにデフォルト値を追加 ───
function ensureLeaveFields() {
  const data = loadStaff();
  let changed = false;
  for (const s of data.staff) {
    if (s.hire_date === undefined)              { s.hire_date = null;              changed = true; }
    if (s.leave_granted === undefined)          { s.leave_granted = 0;             changed = true; }
    if (s.leave_grant_date === undefined)       { s.leave_grant_date = null;       changed = true; }
    if (s.leave_carried_over === undefined)     { s.leave_carried_over = 0;        changed = true; }
    if (s.leave_manual_adjustment === undefined){ s.leave_manual_adjustment = 0;   changed = true; }
    if (s.oncall_eligible === undefined)       { s.oncall_eligible = false;       changed = true; }
  }
  if (changed) { saveStaff(data); console.log('✅ スタッフフィールドを初期化しました'); }
}

// ─── 起動時：ソース staff.json に新スタッフがいれば DATA_DIR へ追加 ──
async function syncNewStaffFromSource() {
  if (DATA_DIR === __dirname) return; // ローカルは同一ファイルなので不要
  const srcPath = path.join(__dirname, 'staff.json');
  if (!fs.existsSync(srcPath)) return;

  const srcData  = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
  const liveData = loadStaff();
  const liveIds  = new Set(liveData.staff.map(s => s.id));

  const newStaff = srcData.staff.filter(s => !liveIds.has(s.id));
  if (newStaff.length === 0) return;

  for (const s of newStaff) {
    if (!s.password_hash && s.initial_pw) {
      s.password_hash = await bcrypt.hash(s.initial_pw, 10);
    }
    liveData.staff.push(s);
    console.log(`✅ 新スタッフを /data/staff.json に追加しました: ${s.name} (${s.id})`);
  }
  saveStaff(liveData);
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

// ─── WebAuthn Credential Storage (Google Sheets) ────────────────
const WEBAUTHN_SHEET = 'WebAuthn';

async function ensureWebAuthnSheet() {
  const api = await getSheets();
  const ss = await api.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = ss.data.sheets.some(s => s.properties.title === WEBAUTHN_SHEET);
  if (!exists) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: WEBAUTHN_SHEET } } }] },
    });
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${WEBAUTHN_SHEET}!A1:F1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['staffId', 'credentialID', 'publicKey', 'counter', 'transports', 'registeredAt']] },
    });
  }
}

async function loadCredentials(staffId) {
  await ensureWebAuthnSheet();
  const api = await getSheets();
  const resp = await api.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${WEBAUTHN_SHEET}!A2:F`,
  });
  const rows = resp.data.values || [];
  return rows
    .filter(r => r[0] === staffId)
    .map(r => ({
      id: r[1],
      publicKey: isoBase64URL.toBuffer(r[2]),
      counter: Number(r[3]),
      transports: JSON.parse(r[4] || '[]'),
    }));
}

async function saveCredential(staffId, credential) {
  await ensureWebAuthnSheet();
  const api = await getSheets();
  await api.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${WEBAUTHN_SHEET}!A:F`,
    valueInputOption: 'RAW',
    requestBody: { values: [[
      staffId,
      credential.id,
      isoBase64URL.fromBuffer(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports || []),
      new Date().toISOString(),
    ]] },
  });
}

async function updateCredentialCounter(credentialID, newCounter) {
  const api = await getSheets();
  const resp = await api.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${WEBAUTHN_SHEET}!B2:B`,
  });
  const rows = resp.data.values || [];
  const idx = rows.findIndex(r => r[0] === credentialID);
  if (idx >= 0) {
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${WEBAUTHN_SHEET}!D${idx + 2}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[newCounter]] },
    });
  }
}

async function deleteCredentials(staffId) {
  const api = await getSheets();
  const resp = await api.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${WEBAUTHN_SHEET}!A2:F`,
  });
  const rows = resp.data.values || [];
  // 該当行を空配列に置換
  const updated = rows.map(r => r[0] === staffId ? ['', '', '', '', '', ''] : r);
  if (rows.length > 0) {
    await api.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${WEBAUTHN_SHEET}!A2:F${rows.length + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: updated },
    });
  }
}

async function hasCredentials(staffId) {
  try {
    const creds = await loadCredentials(staffId);
    return creds.length > 0;
  } catch { return false; }
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
app.get('/manual', (req, res) => {
  if (!req.session.staffId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'manual.html'));
});
app.get('/notices', (req, res) => {
  if (!req.session.staffId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'notices.html'));
});
app.get('/oncall', (req, res) => {
  if (!req.session.staffId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'oncall.html'));
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
  const data = loadStaff();
  const staff = data.staff.find(s => s.id === req.session.staffId);
  res.json({
    id: req.session.staffId,
    name: req.session.staffName,
    type: req.session.staffType,
    oncall_eligible: staff ? !!staff.oncall_eligible : false,
  });
});

// ─── API: WebAuthn (FaceID/TouchID) ─────────────────────────────
function getWebAuthnRpId(req) {
  return req.hostname;
}
function getWebAuthnOrigin(req) {
  // localhost は http 許可、本番は https
  const proto = req.hostname === 'localhost' ? 'http' : 'https';
  const port = req.hostname === 'localhost' && process.env.PORT ? `:${process.env.PORT}` : '';
  return `${proto}://${req.hostname}${port}`;
}

app.get('/api/webauthn/has-credential', async (req, res) => {
  try {
    const { loginId } = req.query;
    if (!loginId) return res.json({ has: false });
    const has = await hasCredentials(loginId);
    res.json({ has });
  } catch (e) {
    console.error('WebAuthn has-credential error:', e.message);
    res.json({ has: false });
  }
});

app.post('/api/webauthn/register-options', requireStaff, async (req, res) => {
  try {
    const staffId = req.session.staffId;
    const staffName = req.session.staffName;
    const existingCreds = await loadCredentials(staffId);

    const options = await generateRegistrationOptions({
      rpName: 'にこっとweb App',
      rpID: getWebAuthnRpId(req),
      userName: staffId,
      userDisplayName: staffName,
      attestationType: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        userVerification: 'required',
      },
      excludeCredentials: existingCreds.map(c => ({
        id: c.id,
        transports: c.transports,
      })),
    });

    req.session.webauthnChallenge = options.challenge;
    res.json(options);
  } catch (e) {
    console.error('WebAuthn register-options error:', e.message);
    res.status(500).json({ error: '登録オプションの生成に失敗しました' });
  }
});

app.post('/api/webauthn/register-verify', requireStaff, async (req, res) => {
  const expectedChallenge = req.session.webauthnChallenge;
  req.session.webauthnChallenge = null;

  try {
    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge,
      expectedOrigin: getWebAuthnOrigin(req),
      expectedRPID: getWebAuthnRpId(req),
    });

    if (!verification.verified) {
      return res.status(400).json({ error: '登録に失敗しました' });
    }

    const { credential } = verification.registrationInfo;
    await saveCredential(req.session.staffId, credential);
    res.json({ success: true });
  } catch (e) {
    console.error('WebAuthn register-verify error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/webauthn/login-options', async (req, res) => {
  try {
    const { loginId } = req.body;
    if (!loginId) return res.status(400).json({ error: 'ログインIDが必要です' });

    const creds = await loadCredentials(loginId);
    if (creds.length === 0) {
      return res.status(400).json({ error: 'パスキーが登録されていません' });
    }

    const options = await generateAuthenticationOptions({
      rpID: getWebAuthnRpId(req),
      allowCredentials: creds.map(c => ({
        id: c.id,
        transports: c.transports,
      })),
      userVerification: 'required',
    });

    req.session.webauthnChallenge = options.challenge;
    req.session.webauthnLoginId = loginId;
    res.json(options);
  } catch (e) {
    console.error('WebAuthn login-options error:', e.message);
    res.status(500).json({ error: '認証オプションの生成に失敗しました' });
  }
});

app.post('/api/webauthn/login-verify', async (req, res) => {
  const expectedChallenge = req.session.webauthnChallenge;
  const loginId = req.session.webauthnLoginId;
  req.session.webauthnChallenge = null;
  req.session.webauthnLoginId = null;

  if (!expectedChallenge || !loginId) {
    return res.status(400).json({ error: '認証セッションが無効です' });
  }

  try {
    const creds = await loadCredentials(loginId);
    const credential = creds.find(c => c.id === req.body.id);
    if (!credential) {
      return res.status(400).json({ error: '不明な認証情報です' });
    }

    const verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge,
      expectedOrigin: getWebAuthnOrigin(req),
      expectedRPID: getWebAuthnRpId(req),
      credential,
    });

    if (!verification.verified) {
      return res.status(401).json({ error: '認証に失敗しました' });
    }

    await updateCredentialCounter(credential.id, verification.authenticationInfo.newCounter);

    const data = loadStaff();
    const staff = data.staff.find(s => s.id === loginId);
    if (!staff) return res.status(401).json({ error: 'スタッフが見つかりません' });

    req.session.staffId = staff.id;
    req.session.staffName = staff.name;
    req.session.staffType = staff.type;
    res.json({ success: true });
  } catch (e) {
    console.error('WebAuthn login-verify error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/webauthn/delete', requireStaff, async (req, res) => {
  try {
    await deleteCredentials(req.session.staffId);
    res.json({ success: true });
  } catch (e) {
    console.error('WebAuthn delete error:', e.message);
    res.status(500).json({ error: '削除に失敗しました' });
  }
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

  // 日付チェック（JST基準）
  const d = new Date(date);
  if (date > getTodayJST()) return res.status(400).json({ error: '未来の日付には記録できません' });

  // 締日チェック：1〜20日は前月16日、21日〜末日は当月16日より前は修正不可
  const now = getNowJST();
  let editYear = now.getUTCFullYear(), editMonth = now.getUTCMonth() + 1;
  if (now.getUTCDate() <= 20) {
    editMonth -= 1;
    if (editMonth <= 0) { editMonth = 12; editYear--; }
  }
  const editableFrom = new Date(`${editYear}-${String(editMonth).padStart(2,'0')}-16T00:00:00`);
  if (d < editableFrom) return res.status(400).json({ error: '締日（15日）以前の日付は修正できません' });

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
  if (date <= getTodayJST()) return res.status(400).json({ error: '予定登録は翌日以降の日付のみ可能です' });

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

  if (schedule.date > getTodayJST()) return res.status(400).json({ error: 'まだ確定できません（翌日以降の予定です）' });

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
    staff: data.staff.filter(s => !s.archived).map(s => ({
      id: s.id, name: s.name, type: s.type,
      furigana_family: s.furigana_family, furigana_given: s.furigana_given,
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
app.get('/api/admin/staff', requireAdmin, (req, res) => {
  const data = loadStaff();
  const includeArchived = req.query.includeArchived === 'true';
  const staff = includeArchived ? data.staff : data.staff.filter(s => !s.archived);
  res.json(staff);
});

app.patch('/api/admin/staff/:id/archive', requireAdmin, (req, res) => {
  const data  = loadStaff();
  const staff = data.staff.find(s => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });
  staff.archived = !staff.archived;
  saveStaff(data);
  res.json({ success: true, archived: staff.archived, staff: data.staff });
});

app.post('/api/admin/staff', requireAdmin, async (req, res) => {
  const { name, furigana_family, furigana_given, type, loginId, initialPw, hire_date, oncall } = req.body;
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
      const nurseCount = data.staff.filter(s => s.type === 'nurse' && !s.archived).length;
      const kaigoIdx = 2 + nurseCount * 2;
      const kaigoCol = idxToCol(kaigoIdx);
      const iryoCol  = idxToCol(kaigoIdx + 1);
      // 太線の旧位置（追加前の最終iryo列）
      const oldDividerIdx = nurseCount > 0 ? kaigoIdx - 1 : null;
      const newDividerIdx = kaigoIdx + 1;

      const NURSE_DARK_BG  = { red: 0.18431373, green: 0.45882353, blue: 0.70980392 };
      const NURSE_NAME_BG  = { red: 0.8392157,  green: 0.89411765, blue: 0.9411765  };
      const NURSE_KAIGO_BG = { red: 221/255,    green: 238/255,    blue: 1.0        };
      const NURSE_IRYO_BG  = { red: 234/255,    green: 244/255,    blue: 1.0        };
      const TOTAL_BG       = { red: 1.0,        green: 242/255,    blue: 204/255    };
      const SUN_BG         = { red: 0.9882353,  green: 0.89411765, blue: 0.8392157  };
      // ssId → 年 の逆引きマップ
      const yearBySsId = Object.fromEntries(Object.entries(registry).map(([y, id]) => [id, parseInt(y)]));
      const SOLID        = { style: 'SOLID',       color: { red:0, green:0, blue:0 } };
      const SOLID_MEDIUM = { style: 'SOLID_MEDIUM', color: { red:0, green:0, blue:0 } };
      const familyName   = furigana_family ? name.split(/[\s　]/)[0] : name.split(/[\s　]/)[0];

      for (const ssId of allSids) {
        const ssYear = yearBySsId[ssId] || new Date().getFullYear();
        const ss = await api.spreadsheets.get({ spreadsheetId: ssId });
        const sm = {};
        for (const s of ss.data.sheets) sm[s.properties.title] = s.properties.sheetId;
        const vm = MONTHS.filter(m => sm[m] !== undefined);

        // 1. 列を挿入
        await api.spreadsheets.batchUpdate({
          spreadsheetId: ssId,
          requestBody: { requests: vm.map(m => ({
            insertDimension: { range: { sheetId: sm[m], dimension: 'COLUMNS',
              startIndex: kaigoIdx, endIndex: kaigoIdx + 2 }, inheritFromBefore: false },
          })) },
        });

        // 2. 行3（氏名）・行4（介護/医療）の値を書き込み
        await api.spreadsheets.values.batchUpdate({
          spreadsheetId: ssId,
          requestBody: { valueInputOption: 'USER_ENTERED', data: vm.flatMap(m => ([
            { range: `${m}!${kaigoCol}3:${iryoCol}3`,
              values: [[familyName, '']] },
            { range: `${m}!${kaigoCol}${HEADER_ROW}:${iryoCol}${HEADER_ROW}`,
              values: [['介護', '医療']] },
          ])) },
        });

        // 3. フォーマット・太線・ヘッダー結合を各シートに適用
        const fmtReqs = vm.flatMap(m => {
          const sid = sm[m];
          return [
            // 行2 看護ヘッダー結合を拡張（C〜新iryo列）
            { unmergeCells: { range: { sheetId: sid, startRowIndex: 1, endRowIndex: 2,
                startColumnIndex: 2, endColumnIndex: kaigoIdx + 2 } } },
            { mergeCells:   { range: { sheetId: sid, startRowIndex: 1, endRowIndex: 2,
                startColumnIndex: 2, endColumnIndex: kaigoIdx + 2 },
                mergeType: 'MERGE_ALL' } },
            // 行2 色（新列）
            { repeatCell: { range: { sheetId: sid, startRowIndex: 1, endRowIndex: 2,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 2 },
                cell: { userEnteredFormat: { backgroundColor: NURSE_DARK_BG,
                  textFormat: { bold: true }, horizontalAlignment: 'CENTER' } },
                fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } },
            // 行3 氏名セルを結合・色付け（Meiryo/10/bold/center）
            { unmergeCells: { range: { sheetId: sid, startRowIndex: 2, endRowIndex: 3,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 2 } } },
            { mergeCells: { range: { sheetId: sid, startRowIndex: 2, endRowIndex: 3,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 2 },
                mergeType: 'MERGE_ALL' } },
            { repeatCell: { range: { sheetId: sid, startRowIndex: 2, endRowIndex: 3,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 2 },
                cell: { userEnteredFormat: { backgroundColor: NURSE_NAME_BG,
                  textFormat: { fontFamily: 'Meiryo', fontSize: 10, bold: true },
                  horizontalAlignment: 'CENTER' } },
                fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } },
            // 行4 介護列（Meiryo/9/bold/center）
            { repeatCell: { range: { sheetId: sid, startRowIndex: 3, endRowIndex: 4,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 1 },
                cell: { userEnteredFormat: { backgroundColor: NURSE_KAIGO_BG,
                  textFormat: { fontFamily: 'Meiryo', fontSize: 9, bold: true },
                  horizontalAlignment: 'CENTER' } },
                fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } },
            // 行4 医療列（Meiryo/9/bold/center）
            { repeatCell: { range: { sheetId: sid, startRowIndex: 3, endRowIndex: 4,
                startColumnIndex: kaigoIdx + 1, endColumnIndex: kaigoIdx + 2 },
                cell: { userEnteredFormat: { backgroundColor: NURSE_IRYO_BG,
                  textFormat: { fontFamily: 'Meiryo', fontSize: 9, bold: true },
                  horizontalAlignment: 'CENTER' } },
                fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } },
            // 行5以降 データ列（介護）
            { repeatCell: { range: { sheetId: sid, startRowIndex: 4, endRowIndex: 36,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 1 },
                cell: { userEnteredFormat: { backgroundColor: NURSE_KAIGO_BG,
                  horizontalAlignment: 'CENTER' } },
                fields: 'userEnteredFormat(backgroundColor,horizontalAlignment)' } },
            // 行5以降 データ列（医療）
            { repeatCell: { range: { sheetId: sid, startRowIndex: 4, endRowIndex: 36,
                startColumnIndex: kaigoIdx + 1, endColumnIndex: kaigoIdx + 2 },
                cell: { userEnteredFormat: { backgroundColor: NURSE_IRYO_BG,
                  horizontalAlignment: 'CENTER' } },
                fields: 'userEnteredFormat(backgroundColor,horizontalAlignment)' } },
            // 日曜行のカラー（既存看護師と同じピンク）
            ...(() => {
              const monthNum = parseInt(m);
              const daysInMonth = new Date(ssYear, monthNum, 0).getDate();
              const sunReqs = [];
              for (let d = 1; d <= daysInMonth; d++) {
                if (new Date(ssYear, monthNum - 1, d).getDay() !== 0) continue;
                const rowIdx = DATA_START_ROW - 1 + (d - 1);
                sunReqs.push(
                  { repeatCell: { range: { sheetId: sid, startRowIndex: rowIdx, endRowIndex: rowIdx + 1,
                      startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 2 },
                      cell: { userEnteredFormat: { backgroundColor: SUN_BG } },
                      fields: 'userEnteredFormat.backgroundColor' } }
                );
              }
              return sunReqs;
            })(),
            // 旧太線を解除
            ...(oldDividerIdx !== null ? [
              { updateBorders: { range: { sheetId: sid, startRowIndex: 1, endRowIndex: 36,
                  startColumnIndex: oldDividerIdx, endColumnIndex: oldDividerIdx + 1 },
                  right: SOLID } },
              { updateBorders: { range: { sheetId: sid, startRowIndex: 1, endRowIndex: 36,
                  startColumnIndex: oldDividerIdx + 1, endColumnIndex: oldDividerIdx + 2 },
                  left: SOLID } },
            ] : []),
            // 新太線を設定（新iryo列右・PT先頭列左）
            { updateBorders: { range: { sheetId: sid, startRowIndex: 1, endRowIndex: 36,
                startColumnIndex: newDividerIdx, endColumnIndex: newDividerIdx + 1 },
                right: SOLID_MEDIUM } },
            { updateBorders: { range: { sheetId: sid, startRowIndex: 1, endRowIndex: 36,
                startColumnIndex: newDividerIdx + 1, endColumnIndex: newDividerIdx + 2 },
                left: SOLID_MEDIUM } },
            // 列幅を既存看護師と同じ 48px に設定
            { updateDimensionProperties: {
                range: { sheetId: sid, dimension: 'COLUMNS',
                  startIndex: kaigoIdx, endIndex: kaigoIdx + 2 },
                properties: { pixelSize: 48 },
                fields: 'pixelSize' } },
          ];
        });
        await api.spreadsheets.batchUpdate({ spreadsheetId: ssId, requestBody: { requests: fmtReqs } });

        // 4. 合計行・個人計行のフォーマットと数式を設定
        for (const m of vm) {
          const sheetVals = await api.spreadsheets.values.get({
            spreadsheetId: ssId, range: `${m}!A1:A40` });
          const totalRowIdx = (sheetVals.data.values || []).findIndex(r => r[0]?.includes('合'));
          if (totalRowIdx < 0) continue;
          const tI = totalRowIdx;
          const kI = totalRowIdx + 1;
          const tRow = tI + 1; // 1-based
          const kRow = kI + 1;
          const dataEnd = tI; // データ最終行（1-based）
          const sid = sm[m];

          // 合計行 新列のフォーマット
          const totalFmt = [
            { repeatCell: { range: { sheetId: sid, startRowIndex: tI, endRowIndex: tI + 1,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 2 },
                cell: { userEnteredFormat: { backgroundColor: TOTAL_BG,
                  textFormat: { fontFamily: 'Meiryo', fontSize: 11, bold: true },
                  horizontalAlignment: 'CENTER' } },
                fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } },
            { updateBorders: { range: { sheetId: sid, startRowIndex: tI, endRowIndex: tI + 1,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 2 },
                top: SOLID_MEDIUM, bottom: SOLID_MEDIUM, left: SOLID, right: SOLID } },
            // 個人計行 新列を結合・フォーマット
            { unmergeCells: { range: { sheetId: sid, startRowIndex: kI, endRowIndex: kI + 1,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 2 } } },
            { mergeCells: { range: { sheetId: sid, startRowIndex: kI, endRowIndex: kI + 1,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 2 },
                mergeType: 'MERGE_ALL' } },
            { repeatCell: { range: { sheetId: sid, startRowIndex: kI, endRowIndex: kI + 1,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 2 },
                cell: { userEnteredFormat: { backgroundColor: NURSE_KAIGO_BG,
                  textFormat: { fontFamily: 'Meiryo', fontSize: 11, bold: true },
                  horizontalAlignment: 'CENTER',
                  numberFormat: { type: 'NUMBER', pattern: '0.0' } } },
                fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,numberFormat)' } },
            { updateBorders: { range: { sheetId: sid, startRowIndex: kI, endRowIndex: kI + 1,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 2 },
                top: SOLID, bottom: SOLID_MEDIUM, left: SOLID,
                right: (kaigoIdx + 1 === newDividerIdx) ? SOLID_MEDIUM : SOLID } },
            // 旧個人計の右ボーダーを修正（前の看護師の結合セル右端）
            ...(oldDividerIdx !== null ? [
              { updateBorders: { range: { sheetId: sid, startRowIndex: kI, endRowIndex: kI + 1,
                  startColumnIndex: oldDividerIdx - 1, endColumnIndex: oldDividerIdx + 1 },
                  right: SOLID } },
            ] : []),
          ];
          await api.spreadsheets.batchUpdate({ spreadsheetId: ssId, requestBody: { requests: totalFmt } });

          // 合計行 数式、個人計行 数式
          await api.spreadsheets.values.batchUpdate({ spreadsheetId: ssId, requestBody: {
            valueInputOption: 'USER_ENTERED', data: [
              { range: `${m}!${kaigoCol}${tRow}`,
                values: [[`=SUM(${kaigoCol}5:${kaigoCol}${dataEnd})`]] },
              { range: `${m}!${iryoCol}${tRow}`,
                values: [[`=SUM(${iryoCol}5:${iryoCol}${dataEnd})`]] },
              { range: `${m}!${kaigoCol}${kRow}`,
                values: [[`=${kaigoCol}${tRow}+${iryoCol}${tRow}`]] },
            ]}});
        }
      }
      for (const s of data.staff)
        if (s.type !== 'nurse') s.col = idxToCol(colToIdx(s.col) + 2);

      newEntry = { id: loginId, name,
        furigana_family: furigana_family || '', furigana_given: furigana_given || '',
        type: 'nurse', kaigo_col: kaigoCol, iryo_col: iryoCol,
        seq: nextSeq, initial_pw: initialPw,
        hire_date: hire_date || null,
        oncall: oncall || '無',
        password_hash: await bcrypt.hash(initialPw, 10) };

    } else {
      // C(index 2) + 看護師人数 × 2列 + リハビリ人数 = 新リハビリの列
      const nurseCount = data.staff.filter(s => s.type === 'nurse' && !s.archived).length;
      const rehabCount = data.staff.filter(s => s.type !== 'nurse' && !s.archived).length;
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
        hire_date: hire_date || null,
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
      // 削除前の太線位置（最終看護師iryo列）
      const activeNursesBeforeDel = data.staff.filter(s => s.type === 'nurse' && !s.archived);
      const oldDividerIdx = activeNursesBeforeDel.length > 0
        ? Math.max(...activeNursesBeforeDel.map(s => colToIdx(s.iryo_col))) : null;

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
      // 削除後の太線位置を計算して更新
      const activeNursesAfterDel = data.staff.filter(s => s.type === 'nurse' && !s.archived);
      const newDividerIdx = activeNursesAfterDel.length > 0
        ? Math.max(...activeNursesAfterDel.map(s => colToIdx(s.iryo_col))) : null;
      const SOLID        = { style: 'SOLID',       color: { red:0, green:0, blue:0 } };
      const SOLID_MEDIUM = { style: 'SOLID_MEDIUM', color: { red:0, green:0, blue:0 } };
      for (const ssId of allSids) {
        const ss = await api.spreadsheets.get({ spreadsheetId: ssId });
        const sm = {};
        for (const s of ss.data.sheets) sm[s.properties.title] = s.properties.sheetId;
        const vm = MONTHS.filter(m => sm[m] !== undefined);
        const borderReqs = vm.flatMap(m => {
          const sid = sm[m];
          return [
            // 旧太線を解除（列削除後の新インデックスで）
            ...(oldDividerIdx !== null ? [
              { updateBorders: { range: { sheetId: sid, startRowIndex: 1, endRowIndex: 36,
                  startColumnIndex: oldDividerIdx - 2, endColumnIndex: oldDividerIdx - 1 },
                  right: SOLID } },
              { updateBorders: { range: { sheetId: sid, startRowIndex: 1, endRowIndex: 36,
                  startColumnIndex: oldDividerIdx - 1, endColumnIndex: oldDividerIdx },
                  left: SOLID } },
            ] : []),
            // 新太線を設定
            ...(newDividerIdx !== null ? [
              { updateBorders: { range: { sheetId: sid, startRowIndex: 1, endRowIndex: 36,
                  startColumnIndex: newDividerIdx, endColumnIndex: newDividerIdx + 1 },
                  right: SOLID_MEDIUM } },
              { updateBorders: { range: { sheetId: sid, startRowIndex: 1, endRowIndex: 36,
                  startColumnIndex: newDividerIdx + 1, endColumnIndex: newDividerIdx + 2 },
                  left: SOLID_MEDIUM } },
            ] : []),
          ];
        });
        if (borderReqs.length > 0)
          await api.spreadsheets.batchUpdate({ spreadsheetId: ssId, requestBody: { requests: borderReqs } });
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

// ─── API: 一時修正 – 列ズレ修正 v2（森部・佐原バグ対応） ─────────
// 正規エントリ(moribe10/sahara11)の列を確定し、重複エントリを削除する
app.post('/api/admin/fix-staff-columns', requireAdmin, (req, res) => {
  try {
    const data = loadStaff();
    const changes = [];

    // PT の列を修正（既に正しい場合はスキップ）
    const ptFixes = { nakashima05: 'O', ozawa06: 'P', ooe07: 'Q' };
    for (const s of data.staff) {
      if (ptFixes[s.id] && s.col !== ptFixes[s.id]) {
        changes.push(`${s.name}: col ${s.col}→${ptFixes[s.id]}`);
        s.col = ptFixes[s.id];
      }
    }

    // 正規の森部・佐原エントリの列を確定（IDで特定）
    const nurseFixes = {
      moribe10: { kaigo_col: 'K', iryo_col: 'L' },
      sahara11: { kaigo_col: 'M', iryo_col: 'N' },
    };
    for (const s of data.staff) {
      if (nurseFixes[s.id]) {
        const fix = nurseFixes[s.id];
        if (s.kaigo_col !== fix.kaigo_col) {
          changes.push(`${s.name}(${s.id}): kaigo_col ${s.kaigo_col}→${fix.kaigo_col}`);
          s.kaigo_col = fix.kaigo_col;
          s.iryo_col  = fix.iryo_col;
        }
      }
    }

    // 重複エントリ（morobe08/sahara09）をスタッフリストから削除（スプレッドシートは触らない）
    const duplicateIds = ['morobe08', 'sahara09'];
    const before = data.staff.length;
    data.staff = data.staff.filter(s => !duplicateIds.includes(s.id));
    const removed = before - data.staff.length;
    if (removed > 0) changes.push(`重複エントリ削除: ${duplicateIds.join(', ')} (${removed}件)`);

    saveStaff(data);
    res.json({ success: true, changes, staff: data.staff });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
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

// ─── API: Excel集計（visitCntDetail） ────────────────────────────
app.post('/api/admin/analyze-excel', requireAdmin, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'ファイルが必要です' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const results = [];

    // Load registered (non-archived) staff for filtering
    const staffData = JSON.parse(fs.readFileSync(STAFF_PATH, 'utf8'));
    const registeredNames = staffData.staff
      .filter(s => !s.archived)
      .map(s => s.name.replace(/\s+/g, ''));

    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      // Fix !ref: the exported Excel often has truncated range
      let maxR = 0, maxC = 0;
      for (const key of Object.keys(ws)) {
        if (key[0] === '!') continue;
        const cell = XLSX.utils.decode_cell(key);
        if (cell.r > maxR) maxR = cell.r;
        if (cell.c > maxC) maxC = cell.c;
      }
      if (maxR > 0) ws['!ref'] = 'A1:' + XLSX.utils.encode_cell({ r: maxR, c: maxC });
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
      if (rows.length < 6) continue;

      // Row 1 (index 1): name and qualification
      const nameQual = String(rows[1]?.[0] || '');
      const qualMatch = nameQual.match(/[（(](看護師|PT|OT|ST)[）)]/);
      if (!qualMatch) continue;

      const staffName = nameQual.replace(/[（(](看護師|PT|OT|ST)[）)]/, '').trim();

      // Only include registered (full-time) staff
      const normalized = staffName.replace(/\s+/g, '');
      if (!registeredNames.includes(normalized)) continue;
      const qualification = qualMatch[1];
      const isNurse = qualification === '看護師';

      // Header row at index 5, data starts at index 6
      const headerRow = rows[5];
      if (!headerRow) continue;
      // Find column indices
      let colTime = -1, colInsurance = -1;
      for (let c = 0; c < headerRow.length; c++) {
        const h = String(headerRow[c] || '');
        if (h === '提供時間' && colTime < 0) colTime = c;
        if (h === '保険適用') colInsurance = c;
      }
      if (colTime < 0 || colInsurance < 0) continue;

      let totalMinutes = 0;      // for nurses
      let totalUnits = 0;        // for rehab
      let visitCount = 0;
      const visits = [];

      for (let r = 6; r < rows.length; r++) {
        const row = rows[r];
        if (!row || row[colTime] == null) continue;
        // Skip summary/total rows
        const firstCell = String(row[0] || '');
        if (firstCell === '合計' || firstCell === '小計') continue;
        const rawMin = parseInt(row[colTime], 10);
        if (isNaN(rawMin) || rawMin <= 0) continue;
        const insurance = String(row[colInsurance] || '');
        visitCount++;

        if (isNurse) {
          // Round: 29→30, 59→60, 89→90
          let rounded = rawMin;
          if (rawMin >= 25 && rawMin <= 34) rounded = 30;
          else if (rawMin >= 55 && rawMin <= 64) rounded = 60;
          else if (rawMin >= 85 && rawMin <= 94) rounded = 90;
          totalMinutes += rounded;
          visits.push({ raw: rawMin, rounded, insurance });
        } else {
          // Rehab: medical=4 units, kaigo=minutes/10
          let units = 0;
          if (insurance === '医療') {
            units = 4;
          } else {
            units = Math.round(rawMin / 10);
          }
          totalUnits += units;
          visits.push({ raw: rawMin, units, insurance });
        }
      }

      const entry = {
        sheetName,
        staffName,
        qualification,
        isNurse,
        visitCount,
      };
      if (isNurse) {
        entry.totalMinutes = totalMinutes;
        entry.totalHours = Math.round(totalMinutes / 60 * 10) / 10;
      } else {
        entry.totalUnits = totalUnits;
      }
      results.push(entry);
    }

    // Sort: nurses first, then rehab
    results.sort((a, b) => {
      if (a.isNurse !== b.isNurse) return a.isNurse ? -1 : 1;
      return 0;
    });

    // Auto-save results
    const ym = req.body.yearMonth || (() => {
      const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
      return `${jst.getFullYear()}-${String(jst.getMonth()+1).padStart(2,'0')}`;
    })();
    const allResults = loadExcelResults();
    allResults[ym] = {
      analyzedAt: new Date().toISOString(),
      fileName: req.file.originalname || '',
      results,
    };
    saveExcelResults(allResults);

    res.json({ success: true, results, savedYearMonth: ym });
  } catch (e) {
    console.error('Excel analyze error:', e);
    res.status(500).json({ error: 'Excel解析に失敗しました: ' + e.message });
  }
});

// ─── API: Excel集計履歴 ──────────────────────────────────────
app.get('/api/admin/excel-results', requireAdmin, (_req, res) => {
  const data = loadExcelResults();
  const periods = Object.keys(data).sort().reverse().map(ym => ({
    yearMonth: ym,
    analyzedAt: data[ym].analyzedAt,
    fileName: data[ym].fileName,
  }));
  res.json(periods);
});

app.get('/api/admin/excel-results/:yearMonth', requireAdmin, (req, res) => {
  const data = loadExcelResults();
  const entry = data[req.params.yearMonth];
  if (!entry) return res.status(404).json({ error: '該当期間のデータがありません' });
  res.json(entry);
});

// ─── API: お知らせ（スタッフ向け） ─────────────────────────────
app.get('/api/notices', requireStaff, (_req, res) => {
  const { notices, readStatus } = loadNotices();
  const staffId = _req.session.staffId;
  const readIds = readStatus[staffId] || [];
  const list = notices
    .map(n => ({ ...n, isRead: readIds.includes(n.id) }))
    .sort((a, b) => (b.createdAt || b.date || '').localeCompare(a.createdAt || a.date || ''));
  res.json({ notices: list });
});

app.get('/api/notices/unread-count', requireStaff, (req, res) => {
  const { notices, readStatus } = loadNotices();
  const readIds = readStatus[req.session.staffId] || [];
  const count = notices.filter(n => !readIds.includes(n.id)).length;
  res.json({ count });
});

app.post('/api/notices/:id/read', requireStaff, (req, res) => {
  const data = loadNotices();
  const staffId = req.session.staffId;
  if (!data.readStatus[staffId]) data.readStatus[staffId] = [];
  if (!data.readStatus[staffId].includes(req.params.id)) {
    data.readStatus[staffId].push(req.params.id);
    saveNotices(data);
  }
  res.json({ ok: true });
});

// ─── API: オンコール（スタッフ向け） ─────────────────────────────
app.get('/api/oncall/records', requireStaff, (req, res) => {
  const month = req.query.month;
  const data = loadOncall();
  let records = data.records.filter(r => r.staffId === req.session.staffId);
  if (month) records = records.filter(r => r.date.startsWith(month));
  records.sort((a, b) => a.date.localeCompare(b.date));
  res.json({ records });
});

app.post('/api/oncall/records', requireStaff, (req, res) => {
  const { date, count, totalHours, transportCount } = req.body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: '日付が不正です' });
  const c = Number(count) || 0;
  const th = Number(totalHours) || 0;
  const tc = Number(transportCount) || 0;
  if (c < 0 || c > 10 || th < 0 || th > 10 || tc < 0 || tc > 10)
    return res.status(400).json({ error: '値が範囲外です' });
  const totalMinutes = Math.round(th * 60);

  const data = loadOncall();
  const existing = data.records.find(r => r.staffId === req.session.staffId && r.date === date);
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString();

  if (existing) {
    existing.count = c;
    existing.totalMinutes = totalMinutes;
    existing.transportCount = tc;
    existing.updatedAt = now;
  } else {
    data.records.push({
      id: `${req.session.staffId}-${date}-${Date.now()}`,
      staffId: req.session.staffId,
      date,
      count: c,
      totalMinutes,
      transportCount: tc,
      createdAt: now,
      updatedAt: now,
    });
  }
  saveOncall(data);
  res.json({ ok: true });
});

app.delete('/api/oncall/records/:id', requireStaff, (req, res) => {
  const data = loadOncall();
  const idx = data.records.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'レコードが見つかりません' });
  if (data.records[idx].staffId !== req.session.staffId)
    return res.status(403).json({ error: '自分のレコードのみ削除できます' });
  data.records.splice(idx, 1);
  saveOncall(data);
  res.json({ ok: true });
});

app.get('/api/oncall/monthly-summary', requireStaff, (req, res) => {
  const month = req.query.month;
  if (!month) return res.status(400).json({ error: 'month パラメータが必要です' });
  const data = loadOncall();
  const records = data.records.filter(r => r.staffId === req.session.staffId && r.date.startsWith(month));
  const summary = {
    totalCount: records.reduce((s, r) => s + (r.count || 0), 0),
    totalMinutes: records.reduce((s, r) => s + (r.totalMinutes || 0), 0),
    totalTransportCount: records.reduce((s, r) => s + (r.transportCount || 0), 0),
    recordDays: records.length,
  };
  res.json({ summary });
});

// ─── API: オンコール（管理者向け） ───────────────────────────────
app.get('/api/admin/oncall/summary', requireAdmin, (req, res) => {
  const month = req.query.month;
  if (!month) return res.status(400).json({ error: 'month パラメータが必要です' });
  const staffData = loadStaff();
  const oncallData = loadOncall();
  const summary = staffData.staff
    .filter(s => !s.archived && s.oncall_eligible)
    .map(s => {
      const records = oncallData.records.filter(r => r.staffId === s.id && r.date.startsWith(month));
      return {
        staffId: s.id, name: s.name, type: s.type,
        totalCount: records.reduce((sum, r) => sum + (r.count || 0), 0),
        totalMinutes: records.reduce((sum, r) => sum + (r.totalMinutes || 0), 0),
        totalTransportCount: records.reduce((sum, r) => sum + (r.transportCount || 0), 0),
        recordDays: records.length,
      };
    });
  res.json({ summary });
});

app.get('/api/admin/oncall/records', requireAdmin, (req, res) => {
  const { month, staffId } = req.query;
  const data = loadOncall();
  let records = data.records;
  if (month) records = records.filter(r => r.date.startsWith(month));
  if (staffId) records = records.filter(r => r.staffId === staffId);
  records.sort((a, b) => a.date.localeCompare(b.date));
  res.json({ records });
});

app.post('/api/admin/staff/:id/oncall', requireAdmin, (req, res) => {
  const data = loadStaff();
  const staff = data.staff.find(s => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });
  if (staff.type !== 'nurse') return res.status(400).json({ error: '看護師のみオンコール設定可能です' });
  staff.oncall_eligible = !!req.body.eligible;
  saveStaff(data);
  res.json({ ok: true, oncall_eligible: staff.oncall_eligible });
});

// ─── API: 有給休暇（管理者向け） ───────────────────────────────
app.get('/api/admin/leave/requests', requireAdmin, (req, res) => {
  const leaveData = loadLeave();
  let requests = leaveData.requests;
  if (req.query.status) {
    requests = requests.filter(r => r.status === req.query.status);
  }
  requests.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({ requests });
});

app.post('/api/admin/leave/requests/:id/approve', requireAdmin, (req, res) => {
  const leaveData = loadLeave();
  const request = leaveData.requests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: '申請が見つかりません' });
  if (request.status !== 'pending')
    return res.status(400).json({ error: '承認待ちの申請のみ承認できます' });

  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === request.staffId);
  if (staff) {
    const balance = calcLeaveBalance(staff);
    const requestDays = (request.type === 'half_am' || request.type === 'half_pm')
      ? request.dates.length * 0.5 : request.dates.length;
    if (balance < requestDays)
      return res.status(400).json({ error: '残日数が不足しています' });
  }

  request.status = 'approved';
  request.adminComment = req.body.comment || null;
  request.reviewedAt = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString();
  saveLeave(leaveData);
  res.json({ ok: true });
});

app.post('/api/admin/leave/requests/:id/reject', requireAdmin, (req, res) => {
  const leaveData = loadLeave();
  const request = leaveData.requests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: '申請が見つかりません' });
  if (request.status !== 'pending')
    return res.status(400).json({ error: '承認待ちの申請のみ却下できます' });

  request.status = 'rejected';
  request.adminComment = req.body.comment || null;
  request.reviewedAt = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString();
  saveLeave(leaveData);
  res.json({ ok: true });
});

app.get('/api/admin/leave/summary', requireAdmin, (_req, res) => {
  const staffData = loadStaff();
  const leaveData = loadLeave();
  const summary = staffData.staff
    .filter(s => !s.archived)
    .map(s => {
      const approved = leaveData.requests.filter(r =>
        r.staffId === s.id && r.status === 'approved'
      );
      let usedDays = 0;
      for (const r of approved) {
        const per = (r.type === 'half_am' || r.type === 'half_pm') ? 0.5 : 1;
        usedDays += r.dates.length * per;
      }
      const pending = leaveData.requests.filter(r =>
        r.staffId === s.id && r.status === 'pending'
      );
      let pendingDays = 0;
      for (const r of pending) {
        const per = (r.type === 'half_am' || r.type === 'half_pm') ? 0.5 : 1;
        pendingDays += r.dates.length * per;
      }
      const granted     = s.leave_granted || 0;
      const carriedOver = s.leave_carried_over || 0;
      const manualAdj   = s.leave_manual_adjustment || 0;
      const balance     = granted + carriedOver + manualAdj - usedDays;
      return {
        id: s.id,
        name: s.name,
        type: s.type,
        hire_date: s.hire_date,
        auto_grant_days: calcLeaveGrantDays(s.hire_date),
        granted,
        carried_over: carriedOver,
        manual_adjustment: manualAdj,
        used: usedDays,
        pending: pendingDays,
        balance,
        grant_date: s.leave_grant_date,
      };
    });
  res.json({ summary });
});

app.post('/api/admin/staff/:id/leave-balance', requireAdmin, (req, res) => {
  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  const { granted, carried_over, manual_adjustment, grant_date } = req.body;
  if (granted !== undefined)          staff.leave_granted = Number(granted);
  if (carried_over !== undefined)     staff.leave_carried_over = Number(carried_over);
  if (manual_adjustment !== undefined) staff.leave_manual_adjustment = Number(manual_adjustment);
  if (grant_date !== undefined)       staff.leave_grant_date = grant_date;

  saveStaff(staffData);
  res.json({ ok: true, balance: calcLeaveBalance(staff) });
});

app.post('/api/admin/staff/:id/hire-date', requireAdmin, (req, res) => {
  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  const { hire_date, auto_apply } = req.body;
  staff.hire_date = hire_date || null;
  if (auto_apply && hire_date) {
    const autoGrant = calcLeaveGrantDays(hire_date);
    staff.leave_granted = autoGrant;
    staff.leave_grant_date = getTodayJST();
  }
  saveStaff(staffData);
  res.json({ ok: true, auto_grant_days: calcLeaveGrantDays(hire_date) });
});

// ─── API: お知らせ（管理者向け） ──────────────────────────────
app.get('/api/admin/notices', requireAdmin, (_req, res) => {
  const { notices } = loadNotices();
  const sorted = [...notices].sort((a, b) => (b.createdAt || b.date || '').localeCompare(a.createdAt || a.date || ''));
  res.json({ notices: sorted });
});

app.post('/api/admin/notices', requireAdmin, (req, res) => {
  const { title, body, source } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'タイトルと本文は必須です' });
  const data = loadNotices();
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const noticeSource = (source === 'system') ? 'system' : 'admin';
  const notice = {
    id: noticeSource === 'system' ? 'sys-' + Date.now() : String(Date.now()),
    date: now.toISOString().slice(0, 10),
    title,
    body,
    source: noticeSource,
    createdAt: now.toISOString()
  };
  data.notices.push(notice);
  saveNotices(data);
  res.json({ ok: true, notice });
});

app.patch('/api/admin/notices/:id', requireAdmin, (req, res) => {
  const data = loadNotices();
  const notice = data.notices.find(n => n.id === req.params.id);
  if (!notice) return res.status(404).json({ error: 'お知らせが見つかりません' });
  if (req.body.title) notice.title = req.body.title;
  if (req.body.body) notice.body = req.body.body;
  saveNotices(data);
  res.json({ ok: true, notice });
});

app.delete('/api/admin/notices/:id', requireAdmin, (req, res) => {
  const data = loadNotices();
  const idx = data.notices.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'お知らせが見つかりません' });
  data.notices.splice(idx, 1);
  // readStatus からも削除
  for (const staffId in data.readStatus) {
    data.readStatus[staffId] = data.readStatus[staffId].filter(id => id !== req.params.id);
  }
  saveNotices(data);
  res.json({ ok: true });
});

// ─── 運営お知らせ自動発信 ────────────────────────────────────────
function createSystemNotice(title, body) {
  const data = loadNotices();
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const notice = {
    id: 'sys-' + Date.now(),
    date: now.toISOString().slice(0, 10),
    title,
    body,
    source: 'system',
    createdAt: now.toISOString()
  };
  data.notices.push(notice);
  saveNotices(data);
  console.log(`[system] 運営お知らせ作成: ${title}`);
  return notice;
}

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
  // notices.json も同様
  if (!fs.existsSync(NOTICES_PATH)) {
    const src = path.join(__dirname, 'notices.json');
    if (fs.existsSync(src)) fs.copyFileSync(src, NOTICES_PATH);
    else fs.writeFileSync(NOTICES_PATH, JSON.stringify({ notices: [], readStatus: {} }, null, 2));
  }
  // leave-requests.json
  if (!fs.existsSync(LEAVE_PATH)) {
    fs.writeFileSync(LEAVE_PATH, JSON.stringify({ requests: [] }, null, 2));
  }
  // oncall-records.json
  if (!fs.existsSync(ONCALL_PATH)) {
    fs.writeFileSync(ONCALL_PATH, JSON.stringify({ records: [] }, null, 2));
  }
}

async function main() {
  await ensureDataDir();
  await ensurePasswordsHashed();
  ensureLeaveFields();
  await syncNewStaffFromSource();

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

  // 毎月16日 8:00 に修正可能期間のお知らせを自動発信
  cron.schedule('0 8 16 * *', () => {
    const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const m = now.getMonth() + 1;
    const y = now.getFullYear();
    createSystemNotice(
      `修正可能期間のお知らせ（${m}月）`,
      `${y}年${m}月の修正可能期間は ${m}月16日〜${m}月20日 です。\n\n締日（${m}月15日）以前のデータに修正がある方は、この期間内に修正をお願いします。\n20日を過ぎると修正できなくなりますのでご注意ください。`
    );
  });
  console.log('📢 運営お知らせスケジュール: 毎月16日 8:00 に修正可能期間を自動通知');

  app.listen(PORT, () => console.log(`✅ Server → http://localhost:${PORT}`));
}
main().catch(e => { console.error(e); process.exit(1); });
