'use strict';
// 監査ログモジュール（SQLiteバックエンド、改ざん検知チェーン付き）

const crypto = require('crypto');
const { getDb } = require('./db');

function loadAuditLog() {
  const db = getDb();
  const rows = db.prepare('SELECT data FROM audit_log ORDER BY timestamp ASC, id ASC').all();
  return rows.map(r => JSON.parse(r.data));
}

function hashEntry(entry) {
  return crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex');
}

function appendAuditLog(entry) {
  const db = getDb();
  const lastRow = db.prepare('SELECT data FROM audit_log ORDER BY timestamp DESC, id DESC LIMIT 1').get();
  entry.prevHash = lastRow ? hashEntry(JSON.parse(lastRow.data)) : '0';
  db.prepare('INSERT INTO audit_log (id, timestamp, prev_hash, data) VALUES (?, ?, ?, ?)').run(
    entry.id, entry.timestamp, entry.prevHash, JSON.stringify(entry)
  );
}

function auditLog(req, action, target, details = {}) {
  try {
    const now = new Date();
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: now.toISOString(),
      actor: {
        type: req.session?.isAdmin ? 'admin' : (req.session?.staffId ? 'staff' : 'anonymous'),
        staffId: req.session?.staffId || null,
        staffName: req.session?.staffName || null,
      },
      action,
      target,
      details,
      ip: req.ip || req.connection?.remoteAddress || null,
    };
    appendAuditLog(entry);
  } catch (e) {
    console.error('⚠️ 監査ログ書き込みエラー:', e.message);
  }
}

// 監査ログのハッシュチェーン整合性検証
function verifyAuditChain() {
  const log = loadAuditLog();
  if (log.length === 0) return { valid: true, entries: 0, errors: [] };
  const errors = [];
  for (let i = 1; i < log.length; i++) {
    const expectedHash = hashEntry(log[i - 1]);
    if (log[i].prevHash !== expectedHash) {
      errors.push({ index: i, id: log[i].id, expected: expectedHash, actual: log[i].prevHash });
    }
  }
  if (log[0].prevHash !== '0') {
    errors.unshift({ index: 0, id: log[0].id, message: '先頭エントリのprevHashが不正' });
  }
  return { valid: errors.length === 0, entries: log.length, errors };
}

module.exports = {
  loadAuditLog,
  hashEntry,
  appendAuditLog,
  auditLog,
  verifyAuditChain,
};
