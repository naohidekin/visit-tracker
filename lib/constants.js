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

// 締め期間（前月16日〜当月15日）
const BILLING_DAY = parseInt(process.env.BILLING_DAY || '16', 10);

// 待機手当料金
const STANDBY_FEES = {
  holiday:  parseInt(process.env.STANDBY_FEE_HOLIDAY  || '10000', 10),
  sunday:   parseInt(process.env.STANDBY_FEE_SUNDAY   || '10000', 10),
  saturday: parseInt(process.env.STANDBY_FEE_SATURDAY || '5000',  10),
  weekday:  parseInt(process.env.STANDBY_FEE_WEEKDAY  || '2000',  10),
};

// インセンティブ単価デフォルト（admin-billing用）
const INCENTIVE_NURSE_RATE = parseInt(process.env.INCENTIVE_NURSE_RATE || '4000', 10);
const INCENTIVE_REHAB_RATE = parseInt(process.env.INCENTIVE_REHAB_RATE || '500',  10);

// 有給付与テーブル（月数ベース：自社規定。通常の労基法とは付与日数が異なる）
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
  BILLING_DAY,
  STANDBY_FEES,
  INCENTIVE_NURSE_RATE,
  INCENTIVE_REHAB_RATE,
};
