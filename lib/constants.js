'use strict';
// 定数定義モジュール（パス、スプレッドシート設定、祝日等）

require('dotenv').config();
const path = require('path');

const PORT            = process.env.PORT || 3000;
const SPREADSHEET_ID  = process.env.SPREADSHEET_ID;
const DATA_DIR        = process.env.DATA_DIR || path.resolve(__dirname, '..');
const APP_BASE_URL    = process.env.APP_BASE_URL || `http://localhost:${PORT}`;

const DB_PATH            = path.join(DATA_DIR, 'visit-tracker.db');
const STAFF_PATH         = path.join(DATA_DIR, 'staff.json');
const REGISTRY_PATH      = path.join(DATA_DIR, 'spreadsheet-registry.json');
const SCHEDULES_PATH     = path.join(DATA_DIR, 'schedules.json');
const NOTICES_PATH       = path.join(DATA_DIR, 'notices.json');
const EXCEL_RESULTS_PATH = path.join(DATA_DIR, 'excel-results.json');
const LEAVE_PATH         = path.join(DATA_DIR, 'leave-requests.json');
const ONCALL_PATH        = path.join(DATA_DIR, 'oncall-records.json');
const AUDIT_LOG_PATH     = path.join(DATA_DIR, 'audit-log.json');
// 監査ログの追記専用 NDJSON ファイル（SQLiteと別ストレージに置く場合は AUDIT_LOG_NDJSON_PATH 環境変数で指定）
const AUDIT_NDJSON_PATH  = process.env.AUDIT_LOG_NDJSON_PATH || path.join(DATA_DIR, 'audit-log.ndjson');
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

// 祝日判定は holiday-jp ライブラリで動的化（lib/helpers.js の isWorkday を使用）
// HOLIDAYS_2026 / HOLIDAYS_2027 / ALL_HOLIDAYS は削除済み

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
  DB_PATH,
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
  AUDIT_NDJSON_PATH,
  LEAVE_GRANT_TABLE,
};
