/**
 * ensureInitialAdmins のユニットテスト
 * 実行: node test-admin-init.js
 *
 * 一時ディレクトリに空の SQLite DB を作り、実ファイルを触らずに動作を確認する。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// lib/constants.js は require 時に DATA_DIR / DB_PATH を決定するため、
// このファイルより先に DATA_DIR 環境変数をセットする必要がある。
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'visit-tracker-test-'));
process.env.DATA_DIR = TMP_DIR;
// SPREADSHEET_ID は spreadsheet_registry の初期化で参照されるのでダミーを入れる
process.env.SPREADSHEET_ID = process.env.SPREADSHEET_ID || 'dummy-sheet-id';

const { getDb, closeDb } = require('./lib/db');
const { loadStaff, saveStaff } = require('./lib/data');

// DB初期化（スキーマ作成）
getDb();

let passed = 0;
let failed = 0;

function test(name, fn) {
  // 各テストで環境変数と staff テーブルをリセット
  delete process.env.INITIAL_ADMIN_STAFF_IDS;
  delete process.env.INITIAL_ADMIN_STAFF_ID;
  const db = getDb();
  db.prepare('DELETE FROM staff').run();

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

function writeStaff(staffArray) {
  saveStaff({ incentive_defaults: {}, staff: staffArray });
}
function readStaff() {
  return loadStaff();
}
function makeStaff(id, extra = {}) {
  return {
    id, name: `スタッフ${id}`, type: 'nurse',
    password_hash: '$2a$10$dummy', is_admin: false, archived: false,
    ...extra,
  };
}

// ログ抑制ヘルパー
function quietRun(fn) {
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { return fn(); }
  finally { console.log = origLog; console.warn = origWarn; }
}

// モジュールキャッシュから再読み込み（環境変数を毎テスト読み直すため）
function freshEnsureInitialAdmins() {
  delete require.cache[require.resolve('./lib/startup')];
  return require('./lib/startup').ensureInitialAdmins;
}

console.log('\n📌 ensureInitialAdmins');

test('INITIAL_ADMIN_STAFF_IDS=a,b,c で 3 人全員が is_admin=true になる', () => {
  writeStaff([makeStaff('a'), makeStaff('b'), makeStaff('c'), makeStaff('d')]);
  process.env.INITIAL_ADMIN_STAFF_IDS = 'a,b,c';
  quietRun(() => freshEnsureInitialAdmins()());
  const data = readStaff();
  assert.strictEqual(data.staff.find(s => s.id === 'a').is_admin, true);
  assert.strictEqual(data.staff.find(s => s.id === 'b').is_admin, true);
  assert.strictEqual(data.staff.find(s => s.id === 'c').is_admin, true);
  assert.strictEqual(data.staff.find(s => s.id === 'd').is_admin, false);
});

test('INITIAL_ADMIN_STAFF_ID=x 単数のみで後方互換動作', () => {
  writeStaff([makeStaff('x'), makeStaff('y')]);
  process.env.INITIAL_ADMIN_STAFF_ID = 'x';
  quietRun(() => freshEnsureInitialAdmins()());
  const data = readStaff();
  assert.strictEqual(data.staff.find(s => s.id === 'x').is_admin, true);
  assert.strictEqual(data.staff.find(s => s.id === 'y').is_admin, false);
});

test('単数と複数の両方を設定すると両方マージされる', () => {
  writeStaff([makeStaff('a'), makeStaff('b'), makeStaff('c')]);
  process.env.INITIAL_ADMIN_STAFF_IDS = 'a,b';
  process.env.INITIAL_ADMIN_STAFF_ID = 'c';
  quietRun(() => freshEnsureInitialAdmins()());
  const data = readStaff();
  assert.strictEqual(data.staff.filter(s => s.is_admin).length, 3);
});

test('空白やカンマ区切りの整形に耐える', () => {
  writeStaff([makeStaff('a'), makeStaff('b'), makeStaff('c')]);
  process.env.INITIAL_ADMIN_STAFF_IDS = ' a , b ,, ,c ';
  quietRun(() => freshEnsureInitialAdmins()());
  const data = readStaff();
  assert.strictEqual(data.staff.filter(s => s.is_admin).length, 3);
});

test('アーカイブ済みスタッフは無視される', () => {
  writeStaff([makeStaff('a'), makeStaff('b', { archived: true })]);
  process.env.INITIAL_ADMIN_STAFF_IDS = 'a,b';
  quietRun(() => freshEnsureInitialAdmins()());
  const data = readStaff();
  assert.strictEqual(data.staff.find(s => s.id === 'a').is_admin, true);
  assert.strictEqual(data.staff.find(s => s.id === 'b').is_admin, false);
});

test('存在しない ID は warn のみでエラーにならない', () => {
  writeStaff([makeStaff('a')]);
  process.env.INITIAL_ADMIN_STAFF_IDS = 'a,nosuch';
  quietRun(() => freshEnsureInitialAdmins()());
  const data = readStaff();
  assert.strictEqual(data.staff.find(s => s.id === 'a').is_admin, true);
});

test('既に is_admin=true なスタッフに対して idempotent', () => {
  writeStaff([makeStaff('a', { is_admin: true })]);
  process.env.INITIAL_ADMIN_STAFF_IDS = 'a';
  quietRun(() => freshEnsureInitialAdmins()());
  const data = readStaff();
  assert.strictEqual(data.staff.find(s => s.id === 'a').is_admin, true);
});

test('env 未設定 + 既存管理者なしで warn のみ (is_admin は変更しない)', () => {
  writeStaff([makeStaff('a')]);
  quietRun(() => freshEnsureInitialAdmins()());
  const data = readStaff();
  assert.strictEqual(data.staff.find(s => s.id === 'a').is_admin, false);
});

test('既存の管理者は env に無くても剥奪されない (union 追加のみ)', () => {
  writeStaff([makeStaff('a', { is_admin: true }), makeStaff('b'), makeStaff('c')]);
  process.env.INITIAL_ADMIN_STAFF_IDS = 'b,c';
  quietRun(() => freshEnsureInitialAdmins()());
  const data = readStaff();
  assert.strictEqual(data.staff.find(s => s.id === 'a').is_admin, true);
  assert.strictEqual(data.staff.find(s => s.id === 'b').is_admin, true);
  assert.strictEqual(data.staff.find(s => s.id === 'c').is_admin, true);
});

// ── 後片付け ────────────────────────────────────────────────
closeDb();
try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
