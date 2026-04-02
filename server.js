// CSRF保護: double-submit cookie 方式で実装済み（setCsrfCookie / verifyCsrf）
// データ整合性: write-file-atomic + withFileLock / lockedRoute で排他制御済み
// TODO: スケール時はJSONファイルI/OをSQLiteに移行（複数インスタンス対応）
'use strict';
require('dotenv').config();

const express  = require('express');
const path     = require('path');
const crypto   = require('crypto');
const csession = require('cookie-session');
const cron     = require('node-cron');
const helmet   = require('helmet');

// ─── lib/ モジュール ────────────────────────────────────────────
const C = require('./lib/constants');
const { getTodayJST, isWorkday } = require('./lib/helpers');
const { loadNotices, saveNotices, loadAttendance, saveAttendance } = require('./lib/data');
const { initMail } = require('./lib/mail');
const { cleanExpiredTokens } = require('./lib/data');
const { ensureDataDir } = require('./lib/data');
const { ensurePasswordsHashed, syncNewStaffFromSource, syncLeaveFieldsFromSource, ensureLeaveFields, ensureAdminFields, ensureFirstAdmin, publishReleaseNotes } = require('./lib/startup');
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

// ─── セキュリティヘッダー ──────────────────────────────────────
const isProd = process.env.NODE_ENV === 'production';
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
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
  name:    'visit_sess',
  keys:    [process.env.SESSION_SECRET || 'dev-secret-please-change'],
  maxAge:  7 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'strict',
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
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ─── CSRF保護（double-submit cookie方式） ──────────────────────
app.use((req, res, next) => {
  if (!req.cookies) {
    req.cookies = {};
    const cookieHeader = req.headers.cookie || '';
    cookieHeader.split(';').forEach(c => {
      const [k, ...v] = c.trim().split('=');
      if (k) req.cookies[k] = v.join('=');
    });
  }
  next();
});
const CSRF_EXEMPT = new Set([
  '/api/login', '/api/admin/login', '/api/admin/login/totp',
  '/api/admin/totp/setup', '/api/admin/totp/setup/confirm',
  '/api/forgot-password', '/api/reset-password',
  '/api/webauthn/login-options', '/api/webauthn/login-verify',
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
app.get('/login',           (_r, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/change-password', (req, res) => {
  if (!req.session.staffId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'change-password.html'));
});
app.get('/admin',           (_r, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin-manual', requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-manual.html')));
app.get('/history', (req, res) => {
  if (!req.session.staffId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'history.html'));
});
app.get('/manual', (req, res) => {
  if (!req.session.staffId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'manual.html'));
});
app.get('/notices', (req, res) => {
  if (!req.session.staffId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'notices.html'));
});
app.get('/leave', (req, res) => {
  if (!req.session.staffId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'leave.html'));
});
app.get('/oncall', (req, res) => {
  if (!req.session.staffId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'oncall.html'));
});
app.get('/forgot-password', (_r, res) => res.sendFile(path.join(__dirname, 'public', 'forgot-password.html')));
app.get('/reset-password',  (_r, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));
app.get('/', (req, res) => {
  if (!req.session.staffId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
function createSystemNotice(title, body) {
  const data = loadNotices();
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const notice = {
    id: 'sys-' + Date.now(),
    date: now.toISOString().slice(0, 10),
    title, body,
    source: 'system',
    createdAt: now.toISOString()
  };
  data.notices.push(notice);
  saveNotices(data);
  console.log(`[system] 運営お知らせ作成: ${title}`);
  return notice;
}

// createStaffNotice（リマインダー用）
const { withFileLock } = require('./lib/helpers');
async function createStaffNotice(staffId, title, body) {
  return await withFileLock(C.NOTICES_PATH, async () => {
    const data = loadNotices();
    const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
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
    return notice;
  });
}

// ─── 起動 ──────────────────────────────────────────────────────
async function main() {
  await ensureDataDir();
  await ensurePasswordsHashed();
  ensureLeaveFields();
  ensureAdminFields();
  ensureFirstAdmin();
  initMail();
  cleanExpiredTokens();
  await syncNewStaffFromSource();
  syncLeaveFieldsFromSource();
  publishReleaseNotes();

  // 毎年12/31 23:00に翌年スプレッドシートを自動作成
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
  });
  console.log('📅 自動作成スケジュール: 毎年 12/31 23:00 に翌年スプレッドシートを作成');

  // 毎月16日 8:00 に修正可能期間のお知らせを自動発信
  cron.schedule('0 8 16 * *', () => {
    const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const m = now.getMonth() + 1;
    const y = now.getFullYear();
    createSystemNotice(
      `修正可能期間のお知らせ（${m}月）`,
      `${y}年${m}月の修正可能期間は ${m}月16日〜${m}月20日 です。\n\n締日（${m}月15日）以前のデータに修正がある方は、この期間内に修正をお願いします。\n20日を過ぎると修正できなくなりますのでご注意ください。`
    );
  });
  console.log('📢 運営お知らせスケジュール: 毎月16日 8:00 に修正可能期間を自動通知');

  // 毎日18:00（JST）平日のみ: 未入力リマインダーを自動送信
  cron.schedule('0 9 * * 1-5', async () => {
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
      console.log(`[cron] 出勤自動確定: confirmed=${results.entered.length}, leave=${results.onLeave.length}`);
    } catch (e) {
      console.error('[cron] リマインダーエラー:', e.message);
    }
  });
  console.log('📝 未入力リマインダー & 出勤自動確定: 毎日 18:00 (JST) 平日のみ');

  // 毎日0:00 UTC: 期限切れリセットトークンを削除
  cron.schedule('0 0 * * *', () => { cleanExpiredTokens(); });

  app.listen(PORT, () => console.log(`✅ Server → http://localhost:${PORT}`));
}
main().catch(e => { console.error(e); process.exit(1); });

// テスト用エクスポート
module.exports = { app };
