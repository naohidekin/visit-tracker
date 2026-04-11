'use strict';
/**
 * 回帰テスト: アーカイブ拒否・CSRF保護・編集期限・管理者権限
 * 実行: node test-regression.js
 *
 * 独立した一時 SQLite DB を使用し、本番データに影響を与えない。
 */

const os    = require('os');
const path  = require('path');
const fs    = require('fs');
const assert = require('assert');

// ── テスト用環境変数（モジュール読み込み前に設定すること） ────────
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'visit-regtest-'));
process.env.DATA_DIR       = TEST_DIR;
process.env.SESSION_SECRET = 'test-secret-for-regression-tests';
process.env.NODE_ENV       = 'test';
process.env.SPREADSHEET_ID = 'dummy-sheet-id';
delete process.env.GOOGLE_CREDENTIALS;

// ── ライブラリ読み込み ────────────────────────────────────────────
const request = require('supertest');
const bcrypt  = require('bcryptjs');
const { getDb }         = require('./lib/db');
const { ensureDataDir } = require('./lib/data');

// ── テストランナー ────────────────────────────────────────────────
let passed = 0;
let failed = 0;

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
  await ensureDataDir();
  const db = getDb();

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
  const csrfToken = csrfRaw?.split(';')[0]?.split('=').slice(1).join('=') ?? '';
  return { agent, csrfToken, res };
}

// ── テスト本体 ────────────────────────────────────────────────────
async function runTests(app) {

  // ────────────────────────────────────────────────────────────
  console.log('\n📌 回帰テスト: アーカイブ済みスタッフ操作拒否');

  await test('アーカイブ後の既存セッションで /api/notices が 401', async () => {
    const { agent: staffAgent } = await loginAs(app, 't_nurse', 'nurse123');

    const { agent: adminAgent, csrfToken: adminCsrf } =
      await loginAs(app, 't_admin', 'Admin12345', true);

    try {
      const archiveRes = await adminAgent
        .patch('/api/admin/staff/t_nurse/archive')
        .set('x-csrf-token', adminCsrf);
      assert.strictEqual(archiveRes.status, 200);
      assert.strictEqual(archiveRes.body.archived, true);

      const noticesRes = await staffAgent.get('/api/notices');
      assert.strictEqual(noticesRes.status, 401, 'アーカイブ後は 401');
    } finally {
      await adminAgent
        .patch('/api/admin/staff/t_nurse/archive')
        .set('x-csrf-token', adminCsrf);
    }
  });

  clearRateLimits();
  // ────────────────────────────────────────────────────────────
  console.log('\n📌 回帰テスト: CSRF保護');

  await test('CSRFトークンなしの POST → 403', async () => {
    const { agent } = await loginAs(app, 't_nurse', 'nurse123');
    const res = await agent.post('/api/logout');
    assert.strictEqual(res.status, 403);
  });

  await test('CSRFトークン不一致の POST → 403', async () => {
    const { agent } = await loginAs(app, 't_nurse', 'nurse123');
    const res = await agent.post('/api/logout').set('x-csrf-token', 'tampered-value');
    assert.strictEqual(res.status, 403);
  });

  await test('CSRF除外パスはトークンなしでも 403 にならない', async () => {
    const res = await request(app).post('/api/login').send({});
    assert.notStrictEqual(res.status, 403, 'CSRF除外パスは 403 以外');
  });

  await test('GET リクエストは CSRF 検証をスキップ', async () => {
    const { agent } = await loginAs(app, 't_nurse', 'nurse123');
    const res = await agent.get('/api/me');
    assert.strictEqual(res.status, 200, 'GET は CSRF 不要で 200');
  });

  clearRateLimits();
  // ────────────────────────────────────────────────────────────
  console.log('\n📌 回帰テスト: 編集期限');

  await test('締め後の記録修正が 400', async () => {
    const { agent, csrfToken } = await loginAs(app, 't_nurse', 'nurse123');
    const res = await agent.post('/api/record')
      .set('x-csrf-token', csrfToken)
      .send({ date: '2024-01-01', kaigo: 5, iryo: 3 });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('締日'), `エラーメッセージに「締日」を含む: ${res.body.error}`);
  });

  clearRateLimits();
  // ────────────────────────────────────────────────────────────
  console.log('\n📌 回帰テスト: 管理者権限');

  await test('非管理者が admin API (GET) にアクセス → 401', async () => {
    const { agent } = await loginAs(app, 't_nurse', 'nurse123');
    const res = await agent.get('/api/admin/audit-log');
    assert.strictEqual(res.status, 401);
  });

  await test('非管理者が admin API (POST) にアクセス → 401', async () => {
    const { agent, csrfToken } = await loginAs(app, 't_nurse', 'nurse123');
    const res = await agent.post('/api/admin/record')
      .set('x-csrf-token', csrfToken)
      .send({ date: '2026-04-01', staffId: 't_nurse', kaigo: 1 });
    assert.strictEqual(res.status, 401);
  });
}

// ── メイン ────────────────────────────────────────────────────────
async function main() {
  await seedData();

  const { app } = require('./server');

  await runTests(app);

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
