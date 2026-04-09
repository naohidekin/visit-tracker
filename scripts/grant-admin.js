#!/usr/bin/env node
'use strict';
/**
 * 管理者権限 (is_admin フラグ) 付与/剥奪/一覧 スクリプト
 *
 * パスワード変更ではなく is_admin フラグの制御専用。
 * パスワードも変えたいときは scripts/set-admin-password.js を使用する。
 *
 * 使い方:
 *   node scripts/grant-admin.js --list                    # 現在の管理者一覧
 *   node scripts/grant-admin.js <staffId> [<staffId>...]  # 指定スタッフに付与
 *   node scripts/grant-admin.js --revoke <staffId>        # 指定スタッフから剥奪
 *   node scripts/grant-admin.js --dry-run <staffId>       # 実際には変更せず結果だけ出力
 *
 * Render.com Shell から実行する場合:
 *   DATA_DIR=/data node scripts/grant-admin.js --list
 */

const path = require('path');

// DB_PATH を環境変数から解決
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..');
const DB_PATH  = path.join(DATA_DIR, 'visit-tracker.db');

const Database = require('better-sqlite3');

function printUsage() {
  console.log('使い方:');
  console.log('  node scripts/grant-admin.js --list');
  console.log('  node scripts/grant-admin.js <staffId> [<staffId>...]');
  console.log('  node scripts/grant-admin.js --revoke <staffId>');
  console.log('  node scripts/grant-admin.js --dry-run <staffId> [<staffId>...]');
}

function openDb() {
  console.log('📂 DB パス:', DB_PATH);
  return new Database(DB_PATH);
}

function listAdmins(db) {
  const rows = db.prepare('SELECT id, data FROM staff ORDER BY id').all();
  const admins = rows
    .map(r => ({ id: r.id, staff: JSON.parse(r.data) }))
    .filter(x => x.staff.is_admin && !x.staff.archived);
  if (admins.length === 0) {
    console.log('⚠️  現在、管理者が 1 人も設定されていません');
    return;
  }
  console.log(`📋 管理者一覧 (${admins.length}人):`);
  for (const { id, staff } of admins) {
    console.log(`  - ${id}  (${staff.name})  hasPassword=${!!staff.password_hash}`);
  }
}

function grantAdmins(db, ids, { dryRun = false } = {}) {
  const update = db.prepare('UPDATE staff SET data = ? WHERE id = ?');
  const select = db.prepare('SELECT data FROM staff WHERE id = ?');

  const granted = [];
  const already = [];
  const missing = [];
  const archived = [];

  const applyAll = db.transaction(() => {
    for (const id of ids) {
      const row = select.get(id);
      if (!row) { missing.push(id); continue; }
      const staff = JSON.parse(row.data);
      if (staff.archived) { archived.push({ id, staff }); continue; }
      if (staff.is_admin) { already.push({ id, staff }); continue; }
      staff.is_admin = true;
      if (!dryRun) update.run(JSON.stringify(staff), id);
      granted.push({ id, staff });
    }
  });
  applyAll();

  for (const { id, staff } of granted) console.log(`✅ 付与: ${id}  (${staff.name})`);
  for (const { id, staff } of already) console.log(`ℹ️  既に管理者: ${id}  (${staff.name})`);
  for (const { id, staff } of archived) console.log(`⚠️  archived のためスキップ: ${id}  (${staff.name})`);
  for (const id of missing) console.log(`❌ 見つからない: ${id}`);

  if (granted.length === 0) {
    console.log('変更なし');
    return;
  }
  if (dryRun) {
    console.log(`\n[dry-run] ${granted.length}件の変更を適用せずに終了します`);
    return;
  }
  console.log(`\n✅ ${granted.length}件の管理者権限を付与しました`);
}

function revokeAdmin(db, id, { dryRun = false } = {}) {
  const row = db.prepare('SELECT data FROM staff WHERE id = ?').get(id);
  if (!row) {
    console.log(`❌ 見つからない: ${id}`);
    process.exit(1);
  }
  const staff = JSON.parse(row.data);
  if (!staff.is_admin) {
    console.log(`ℹ️  ${id} (${staff.name}) は管理者ではありません`);
    return;
  }

  // 剥奪後に管理者が 0 人になるなら中止
  const allRows = db.prepare('SELECT id, data FROM staff').all();
  const activeAdmins = allRows
    .map(r => ({ id: r.id, staff: JSON.parse(r.data) }))
    .filter(x => x.staff.is_admin && !x.staff.archived && x.id !== id);
  if (activeAdmins.length === 0) {
    console.log(`⚠️  ${id} (${staff.name}) を剥奪すると管理者が 0 人になります。中止します`);
    console.log('    別の管理者を先に付与してから実行してください');
    process.exit(1);
  }

  staff.is_admin = false;
  if (dryRun) {
    console.log(`[dry-run] 剥奪予定: ${id} (${staff.name})`);
    return;
  }
  db.prepare('UPDATE staff SET data = ? WHERE id = ?').run(JSON.stringify(staff), id);
  console.log(`✅ 剥奪: ${id}  (${staff.name})`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printUsage();
    return;
  }

  const db = openDb();
  try {
    if (args.includes('--list')) {
      listAdmins(db);
      return;
    }

    const dryRun = args.includes('--dry-run');
    const revokeIdx = args.indexOf('--revoke');
    if (revokeIdx !== -1) {
      const id = args[revokeIdx + 1];
      if (!id) { console.error('❌ --revoke には staffId が必要です'); process.exit(1); }
      revokeAdmin(db, id, { dryRun });
      return;
    }

    const ids = args.filter(a => !a.startsWith('--'));
    if (ids.length === 0) {
      printUsage();
      process.exit(1);
    }
    grantAdmins(db, ids, { dryRun });
  } finally {
    db.close();
  }
}

try { main(); }
catch (e) { console.error('❌ エラー:', e.message); process.exit(1); }
