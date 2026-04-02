'use strict';
// データ永続化モジュール（JSONファイルの読み書き全般）

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const writeFileAtomicSync = require('write-file-atomic').sync;
const {
  SPREADSHEET_ID, DATA_DIR,
  STAFF_PATH, REGISTRY_PATH, SCHEDULES_PATH, NOTICES_PATH,
  EXCEL_RESULTS_PATH, LEAVE_PATH, ONCALL_PATH, AUDIT_LOG_PATH,
  RESET_TOKENS_PATH, STANDBY_PATH, ATTENDANCE_PATH, WEBAUTHN_FILE,
} = require('./constants');

// ─── スプレッドシートレジストリ（年 → ID） ─────────────────────
function loadRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    const year = String(new Date().getFullYear());
    const reg  = { [year]: SPREADSHEET_ID };
    writeFileAtomicSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
    return reg;
  }
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

function saveRegistry(reg) {
  writeFileAtomicSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

function getSpreadsheetIdForYear(year) {
  const reg = loadRegistry();
  return reg[String(year)] || SPREADSHEET_ID;
}

// ─── スタッフ ───────────────────────────────────────────────────
function loadStaff() {
  return JSON.parse(fs.readFileSync(STAFF_PATH, 'utf8'));
}

function saveStaff(data) {
  writeFileAtomicSync(STAFF_PATH, JSON.stringify(data, null, 2));
}

// ─── スケジュール ───────────────────────────────────────────────
function loadSchedules() {
  if (!fs.existsSync(SCHEDULES_PATH)) return { schedules: [] };
  return JSON.parse(fs.readFileSync(SCHEDULES_PATH, 'utf8'));
}

function saveSchedules(data) {
  writeFileAtomicSync(SCHEDULES_PATH, JSON.stringify(data, null, 2));
}

// ─── お知らせ ───────────────────────────────────────────────────
function loadNotices() {
  if (!fs.existsSync(NOTICES_PATH)) return { notices: [], readStatus: {} };
  const data = JSON.parse(fs.readFileSync(NOTICES_PATH, 'utf8'));
  if (!data.readStatus) data.readStatus = {};
  return data;
}

function saveNotices(data) {
  writeFileAtomicSync(NOTICES_PATH, JSON.stringify(data, null, 2));
}

// ─── 有給休暇 ───────────────────────────────────────────────────
function loadLeave() {
  if (!fs.existsSync(LEAVE_PATH)) return { requests: [] };
  return JSON.parse(fs.readFileSync(LEAVE_PATH, 'utf8'));
}

function saveLeave(data) {
  writeFileAtomicSync(LEAVE_PATH, JSON.stringify(data, null, 2));
}

// ─── 当番記録 ───────────────────────────────────────────────────
function loadOncall() {
  if (!fs.existsSync(ONCALL_PATH)) return { records: [] };
  return JSON.parse(fs.readFileSync(ONCALL_PATH, 'utf8'));
}

function saveOncall(data) {
  writeFileAtomicSync(ONCALL_PATH, JSON.stringify(data, null, 2));
}

// ─── 待機記録 ───────────────────────────────────────────────────
function loadStandby() {
  if (!fs.existsSync(STANDBY_PATH)) return { records: [], customHolidays: [], rainyDays: [] };
  const data = JSON.parse(fs.readFileSync(STANDBY_PATH, 'utf8'));
  if (!data.records) data.records = [];
  if (!data.customHolidays) data.customHolidays = [];
  if (!data.rainyDays) data.rainyDays = [];
  return data;
}

function saveStandby(data) {
  writeFileAtomicSync(STANDBY_PATH, JSON.stringify(data, null, 2));
}

// ─── 出勤確定 ───────────────────────────────────────────────────
function loadAttendance() {
  if (!fs.existsSync(ATTENDANCE_PATH)) return { records: {}, reminders_sent: {} };
  const data = JSON.parse(fs.readFileSync(ATTENDANCE_PATH, 'utf8'));
  if (!data.records) data.records = {};
  if (!data.reminders_sent) data.reminders_sent = {};
  return data;
}

function saveAttendance(data) {
  writeFileAtomicSync(ATTENDANCE_PATH, JSON.stringify(data, null, 2));
}

// ─── Excelインポート結果 ────────────────────────────────────────
function loadExcelResults() {
  if (!fs.existsSync(EXCEL_RESULTS_PATH)) return {};
  return JSON.parse(fs.readFileSync(EXCEL_RESULTS_PATH, 'utf8'));
}

function saveExcelResults(data) {
  writeFileAtomicSync(EXCEL_RESULTS_PATH, JSON.stringify(data, null, 2));
}

// ─── パスワードリセットトークン ─────────────────────────────────
function loadResetTokens() {
  try { return JSON.parse(fs.readFileSync(RESET_TOKENS_PATH, 'utf8')); }
  catch { return { tokens: [] }; }
}

function saveResetTokens(data) {
  writeFileAtomicSync(RESET_TOKENS_PATH, JSON.stringify(data, null, 2));
}

function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

function cleanExpiredTokens() {
  const data = loadResetTokens();
  const now = Date.now();
  data.tokens = data.tokens.filter(t => new Date(t.expiresAt).getTime() > now && !t.used);
  saveResetTokens(data);
}

// ─── WebAuthn資格情報 ───────────────────────────────────────────
function loadWebAuthnData() {
  try { return JSON.parse(fs.readFileSync(WEBAUTHN_FILE, 'utf8')); }
  catch { return { credentials: [] }; }
}

function saveWebAuthnData(data) {
  writeFileAtomicSync(WEBAUTHN_FILE, JSON.stringify(data, null, 2));
}

// ─── DATA_DIR 初期化 ────────────────────────────────────────────
async function ensureDataDir() {
  if (DATA_DIR === path.resolve(__dirname, '..')) return;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const __rootdir = path.resolve(__dirname, '..');
  // staff.json が DATA_DIR になければ ソースからコピー（なければ空テンプレート作成）
  if (!fs.existsSync(STAFF_PATH)) {
    const src = path.join(__rootdir, 'staff.json');
    if (fs.existsSync(src)) fs.copyFileSync(src, STAFF_PATH);
    else writeFileAtomicSync(STAFF_PATH, JSON.stringify({ incentive_defaults: { nurse: 3.5, rehab: 20 }, staff: [] }, null, 2));
  }
  // spreadsheet-registry.json も同様
  if (!fs.existsSync(REGISTRY_PATH)) {
    const src = path.join(__rootdir, 'spreadsheet-registry.json');
    if (fs.existsSync(src)) fs.copyFileSync(src, REGISTRY_PATH);
  }
  // schedules.json も同様
  if (!fs.existsSync(SCHEDULES_PATH)) {
    const src = path.join(__rootdir, 'schedules.json');
    if (fs.existsSync(src)) fs.copyFileSync(src, SCHEDULES_PATH);
    else writeFileAtomicSync(SCHEDULES_PATH, JSON.stringify({ schedules: [] }, null, 2));
  }
  // notices.json も同様
  if (!fs.existsSync(NOTICES_PATH)) {
    const src = path.join(__rootdir, 'notices.json');
    if (fs.existsSync(src)) fs.copyFileSync(src, NOTICES_PATH);
    else writeFileAtomicSync(NOTICES_PATH, JSON.stringify({ notices: [], readStatus: {} }, null, 2));
  }
  // leave-requests.json も同様
  if (!fs.existsSync(LEAVE_PATH)) {
    writeFileAtomicSync(LEAVE_PATH, JSON.stringify({ requests: [] }, null, 2));
  }
  // oncall-records.json も同様
  if (!fs.existsSync(ONCALL_PATH)) {
    writeFileAtomicSync(ONCALL_PATH, JSON.stringify({ records: [] }, null, 2));
  }
  // audit-log.json
  if (!fs.existsSync(AUDIT_LOG_PATH)) {
    writeFileAtomicSync(AUDIT_LOG_PATH, JSON.stringify([], null, 2));
  }
  // attendance.json
  if (!fs.existsSync(ATTENDANCE_PATH)) {
    writeFileAtomicSync(ATTENDANCE_PATH, JSON.stringify({ records: {}, reminders_sent: {} }, null, 2));
  }
}

module.exports = {
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
