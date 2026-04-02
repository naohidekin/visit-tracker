'use strict';
// 定数定義モジュール（パス、スプレッドシート設定、祝日等）

require('dotenv').config();
const path = require('path');

const PORT            = process.env.PORT || 3000;
const SPREADSHEET_ID  = process.env.SPREADSHEET_ID;
const DATA_DIR        = process.env.DATA_DIR || path.resolve(__dirname, '..');
const APP_BASE_URL    = process.env.APP_BASE_URL || `http://localhost:${PORT}`;

const STAFF_PATH         = path.join(DATA_DIR, 'staff.json');
const REGISTRY_PATH      = path.join(DATA_DIR, 'spreadsheet-registry.json');
const SCHEDULES_PATH     = path.join(DATA_DIR, 'schedules.json');
const NOTICES_PATH       = path.join(DATA_DIR, 'notices.json');
const EXCEL_RESULTS_PATH = path.join(DATA_DIR, 'excel-results.json');
const LEAVE_PATH         = path.join(DATA_DIR, 'leave-requests.json');
const ONCALL_PATH        = path.join(DATA_DIR, 'oncall-records.json');
const AUDIT_LOG_PATH     = path.join(DATA_DIR, 'audit-log.json');
const RESET_TOKENS_PATH  = path.join(DATA_DIR, 'password-reset-tokens.json');
const STANDBY_PATH       = path.join(DATA_DIR, 'standby-records.json');
const ATTENDANCE_PATH    = path.join(DATA_DIR, 'attendance.json');
const WEBAUTHN_FILE      = path.join(DATA_DIR, 'webauthn-credentials.json');

const MONTHS          = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
const HEADER_ROW      = 4;
const DATA_START_ROW  = 5;
const WD              = ['日','月','火','水','木','金','土'];

// 有給・オンコール機能の公開対象スタッフID（全員対象のため空配列に）
const LEAVE_ONCALL_ENABLED_IDS = [];

// 祝日判定（静的リスト：年初に更新する）
const HOLIDAYS_2026 = [
  '2026-01-01','2026-01-12','2026-02-11','2026-02-23',
  '2026-03-20','2026-04-29','2026-05-03','2026-05-04','2026-05-05','2026-05-06',
  '2026-07-20','2026-08-11','2026-09-21','2026-09-22','2026-09-23',
  '2026-10-12','2026-11-03','2026-11-23',
];
const HOLIDAYS_2027 = [
  '2027-01-01','2027-01-11','2027-02-11','2027-02-23',
  '2027-03-21','2027-04-29','2027-05-03','2027-05-04','2027-05-05',
  '2027-07-19','2027-08-11','2027-09-20','2027-09-23',
  '2027-10-11','2027-11-03','2027-11-23',
];
const ALL_HOLIDAYS = new Set([...HOLIDAYS_2026, ...HOLIDAYS_2027]);

// Yuw connect 有給付与テーブル（月数ベース：労基法準拠）
const LEAVE_GRANT_TABLE = [
  { months: 6,  days: 10 },
  { months: 18, days: 12 },
  { months: 30, days: 14 },
  { months: 42, days: 16 },
  { months: 54, days: 18 },
  { months: 66, days: 20 },
];

module.exports = {
  PORT,
  SPREADSHEET_ID,
  DATA_DIR,
  APP_BASE_URL,
  STAFF_PATH,
  REGISTRY_PATH,
  SCHEDULES_PATH,
  NOTICES_PATH,
  EXCEL_RESULTS_PATH,
  LEAVE_PATH,
  ONCALL_PATH,
  AUDIT_LOG_PATH,
  RESET_TOKENS_PATH,
  STANDBY_PATH,
  ATTENDANCE_PATH,
  WEBAUTHN_FILE,
  MONTHS,
  HEADER_ROW,
  DATA_START_ROW,
  WD,
  LEAVE_ONCALL_ENABLED_IDS,
  HOLIDAYS_2026,
  HOLIDAYS_2027,
  ALL_HOLIDAYS,
  LEAVE_GRANT_TABLE,
};
