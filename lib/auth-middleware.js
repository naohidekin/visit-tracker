'use strict';
// 認証ミドルウェアモジュール（スタッフ認証・管理者認証・CSRF）

const crypto = require('crypto');
const { loadStaff } = require('./data');

// セッション無効化ブラックリスト（アーカイブ時に追加）
const _invalidatedStaffIds = new Set();

function requireStaff(req, res, next) {
  if (!req.session.staffId) return res.status(401).json({ error: 'ログインが必要です' });
  // ブラックリスト（アーカイブ時に即追加）で高速判定
  if (_invalidatedStaffIds.has(req.session.staffId)) {
    req.session = null;
    return res.status(401).json({ error: 'このアカウントは無効化されています' });
  }
  // 念のためファイルからも確認（ブラックリスト漏れ・サーバー再起動後対策）
  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === req.session.staffId);
  if (!staff || staff.archived) {
    _invalidatedStaffIds.add(req.session.staffId);
    req.session = null;
    return res.status(401).json({ error: 'このアカウントは無効化されています' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(401).json({ error: '管理者権限が必要です' });
  next();
}

// 有給・オンコール機能のアクセス制御（全職員対象のため制限なし）
function requireLeaveOncall(req, res, next) {
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
  _invalidatedStaffIds,
  requireStaff,
  requireAdmin,
  requireLeaveOncall,
  setCsrfCookie,
};
