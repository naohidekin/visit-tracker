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
    const years = Object.keys(reg);
    if (years.length > 0) {
      db.prepare(`DELETE FROM spreadsheet_registry WHERE year NOT IN (${years.map(() => '?').join(',')})`).run(...years);
    } else {
      db.prepare('DELETE FROM spreadsheet_registry').run();
    }
    const upsert = db.prepare('INSERT OR REPLACE INTO spreadsheet_registry (year, spreadsheet_id) VALUES (?, ?)');
    for (const [year, id] of Object.entries(reg)) upsert.run(year, id);
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
    const ids = data.staff.map(s => s.id);
    if (ids.length > 0) {
      db.prepare(`DELETE FROM staff WHERE id NOT IN (${ids.map(() => '?').join(',')})`).run(...ids);
    } else {
      db.prepare('DELETE FROM staff').run();
    }
    const upsert = db.prepare('INSERT OR REPLACE INTO staff (id, data) VALUES (?, ?)');
    for (const s of data.staff) upsert.run(s.id, JSON.stringify(s));
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
    const ids = (data.schedules || []).map(s => s.id);
    if (ids.length > 0) {
      db.prepare(`DELETE FROM schedules WHERE id NOT IN (${ids.map(() => '?').join(',')})`).run(...ids);
    } else {
      db.prepare('DELETE FROM schedules').run();
    }
    const upsert = db.prepare('INSERT OR REPLACE INTO schedules (id, data) VALUES (?, ?)');
    for (const s of (data.schedules || [])) upsert.run(s.id, JSON.stringify(s));
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
    const noticeIds = (data.notices || []).map(n => n.id);
    if (noticeIds.length > 0) {
      db.prepare(`DELETE FROM notices WHERE id NOT IN (${noticeIds.map(() => '?').join(',')})`).run(...noticeIds);
      db.prepare(`DELETE FROM notice_read_status WHERE notice_id NOT IN (${noticeIds.map(() => '?').join(',')})`).run(...noticeIds);
    } else {
      db.prepare('DELETE FROM notices').run();
      db.prepare('DELETE FROM notice_read_status').run();
    }
    const upsertN = db.prepare('INSERT OR REPLACE INTO notices (id, data) VALUES (?, ?)');
    for (const n of (data.notices || [])) upsertN.run(n.id, JSON.stringify(n));
    const upsertR = db.prepare('INSERT OR IGNORE INTO notice_read_status (staff_id, notice_id) VALUES (?, ?)');
    for (const [staffId, noticeIds] of Object.entries(data.readStatus || {})) {
      for (const nid of (Array.isArray(noticeIds) ? noticeIds : [])) upsertR.run(staffId, nid);
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
    const ids = (data.requests || []).map(r => r.id);
    if (ids.length > 0) {
      db.prepare(`DELETE FROM leave_requests WHERE id NOT IN (${ids.map(() => '?').join(',')})`).run(...ids);
    } else {
      db.prepare('DELETE FROM leave_requests').run();
    }
    const upsert = db.prepare('INSERT OR REPLACE INTO leave_requests (id, data) VALUES (?, ?)');
    for (const r of (data.requests || [])) upsert.run(r.id, JSON.stringify(r));
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
    const ids = (data.records || []).map(r => r.id);
    if (ids.length > 0) {
      db.prepare(`DELETE FROM oncall_records WHERE id NOT IN (${ids.map(() => '?').join(',')})`).run(...ids);
    } else {
      db.prepare('DELETE FROM oncall_records').run();
    }
    const upsert = db.prepare('INSERT OR REPLACE INTO oncall_records (id, data) VALUES (?, ?)');
    for (const r of (data.records || [])) upsert.run(r.id, JSON.stringify(r));
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
    const recDates = (data.records || []).map(r => r.date);
    if (recDates.length > 0) {
      db.prepare(`DELETE FROM standby_records WHERE date NOT IN (${recDates.map(() => '?').join(',')})`).run(...recDates);
    } else {
      db.prepare('DELETE FROM standby_records').run();
    }
    const holDates = data.customHolidays || [];
    if (holDates.length > 0) {
      db.prepare(`DELETE FROM custom_holidays WHERE date NOT IN (${holDates.map(() => '?').join(',')})`).run(...holDates);
    } else {
      db.prepare('DELETE FROM custom_holidays').run();
    }
    const rainyDates = data.rainyDays || [];
    if (rainyDates.length > 0) {
      db.prepare(`DELETE FROM rainy_days WHERE date NOT IN (${rainyDates.map(() => '?').join(',')})`).run(...rainyDates);
    } else {
      db.prepare('DELETE FROM rainy_days').run();
    }
    const upsertR = db.prepare('INSERT OR REPLACE INTO standby_records (date, staff_id, fee, category) VALUES (?, ?, ?, ?)');
    for (const r of (data.records || [])) upsertR.run(r.date, r.staffId, r.fee, r.category);
    const upsertH = db.prepare('INSERT OR REPLACE INTO custom_holidays (date) VALUES (?)');
    for (const d of holDates) upsertH.run(d);
    const upsertD = db.prepare('INSERT OR REPLACE INTO rainy_days (date) VALUES (?)');
    for (const d of rainyDates) upsertD.run(d);
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
    // attendance: 複合PK (date, staff_id)
    const attKeys = [];
    for (const [date, staffMap] of Object.entries(data.records || {})) {
      for (const staffId of Object.keys(staffMap)) attKeys.push(date, staffId);
    }
    if (attKeys.length > 0) {
      const pairs = [];
      for (let i = 0; i < attKeys.length; i += 2) pairs.push('(?,?)');
      db.prepare(`DELETE FROM attendance WHERE (date, staff_id) NOT IN (VALUES ${pairs.join(',')})`).run(...attKeys);
    } else {
      db.prepare('DELETE FROM attendance').run();
    }
    const upsertA = db.prepare('INSERT OR REPLACE INTO attendance (date, staff_id, status, source, updated_at) VALUES (?, ?, ?, ?, ?)');
    for (const [date, staffMap] of Object.entries(data.records || {})) {
      for (const [staffId, rec] of Object.entries(staffMap)) {
        upsertA.run(date, staffId, rec.status, rec.source, rec.updatedAt);
      }
    }
    // reminders_sent: 複合PK (date, staff_id)
    const remKeys = [];
    for (const [date, staffMap] of Object.entries(data.reminders_sent || {})) {
      for (const staffId of Object.keys(staffMap)) remKeys.push(date, staffId);
    }
    if (remKeys.length > 0) {
      const pairs = [];
      for (let i = 0; i < remKeys.length; i += 2) pairs.push('(?,?)');
      db.prepare(`DELETE FROM reminders_sent WHERE (date, staff_id) NOT IN (VALUES ${pairs.join(',')})`).run(...remKeys);
    } else {
      db.prepare('DELETE FROM reminders_sent').run();
    }
    const upsertR = db.prepare('INSERT OR REPLACE INTO reminders_sent (date, staff_id, sent_at) VALUES (?, ?, ?)');
    for (const [date, staffMap] of Object.entries(data.reminders_sent || {})) {
      for (const [staffId, sentAt] of Object.entries(staffMap)) {
        upsertR.run(date, staffId, sentAt);
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
    const yms = Object.keys(data);
    if (yms.length > 0) {
      db.prepare(`DELETE FROM excel_results WHERE year_month NOT IN (${yms.map(() => '?').join(',')})`).run(...yms);
    } else {
      db.prepare('DELETE FROM excel_results').run();
    }
    const upsert = db.prepare('INSERT OR REPLACE INTO excel_results (year_month, data) VALUES (?, ?)');
    for (const [ym, val] of Object.entries(data)) upsert.run(ym, JSON.stringify(val));
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
    const tokens = (data.tokens || []).map(t => t.token);
    if (tokens.length > 0) {
      db.prepare(`DELETE FROM reset_tokens WHERE token NOT IN (${tokens.map(() => '?').join(',')})`).run(...tokens);
    } else {
      db.prepare('DELETE FROM reset_tokens').run();
    }
    const upsert = db.prepare('INSERT OR REPLACE INTO reset_tokens (token, staff_id, expires_at, used, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const t of (data.tokens || [])) {
      upsert.run(t.token, t.staffId, t.expiresAt, t.used ? 1 : 0, t.createdAt);
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
    const credIds = (data.credentials || []).map(c => c.credentialID);
    if (credIds.length > 0) {
      db.prepare(`DELETE FROM webauthn_credentials WHERE credential_id NOT IN (${credIds.map(() => '?').join(',')})`).run(...credIds);
    } else {
      db.prepare('DELETE FROM webauthn_credentials').run();
    }
    const upsert = db.prepare('INSERT OR REPLACE INTO webauthn_credentials (credential_id, staff_id, data) VALUES (?, ?, ?)');
    for (const c of (data.credentials || [])) upsert.run(c.credentialID, c.staffId, JSON.stringify(c));
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
