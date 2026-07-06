'use strict';
/**
 * 統合テスト: 認証・権限・有給承認・オンコール集計
 * 実行: node test-api.js
 *
 * 独立した一時 SQLite DB を使用し、本番データに影響を与えない。
 */

const os    = require('os');
const path  = require('path');
const fs    = require('fs');
const assert = require('assert');

// ── テスト用環境変数（モジュール読み込み前に設定すること） ────────
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'visit-test-'));
process.env.DATA_DIR       = TEST_DIR;
process.env.SESSION_SECRET = 'test-secret-for-api-integration-tests';
process.env.NODE_ENV       = 'test';
process.env.SPREADSHEET_ID = 'dummy-sheet-id';
// Google Sheets・メール送信を無効化
delete process.env.GOOGLE_CREDENTIALS;

// ── ライブラリ読み込み ────────────────────────────────────────────
const request = require('supertest');
const bcrypt  = require('bcryptjs');
const { getDb }         = require('./lib/db');
const { ensureDataDir } = require('./lib/data');
const { getTodayJST }   = require('./lib/helpers');

// ── テストランナー ────────────────────────────────────────────────
let passed = 0;
let failed = 0;

// レート制限をリセット（テスト間の干渉を防ぐ）
function clearRateLimits() {
  try { getDb().prepare('DELETE FROM rate_limit').run(); }
  catch (e) { console.warn('⚠️ rate_limit クリア失敗:', e.message); }
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

// ── テストデータ投入 ──────────────────────────────────────────────
async function seedData() {
  await ensureDataDir(); // DB 初期化 + JSON マイグレーション
  const db = getDb();

  // rounds=4 でテスト高速化（本番は 10 以上）
  const makeStaff = (id, name, type, password, is_admin, archived = false) => ({
    id, name, type,
    password_hash: bcrypt.hashSync(password, 4),
    is_admin, archived,
    hire_date: '2024-04-01',
    oncall_eligible: true,
    leave_granted: 10,
    leave_carried_over: 2,
    leave_manual_adjustment: 0,
    oncall_leave_granted: 0,
    email: null,
  });

  const staffList = [
    makeStaff('t_nurse',    'テスト看護師',   'nurse', 'nurse123',   false),
    makeStaff('t_admin',    'テスト管理者',   'admin', 'Admin12345', true),
    makeStaff('t_archived', 'アーカイブ済み', 'nurse', 'nurse123',   false, true),
  ];

  for (const s of staffList) {
    db.prepare('INSERT OR REPLACE INTO staff (id, data) VALUES (?, ?)').run(
      s.id, JSON.stringify(s)
    );
  }
}

// ── ヘルパー: ログインしてエージェントと CSRF トークンを返す ──────
async function loginAs(app, loginId, password, isAdmin = false) {
  const agent    = request.agent(app);
  const endpoint = isAdmin ? '/api/admin/login' : '/api/login';
  const body     = isAdmin
    ? { staffId: loginId, password }
    : { loginId, password };

  const res     = await agent.post(endpoint).send(body);
  const cookies = res.headers['set-cookie'] || [];
  const csrfRaw = cookies.find(c => c.startsWith('csrf_token='));
  // csrf_token=<hex>; Path=/ の形式から値だけ抽出
  const csrfToken = csrfRaw?.split(';')[0]?.split('=').slice(1).join('=') ?? '';
  return { agent, csrfToken, res };
}

// ── テスト本体 ────────────────────────────────────────────────────
async function runTests(app) {

  // ────────────────────────────────────────────────────────────
  console.log('\n📌 認証テスト');

  await test('ログイン失敗: パスワード誤り → 401', async () => {
    const res = await request(app).post('/api/login')
      .send({ loginId: 't_nurse', password: 'wrongpass' });
    assert.strictEqual(res.status, 401);
  });

  await test('ログイン成功 → 200 + success:true', async () => {
    const { res } = await loginAs(app, 't_nurse', 'nurse123');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
  });

  await test('アーカイブ済みスタッフはログイン拒否 → 401', async () => {
    const res = await request(app).post('/api/login')
      .send({ loginId: 't_archived', password: 'nurse123' });
    assert.strictEqual(res.status, 401);
  });

  await test('ログアウト → 200', async () => {
    const { agent, csrfToken } = await loginAs(app, 't_nurse', 'nurse123');
    const res = await agent.post('/api/logout').set('x-csrf-token', csrfToken);
    assert.strictEqual(res.status, 200);
  });

  clearRateLimits();
  // ────────────────────────────────────────────────────────────
  console.log('\n📌 CSRF テスト');

  await test('CSRF トークンなしの POST → 403', async () => {
    const { agent } = await loginAs(app, 't_nurse', 'nurse123');
    const res = await agent.post('/api/logout'); // x-csrf-token ヘッダーなし
    assert.strictEqual(res.status, 403);
  });

  await test('CSRF トークン不一致の POST → 403', async () => {
    const { agent } = await loginAs(app, 't_nurse', 'nurse123');
    const res = await agent.post('/api/logout').set('x-csrf-token', 'tampered');
    assert.strictEqual(res.status, 403);
  });

  clearRateLimits();
  // ────────────────────────────────────────────────────────────
  console.log('\n📌 管理者権限テスト');

  await test('未認証でスタッフ一覧 → 401', async () => {
    const res = await request(app).get('/api/admin/staff');
    assert.strictEqual(res.status, 401);
  });

  await test('スタッフ権限でスタッフ一覧 → 401', async () => {
    const { agent } = await loginAs(app, 't_nurse', 'nurse123');
    const res = await agent.get('/api/admin/staff');
    assert.strictEqual(res.status, 401);
  });

  await test('管理者ログイン成功 → 200', async () => {
    const { res } = await loginAs(app, 't_admin', 'Admin12345', true);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
  });

  await test('管理者権限でスタッフ一覧取得 → 200 + 配列', async () => {
    const { agent } = await loginAs(app, 't_admin', 'Admin12345', true);
    const res = await agent.get('/api/admin/staff?includeArchived=true');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body), 'スタッフ配列が返る');
    const ids = res.body.map(s => s.id);
    assert.ok(ids.includes('t_nurse'), 't_nurse が含まれる');
    assert.ok(!res.body.some(s => s.password_hash), 'password_hash は除外済み');
  });

  clearRateLimits();
  // ────────────────────────────────────────────────────────────
  console.log('\n📌 アーカイブ後のセッション拒否テスト');

  await test('スタッフ稼働中 → アーカイブ → 次リクエストで 401', async () => {
    // t_nurse でログイン
    const { agent: staffAgent, csrfToken: staffCsrf } =
      await loginAs(app, 't_nurse', 'nurse123');

    // ログイン中は requireStaff ガード付きエンドポイントが通る
    const balanceBefore = await staffAgent.get('/api/leave/balance')
      .set('x-csrf-token', staffCsrf);
    assert.strictEqual(balanceBefore.status, 200, 'アーカイブ前は 200');

    // 管理者でアーカイブ
    const { agent: adminAgent, csrfToken: adminCsrf } =
      await loginAs(app, 't_admin', 'Admin12345', true);

    try {
      const archiveRes = await adminAgent
        .patch('/api/admin/staff/t_nurse/archive')
        .set('x-csrf-token', adminCsrf);
      assert.strictEqual(archiveRes.status, 200);
      assert.strictEqual(archiveRes.body.archived, true);

      // アーカイブ後: 既存セッションのリクエストは 401
      const balanceAfter = await staffAgent.get('/api/leave/balance')
        .set('x-csrf-token', staffCsrf);
      assert.strictEqual(balanceAfter.status, 401, 'アーカイブ後は 401');
    } finally {
      // 後続テストのために必ず元に戻す
      await adminAgent
        .patch('/api/admin/staff/t_nurse/archive')
        .set('x-csrf-token', adminCsrf);
    }
  });

  clearRateLimits();
  // ────────────────────────────────────────────────────────────
  console.log('\n📌 有給申請・承認テスト');

  let leaveRequestId;

  await test('有給申請（スタッフ） → 200 + ID返却', async () => {
    const { agent, csrfToken } = await loginAs(app, 't_nurse', 'nurse123');
    const res = await agent.post('/api/leave/requests')
      .set('x-csrf-token', csrfToken)
      .send({ type: 'full', startDate: '2028-02-10', endDate: '2028-02-10' });
    assert.ok(res.status === 200 || res.status === 201, `status=${res.status} body=${JSON.stringify(res.body)}`);
    leaveRequestId = res.body.id ?? res.body.request?.id;
    assert.ok(leaveRequestId, '申請 ID が返る');
  });

  await test('有給申請一覧取得（スタッフ） → 200 + 配列', async () => {
    const { agent, csrfToken } = await loginAs(app, 't_nurse', 'nurse123');
    const res = await agent.get('/api/leave/requests')
      .set('x-csrf-token', csrfToken);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.requests), `requests 配列が返る body=${JSON.stringify(res.body)}`);
    assert.ok(res.body.requests.length >= 1, '1件以上ある');
  });

  await test('有給承認（管理者） → 200', async () => {
    assert.ok(leaveRequestId, '申請 ID が取得済み');
    const { agent, csrfToken } = await loginAs(app, 't_admin', 'Admin12345', true);
    const res = await agent
      .post(`/api/admin/leave/requests/${leaveRequestId}/approve`)
      .set('x-csrf-token', csrfToken)
      .send({ comment: '承認しました' });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.ok === true || res.body.success === true, `承認レスポンス body=${JSON.stringify(res.body)}`);
  });

  await test('承認済み申請のステータス確認 → approved', async () => {
    assert.ok(leaveRequestId, '申請 ID が取得済み');
    const { agent, csrfToken } = await loginAs(app, 't_nurse', 'nurse123');
    const res = await agent.get('/api/leave/requests')
      .set('x-csrf-token', csrfToken);
    const req = res.body.requests?.find(r => r.id === leaveRequestId);
    assert.ok(req, '申請が見つかる');
    assert.strictEqual(req.status, 'approved');
  });

  clearRateLimits();
  // ────────────────────────────────────────────────────────────
  console.log('\n📌 有給付与記録・お知らせテスト');

  await test('付与記録: アラート→反映→履歴記録＆本人お知らせ、二度付け防止', async () => {
    const { agent: admin, csrfToken: adminCsrf } = await loginAs(app, 't_admin', 'Admin12345', true);
    const setBalance = (body) => admin.post('/api/admin/staff/t_nurse/leave-balance')
      .set('x-csrf-token', adminCsrf).send(body);
    try {
      // 入社日を過去に設定（付与基準日を全て通過させる）＋付与日数を0に
      const hireRes = await admin.post('/api/admin/staff/t_nurse/hire-date')
        .set('x-csrf-token', adminCsrf).send({ hire_date: '2020-01-01' });
      assert.strictEqual(hireRes.status, 200);
      await setBalance({ granted: 0, carried_over: 0, manual_adjustment: 0 });

      // アラート一覧に出る（規定上の基準日=マイルストーン日を控えておく）
      const alerts = await admin.get('/api/admin/leave/grant-alerts');
      assert.strictEqual(alerts.status, 200);
      const alert = alerts.body.alerts.find(a => a.id === 't_nurse');
      assert.ok(alert, 'grant-alerts に t_nurse が出る');
      const milestoneDate = alert.reached_date;

      // 反映フラグ付きでも、保存された付与日数が規定未満なら記録・通知しない
      const lowered = await setBalance({ granted: 5, record_grant: true });
      assert.strictEqual(lowered.body.grant_recorded, false, '付与日数が規定未満なら記録しない');
      const afterLow = await admin.get('/api/admin/leave/summary');
      assert.strictEqual(afterLow.body.summary.find(s => s.id === 't_nurse').grant_history.length, 0, '未記録のまま');

      // 付与を反映（record_grant, 規定どおり）→ 記録される
      const applied = await setBalance({ granted: 20, record_grant: true });
      assert.strictEqual(applied.status, 200);
      assert.strictEqual(applied.body.grant_recorded, true, '付与が記録される');

      // 履歴に1件、アラートから消える
      const summary = await admin.get('/api/admin/leave/summary');
      const row = summary.body.summary.find(s => s.id === 't_nurse');
      assert.strictEqual(row.grant_history.length, 1, '付与履歴が1件');
      assert.strictEqual(row.pending_grant, null, 'アラート対象から外れる');
      // 付与日は「クリック日」ではなく規定上の基準日（マイルストーン日）
      assert.strictEqual(row.grant_history[0].grantedAt, milestoneDate, '履歴の付与日=マイルストーン日');
      assert.strictEqual(row.grant_date, milestoneDate, 'grant_date=マイルストーン日（クリック日ではない）');
      assert.ok(row.grant_history[0].label, '付与履歴にラベルがサーバ側で付く');

      // 二度付け防止：同じ時期を再度反映しても記録されない
      const again = await setBalance({ granted: 20, record_grant: true });
      assert.strictEqual(again.body.grant_recorded, false, '二度付けされない');

      // 本人に個別お知らせが届く
      const { agent: staff, csrfToken: staffCsrf } = await loginAs(app, 't_nurse', 'nurse123');
      const notices = await staff.get('/api/notices').set('x-csrf-token', staffCsrf);
      assert.ok(notices.body.notices.some(n => n.title === '有給休暇が付与されました'), '付与お知らせが本人に届く');
    } finally {
      // 後続テストのため状態を戻す（付与日数・入社日）
      await setBalance({ granted: 0, carried_over: 0, manual_adjustment: 0 });
    }
  });

  await test('管理サマリの残: お祝い休暇での取得は有給から差し引かない', async () => {
    const { agent: admin, csrfToken: adminCsrf } = await loginAs(app, 't_admin', 'Admin12345', true);
    const today = getTodayJST();
    try {
      // 入社日を当日に設定（お祝い休暇有効期間内）＋付与10・お祝い5
      await admin.post('/api/admin/staff/t_nurse/hire-date')
        .set('x-csrf-token', adminCsrf).send({ hire_date: today });
      await admin.post('/api/admin/staff/t_nurse/leave-balance')
        .set('x-csrf-token', adminCsrf)
        .send({ granted: 10, carried_over: 0, manual_adjustment: 0, celebration_days: 5, celebration_used_adj: 0 });

      // お祝い休暇申請“前”の残・使用を控える（他テストの承認済み申請の影響を排除）
      const before = await admin.get('/api/admin/leave/summary');
      const beforeRow = before.body.summary.find(s => s.id === 't_nurse');

      // 本人がお祝い休暇（type=celebration）を1日申請 → 管理者が承認
      const { agent: staff, csrfToken: staffCsrf } = await loginAs(app, 't_nurse', 'nurse123');
      const reqRes = await staff.post('/api/leave/requests')
        .set('x-csrf-token', staffCsrf)
        .send({ type: 'celebration', startDate: today, endDate: today });
      assert.ok(reqRes.status === 200 || reqRes.status === 201, `申請 status=${reqRes.status} body=${JSON.stringify(reqRes.body)}`);
      const reqId = reqRes.body.id ?? reqRes.body.request?.id;
      const apRes = await admin.post(`/api/admin/leave/requests/${reqId}/approve`)
        .set('x-csrf-token', adminCsrf).send({ comment: 'ok' });
      assert.strictEqual(apRes.status, 200);

      // 管理サマリ: お祝い休暇取得分は有給残・使用に影響しない（前後で不変）
      const after = await admin.get('/api/admin/leave/summary');
      const afterRow = after.body.summary.find(s => s.id === 't_nurse');
      assert.strictEqual(afterRow.used, beforeRow.used, 'お祝い休暇取得で有給の使用は増えない');
      assert.strictEqual(afterRow.balance, beforeRow.balance, 'お祝い休暇取得で有給残は減らない');
    } finally {
      await admin.post('/api/admin/staff/t_nurse/leave-balance')
        .set('x-csrf-token', adminCsrf)
        .send({ granted: 0, carried_over: 0, manual_adjustment: 0, celebration_used_adj: 0 });
    }
  });

  await test('管理者: 本人ビュー内訳の取得（本人 /api/leave/balance と一致）', async () => {
    const { agent: admin } = await loginAs(app, 't_admin', 'Admin12345', true);
    const adminView = await admin.get('/api/admin/staff/t_nurse/leave-balance-view');
    assert.strictEqual(adminView.status, 200);
    assert.strictEqual(typeof adminView.body.balance, 'number', 'balance が返る');
    assert.ok('celebration_remaining' in adminView.body, 'お祝い休暇残を含む');
    // 本人が自分の /api/leave/balance で見る値と一致する
    const { agent: staff } = await loginAs(app, 't_nurse', 'nurse123');
    const own = await staff.get('/api/leave/balance');
    assert.strictEqual(adminView.body.balance, own.body.balance, '本人画面と残日数が一致');
    assert.strictEqual(adminView.body.used, own.body.used, '本人画面と使用日数が一致');
    // 存在しない職員 → 404
    const nf = await admin.get('/api/admin/staff/__nope__/leave-balance-view');
    assert.strictEqual(nf.status, 404);
  });

  await test('管理者: 承認済み申請の取消 → cancelled・本人へ通知', async () => {
    const { agent: admin, csrfToken: adminCsrf } = await loginAs(app, 't_admin', 'Admin12345', true);
    try {
      // お祝い休暇への自動変換を避けるため入社日は過去（お祝い期限切れ）＋付与10
      await admin.post('/api/admin/staff/t_nurse/hire-date')
        .set('x-csrf-token', adminCsrf).send({ hire_date: '2020-01-01' });
      await admin.post('/api/admin/staff/t_nurse/leave-balance')
        .set('x-csrf-token', adminCsrf).send({ granted: 10, carried_over: 0, manual_adjustment: 0 });

      // 本人が有給申請 → 管理者が承認
      const { agent: staff, csrfToken: staffCsrf } = await loginAs(app, 't_nurse', 'nurse123');
      const reqRes = await staff.post('/api/leave/requests')
        .set('x-csrf-token', staffCsrf).send({ type: 'full', startDate: '2028-05-15', endDate: '2028-05-15' });
      const reqId = reqRes.body.id ?? reqRes.body.request?.id;
      assert.ok(reqId, `申請ID body=${JSON.stringify(reqRes.body)}`);
      const ap = await admin.post(`/api/admin/leave/requests/${reqId}/approve`)
        .set('x-csrf-token', adminCsrf).send({ comment: 'ok' });
      assert.strictEqual(ap.status, 200);

      // 管理者が承認済み申請を取消
      const cancel = await admin.post(`/api/admin/leave/requests/${reqId}/cancel`)
        .set('x-csrf-token', adminCsrf).send({});
      assert.strictEqual(cancel.status, 200);
      assert.strictEqual(cancel.body.ok, true, '取消成功');

      // ステータスが cancelled になり、使用日数から外れる
      const hist = await admin.get('/api/admin/leave/requests');
      assert.strictEqual(hist.body.requests.find(r => r.id === reqId).status, 'cancelled', '取消済みになる');
      // 本人に取消通知
      const notices = await staff.get('/api/notices').set('x-csrf-token', staffCsrf);
      assert.ok(notices.body.notices.some(n => n.title === '有給申請が取り消されました'), '取消通知が本人に届く');
      // 存在しない申請 → 404
      const nf = await admin.post('/api/admin/leave/requests/__nope__/cancel')
        .set('x-csrf-token', adminCsrf).send({});
      assert.strictEqual(nf.status, 404);
    } finally {
      await admin.post('/api/admin/staff/t_nurse/leave-balance')
        .set('x-csrf-token', adminCsrf).send({ granted: 0, carried_over: 0, manual_adjustment: 0 });
    }
  });

  clearRateLimits();
  // ────────────────────────────────────────────────────────────
  console.log('\n📌 オンコール記録・集計テスト');

  const oncallMonth = '2028-03';

  await test('オンコール記録投入（スタッフ） → 200', async () => {
    const { agent, csrfToken } = await loginAs(app, 't_nurse', 'nurse123');
    const res = await agent.post('/api/oncall/records')
      .set('x-csrf-token', csrfToken)
      .send({ date: '2028-03-05', count: 2, totalMinutes: 120, transportCount: 1 });
    assert.ok(res.status === 200 || res.status === 201, `status=${res.status} body=${JSON.stringify(res.body)}`);
  });

  await test('月次集計取得（スタッフ） → 200 + totalCount >= 2', async () => {
    const { agent, csrfToken } = await loginAs(app, 't_nurse', 'nurse123');
    const res = await agent
      .get(`/api/oncall/monthly-summary?month=${oncallMonth}`)
      .set('x-csrf-token', csrfToken);
    assert.strictEqual(res.status, 200);
    // totalCount は res.body.summary.totalCount または res.body.totalCount に存在する
    const totalCount = res.body.summary?.totalCount ?? res.body.totalCount;
    assert.ok(typeof totalCount === 'number', `totalCount が返る body=${JSON.stringify(res.body)}`);
    assert.ok(totalCount >= 2, `totalCount=${totalCount}`);
  });

  await test('管理者向け全スタッフ集計 → 200 + summary 配列', async () => {
    const { agent, csrfToken } = await loginAs(app, 't_admin', 'Admin12345', true);
    const res = await agent
      .get(`/api/admin/oncall/summary?month=${oncallMonth}`)
      .set('x-csrf-token', csrfToken);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.summary), `summary 配列が返る body=${JSON.stringify(res.body)}`);
  });

  // ── 締期間フィルタテスト（単一セッションで実行） ──────────────
  console.log('\n📌 オンコール締期間フィルタテスト');

  await test('締期間フィルタ: 境界値と年跨ぎ', async () => {
    const { agent, csrfToken } = await loginAs(app, 't_nurse', 'nurse123');

    // テストデータ投入
    for (const d of ['2028-02-16', '2028-03-15', '2028-03-16', '2027-12-20']) {
      const r = await agent.post('/api/oncall/records')
        .set('x-csrf-token', csrfToken)
        .send({ date: d, count: 1, totalMinutes: 60, transportCount: 0 });
      assert.ok(r.status === 200 || r.status === 201, `POST ${d} status=${r.status}`);
    }

    // month=2028-03 の締期間（2028-02-16 〜 2028-03-15）
    const res3 = await agent.get('/api/oncall/records?month=2028-03').set('x-csrf-token', csrfToken);
    assert.strictEqual(res3.status, 200);
    const dates3 = res3.body.records.map(r => r.date);
    assert.ok(dates3.includes('2028-02-16'), `前月16日が含まれるべき: ${JSON.stringify(dates3)}`);
    assert.ok(dates3.includes('2028-03-15'), `当月15日が含まれるべき: ${JSON.stringify(dates3)}`);
    assert.ok(!dates3.includes('2028-03-16'), `当月16日は含まれてはいけない: ${JSON.stringify(dates3)}`);

    // month=2028-01 の締期間（2027-12-16 〜 2028-01-15）年跨ぎ
    const res1 = await agent.get('/api/oncall/records?month=2028-01').set('x-csrf-token', csrfToken);
    assert.strictEqual(res1.status, 200);
    const dates1 = res1.body.records.map(r => r.date);
    assert.ok(dates1.includes('2027-12-20'), `年跨ぎ: 2027-12-20 が含まれるべき: ${JSON.stringify(dates1)}`);
  });
}

// ── メイン ────────────────────────────────────────────────────────
async function main() {
  await seedData();

  // server.js は NODE_ENV=test のため main() を自動実行しない
  const { app } = require('./server');

  await runTests(app);

  // テスト用一時ディレクトリを削除
  fs.rmSync(TEST_DIR, { recursive: true, force: true });

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`結果: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('✨ All tests passed!\n');
  }
}

main().catch(e => { console.error('テスト実行エラー:', e); process.exit(1); });
