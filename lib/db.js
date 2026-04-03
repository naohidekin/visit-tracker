'use strict';
// SQLite データベース管理モジュール（初期化・スキーマ・JSON移行）

const Database = require('better-sqlite3');
const fs   = require('fs');
const path = require('path');
const { DB_PATH, DATA_DIR, SPREADSHEET_ID } = require('./constants');

let _db = null;

// ─── データベース接続取得 ──────────────────────────────────────────
function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');
  createSchema(_db);
  return _db;
}

// ─── スキーマ定義 ──────────────────────────────────────────────────
function createSchema(db) {
  db.exec(`
    -- アプリ設定（インセンティブデフォルト等）
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- スタッフ（1行 = 1人、data列にJSON全体を格納）
    CREATE TABLE IF NOT EXISTS staff (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    -- 有給申請
    CREATE TABLE IF NOT EXISTS leave_requests (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    -- オンコール記録
    CREATE TABLE IF NOT EXISTS oncall_records (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    -- 予定
    CREATE TABLE IF NOT EXISTS schedules (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    -- お知らせ
    CREATE TABLE IF NOT EXISTS notices (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    -- お知らせ既読状態
    CREATE TABLE IF NOT EXISTS notice_read_status (
      staff_id  TEXT NOT NULL,
      notice_id TEXT NOT NULL,
      PRIMARY KEY (staff_id, notice_id)
    );

    -- 出勤確定
    CREATE TABLE IF NOT EXISTS attendance (
      date       TEXT NOT NULL,
      staff_id   TEXT NOT NULL,
      status     TEXT,
      source     TEXT,
      updated_at TEXT,
      PRIMARY KEY (date, staff_id)
    );

    -- リマインダー送信済み
    CREATE TABLE IF NOT EXISTS reminders_sent (
      date     TEXT NOT NULL,
      staff_id TEXT NOT NULL,
      sent_at  TEXT,
      PRIMARY KEY (date, staff_id)
    );

    -- 待機記録
    CREATE TABLE IF NOT EXISTS standby_records (
      date     TEXT PRIMARY KEY,
      staff_id TEXT,
      fee      INTEGER,
      category TEXT
    );

    -- 待機用カスタム祝日
    CREATE TABLE IF NOT EXISTS custom_holidays (
      date TEXT PRIMARY KEY
    );

    -- 雨の日
    CREATE TABLE IF NOT EXISTS rainy_days (
      date TEXT PRIMARY KEY
    );

    -- スプレッドシートレジストリ（年 → Sheet ID）
    CREATE TABLE IF NOT EXISTS spreadsheet_registry (
      year           TEXT PRIMARY KEY,
      spreadsheet_id TEXT NOT NULL
    );

    -- Excelインポート結果
    CREATE TABLE IF NOT EXISTS excel_results (
      year_month TEXT PRIMARY KEY,
      data       TEXT NOT NULL
    );

    -- パスワードリセットトークン
    CREATE TABLE IF NOT EXISTS reset_tokens (
      token      TEXT PRIMARY KEY,
      staff_id   TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used       INTEGER DEFAULT 0,
      created_at TEXT
    );

    -- WebAuthn 資格情報
    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      credential_id TEXT PRIMARY KEY,
      staff_id      TEXT NOT NULL,
      data          TEXT NOT NULL
    );

    -- 監査ログ（ハッシュチェーン付き）
    CREATE TABLE IF NOT EXISTS audit_log (
      id        TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      prev_hash TEXT,
      data      TEXT NOT NULL
    );

    -- レート制限（キー単位の試行回数 + ウィンドウ期限）
    CREATE TABLE IF NOT EXISTS rate_limit (
      key      TEXT PRIMARY KEY,
      count    INTEGER NOT NULL DEFAULT 0,
      reset_at INTEGER NOT NULL
    );
  `);
}

// ─── JSONファイルからの移行（初回起動時） ──────────────────────────
function migrateFromJson() {
  const db = getDb();
  const rootDir = path.resolve(__dirname, '..');

  function findJson(filename) {
    for (const dir of [DATA_DIR, rootDir]) {
      const p = path.join(dir, filename);
      if (fs.existsSync(p)) {
        try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
        catch (e) { console.warn(`[migration] ${filename} の解析に失敗:`, e.message); }
      }
    }
    return null;
  }

  function tableEmpty(table) {
    return db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c === 0;
  }

  // --- スタッフ ---
  if (tableEmpty('staff')) {
    const data = findJson('staff.json');
    if (data && data.staff) {
      const tx = db.transaction(() => {
        if (data.incentive_defaults) {
          db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('incentive_defaults', ?)").run(JSON.stringify(data.incentive_defaults));
        }
        const ins = db.prepare('INSERT OR IGNORE INTO staff (id, data) VALUES (?, ?)');
        for (const s of data.staff) {
          ins.run(s.id, JSON.stringify(s));
        }
      });
      tx();
      console.log(`[migration] staff.json → SQLite (${data.staff.length} staff)`);
    }
  }

  // --- 有給申請 ---
  if (tableEmpty('leave_requests')) {
    const data = findJson('leave-requests.json');
    if (data && data.requests) {
      const ins = db.prepare('INSERT OR IGNORE INTO leave_requests (id, data) VALUES (?, ?)');
      const tx = db.transaction(() => {
        for (const r of data.requests) ins.run(r.id, JSON.stringify(r));
      });
      tx();
      console.log(`[migration] leave-requests.json → SQLite (${data.requests.length} requests)`);
    }
  }

  // --- オンコール ---
  if (tableEmpty('oncall_records')) {
    const data = findJson('oncall-records.json');
    if (data && data.records) {
      const ins = db.prepare('INSERT OR IGNORE INTO oncall_records (id, data) VALUES (?, ?)');
      const tx = db.transaction(() => {
        for (const r of data.records) ins.run(r.id, JSON.stringify(r));
      });
      tx();
      console.log(`[migration] oncall-records.json → SQLite (${data.records.length} records)`);
    }
  }

  // --- 予定 ---
  if (tableEmpty('schedules')) {
    const data = findJson('schedules.json');
    if (data && data.schedules) {
      const ins = db.prepare('INSERT OR IGNORE INTO schedules (id, data) VALUES (?, ?)');
      const tx = db.transaction(() => {
        for (const s of data.schedules) ins.run(s.id, JSON.stringify(s));
      });
      tx();
      console.log(`[migration] schedules.json → SQLite (${data.schedules.length} schedules)`);
    }
  }

  // --- お知らせ ---
  if (tableEmpty('notices')) {
    const data = findJson('notices.json');
    if (data) {
      const tx = db.transaction(() => {
        if (data.notices) {
          const insN = db.prepare('INSERT OR IGNORE INTO notices (id, data) VALUES (?, ?)');
          for (const n of data.notices) insN.run(n.id, JSON.stringify(n));
        }
        if (data.readStatus) {
          const insR = db.prepare('INSERT OR IGNORE INTO notice_read_status (staff_id, notice_id) VALUES (?, ?)');
          for (const [staffId, noticeIds] of Object.entries(data.readStatus)) {
            for (const nid of (Array.isArray(noticeIds) ? noticeIds : [])) {
              insR.run(staffId, nid);
            }
          }
        }
      });
      tx();
      console.log(`[migration] notices.json → SQLite (${(data.notices || []).length} notices)`);
    }
  }

  // --- 出勤確定 ---
  if (tableEmpty('attendance')) {
    const data = findJson('attendance.json');
    if (data) {
      const tx = db.transaction(() => {
        if (data.records) {
          const insA = db.prepare('INSERT OR IGNORE INTO attendance (date, staff_id, status, source, updated_at) VALUES (?, ?, ?, ?, ?)');
          for (const [date, staffMap] of Object.entries(data.records)) {
            for (const [staffId, rec] of Object.entries(staffMap)) {
              insA.run(date, staffId, rec.status, rec.source, rec.updatedAt);
            }
          }
        }
        if (data.reminders_sent) {
          const insR = db.prepare('INSERT OR IGNORE INTO reminders_sent (date, staff_id, sent_at) VALUES (?, ?, ?)');
          for (const [date, staffMap] of Object.entries(data.reminders_sent)) {
            for (const [staffId, sentAt] of Object.entries(staffMap)) {
              insR.run(date, staffId, sentAt);
            }
          }
        }
      });
      tx();
      console.log('[migration] attendance.json → SQLite');
    }
  }

  // --- 待機記録 ---
  if (tableEmpty('standby_records')) {
    const data = findJson('standby-records.json');
    if (data) {
      const tx = db.transaction(() => {
        if (data.records) {
          const insR = db.prepare('INSERT OR IGNORE INTO standby_records (date, staff_id, fee, category) VALUES (?, ?, ?, ?)');
          for (const r of data.records) insR.run(r.date, r.staffId, r.fee, r.category);
        }
        if (data.customHolidays) {
          const insH = db.prepare('INSERT OR IGNORE INTO custom_holidays (date) VALUES (?)');
          for (const d of data.customHolidays) insH.run(d);
        }
        if (data.rainyDays) {
          const insD = db.prepare('INSERT OR IGNORE INTO rainy_days (date) VALUES (?)');
          for (const d of data.rainyDays) insD.run(d);
        }
      });
      tx();
      console.log(`[migration] standby-records.json → SQLite (${(data.records || []).length} records)`);
    }
  }

  // --- スプレッドシートレジストリ ---
  if (tableEmpty('spreadsheet_registry')) {
    const data = findJson('spreadsheet-registry.json');
    if (data) {
      const ins = db.prepare('INSERT OR IGNORE INTO spreadsheet_registry (year, spreadsheet_id) VALUES (?, ?)');
      const tx = db.transaction(() => {
        for (const [year, id] of Object.entries(data)) ins.run(year, id);
      });
      tx();
      console.log('[migration] spreadsheet-registry.json → SQLite');
    } else if (SPREADSHEET_ID) {
      const year = String(new Date().getFullYear());
      db.prepare('INSERT OR IGNORE INTO spreadsheet_registry (year, spreadsheet_id) VALUES (?, ?)').run(year, SPREADSHEET_ID);
    }
  }

  // --- Excelインポート結果 ---
  if (tableEmpty('excel_results')) {
    const data = findJson('excel-results.json');
    if (data && typeof data === 'object') {
      const ins = db.prepare('INSERT OR IGNORE INTO excel_results (year_month, data) VALUES (?, ?)');
      const tx = db.transaction(() => {
        for (const [ym, val] of Object.entries(data)) ins.run(ym, JSON.stringify(val));
      });
      tx();
      console.log('[migration] excel-results.json → SQLite');
    }
  }

  // --- パスワードリセットトークン ---
  if (tableEmpty('reset_tokens')) {
    const data = findJson('password-reset-tokens.json');
    if (data && data.tokens) {
      const ins = db.prepare('INSERT OR IGNORE INTO reset_tokens (token, staff_id, expires_at, used, created_at) VALUES (?, ?, ?, ?, ?)');
      const tx = db.transaction(() => {
        for (const t of data.tokens) ins.run(t.token, t.staffId, t.expiresAt, t.used ? 1 : 0, t.createdAt);
      });
      tx();
      console.log(`[migration] password-reset-tokens.json → SQLite (${data.tokens.length} tokens)`);
    }
  }

  // --- WebAuthn ---
  if (tableEmpty('webauthn_credentials')) {
    const data = findJson('webauthn-credentials.json');
    if (data && data.credentials) {
      const ins = db.prepare('INSERT OR IGNORE INTO webauthn_credentials (credential_id, staff_id, data) VALUES (?, ?, ?)');
      const tx = db.transaction(() => {
        for (const c of data.credentials) ins.run(c.credentialID, c.staffId, JSON.stringify(c));
      });
      tx();
      console.log(`[migration] webauthn-credentials.json → SQLite (${data.credentials.length} credentials)`);
    }
  }

  // --- 監査ログ ---
  if (tableEmpty('audit_log')) {
    const data = findJson('audit-log.json');
    if (Array.isArray(data) && data.length > 0) {
      const ins = db.prepare('INSERT OR IGNORE INTO audit_log (id, timestamp, prev_hash, data) VALUES (?, ?, ?, ?)');
      const tx = db.transaction(() => {
        for (const entry of data) {
          ins.run(entry.id, entry.timestamp, entry.prevHash || '0', JSON.stringify(entry));
        }
      });
      tx();
      console.log(`[migration] audit-log.json → SQLite (${data.length} entries)`);
    }
  }
}

// ─── データベース初期化（起動時に1回呼ぶ） ────────────────────────
function initDb() {
  const db = getDb();
  migrateFromJson();
  console.log('💾 SQLite データベース初期化完了');
  return db;
}

// ─── シャットダウン ────────────────────────────────────────────────
function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = { getDb, initDb, closeDb };
