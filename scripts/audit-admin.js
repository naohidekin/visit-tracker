#!/usr/bin/env node
'use strict';
/**
 * 管理者ログイン関連の監査ログを見やすく表示する診断スクリプト
 *
 * 使い方:
 *   node scripts/audit-admin.js              # 直近 50 件の管理者認証イベント
 *   node scripts/audit-admin.js --limit 200  # 件数指定
 *   node scripts/audit-admin.js --id suzuki02  # 特定スタッフのイベントのみ
 *   node scripts/audit-admin.js --failed     # 失敗イベントのみ
 *
 * Render.com Shell から実行する場合:
 *   DATA_DIR=/data node scripts/audit-admin.js
 */

const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..');
const DB_PATH  = path.join(DATA_DIR, 'visit-tracker.db');

const Database = require('better-sqlite3');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { limit: 50, id: null, failedOnly: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--limit') opts.limit = parseInt(args[++i], 10) || 50;
    else if (a === '--id') opts.id = args[++i];
    else if (a === '--failed') opts.failedOnly = true;
  }
  return opts;
}

function printUsage() {
  console.log('使い方:');
  console.log('  node scripts/audit-admin.js [--limit 50] [--id staffId] [--failed]');
}

function formatJst(isoString) {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    // JST 表記
    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    return jst.toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return isoString;
  }
}

function main() {
  const opts = parseArgs();
  if (opts.help) { printUsage(); return; }

  console.log('📂 DB パス:', DB_PATH);
  const db = new Database(DB_PATH, { readonly: true });
  try {
    // audit_log を新しい順に取得
    // 管理者ログイン関連の action は 'auth.admin_login', 'auth.admin_login_failed',
    // 'auth.admin_logout', 'auth.admin_webauthn_failed', 'auth.admin_emergency_login' 等
    const rows = db.prepare('SELECT data FROM audit_log ORDER BY timestamp DESC').all();

    const matches = [];
    for (const r of rows) {
      let e;
      try { e = JSON.parse(r.data); } catch { continue; }
      if (!e.action || e.action.indexOf('admin') < 0) continue;
      if (opts.failedOnly && e.action.indexOf('failed') < 0) continue;
      if (opts.id) {
        const targetId = e.target && (e.target.id || '');
        if (targetId !== opts.id) continue;
      }
      matches.push(e);
      if (matches.length >= opts.limit) break;
    }

    if (matches.length === 0) {
      console.log('⚠️ 該当する監査ログが見つかりません');
      return;
    }

    console.log(`\n📋 直近 ${matches.length} 件の管理者認証イベント (新しい順):\n`);
    console.log('時刻 (JST)              アクション                        ID          ラベル');
    console.log('─'.repeat(100));

    for (const e of matches) {
      const ts = formatJst(e.timestamp).padEnd(22);
      const action = (e.action || '').padEnd(34);
      const target = e.target || {};
      const id = String(target.id || '').padEnd(12);
      const label = String(target.label || '');
      // 成功/失敗で色分け（ANSIカラー）
      const isFailed = e.action && e.action.indexOf('failed') >= 0;
      const mark = isFailed ? '❌' : '✅';
      console.log(`${mark} ${ts} ${action} ${id} ${label}`);
    }

    // 集計
    console.log('\n📊 サマリー:');
    const counts = {};
    const byId = {};
    for (const e of matches) {
      counts[e.action] = (counts[e.action] || 0) + 1;
      const id = (e.target && e.target.id) || '(不明)';
      byId[id] = byId[id] || { success: 0, failed: 0 };
      if (e.action.indexOf('failed') >= 0) byId[id].failed++;
      else if (e.action === 'auth.admin_login') byId[id].success++;
    }
    for (const [action, count] of Object.entries(counts)) {
      console.log(`  ${action}: ${count}件`);
    }
    console.log('\n👥 スタッフ別:');
    for (const [id, stat] of Object.entries(byId)) {
      console.log(`  ${id.padEnd(14)} 成功:${stat.success}  失敗:${stat.failed}`);
    }
  } finally {
    db.close();
  }
}

try { main(); }
catch (e) { console.error('❌ エラー:', e.message); process.exit(1); }
