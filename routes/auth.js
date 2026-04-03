'use strict';
// 認証関連ルート（ログイン・ログアウト・パスワード変更・WebAuthn）

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { generateRegistrationOptions, verifyRegistrationResponse,
        generateAuthenticationOptions, verifyAuthenticationResponse } = require('@simplewebauthn/server');

const { loadStaff, saveStaff, loadResetTokens, saveResetTokens, generateResetToken } = require('../lib/data');
const { requireStaff, setCsrfCookie } = require('../lib/auth-middleware');
const { checkRateLimit, lockedRoute, isValidDate, sanitizeStr } = require('../lib/helpers');
const { auditLog } = require('../lib/audit');
const { sendResetEmail } = require('../lib/mail');
const { loadCredentials, saveCredential, updateCredentialCounter, deleteCredentials, hasCredentials,
        getWebAuthnRpId, getWebAuthnOrigin } = require('../lib/webauthn');
const { STAFF_PATH, APP_BASE_URL, RESET_TOKENS_PATH } = require('../lib/constants');

// ─── API: パスワードリセット ────────────────────────────────────
router.post('/api/forgot-password', (req, res) => {
  const { staffId } = req.body;
  if (!staffId) return res.status(400).json({ error: 'ログインIDを入力してください' });

  // IP レート制限
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (!checkRateLimit(`ip:${ip}`, 5, 60000)) {
    return res.status(429).json({ error: 'リクエストが多すぎます。しばらく待ってから再度お試しください' });
  }

  const data = loadStaff();
  const staff = data.staff.find(s => s.id === staffId);

  // staffが見つからない or email未登録でも同じレスポンス（ID列挙対策）
  if (!staff || !staff.email) {
    auditLog(req, 'auth.reset_request', { type: 'auth', id: staffId, label: 'メール未登録/ID不明' });
    return res.json({ success: true, message: 'ご登録のメールアドレスにリセットリンクを送信しました' });
  }

  // staffId レート制限（5分に1回）
  if (!checkRateLimit(`staff:${staffId}`, 1, 300000)) {
    return res.json({ success: true, message: 'ご登録のメールアドレスにリセットリンクを送信しました' });
  }

  // トークン生成・保存
  const token = generateResetToken();
  const tokens = loadResetTokens();
  // 同一staffの古い未使用トークンを無効化
  tokens.tokens.forEach(t => { if (t.staffId === staffId && !t.used) t.used = true; });
  tokens.tokens.push({
    staffId: staff.id,
    token,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30分
    used: false,
    createdAt: new Date().toISOString(),
  });
  saveResetTokens(tokens);

  // メール送信（非同期・レスポンスは先に返す）
  const resetUrl = `${APP_BASE_URL}/reset-password?token=${token}`;
  sendResetEmail(staff.email, staff.name, resetUrl);

  auditLog(req, 'auth.reset_request', { type: 'auth', id: staff.id, label: staff.name });
  res.json({ success: true, message: 'ご登録のメールアドレスにリセットリンクを送信しました' });
});

router.get('/api/reset-password/verify', (req, res) => {
  const { token } = req.query;
  if (!token) return res.json({ valid: false });

  const data = loadResetTokens();
  const entry = data.tokens.find(t => t.token === token && !t.used);
  if (!entry) return res.json({ valid: false });
  if (new Date(entry.expiresAt).getTime() < Date.now()) return res.json({ valid: false, expired: true });

  res.json({ valid: true });
});

router.post('/api/reset-password', lockedRoute(STAFF_PATH, async (req, res) => {
  const { token, newPassword, confirmPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'パラメータが不足しています' });
  if (newPassword !== confirmPassword) return res.status(400).json({ error: 'パスワードが一致しません' });
  if (newPassword.length < 4) return res.status(400).json({ error: 'パスワードは4文字以上で設定してください' });

  const tokenData = loadResetTokens();
  const entry = tokenData.tokens.find(t => t.token === token && !t.used);
  if (!entry) return res.status(400).json({ error: 'リセットリンクが無効です。再度リクエストしてください' });
  if (new Date(entry.expiresAt).getTime() < Date.now()) {
    return res.status(400).json({ error: 'リセットリンクの有効期限が切れています。再度リクエストしてください' });
  }

  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === entry.staffId);
  if (!staff) return res.status(400).json({ error: 'スタッフが見つかりません' });

  staff.password_hash = await bcrypt.hash(newPassword, 10);
  saveStaff(staffData);

  // トークンを使用済みに
  entry.used = true;
  saveResetTokens(tokenData);

  auditLog(req, 'auth.self_reset_password', { type: 'auth', id: staff.id, label: staff.name });
  res.json({ success: true });
}));

// ─── API: スタッフ認証 ──────────────────────────────────────────
router.post('/api/login', async (req, res) => {
  const { loginId, password } = req.body;
  if (!loginId || !password)
    return res.status(400).json({ error: 'IDとパスワードを入力してください' });

  // ブルートフォース対策: IP単位10回/分、ID単位5回/5分
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (!checkRateLimit(`login-ip:${ip}`, 10, 60000))
    return res.status(429).json({ error: 'ログイン試行回数が上限を超えました。しばらく待ってから再度お試しください' });
  if (!checkRateLimit(`login-id:${loginId}`, 5, 300000))
    return res.status(429).json({ error: 'ログイン試行回数が上限を超えました。しばらく待ってから再度お試しください' });

  const data  = loadStaff();
  const staff = data.staff.find(s => s.id === loginId);
  if (!staff)
    return res.status(401).json({ error: 'IDまたはパスワードが正しくありません' });
  if (staff.archived)
    return res.status(401).json({ error: 'このアカウントは無効化されています' });

  const ok = await bcrypt.compare(password, staff.password_hash);
  if (!ok) {
    auditLog(req, 'auth.login_failed', { type: 'auth', id: loginId, label: 'パスワード不一致' });
    return res.status(401).json({ error: 'IDまたはパスワードが正しくありません' });
  }

  req.session.staffId   = staff.id;
  req.session.staffName = staff.name;
  req.session.staffType = staff.type;
  setCsrfCookie(res);
  auditLog(req, 'auth.login', { type: 'auth', id: staff.id, label: staff.name });
  res.json({ success: true });
});

router.post('/api/logout', (req, res) => {
  auditLog(req, 'auth.logout', { type: 'auth', id: req.session?.staffId, label: req.session?.staffName });
  req.session = null;
  res.json({ success: true });
});

router.get('/api/me', (req, res) => {
  if (!req.session.staffId) return res.status(401).json({ error: '未ログイン' });
  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === req.session.staffId);
  const oncall_eligible = staff ? !!staff.oncall_eligible : false;
  const leave_oncall_enabled = true; // 全職員対象
  res.json({ id: req.session.staffId, name: req.session.staffName, type: req.session.staffType, oncall_eligible, leave_oncall_enabled });
});

// ─── API: WebAuthn (FaceID/TouchID) ─────────────────────────────
router.get('/api/webauthn/has-credential', async (req, res) => {
  try {
    const { loginId } = req.query;
    if (!loginId) return res.json({ has: false });
    const has = await hasCredentials(loginId);
    res.json({ has });
  } catch (e) {
    console.error('WebAuthn has-credential error:', e.message);
    res.json({ has: false });
  }
});

router.post('/api/webauthn/register-options', requireStaff, async (req, res) => {
  try {
    const staffId = req.session.staffId;
    const staffName = req.session.staffName;
    const existingCreds = await loadCredentials(staffId);

    const options = await generateRegistrationOptions({
      rpName: 'にこっとweb App',
      rpID: getWebAuthnRpId(req),
      userName: staffId,
      userDisplayName: staffName,
      attestationType: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        userVerification: 'required',
      },
      excludeCredentials: existingCreds.map(c => ({
        id: c.id,
        transports: c.transports,
      })),
    });

    req.session.webauthnChallenge = options.challenge;
    res.json(options);
  } catch (e) {
    console.error('WebAuthn register-options error:', e.message);
    res.status(500).json({ error: '登録オプションの生成に失敗しました' });
  }
});

router.post('/api/webauthn/register-verify', requireStaff, async (req, res) => {
  const expectedChallenge = req.session.webauthnChallenge;
  req.session.webauthnChallenge = null;

  try {
    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge,
      expectedOrigin: getWebAuthnOrigin(req),
      expectedRPID: getWebAuthnRpId(req),
    });

    if (!verification.verified) {
      return res.status(400).json({ error: '登録に失敗しました' });
    }

    const { credential } = verification.registrationInfo;
    await saveCredential(req.session.staffId, credential);
    res.json({ success: true });
  } catch (e) {
    console.error('WebAuthn register-verify error:', e.message);
    res.status(400).json({ error: '生体認証の登録に失敗しました' });
  }
});

router.post('/api/webauthn/login-options', async (req, res) => {
  try {
    const { loginId } = req.body;
    if (!loginId) return res.status(400).json({ error: 'ログインIDが必要です' });

    const creds = await loadCredentials(loginId);
    if (creds.length === 0) {
      return res.status(400).json({ error: 'パスキーが登録されていません' });
    }

    const options = await generateAuthenticationOptions({
      rpID: getWebAuthnRpId(req),
      allowCredentials: creds.map(c => ({
        id: c.id,
        transports: c.transports,
      })),
      userVerification: 'required',
    });

    req.session.webauthnChallenge = options.challenge;
    req.session.webauthnLoginId = loginId;
    res.json(options);
  } catch (e) {
    console.error('WebAuthn login-options error:', e.message);
    res.status(500).json({ error: '認証オプションの生成に失敗しました' });
  }
});

router.post('/api/webauthn/login-verify', async (req, res) => {
  const expectedChallenge = req.session.webauthnChallenge;
  const loginId = req.session.webauthnLoginId;
  req.session.webauthnChallenge = null;
  req.session.webauthnLoginId = null;

  if (!expectedChallenge || !loginId) {
    return res.status(400).json({ error: '認証セッションが無効です' });
  }

  try {
    const creds = await loadCredentials(loginId);
    const credential = creds.find(c => c.id === req.body.id);
    if (!credential) {
      return res.status(400).json({ error: '不明な認証情報です' });
    }

    const verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge,
      expectedOrigin: getWebAuthnOrigin(req),
      expectedRPID: getWebAuthnRpId(req),
      credential,
    });

    if (!verification.verified) {
      return res.status(401).json({ error: '認証に失敗しました' });
    }

    await updateCredentialCounter(credential.id, verification.authenticationInfo.newCounter);

    const data = loadStaff();
    const staff = data.staff.find(s => s.id === loginId);
    if (!staff) return res.status(401).json({ error: 'スタッフが見つかりません' });
    if (staff.archived) return res.status(401).json({ error: 'このアカウントは無効化されています' });

    req.session.staffId = staff.id;
    req.session.staffName = staff.name;
    req.session.staffType = staff.type;
    setCsrfCookie(res);
    auditLog(req, 'auth.webauthn_login', { type: 'auth', id: staff.id, label: staff.name });
    res.json({ success: true });
  } catch (e) {
    console.error('WebAuthn login-verify error:', e.message);
    res.status(400).json({ error: '生体認証によるログインに失敗しました' });
  }
});

router.post('/api/webauthn/delete', requireStaff, async (req, res) => {
  try {
    await deleteCredentials(req.session.staffId);
    auditLog(req, 'auth.webauthn_delete', { type: 'auth', id: req.session.staffId, label: req.session.staffName });
    res.json({ success: true });
  } catch (e) {
    console.error('WebAuthn delete error:', e.message);
    res.status(500).json({ error: '削除に失敗しました' });
  }
});

// ─── API: パスワード変更 ────────────────────────────────────────
router.post('/api/change-password', requireStaff, lockedRoute(STAFF_PATH, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: 'パラメータが不足しています' });
  if (newPassword.length < 4 || newPassword.length > 20)
    return res.status(400).json({ error: 'パスワードは4〜20文字で設定してください' });
  if (newPassword !== confirmPassword)
    return res.status(400).json({ error: '新しいパスワードが一致しません' });

  const data  = loadStaff();
  const staff = data.staff.find(s => s.id === req.session.staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  const ok = await bcrypt.compare(currentPassword, staff.password_hash);
  if (!ok) return res.status(401).json({ error: '現在のパスワードが正しくありません' });

  staff.password_hash = await bcrypt.hash(newPassword, 10);
  saveStaff(data);
  auditLog(req, 'auth.change_password', { type: 'auth', id: staff.id, label: staff.name });
  res.json({ success: true });
}));

module.exports = router;
