'use strict';
/**
 * Phase A リファクタリング 自動検証テスト
 * 対象: constants.js 定数・締め期間算出・getStandbyFee()・loadStaff() 正規化
 * 実行: node test-phase-a.js
 */

const os   = require('os');
const path = require('path');
const fs   = require('fs');
const assert = require('assert');

// ── テスト用環境変数（モジュール読み込み前に設定） ─────────────
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'visit-phaseA-'));
process.env.DATA_DIR       = TEST_DIR;
process.env.SESSION_SECRET = 'test-secret-phase-a';
process.env.NODE_ENV       = 'test';
process.env.SPREADSHEET_ID = 'dummy-sheet-id';
delete process.env.GOOGLE_CREDENTIALS;

// ── モジュール読み込み ─────────────────────────────────────────
const { BILLING_DAY, STANDBY_FEES, INCENTIVE_NURSE_RATE, INCENTIVE_REHAB_RATE } = require('./lib/constants');
const { getStandbyFee } = require('./lib/helpers');
const { initDb, getDb } = require('./lib/db');
const { loadStaff, ensureDataDir } = require('./lib/data');

// ── テストランナー ────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

// ── DB初期化（getStandbyFee・loadStaff がDBを参照するため先に実行） ──
ensureDataDir();
initDb();
const db = getDb();

// ══════════════════════════════════════════════════════════════
// 1. constants.js デフォルト値
// ══════════════════════════════════════════════════════════════
console.log('\n📌 constants.js デフォルト値');

test('BILLING_DAY は 16', () => {
  assert.strictEqual(BILLING_DAY, 16);
});

test('STANDBY_FEES.holiday は 10000', () => {
  assert.strictEqual(STANDBY_FEES.holiday, 10000);
});

test('STANDBY_FEES.sunday は 10000', () => {
  assert.strictEqual(STANDBY_FEES.sunday, 10000);
});

test('STANDBY_FEES.saturday は 5000', () => {
  assert.strictEqual(STANDBY_FEES.saturday, 5000);
});

test('STANDBY_FEES.weekday は 2000', () => {
  assert.strictEqual(STANDBY_FEES.weekday, 2000);
});

test('INCENTIVE_NURSE_RATE は 4000', () => {
  assert.strictEqual(INCENTIVE_NURSE_RATE, 4000);
});

test('INCENTIVE_REHAB_RATE は 500', () => {
  assert.strictEqual(INCENTIVE_REHAB_RATE, 500);
});

// ══════════════════════════════════════════════════════════════
// 2. 締め期間日付算出（BILLING_DAY を使った計算検証）
// ══════════════════════════════════════════════════════════════
console.log('\n📌 締め期間日付算出');

test('3月の締め期間 → 2026-02-16 〜 2026-03-15', () => {
  const y = 2026, m = 3;
  const prevM    = m - 1;
  const prevYear = y;
  const start = `${prevYear}-${String(prevM).padStart(2,'0')}-${String(BILLING_DAY).padStart(2,'0')}`;
  const end   = `${y}-${String(m).padStart(2,'0')}-${String(BILLING_DAY - 1).padStart(2,'0')}`;
  assert.strictEqual(start, '2026-02-16');
  assert.strictEqual(end,   '2026-03-15');
});

test('1月の締め期間 → 年跨ぎで 2025-12-16 〜 2026-01-15', () => {
  const y = 2026, m = 1;
  const prevM    = 12;
  const prevYear = y - 1;
  const start = `${prevYear}-${String(prevM).padStart(2,'0')}-${String(BILLING_DAY).padStart(2,'0')}`;
  const end   = `${y}-${String(m).padStart(2,'0')}-${String(BILLING_DAY - 1).padStart(2,'0')}`;
  assert.strictEqual(start, '2025-12-16');
  assert.strictEqual(end,   '2026-01-15');
});

test('前月分の行数が正しい（3月: 2月は28日なので 28-15=13日分）', () => {
  // 2026-02-16 〜 2026-02-28 = 13日分
  const prevYear = 2026, prevM = 2;
  const daysInPrev = new Date(prevYear, prevM, 0).getDate(); // 28
  const count = daysInPrev - (BILLING_DAY - 1);
  assert.strictEqual(count, 13);
});

test('前月分の開始行が DATA_START_ROW + (BILLING_DAY-1) = row 20', () => {
  const DATA_START_ROW = 5;
  const startRowA = DATA_START_ROW + (BILLING_DAY - 1);
  assert.strictEqual(startRowA, 20); // 5 + 15 = 20 (16日目のrow)
});

// ══════════════════════════════════════════════════════════════
// 3. getStandbyFee() 手当計算
// ══════════════════════════════════════════════════════════════
console.log('\n📌 getStandbyFee() 手当計算');

test('元日(2026-01-01) → 祝日 10000円', () => {
  const r = getStandbyFee('2026-01-01');
  assert.strictEqual(r.fee, 10000);
  assert.strictEqual(r.category, '祝日');
});

test('みどりの日(2026-05-04) → 祝日 10000円', () => {
  const r = getStandbyFee('2026-05-04');
  assert.strictEqual(r.fee, 10000);
  assert.strictEqual(r.category, '祝日');
});

test('日曜日(2026-05-10) → 10000円', () => {
  assert.strictEqual(new Date('2026-05-10T00:00:00').getDay(), 0, '日曜確認');
  const r = getStandbyFee('2026-05-10');
  assert.strictEqual(r.fee, 10000);
  assert.strictEqual(r.category, '日曜');
});

test('土曜日(2026-05-09) → 5000円', () => {
  assert.strictEqual(new Date('2026-05-09T00:00:00').getDay(), 6, '土曜確認');
  const r = getStandbyFee('2026-05-09');
  assert.strictEqual(r.fee, 5000);
  assert.strictEqual(r.category, '土曜');
});

test('平日(2026-05-11 月曜) → 2000円', () => {
  assert.strictEqual(new Date('2026-05-11T00:00:00').getDay(), 1, '月曜確認');
  const r = getStandbyFee('2026-05-11');
  assert.strictEqual(r.fee, 2000);
  assert.strictEqual(r.category, '平日');
});

test('祝前日の平日(2026-12-31 木曜) → 2000円（祝日扱いにならない）', () => {
  // 大晦日は祝日ではない
  assert.strictEqual(new Date('2026-12-31T00:00:00').getDay(), 4, '木曜確認');
  const r = getStandbyFee('2026-12-31');
  assert.strictEqual(r.fee, 2000);
  assert.strictEqual(r.category, '平日');
});

// ══════════════════════════════════════════════════════════════
// 4. loadStaff() incentive_defaults 正規化
// ══════════════════════════════════════════════════════════════
console.log('\n📌 loadStaff() incentive_defaults 正規化');

test('DB未設定 → デフォルト {nurse: 3.5, rehab: 20.0} を返す', () => {
  db.prepare("DELETE FROM settings WHERE key = 'incentive_defaults'").run();
  const { incentive_defaults } = loadStaff();
  assert.strictEqual(incentive_defaults.nurse, 3.5,  'nurse デフォルト');
  assert.strictEqual(incentive_defaults.rehab, 20.0, 'rehab デフォルト');
});

test('DB設定あり → DB値をそのまま返す', () => {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('incentive_defaults', ?)").run(
    JSON.stringify({ nurse: 4.0, rehab: 25.0 })
  );
  const { incentive_defaults } = loadStaff();
  assert.strictEqual(incentive_defaults.nurse, 4.0);
  assert.strictEqual(incentive_defaults.rehab, 25.0);
});

test('DB設定がnurseのみ → rehab はデフォルト(20.0)で補完', () => {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('incentive_defaults', ?)").run(
    JSON.stringify({ nurse: 5.0 })
  );
  const { incentive_defaults } = loadStaff();
  assert.strictEqual(incentive_defaults.nurse, 5.0);
  assert.strictEqual(incentive_defaults.rehab, 20.0, '欠損キーがデフォルト補完される');
});

test('DB設定が {} (空) → 全キーがデフォルト補完', () => {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('incentive_defaults', ?)").run('{}');
  const { incentive_defaults } = loadStaff();
  assert.strictEqual(incentive_defaults.nurse, 3.5);
  assert.strictEqual(incentive_defaults.rehab, 20.0);
});

test('incentive_defaults は常にオブジェクトで返る（null にならない）', () => {
  db.prepare("DELETE FROM settings WHERE key = 'incentive_defaults'").run();
  const { incentive_defaults } = loadStaff();
  assert.ok(incentive_defaults !== null && typeof incentive_defaults === 'object', 'オブジェクト型であること');
  assert.ok('nurse' in incentive_defaults, 'nurse キーが存在すること');
  assert.ok('rehab' in incentive_defaults, 'rehab キーが存在すること');
});

// ── 結果 ──────────────────────────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`結果: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('✨ All tests passed!');
} else {
  console.log('⚠️  失敗があります。上記のエラーを確認してください。');
}

// クリーンアップ
try { fs.rmSync(TEST_DIR, { recursive: true }); } catch (_) {}

if (failed > 0) process.exit(1);
