// CSRF保護: double-submit cookie 方式で実装済み（setCsrfCookie / verifyCsrf）
// データ整合性: SQLiteトランザクション + write-file-atomic で排他制御済み
'use strict';
require('dotenv').config();

const express  = require('express');
const path     = require('path');
const crypto   = require('crypto');
const fs       = require('fs');
const csession = require('cookie-session');
const cron     = require('node-cron');
const helmet   = require('helmet');

// ─── lib/ モジュール ────────────────────────────────────────────
const C = require('./lib/constants');
const { getTodayJST, getNowJST, isWorkday, cleanExpiredRateLimits } = require('./lib/helpers');
const { loadNotices, saveNotices, loadAttendance, saveAttendance, atomicModify } = require('./lib/data');
const { initMail } = require('./lib/mail');
const { cleanExpiredTokens } = require('./lib/data');
const { ensureDataDir } = require('./lib/data');
const { ensurePasswordsHashed, syncNewStaffFromSource, syncLeaveFieldsFromSource, ensureLeaveFields, ensureAdminFields, ensureInitialAdmins, publishReleaseNotes } = require('./lib/startup');
const { createSpreadsheetForYear } = require('./lib/sheets');
const { getAllStaffRecordStatus } = require('./lib/sheets');

// ─── routes/ ────────────────────────────────────────────────────
const authRoutes      = require('./routes/auth');
const recordRoutes    = require('./routes/record');
const schedulesRoutes = require('./routes/schedules');
const leaveRoutes     = require('./routes/leave');
const oncallRoutes    = require('./routes/oncall');
const noticesRoutes   = require('./routes/notices');
const adminRoutes     = require('./routes/admin');

// ─── Express アプリ初期化 ───────────────────────────────────────
const app  = express();
const PORT = C.PORT;

// SESSION_SECRET 未設定時は起動拒否
if (!process.env.SESSION_SECRET) {
  console.error('❌ SESSION_SECRET が設定されていません。.env または環境変数に設定してください。');
  process.exit(1);
}

app.set('trust proxy', 1);

// ─── CSP nonce 生成（リクエスト毎） ──────────────────────────────
app.use((_req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString('base64');
  next();
});

// ─── セキュリティヘッダー ──────────────────────────────────────
const isProd = process.env.NODE_ENV === 'production';
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", (_req, res) => `'nonce-${res.locals.nonce}'`],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc:    ["'self'"],
      objectSrc:  ["'none'"],
      baseUri:    ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

app.use(express.json());
app.use(csession({
  name:     'visit_sess',
  keys:     [process.env.SESSION_SECRET],
  maxAge:   7 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'strict',
  secure:   isProd,
}));

// ─── 静的HTMLファイルの認証ガード ───────────────────────────────
const STAFF_ONLY_HTML = new Set([
  '/index.html', '/history.html', '/change-password.html',
  '/leave.html', '/oncall.html', '/notices.html', '/manual.html',
]);
const ADMIN_ONLY_HTML = new Set(['/admin.html', '/admin-manual.html']);
app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if (STAFF_ONLY_HTML.has(p)) {
    if (!req.session.staffId) return res.redirect('/login');
  } else if (ADMIN_ONLY_HTML.has(p)) {
    if (!req.session.isAdmin) return res.redirect('/admin');
  }
  next();
});

// ─── HTML nonce 注入（<script> タグに nonce 属性を付与） ────────
function sendHtmlWithNonce(res, filePath) {
  const nonce = res.locals.nonce;
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) return res.status(404).send('Not Found');
    html = html.replace(/<script(?=[\s>])/gi, `<script nonce="${nonce}"`);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(html);
  });
}
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (!req.path.endsWith('.html')) return next();
  const filePath = path.join(__dirname, 'public', req.path);
  if (!path.resolve(filePath).startsWith(path.join(__dirname, 'public'))) return next();
  fs.access(filePath, fs.constants.R_OK, (err) => {
    if (err) return next();
    sendHtmlWithNonce(res, filePath);
  });
});

app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders(res, filePath) {
    // HTMLファイルはキャッシュしない（常に最新を配信）
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// ─── CSRF保護（double-submit cookie方式） ──────────────────────
app.use((req, res, next) => {
  if (!req.cookies) {
    req.cookies = {};
    const cookieHeader = req.headers.cookie || '';
    cookieHeader.split(';').forEach(c => {
      const [k, ...v] = c.trim().split('=');
      const key = k ? k.trim() : '';
      if (!key) return;
      const raw = v.join('=');
      if (raw.length > 4096) return;
      try {
        req.cookies[key] = decodeURIComponent(raw);
      } catch {
        req.cookies[key] = raw;
      }
    });
  }
  next();
});
const CSRF_EXEMPT = new Set([
  // ログイン系: セッション未確立のためCSRFトークンが存在しない
  '/api/login', '/api/admin/login', '/api/admin/check',
  // WebAuthn認証: ログインフローの一部でセッション未確立
  '/api/admin/webauthn/login-options', '/api/admin/webauthn/login-verify',
  // パスワードリセット: 未認証ユーザーが使用するためトークン不在
  '/api/forgot-password', '/api/reset-password',
  // WebAuthn（スタッフ側）: ログインフローの一部
  '/api/webauthn/login-options', '/api/webauthn/login-verify',
  // WebAuthn登録オプション: challenge生成のみ（register-verifyはCSRF必須）
  '/api/webauthn/register-options',
]);
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (CSRF_EXEMPT.has(req.path)) return next();
  const cookieToken = req.cookies?.csrf_token;
  const headerToken = req.headers['x-csrf-token'];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'CSRF検証に失敗しました' });
  }
  next();
});

// ─── HTMLルーティング ──────────────────────────────────────────
const { requireAdmin } = require('./lib/auth-middleware');
app.get('/login',           (_r, res) => sendHtmlWithNonce(res, path.join(__dirname, 'public','login.html')));
app.get('/change-password', (req, res) => {
  if (!req.session.staffId) return res.redirect('/login');
  sendHtmlWithNonce(res, path.join(__dirname, 'public','change-password.html'));
});
app.get('/admin',           (_r, res) => sendHtmlWithNonce(res, path.join(__dirname, 'public','admin.html')));
app.get('/admin-manual', requireAdmin, (_req, res) => sendHtmlWithNonce(res, path.join(__dirname, 'public','admin-manual.html')));
app.get('/history', (req, res) => {
  if (!req.session.staffId) return res.redirect('/login');
  sendHtmlWithNonce(res, path.join(__dirname, 'public','history.html'));
});
app.get('/manual', (req, res) => {
  if (!req.session.staffId) return res.redirect('/login');
  sendHtmlWithNonce(res, path.join(__dirname, 'public','manual.html'));
});
app.get('/notices', (req, res) => {
  if (!req.session.staffId) return res.redirect('/login');
  sendHtmlWithNonce(res, path.join(__dirname, 'public','notices.html'));
});
app.get('/leave', (req, res) => {
  if (!req.session.staffId) return res.redirect('/login');
  sendHtmlWithNonce(res, path.join(__dirname, 'public','leave.html'));
});
app.get('/oncall', (req, res) => {
  if (!req.session.staffId) return res.redirect('/login');
  sendHtmlWithNonce(res, path.join(__dirname, 'public','oncall.html'));
});
app.get('/forgot-password', (_r, res) => sendHtmlWithNonce(res, path.join(__dirname, 'public','forgot-password.html')));
app.get('/reset-password',  (_r, res) => sendHtmlWithNonce(res, path.join(__dirname, 'public','reset-password.html')));
app.get('/', (req, res) => {
  if (!req.session.staffId) return res.redirect('/login');
  sendHtmlWithNonce(res, path.join(__dirname, 'public','index.html'));
});

// ─── APIルーターマウント ────────────────────────────────────────
app.use('/', authRoutes);
app.use('/', recordRoutes);
app.use('/', schedulesRoutes);
app.use('/', leaveRoutes);
app.use('/', oncallRoutes);
app.use('/', noticesRoutes);
app.use('/', adminRoutes);

// ─── 運営お知らせ自動発信 ───────────────────────────────────────
function createSystemNotice(title, body, target) {
  atomicModify(() => {
    const data = loadNotices();
    const now = getNowJST();
    const notice = {
      id: 'sys-' + Date.now(),
      date: now.toISOString().slice(0, 10),
      title, body,
      source: 'system',
      createdAt: now.toISOString()
    };
    if (target === 'staff' || target === 'admin') notice.target = target;
    data.notices.push(notice);
    saveNotices(data);
  });
  console.log(`[system] 運営お知らせ作成: ${title}`);
}

// createStaffNotice（リマインダー用）
function createStaffNotice(staffId, title, body) {
  atomicModify(() => {
    const data = loadNotices();
    const now = getNowJST();
    const notice = {
      id: `reminder-${staffId}-${getTodayJST()}`,
      date: now.toISOString().slice(0, 10),
      title, body,
      source: 'system',
      targetStaffId: staffId,
      createdAt: now.toISOString()
    };
    data.notices.push(notice);
    saveNotices(data);
  });
}

// ─── 起動 ──────────────────────────────────────────────────────
async function main() {
  await ensureDataDir();
  await ensurePasswordsHashed();
  ensureLeaveFields();
  ensureAdminFields();
  ensureInitialAdmins();
  initMail();
  cleanExpiredTokens();
  await syncNewStaffFromSource();
  syncLeaveFieldsFromSource();
  publishReleaseNotes();

  // 毎年12/31 23:00 JST に翌年スプレッドシートを自動作成
  cron.schedule('0 23 31 12 *', async () => {
    const nextYear = new Date().getFullYear() + 1;
    console.log(`[cron] ${nextYear}年スプレッドシートを自動作成します...`);
    try {
      const id = await createSpreadsheetForYear(nextYear);
      console.log(`[cron] ✅ 完了: ${id}`);
    } catch (e) {
      if (e.message.startsWith('already_exists:')) {
        console.log(`[cron] ${nextYear}年スプレッドシートは既に存在します`);
      } else {
        console.error('[cron] ❌ エラー:', e.message);
      }
    }
  }, { timezone: 'Asia/Tokyo' });
  console.log('📅 自動作成スケジュール: 毎年 12/31 23:00 に翌年スプレッドシートを作成');

  // 毎月16日 8:00 JST に修正可能期間のお知らせを自動発信
  cron.schedule('0 8 16 * *', () => {
    const now = getNowJST();
    const m = now.getMonth() + 1;
    const y = now.getFullYear();
    createSystemNotice(
      `修正可能期間のお知らせ（${m}月）`,
      `${y}年${m}月の修正可能期間は ${m}月16日〜${m}月20日 です。\n\n締日（${m}月15日）以前のデータに修正がある方は、この期間内に修正をお願いします。\n20日を過ぎると修正できなくなりますのでご注意ください。`,
      'staff'
    );
  }, { timezone: 'Asia/Tokyo' });
  console.log('📢 運営お知らせスケジュール: 毎月16日 8:00 に修正可能期間を自動通知');

  // 毎日18:00 JST 平日のみ: 未入力リマインダーを自動送信
  cron.schedule('0 18 * * 1-5', async () => {
    const today = getTodayJST();
    if (!isWorkday(today)) return;

    console.log(`[cron] 未入力リマインダーチェック: ${today}`);
    try {
      const results = await getAllStaffRecordStatus(today);
      const d = new Date(today + 'T00:00:00');
      const dateLabel = `${d.getMonth() + 1}月${d.getDate()}日（${C.WD[d.getDay()]}）`;

      for (const s of results.missing) {
        const notices = loadNotices();
        const alreadySent = notices.notices.some(n =>
          n.id === `reminder-${s.id}-${today}` ||
          (n.targetStaffId === s.id && n.title && n.title.includes(today))
        );
        if (alreadySent) continue;

        await createStaffNotice(s.id,
          `${dateLabel}の記録が未入力です`,
          `本日の訪問記録がまだ入力されていません。\n忘れずに入力をお願いします。`
        );
      }
      if (results.missing.length > 0) {
        console.log(`[cron] リマインダー送信: ${results.missing.map(s => s.name).join(', ')}`);
      }

      // 出勤自動確定
      atomicModify(() => {
        const attendanceData = loadAttendance();
        if (!attendanceData.records[today]) attendanceData.records[today] = {};
        for (const s of results.entered) {
          if (!attendanceData.records[today][s.id]) {
            attendanceData.records[today][s.id] = {
              status: 'confirmed', source: 'auto',
              updatedAt: new Date().toISOString(),
            };
          }
        }
        for (const s of results.onLeave) {
          if (!attendanceData.records[today][s.id]) {
            attendanceData.records[today][s.id] = {
              status: 'leave', source: 'auto',
              updatedAt: new Date().toISOString(),
            };
          }
        }
        saveAttendance(attendanceData);
      });
      console.log(`[cron] 出勤自動確定: confirmed=${results.entered.length}, leave=${results.onLeave.length}`);
    } catch (e) {
      console.error('[cron] リマインダーエラー:', e.message);
    }
  }, { timezone: 'Asia/Tokyo' });
  console.log('📝 未入力リマインダー & 出勤自動確定: 毎日 18:00 (JST) 平日のみ');

  // 毎日0:00 JST: 期限切れリセットトークン・レート制限エントリを削除
  cron.schedule('0 0 * * *', () => { cleanExpiredTokens(); cleanExpiredRateLimits(); }, { timezone: 'Asia/Tokyo' });

  // 毎日 02:00 JST: システムヘルスチェック
  cron.schedule('0 2 * * *', () => {
    const { runHealthChecks } = require('./lib/health');
    const result = runHealthChecks();
    if (result.ok) {
      console.log('[health] ✅ 全チェック正常:', result.checkedAt);
    } else {
      const failed = result.checks.filter(c => !c.ok).map(c => `${c.name}(${c.detail})`).join(', ');
      console.error('[health] ❌ 異常検知:', failed);
    }
  }, { timezone: 'Asia/Tokyo' });

  app.listen(PORT, () => console.log(`✅ Server → http://localhost:${PORT}`));
}
// テスト時は自動起動しない（test-api.js が ensureDataDir() を手動呼び出す）
if (process.env.NODE_ENV !== 'test') {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { app, main };
