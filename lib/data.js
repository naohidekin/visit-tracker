'use strict';
// データ永続化モジュール（SQLiteバックエンド、API互換を維持）

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { SPREADSHEET_ID, DATA_DIR } = require('./constants');
const { getDb, initDb } = require('./db');

// ─── トランザクション付きload-modify-save ──────────────────────
// load → 変更 → save を単一トランザクション内で実行し、競合状態を防ぐ
function atomicModify(fn) {
  const db = getDb();
  if (db.inTransaction) return fn();
  return db.transaction(fn)();
}

// save関数内部のトランザクション制御ヘルパー
// 既にトランザクション内なら直接実行、そうでなければトランザクションで包む
function _txn(db, ops) {
  if (db.inTransaction) ops();
  else db.transaction(ops)();
}

// ─── スプレッドシートレジストリ（年 → ID） ─────────────────────
function loadRegistry() {
  const db = getDb();
  const rows = db.prepare('SELECT year, spreadsheet_id FROM spreadsheet_registry').all();
  if (rows.length === 0) {
    const year = String(new Date().getFullYear());
    const reg = { [year]: SPREADSHEET_ID };
    db.prepare('INSERT OR IGNORE INTO spreadsheet_registry (year, spreadsheet_id) VALUES (?, ?)').run(year, SPREADSHEET_ID);
    return reg;
  }
  const reg = {};
  for (const r of rows) reg[r.year] = r.spreadsheet_id;
  return reg;
}

function saveRegistry(reg) {
  const db = getDb();
  _txn(db, () => {
    db.prepare('DELETE FROM spreadsheet_registry').run();
    const ins = db.prepare('INSERT INTO spreadsheet_registry (year, spreadsheet_id) VALUES (?, ?)');
    for (const [year, id] of Object.entries(reg)) ins.run(year, id);
  });
}

function getSpreadsheetIdForYear(year) {
  const reg = loadRegistry();
  return reg[String(year)] || SPREADSHEET_ID;
}

// ─── スタッフ ───────────────────────────────────────────────────
function loadStaff() {
  const db = getDb();
  const rows = db.prepare('SELECT data FROM staff ORDER BY id').all();
  const staff = rows.map(r => JSON.parse(r.data));
  const meta = db.prepare("SELECT value FROM settings WHERE key = 'incentive_defaults'").get();
  const incentive_defaults = meta ? JSON.parse(meta.value) : { nurse: 3.5, rehab: 20 };
  return { incentive_defaults, staff };
}

function saveStaff(data) {
  const db = getDb();
  _txn(db, () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('incentive_defaults', ?)").run(
      JSON.stringify(data.incentive_defaults || {})
    );
    db.prepare('DELETE FROM staff').run();
    const ins = db.prepare('INSERT INTO staff (id, data) VALUES (?, ?)');
    for (const s of data.staff) ins.run(s.id, JSON.stringify(s));
  });
}

// ─── スケジュール ───────────────────────────────────────────────
function loadSchedules() {
  const db = getDb();
  const rows = db.prepare('SELECT data FROM schedules').all();
  return { schedules: rows.map(r => JSON.parse(r.data)) };
}

function saveSchedules(data) {
  const db = getDb();
  _txn(db, () => {
    db.prepare('DELETE FROM schedules').run();
    const ins = db.prepare('INSERT INTO schedules (id, data) VALUES (?, ?)');
    for (const s of (data.schedules || [])) ins.run(s.id, JSON.stringify(s));
  });
}

// ─── お知らせ ───────────────────────────────────────────────────
function loadNotices() {
  const db = getDb();
  const noticeRows = db.prepare('SELECT data FROM notices').all();
  const notices = noticeRows.map(r => JSON.parse(r.data));

  const readRows = db.prepare('SELECT staff_id, notice_id FROM notice_read_status').all();
  const readStatus = {};
  for (const r of readRows) {
    if (!readStatus[r.staff_id]) readStatus[r.staff_id] = [];
    readStatus[r.staff_id].push(r.notice_id);
  }
  return { notices, readStatus };
}

function saveNotices(data) {
  const db = getDb();
  _txn(db, () => {
    db.prepare('DELETE FROM notices').run();
    db.prepare('DELETE FROM notice_read_status').run();
    const insN = db.prepare('INSERT INTO notices (id, data) VALUES (?, ?)');
    for (const n of (data.notices || [])) insN.run(n.id, JSON.stringify(n));
    const insR = db.prepare('INSERT INTO notice_read_status (staff_id, notice_id) VALUES (?, ?)');
    for (const [staffId, noticeIds] of Object.entries(data.readStatus || {})) {
      for (const nid of (Array.isArray(noticeIds) ? noticeIds : [])) insR.run(staffId, nid);
    }
  });
}

// ─── 有給休暇 ───────────────────────────────────────────────────
function loadLeave() {
  const db = getDb();
  const rows = db.prepare('SELECT data FROM leave_requests').all();
  return { requests: rows.map(r => JSON.parse(r.data)) };
}

function saveLeave(data) {
  const db = getDb();
  _txn(db, () => {
    db.prepare('DELETE FROM leave_requests').run();
    const ins = db.prepare('INSERT INTO leave_requests (id, data) VALUES (?, ?)');
    for (const r of (data.requests || [])) ins.run(r.id, JSON.stringify(r));
  });
}

// ─── 当番記録 ───────────────────────────────────────────────────
function loadOncall() {
  const db = getDb();
  const rows = db.prepare('SELECT data FROM oncall_records').all();
  return { records: rows.map(r => JSON.parse(r.data)) };
}

function saveOncall(data) {
  const db = getDb();
  _txn(db, () => {
    db.prepare('DELETE FROM oncall_records').run();
    const ins = db.prepare('INSERT INTO oncall_records (id, data) VALUES (?, ?)');
    for (const r of (data.records || [])) ins.run(r.id, JSON.stringify(r));
  });
}

// ─── 待機記録 ───────────────────────────────────────────────────
function loadStandby() {
  const db = getDb();
  const recordRows = db.prepare('SELECT date, staff_id, fee, category FROM standby_records').all();
  const records = recordRows.map(r => ({ date: r.date, staffId: r.staff_id, fee: r.fee, category: r.category }));

  const holidayRows = db.prepare('SELECT date FROM custom_holidays ORDER BY date').all();
  const customHolidays = holidayRows.map(r => r.date);

  const rainyRows = db.prepare('SELECT date FROM rainy_days ORDER BY date').all();
  const rainyDays = rainyRows.map(r => r.date);

  return { records, customHolidays, rainyDays };
}

function saveStandby(data) {
  const db = getDb();
  _txn(db, () => {
    db.prepare('DELETE FROM standby_records').run();
    db.prepare('DELETE FROM custom_holidays').run();
    db.prepare('DELETE FROM rainy_days').run();
    const insR = db.prepare('INSERT INTO standby_records (date, staff_id, fee, category) VALUES (?, ?, ?, ?)');
    for (const r of (data.records || [])) insR.run(r.date, r.staffId, r.fee, r.category);
    const insH = db.prepare('INSERT INTO custom_holidays (date) VALUES (?)');
    for (const d of (data.customHolidays || [])) insH.run(d);
    const insD = db.prepare('INSERT INTO rainy_days (date) VALUES (?)');
    for (const d of (data.rainyDays || [])) insD.run(d);
  });
}

// ─── 出勤確定 ───────────────────────────────────────────────────
function loadAttendance() {
  const db = getDb();
  const attRows = db.prepare('SELECT date, staff_id, status, source, updated_at FROM attendance').all();
  const records = {};
  for (const r of attRows) {
    if (!records[r.date]) records[r.date] = {};
    records[r.date][r.staff_id] = { status: r.status, source: r.source, updatedAt: r.updated_at };
  }

  const remRows = db.prepare('SELECT date, staff_id, sent_at FROM reminders_sent').all();
  const reminders_sent = {};
  for (const r of remRows) {
    if (!reminders_sent[r.date]) reminders_sent[r.date] = {};
    reminders_sent[r.date][r.staff_id] = r.sent_at;
  }

  return { records, reminders_sent };
}

function saveAttendance(data) {
  const db = getDb();
  _txn(db, () => {
    db.prepare('DELETE FROM attendance').run();
    db.prepare('DELETE FROM reminders_sent').run();
    const insA = db.prepare('INSERT INTO attendance (date, staff_id, status, source, updated_at) VALUES (?, ?, ?, ?, ?)');
    for (const [date, staffMap] of Object.entries(data.records || {})) {
      for (const [staffId, rec] of Object.entries(staffMap)) {
        insA.run(date, staffId, rec.status, rec.source, rec.updatedAt);
      }
    }
    const insR = db.prepare('INSERT INTO reminders_sent (date, staff_id, sent_at) VALUES (?, ?, ?)');
    for (const [date, staffMap] of Object.entries(data.reminders_sent || {})) {
      for (const [staffId, sentAt] of Object.entries(staffMap)) {
        insR.run(date, staffId, sentAt);
      }
    }
  });
}

// ─── Excelインポート結果 ────────────────────────────────────────
function loadExcelResults() {
  const db = getDb();
  const rows = db.prepare('SELECT year_month, data FROM excel_results').all();
  const result = {};
  for (const r of rows) result[r.year_month] = JSON.parse(r.data);
  return result;
}

function saveExcelResults(data) {
  const db = getDb();
  _txn(db, () => {
    db.prepare('DELETE FROM excel_results').run();
    const ins = db.prepare('INSERT INTO excel_results (year_month, data) VALUES (?, ?)');
    for (const [ym, val] of Object.entries(data)) ins.run(ym, JSON.stringify(val));
  });
}

// ─── パスワードリセットトークン ─────────────────────────────────
function loadResetTokens() {
  const db = getDb();
  const rows = db.prepare('SELECT token, staff_id, expires_at, used, created_at FROM reset_tokens').all();
  return {
    tokens: rows.map(r => ({
      staffId: r.staff_id,
      token: r.token,
      expiresAt: r.expires_at,
      used: !!r.used,
      createdAt: r.created_at,
    }))
  };
}

function saveResetTokens(data) {
  const db = getDb();
  _txn(db, () => {
    db.prepare('DELETE FROM reset_tokens').run();
    const ins = db.prepare('INSERT INTO reset_tokens (token, staff_id, expires_at, used, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const t of (data.tokens || [])) {
      ins.run(t.token, t.staffId, t.expiresAt, t.used ? 1 : 0, t.createdAt);
    }
  });
}

function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

function cleanExpiredTokens() {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('DELETE FROM reset_tokens WHERE expires_at < ? OR used = 1').run(now);
}

// ─── WebAuthn資格情報 ───────────────────────────────────────────
function loadWebAuthnData() {
  const db = getDb();
  const rows = db.prepare('SELECT data FROM webauthn_credentials').all();
  return { credentials: rows.map(r => JSON.parse(r.data)) };
}

function saveWebAuthnData(data) {
  const db = getDb();
  _txn(db, () => {
    db.prepare('DELETE FROM webauthn_credentials').run();
    const ins = db.prepare('INSERT INTO webauthn_credentials (credential_id, staff_id, data) VALUES (?, ?, ?)');
    for (const c of (data.credentials || [])) ins.run(c.credentialID, c.staffId, JSON.stringify(c));
  });
}

// ─── DATA_DIR 初期化 + DB初期化 ─────────────────────────────────
async function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  initDb();
}

module.exports = {
  atomicModify,
  loadRegistry,
  saveRegistry,
  getSpreadsheetIdForYear,
  loadStaff,
  saveStaff,
  loadSchedules,
  saveSchedules,
  loadNotices,
  saveNotices,
  loadLeave,
  saveLeave,
  loadOncall,
  saveOncall,
  loadStandby,
  saveStandby,
  loadAttendance,
  saveAttendance,
  loadExcelResults,
  saveExcelResults,
  loadResetTokens,
  saveResetTokens,
  generateResetToken,
  cleanExpiredTokens,
  loadWebAuthnData,
  saveWebAuthnData,
  ensureDataDir,
};
