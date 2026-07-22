'use strict';
/**
 * 回帰テスト: 記録の直接入力時に「未確定の予定」を掃除する整合性
 * 実行: node test-schedule-record.js
 *
 * 背景（バグ）:
 *   翌日分を「予定」として登録したあと、同じ日を通常フォームから直接記録すると、
 *   古い予定が残り続ける。その予定を後から「確定」すると、実績セルが予定値で
 *   上書きされ、入力した単位が反映されなくなる（実績が消える）。
 *   → 記録の確定時に同一スタッフ・同一日付の予定を削除して防止する。
 *
 * Google Sheets はインメモリのモックに差し替える（require キャッシュ注入）。
 */

const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');

// ── テスト用環境変数（モジュール読み込み前に設定） ──────────────────
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'visit-sched-test-'));
process.env.DATA_DIR       = TEST_DIR;
process.env.SESSION_SECRET = 'test-secret-for-schedule-record-tests';
process.env.NODE_ENV       = 'test';
process.env.SPREADSHEET_ID = 'dummy-sheet-id';
delete process.env.GOOGLE_CREDENTIALS;

// ── インメモリ Sheets モック ───────────────────────────────────────
const store = new Map();
const colIdx = (c) => { let n = 0; for (const ch of c) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
const idxCol = (i) => { let s = '', n = i + 1; while (n > 0) { s = String.fromCharCode(64 + ((n - 1) % 26 + 1)) + s; n = Math.floor((n - 1) / 26); } return s; };
function parseRange(range) {
  const b = range.indexOf('!'); const title = range.slice(0, b), a1 = range.slice(b + 1);
  const m = a1.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
  return { title, c1: m[1], r1: +m[2], c2: m[3] || m[1], r2: m[4] ? +m[4] : +m[2] };
}
function readRange(range) {
  const { title, c1, r1, c2, r2 } = parseRange(range);
  const ci1 = colIdx(c1), ci2 = colIdx(c2); const out = [];
  for (let r = r1; r <= r2; r++) {
    const a = [];
    for (let ci = ci1; ci <= ci2; ci++) { const k = `${title}!${idxCol(ci)}${r}`; a.push(store.has(k) ? store.get(k) : ''); }
    while (a.length && (a[a.length - 1] === '' || a[a.length - 1] == null)) a.pop();
    out.push(a);
  }
  while (out.length && out[out.length - 1].length === 0) out.pop();
  return out;
}
function writeRange(range, values) {
  const { title, c1, r1 } = parseRange(range); const ci1 = colIdx(c1);
  for (let i = 0; i < values.length; i++)
    for (let j = 0; j < (values[i] || []).length; j++) {
      const k = `${title}!${idxCol(ci1 + j)}${r1 + i}`; const v = values[i][j];
      if (v === '' || v == null) store.delete(k); else store.set(k, String(v));
    }
}
const fakeApi = { spreadsheets: { values: {
  get: async ({ range }) => ({ data: { values: readRange(range) } }),
  update: async ({ range, requestBody }) => { writeRange(range, requestBody.values); return { data: {} }; },
  batchUpdate: async ({ requestBody }) => { for (const d of requestBody.data) writeRange(d.range, d.values); return { data: {} }; },
  batchGet: async ({ ranges }) => ({ data: { valueRanges: ranges.map(r => ({ values: readRange(r) })) } }),
} } };
const fakeSheets = {
  getAuth: () => ({}), getSheets: async () => fakeApi, sheetsRetry: async (fn) => fn(),
  buildSheetHeaderRow: () => ['日付', '曜日'], createSpreadsheetForYear: async () => 'dummy-sheet-id',
  hasRecordForDate: async () => false, getAllStaffRecordStatus: async () => ({ missing: [], entered: [], onLeave: [] }),
  getValues: async (s, r) => readRange(r),
  updateValues: async (s, r, v) => { writeRange(r, v); },
  batchUpdateValues: async (s, d) => { for (const x of d) writeRange(x.range, x.values); },
  batchGetValues: async (s, rs) => rs.map(r => ({ values: readRange(r) })),
};
const sheetsPath = require.resolve('./lib/sheets.js');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

// ── ライブラリ読み込み ────────────────────────────────────────────
const request = require('supertest');
const bcrypt  = require('bcryptjs');
const { getDb } = require('./lib/db');
const { ensureDataDir, loadSchedules, saveSchedules } = require('./lib/data');
const { getTodayJST } = require('./lib/helpers');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.error(`  ❌ ${name}\n     ${e.message}`); failed++; }
}
async function login(app, loginId, password) {
  const agent = request.agent(app);
  const res = await agent.post('/api/login').send({ loginId, password });
  const c = (res.headers['set-cookie'] || []).find(x => x.startsWith('csrf_token='));
  const csrf = c?.split(';')[0]?.split('=').slice(1).join('=') ?? '';
  return { agent, csrf };
}
const rowOfToday = () => 5 + parseInt(getTodayJST().slice(8, 10), 10) - 1;
const cellKeyToday = (col) => `${parseInt(getTodayJST().slice(5, 7), 10)}月!${col}${rowOfToday()}`;

(async () => {
  await ensureDataDir();
  const db = getDb();
  const pt = { id: 't_pt', name: 'テストPT', type: 'PT', col: 'C',
    password_hash: bcrypt.hashSync('pt123', 4), is_admin: false, archived: false,
    hire_date: '2024-04-01', incentive_line: 20 };
  db.prepare('INSERT OR REPLACE INTO staff (id, data) VALUES (?, ?)').run(pt.id, JSON.stringify(pt));

  const { app } = require('./server.js');
  const today = getTodayJST();

  console.log('\n📌 予定掃除テスト（記録の直接入力時）');

  await test('当日を直接記録すると、その日の未確定予定が削除される', async () => {
    const { agent, csrf } = await login(app, 't_pt', 'pt123');
    // 前日に「翌日（＝今日）」として登録された予定を模擬（plan=40）
    saveSchedules({ schedules: [{ id: 's-today', staffId: 't_pt', staffName: 'テストPT', jobType: 'PT', date: today, units: 40, status: 'pending', createdAt: 'y' }] });
    const res = await agent.post('/api/record').set('x-csrf-token', csrf).send({ date: today, value: 35 });
    assert.strictEqual(res.status, 200, `記録は成功する: ${JSON.stringify(res.body)}`);
    const remaining = loadSchedules().schedules.filter(s => s.staffId === 't_pt' && s.date === today);
    assert.strictEqual(remaining.length, 0, '同一日付の予定は掃除される');
    assert.strictEqual(store.get(cellKeyToday('C')), '35', '実績セルには入力値(35)が入る');
  });

  await test('掃除された予定を確定しても実績は上書きされない（404）', async () => {
    const { agent, csrf } = await login(app, 't_pt', 'pt123');
    const res = await agent.post('/api/schedules/s-today/confirm').set('x-csrf-token', csrf).send({});
    assert.strictEqual(res.status, 404, '掃除済みの予定は確定できない');
    assert.strictEqual(store.get(cellKeyToday('C')), '35', '実績(35)は予定値(40)で上書きされない');
  });

  await test('他の日付（翌日）の予定は掃除されない', async () => {
    const { agent, csrf } = await login(app, 't_pt', 'pt123');
    const tomorrow = new Date(new Date(today + 'T00:00:00').getTime() + 86400000).toISOString().slice(0, 10);
    saveSchedules({ schedules: [
      { id: 's-today2', staffId: 't_pt', staffName: 'テストPT', jobType: 'PT', date: today, units: 10, status: 'pending', createdAt: 'y' },
      { id: 's-tom', staffId: 't_pt', staffName: 'テストPT', jobType: 'PT', date: tomorrow, units: 33, status: 'pending', createdAt: 'y' },
    ] });
    const res = await agent.post('/api/record').set('x-csrf-token', csrf).send({ date: today, value: 20 });
    assert.strictEqual(res.status, 200);
    const scheds = loadSchedules().schedules.filter(s => s.staffId === 't_pt');
    assert.ok(!scheds.some(s => s.date === today), '当日分は掃除される');
    assert.ok(scheds.some(s => s.date === tomorrow && s.units === 33), '翌日分は残る');
  });

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`結果: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.error('❌ テスト失敗'); process.exit(1); }
  console.log('✨ All tests passed!');
  process.exit(0);
})().catch(e => { console.error('テスト実行エラー:', e); process.exit(1); });
