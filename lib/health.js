'use strict';
// システムヘルスチェック
// 毎日 02:00 (JST) の cron + 管理者 API エンドポイントから呼ばれる

const path = require('path');
const fs   = require('fs');
const { getDb }          = require('./db');
const { verifyAuditChain } = require('./audit');
const { AUDIT_NDJSON_PATH } = require('./constants');

function runHealthChecks() {
  const checks = [];

  // 1. SQLite 物理整合性
  try {
    const db  = getDb();
    const row = db.prepare('PRAGMA integrity_check').get();
    const ok  = row.integrity_check === 'ok';
    checks.push({ name: 'SQLite整合性', ok, detail: ok ? 'OK' : row.integrity_check });
  } catch (e) {
    checks.push({ name: 'SQLite整合性', ok: false, detail: e.message });
  }

  // 2. 監査ログ ハッシュチェーン整合性
  try {
    const result = verifyAuditChain();
    checks.push({
      name:   '監査ログチェーン',
      ok:     result.valid,
      detail: result.valid ? 'OK' : `${result.errors.length}件のエラー`,
    });
  } catch (e) {
    checks.push({ name: '監査ログチェーン', ok: false, detail: e.message });
  }

  // 3. NDJSON 書き込み可能性
  try {
    fs.accessSync(path.dirname(AUDIT_NDJSON_PATH), fs.constants.W_OK);
    checks.push({ name: 'NDJSON書き込み', ok: true, detail: '書き込み可能' });
  } catch (e) {
    checks.push({ name: 'NDJSON書き込み', ok: false, detail: e.message });
  }

  // 4. 有効な管理者アカウントの存在
  try {
    const db    = getDb();
    const rows  = db.prepare('SELECT data FROM staff').all();
    const count = rows.filter(r => {
      try { const s = JSON.parse(r.data); return s.is_admin && !s.archived; }
      catch (_) { return false; }
    }).length;
    checks.push({
      name:   '管理者アカウント',
      ok:     count > 0,
      detail: `有効な管理者 ${count}名`,
    });
  } catch (e) {
    checks.push({ name: '管理者アカウント', ok: false, detail: e.message });
  }

  // 5. rate_limit テーブルの到達可能性
  try {
    const db    = getDb();
    const count = db.prepare('SELECT COUNT(*) as c FROM rate_limit').get().c;
    checks.push({ name: 'レート制限テーブル', ok: true, detail: `${count}件のエントリ` });
  } catch (e) {
    checks.push({ name: 'レート制限テーブル', ok: false, detail: e.message });
  }

  const ok        = checks.every(c => c.ok);
  const checkedAt = new Date().toISOString();
  const result    = { ok, checkedAt, checks };

  // 結果を settings テーブルに保存（管理画面の「前回結果」表示用）
  try {
    getDb().prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('last_health_check', ?)"
    ).run(JSON.stringify(result));
  } catch (e) { console.warn('[health] ⚠️ 結果の保存に失敗:', e.message); }

  return result;
}

function getLastHealthCheck() {
  try {
    const row = getDb().prepare(
      "SELECT value FROM settings WHERE key = 'last_health_check'"
    ).get();
    return row ? JSON.parse(row.value) : null;
  } catch (_) {
    return null;
  }
}

module.exports = { runHealthChecks, getLastHealthCheck };
