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
