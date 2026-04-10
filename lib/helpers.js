'use strict';
// ヘルパー関数モジュール（バリデーション、日付、ファイルロック、レート制限等）

const holidayJp = require('holiday-jp');
const { getDb } = require('./db');

// ─── 入力バリデーション ─────────────────────────────────────────
const isValidDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s).getTime());
const isValidYearMonth = (y, m) => Number.isInteger(+y) && +y >= 2020 && +y <= 2099 && Number.isInteger(+m) && +m >= 1 && +m <= 12;
const sanitizeStr = (s, maxLen = 200) => typeof s === 'string' ? s.trim().slice(0, maxLen) : '';

// 訪問単位数のバリデーション（空・null許容、数値は0〜9999の範囲）
function validateUnitValue(v) {
  if (v === '' || v === null || v === undefined) return { valid: true, value: '' };
  const n = Number(v);
  if (isNaN(n) || !isFinite(n)) return { valid: false };
  if (n < 0 || n > 9999) return { valid: false };
  return { valid: true, value: n };
}

// 汎用数値バリデーション（null許容オプション付き）
function validateNum(v, { min = -Infinity, max = Infinity, allowNull = false, allowEmpty = false } = {}) {
  if (v === null || v === undefined) return allowNull ? { valid: true, value: null } : { valid: false };
  if (v === '') return allowEmpty ? { valid: true, value: null } : { valid: false };
  const n = Number(v);
  if (!Number.isFinite(n)) return { valid: false };
  if (n < min || n > max) return { valid: false };
  return { valid: true, value: n };
}

// ─── 日付ユーティリティ ─────────────────────────────────────────
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

// JST での現在年月文字列（YYYY-MM）
function getYearMonthJST() {
  const jst = getNowJST();
  return `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, '0')}`;
}

function formatLocalDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ─── 列変換 ─────────────────────────────────────────────────────
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

// asyncルートハンドラ（エラーハンドリング付き）
function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      console.error('Route error:', err);
      if (!res.headersSent) res.status(500).json({ error: '内部エラーが発生しました' });
    }
  };
}

// ─── レート制限（SQLite永続化・プロセス再起動でもリセットされない） ───
function checkRateLimit(key, maxPerWindow = 3, windowMs = 60000) {
  const db = getDb();
  const now = Date.now();
  const row = db.prepare('SELECT count, reset_at FROM rate_limit WHERE key = ?').get(key);
  if (!row || now > row.reset_at) {
    db.prepare('INSERT OR REPLACE INTO rate_limit (key, count, reset_at) VALUES (?, 1, ?)').run(key, now + windowMs);
    return true;
  }
  if (row.count >= maxPerWindow) return false;
  db.prepare('UPDATE rate_limit SET count = count + 1 WHERE key = ?').run(key);
  return true;
}

// 期限切れレート制限エントリのクリーンアップ（server.js の cron から定期呼び出し）
function cleanExpiredRateLimits() {
  const db = getDb();
  db.prepare('DELETE FROM rate_limit WHERE reset_at < ?').run(Date.now());
}

// ─── 祝日・営業日判定 ──────────────────────────────────────────
function isWorkday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false; // 土日
  if (holidayJp.isHoliday(d)) return false; // 祝日（holiday-jp ライブラリ）
  return true;
}

// ─── 待機手当計算（data.js を遅延require） ──────────────────────
function getStandbyFee(dateStr) {
  const { loadStandby } = require('./data');
  const standbyData = loadStandby();
  const customHols = new Set(standbyData.customHolidays || []);
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay();
  if (holidayJp.isHoliday(d) || customHols.has(dateStr)) return { fee: 10000, category: '祝日' };
  if (dow === 0) return { fee: 10000, category: '日曜' };
  if (dow === 6) return { fee: 5000, category: '土曜' };
  return { fee: 2000, category: '平日' };
}

function getStandbyFeeWithCustom(dateStr, customHols) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay();
  if (holidayJp.isHoliday(d) || customHols.has(dateStr)) return { fee: 10000, category: '祝日' };
  if (dow === 0) return { fee: 10000, category: '日曜' };
  if (dow === 6) return { fee: 5000, category: '土曜' };
  return { fee: 2000, category: '平日' };
}

// ─── 有給取得中判定（data.js を遅延require） ────────────────────
function isOnLeaveToday(staffId, dateStr) {
  const { loadLeave } = require('./data');
  const leaveData = loadLeave();
  return leaveData.requests.some(r =>
    r.staffId === staffId &&
    (r.status === 'approved') &&
    r.dates.includes(dateStr)
  );
}

// 出勤確定 + 有給データから月の出勤予定日数を算出
function getExpectedWorkingDays(staffId, year, month) {
  const { loadAttendance, loadLeave } = require('./data');
  const daysInMonth = new Date(year, month, 0).getDate();
  const attendanceData = loadAttendance();
  const leaveData = loadLeave();
  let expected = 0;

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    if (!isWorkday(dateStr)) continue;

    const manual = attendanceData.records[dateStr]?.[staffId];
    if (manual && manual.status === 'absent') continue;

    const onLeave = leaveData.requests.some(r =>
      r.staffId === staffId && r.status === 'approved' && r.dates.includes(dateStr)
    );
    if (onLeave) continue;

    expected++;
  }
  return expected;
}

module.exports = {
  isValidDate,
  isValidYearMonth,
  sanitizeStr,
  validateUnitValue,
  validateNum,
  toDateStr,
  getTodayJST,
  getNowJST,
  getYearMonthJST,
  formatLocalDate,
  colToIdx,
  idxToCol,
  asyncRoute,
  checkRateLimit,
  cleanExpiredRateLimits,
  isWorkday,
  getStandbyFee,
  getStandbyFeeWithCustom,
  isOnLeaveToday,
  getExpectedWorkingDays,
};
