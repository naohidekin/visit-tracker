'use strict';
// 監査ログモジュール（改ざん検知チェーン付き）

const crypto = require('crypto');
const path   = require('path');
const writeFileAtomicSync = require('write-file-atomic').sync;
const { DATA_DIR, AUDIT_LOG_PATH } = require('./constants');
const fs = require('fs');

function loadAuditLog() {
  if (!fs.existsSync(AUDIT_LOG_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(AUDIT_LOG_PATH, 'utf8')); }
  catch { return []; }
}

function hashEntry(entry) {
  return crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex');
}

function appendAuditLog(entry) {
  const log = loadAuditLog();
  entry.prevHash = log.length > 0 ? hashEntry(log[log.length - 1]) : '0';
  log.push(entry);
  // ログローテーション: 10,000件超でアーカイブ
  if (log.length > 10000) {
    const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const archiveName = `audit-log-${now.toISOString().slice(0, 7)}.json`;
    const archivePath = path.join(DATA_DIR, archiveName);
    writeFileAtomicSync(archivePath, JSON.stringify(log.slice(0, -1000), null, 2));
    const remaining = log.slice(-1000);
    writeFileAtomicSync(AUDIT_LOG_PATH, JSON.stringify(remaining, null, 2));
    console.log(`📋 監査ログローテーション: ${archiveName} にアーカイブ`);
  } else {
    writeFileAtomicSync(AUDIT_LOG_PATH, JSON.stringify(log, null, 2));
  }
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
