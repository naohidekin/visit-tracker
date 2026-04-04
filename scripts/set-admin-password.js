#!/usr/bin/env node
'use strict';
/**
 * 管理者パスワード緊急設定スクリプト
 * 使い方: node scripts/set-admin-password.js <staffId> <newPassword>
 * 例:     node scripts/set-admin-password.js ubukata01 MyPass2026!
 *
 * Render.com Shell から実行する場合:
 *   DATA_DIR=/data node scripts/set-admin-password.js <staffId> <newPassword>
 */

const path     = require('path');
const bcrypt   = require('bcryptjs');

const [,, staffId, newPassword] = process.argv;

if (!staffId || !newPassword) {
  console.error('使い方: node scripts/set-admin-password.js <staffId> <newPassword>');
  process.exit(1);
}
if (newPassword.length < 8) {
  console.error('❌ パスワードは8文字以上にしてください');
  process.exit(1);
}

// DB_PATH を環境変数から解決
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..');
const DB_PATH  = path.join(DATA_DIR, 'visit-tracker.db');

console.log('📂 DB パス:', DB_PATH);

const Database = require('better-sqlite3');
const db = new Database(DB_PATH);

const row = db.prepare('SELECT data FROM staff WHERE id = ?').get(staffId);
if (!row) {
  console.error(`❌ スタッフ ID "${staffId}" が見つかりません`);
  const all = db.prepare('SELECT id, json_extract(data,"$.name") as name, json_extract(data,"$.is_admin") as is_admin FROM staff').all();
  console.log('登録済みスタッフ一覧:');
  all.forEach(s => console.log(`  ${s.id} (${s.name}) is_admin=${s.is_admin}`));
  process.exit(1);
}

const staff = JSON.parse(row.data);
console.log(`✅ スタッフ確認: ${staff.name} (is_admin=${staff.is_admin}, archived=${staff.archived})`);

if (staff.archived) {
  console.error('❌ このスタッフはアーカイブ済みです');
  process.exit(1);
}

const hash = bcrypt.hashSync(newPassword, 10);
staff.password_hash = hash;

db.prepare('UPDATE staff SET data = ? WHERE id = ?').run(JSON.stringify(staff), staffId);
console.log(`✅ パスワードを設定しました: ${staff.name} (${staffId})`);
console.log('➡️  管理画面 /admin から ID + 新パスワードでログインしてください');
db.close();
