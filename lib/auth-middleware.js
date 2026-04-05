'use strict';
// 認証ミドルウェアモジュール（スタッフ認証・管理者認証・CSRF）

const crypto = require('crypto');
const { getDb } = require('./db');

function requireStaff(req, res, next) {
  if (!req.session.staffId) return res.status(401).json({ error: 'ログインが必要です' });
  // SQLiteから直接確認（再起動・複数インスタンスでも一貫性が保たれる）
  const db = getDb();
  const row = db.prepare('SELECT data FROM staff WHERE id = ?').get(req.session.staffId);
  const staff = row ? JSON.parse(row.data) : null;
  if (!staff || staff.archived) {
    req.session = null;
    return res.status(401).json({ error: 'このアカウントは無効化されています' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(401).json({ error: '管理者権限が必要です' });
  // 管理者権限を保持しているか毎リクエストDB確認（権限剥奪・アーカイブを即時反映）
  const db = getDb();
  const row = db.prepare('SELECT data FROM staff WHERE id = ?').get(req.session.adminStaffId);
  const staff = row ? JSON.parse(row.data) : null;
  if (!staff || !staff.is_admin || staff.archived) {
    req.session.isAdmin = false;
    req.session.adminStaffId = null;
    return res.status(401).json({ error: '管理者権限が取り消されました' });
  }
  next();
}

// ログイン成功時にCSRFトークンcookieを発行するヘルパー
function setCsrfCookie(res) {
  const token = crypto.randomBytes(32).toString('hex');
  res.cookie('csrf_token', token, {
    httpOnly: false, sameSite: 'strict', path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  return token;
}

module.exports = {
  requireStaff,
  requireAdmin,
  setCsrfCookie,
};
