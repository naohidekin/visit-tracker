'use strict';
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { generateAuthenticationOptions, verifyAuthenticationResponse } = require('@simplewebauthn/server');

const { loadStaff, saveStaff, atomicModify } = require('../lib/data');
const { requireAdmin, setCsrfCookie } = require('../lib/auth-middleware');
const { checkRateLimit, asyncRoute } = require('../lib/helpers');
const { auditLog } = require('../lib/audit');
const { loadCredentials, updateCredentialCounter, getWebAuthnRpId, getWebAuthnOrigin } = require('../lib/webauthn');

// Face ID有無チェック（ログイン画面でUIを切り替える用）
router.post('/api/admin/check', async (req, res) => {
  try {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    if (!checkRateLimit(`admin-check-ip:${ip}`, 10, 60000))
      return res.status(429).json({ exists: false });
    const { staffId } = req.body;
    if (!staffId || typeof staffId !== 'string' || staffId.length > 50)
      return res.json({ exists: false });
    const data = loadStaff();
    const staff = data.staff.find(s => s.id === staffId && !s.archived && s.is_admin);
    if (!staff) return res.json({ exists: false });
    const creds = await loadCredentials(staffId);
    return res.json({ exists: true, hasFaceId: creds.length > 0 });
  } catch { return res.json({ exists: false }); }
});

// ルートA: パスワードログイン（Face ID未登録者向け、8文字以上）
router.post('/api/admin/login', async (req, res) => {
  try {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    if (!checkRateLimit(`admin-login-ip:${ip}`, 5, 300000))
      return res.status(429).json({ error: 'ログイン試行回数が上限を超えました。しばらく待ってから再度お試しください' });

    const { staffId, password } = req.body;

    // --- パスワード認証 ---
    if (!staffId || !password) {
      return res.status(400).json({ error: 'スタッフIDとパスワードを入力してください' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'パスワードは8文字以上必要です。スタッフ画面でパスワードを変更してください', code: 'PASSWORD_TOO_SHORT' });
    }

    if (!checkRateLimit(`admin-login-id:${staffId}`, 5, 300000))
      return res.status(429).json({ error: 'ログイン試行回数が上限を超えました' });

    const data = loadStaff();
    const staff = data.staff.find(s => s.id === staffId && !s.archived);
    if (!staff || !staff.is_admin) {
      auditLog(req, 'auth.admin_login_failed', { type: 'auth', label: `管理者ログイン失敗: ${staffId || '不明'}` });
      return res.status(401).json({ error: 'IDまたはパスワードが正しくありません' });
    }
    if (!staff.password_hash) {
      return res.status(401).json({ error: 'パスワードが設定されていません' });
    }
    const match = await bcrypt.compare(password, staff.password_hash);
    if (!match) {
      auditLog(req, 'auth.admin_login_failed', { type: 'auth', id: staffId, label: `管理者ログイン失敗: ${staff.name}` });
      return res.status(401).json({ error: 'IDまたはパスワードが正しくありません' });
    }

    // 認証成功
    req.session.isAdmin = true;
    req.session.adminStaffId = staffId;
    req.session.adminStaffName = staff.name;
    req.session.staffId = staffId;
    req.session.staffName = staff.name;
    req.session.staffType = staff.type;
    setCsrfCookie(res);
    auditLog(req, 'auth.admin_login', { type: 'auth', id: staffId, label: staff.name });
    return res.json({ success: true });
  } catch (e) {
    console.error('管理者ログインエラー:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ルートB: Face IDログイン（IDだけ入力 → Face ID → 完了）
router.post('/api/admin/webauthn/login-options', async (req, res) => {
  try {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    if (!checkRateLimit(`admin-login-ip:${ip}`, 5, 300000))
      return res.status(429).json({ error: 'ログイン試行回数が上限を超えました' });

    const { staffId } = req.body;
    if (!staffId) return res.status(400).json({ error: 'スタッフIDを入力してください' });

    // 管理者かつFace ID登録済みか確認
    const data = loadStaff();
    const staff = data.staff.find(s => s.id === staffId && !s.archived && s.is_admin);
    if (!staff) return res.status(401).json({ error: 'IDが正しくありません' });

    const creds = await loadCredentials(staffId);
    if (creds.length === 0) return res.status(400).json({ error: 'Face IDが登録されていません' });

    req.session.pendingAdminStaffId = staffId;

    const options = await generateAuthenticationOptions({
      rpID: getWebAuthnRpId(req),
      allowCredentials: creds.map(c => ({ id: c.id, transports: c.transports })),
      userVerification: 'required',
    });
    req.session.adminWebAuthnChallenge = options.challenge;
    res.json(options);
  } catch (e) {
    console.error('管理者WebAuthnオプションエラー:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ステップ2: WebAuthn（Face ID）認証検証
router.post('/api/admin/webauthn/login-verify', async (req, res) => {
  try {
    const pendingId = req.session.pendingAdminStaffId;
    const expectedChallenge = req.session.adminWebAuthnChallenge;
    if (!pendingId || !expectedChallenge) return res.status(401).json({ error: '認証セッションが無効です' });

    const creds = await loadCredentials(pendingId);
    const credential = creds.find(c => c.id === req.body.id);
    if (!credential) return res.status(401).json({ error: '認証情報が見つかりません' });

    const verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge,
      expectedOrigin: getWebAuthnOrigin(req),
      expectedRPID: getWebAuthnRpId(req),
      credential: {
        id: credential.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: credential.transports,
      },
    });

    if (!verification.verified) {
      auditLog(req, 'auth.admin_webauthn_failed', { type: 'auth', id: pendingId, label: `Face ID失敗` });
      return res.status(401).json({ error: 'Face ID認証に失敗しました' });
    }

    // カウンター更新（リプレイ攻撃防止）
    const newCounter = verification.authenticationInfo.newCounter;
    await updateCredentialCounter(credential.id, newCounter);

    // 認証成功 — セッション発行直前に is_admin / archived を再確認
    const data = loadStaff();
    const staff = data.staff.find(s => s.id === pendingId);
    if (!staff || !staff.is_admin || staff.archived) {
      delete req.session.pendingAdminStaffId;
      delete req.session.adminWebAuthnChallenge;
      auditLog(req, 'auth.admin_login_failed', { type: 'auth', id: pendingId, label: 'Face ID成功後に管理者権限なし' });
      return res.status(401).json({ error: '管理者権限がありません' });
    }
    req.session.isAdmin = true;
    req.session.adminStaffId = pendingId;
    req.session.adminStaffName = staff.name;
    req.session.staffId = pendingId;
    req.session.staffName = staff.name;
    req.session.staffType = staff.type;
    delete req.session.pendingAdminStaffId;
    delete req.session.adminWebAuthnChallenge;
    setCsrfCookie(res);
    auditLog(req, 'auth.admin_login', { type: 'auth', id: pendingId, label: staff.name });
    res.json({ success: true });
  } catch (e) {
    console.error('管理者WebAuthn検証エラー:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 管理者情報取得
router.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({
    id: req.session.adminStaffId || null,
    name: req.session.adminStaffName || '管理者',
  });
});

// 管理者権限付与
router.post('/api/admin/staff/:id/grant-admin', requireAdmin, asyncRoute(async (req, res) => {
  const result = atomicModify(() => {
    const data = loadStaff();
    const staff = data.staff.find(s => s.id === req.params.id);
    if (!staff) return { error: 'スタッフが見つかりません', status: 404 };
    if (staff.is_admin) return { alreadyAdmin: true };
    staff.is_admin = true;
    saveStaff(data);
    return { staffName: staff.name };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  if (result.alreadyAdmin) return res.json({ success: true, message: '既に管理者です' });
  auditLog(req, 'admin.grant_admin', { type: 'admin', id: req.params.id, label: `管理者権限付与: ${result.staffName}`, by: req.session.adminStaffId });
  res.json({ success: true });
}));

// 管理者権限剥奪
router.post('/api/admin/staff/:id/revoke-admin', requireAdmin, asyncRoute(async (req, res) => {
  if (req.params.id === req.session.adminStaffId) return res.status(400).json({ error: '自分の管理者権限は削除できません' });
  const result = atomicModify(() => {
    const data = loadStaff();
    const staff = data.staff.find(s => s.id === req.params.id);
    if (!staff) return { error: 'スタッフが見つかりません', status: 404 };
    staff.is_admin = false;
    saveStaff(data);
    return { staffName: staff.name };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  auditLog(req, 'admin.revoke_admin', { type: 'admin', id: req.params.id, label: `管理者権限剥奪: ${result.staffName}`, by: req.session.adminStaffId });
  res.json({ success: true });
}));

router.post('/api/admin/logout', (req, res) => {
  const name = req.session.adminStaffName || '管理者';
  auditLog(req, 'auth.admin_logout', { type: 'auth', label: name });
  req.session = null;
  res.clearCookie('csrf_token');
  res.json({ success: true });
});

module.exports = router;
