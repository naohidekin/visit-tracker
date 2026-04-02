'use strict';
// 起動時初期化モジュール（パスワードハッシュ化、スタッフ同期、有給フィールド初期化）

const bcrypt = require('bcryptjs');
const fs     = require('fs');
const path   = require('path');
const { loadStaff, saveStaff, loadNotices, saveNotices } = require('./data');
const { DATA_DIR } = require('./constants');

// 起動時：未ハッシュPWをハッシュ化 & 旧 'rehab' 職種を 'PT' に移行
async function ensurePasswordsHashed() {
  const data = loadStaff();
  let changed = false;
  for (const s of data.staff) {
    if (!s.password_hash && s.initial_pw) {
      s.password_hash = await bcrypt.hash(s.initial_pw, 10);
      changed = true;
    }
    // 旧データの 'rehab' を 'PT' に移行（PT/OT/ST 細分化対応）
    if (s.type === 'rehab') {
      s.type = 'PT';
      changed = true;
    }
  }
  if (changed) { saveStaff(data); console.log('✅ スタッフデータを更新しました'); }
}

// 起動時：ソース staff.json に新スタッフがいれば DATA_DIR へ追加
async function syncNewStaffFromSource() {
  const __rootdir = path.resolve(__dirname, '..');
  if (DATA_DIR === __rootdir) return; // ローカルは同一ファイルなので不要
  const srcPath = path.join(__rootdir, 'staff.json');
  if (!fs.existsSync(srcPath)) return;

  const srcData  = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
  const liveData = loadStaff();
  const liveIds  = new Set(liveData.staff.map(s => s.id));

  const newStaff = srcData.staff.filter(s => !liveIds.has(s.id));
  if (newStaff.length === 0) return;

  for (const s of newStaff) {
    if (!s.password_hash && s.initial_pw) {
      s.password_hash = await bcrypt.hash(s.initial_pw, 10);
    }
    liveData.staff.push(s);
    console.log(`✅ 新スタッフを /data/staff.json に追加しました: ${s.name} (${s.id})`);
  }
  saveStaff(liveData);
}

// 起動時：ソース staff.json の有給・OC設定を既存スタッフに同期
function syncLeaveFieldsFromSource() {
  const __rootdir = path.resolve(__dirname, '..');
  if (DATA_DIR === __rootdir) return;
  const srcPath = path.join(__rootdir, 'staff.json');
  if (!fs.existsSync(srcPath)) return;
  const srcData  = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
  const liveData = loadStaff();
  let changed = false;
  const syncFields = ['hire_date','leave_granted','leave_grant_date','leave_carried_over','leave_manual_adjustment','oncall_eligible','oncall_leave_granted','celebration_days','celebration_used_adj'];
  for (const src of srcData.staff) {
    const live = liveData.staff.find(s => s.id === src.id);
    if (!live) continue;
    for (const f of syncFields) {
      if (src[f] !== undefined && src[f] !== null && src[f] !== 0 && src[f] !== false && live[f] !== src[f]) {
        live[f] = src[f];
        changed = true;
      }
    }
  }
  if (changed) { saveStaff(liveData); console.log('✅ ソースからスタッフ有給・OC設定を同期しました'); }
}

// 起動時：有給フィールドがないスタッフにデフォルト値を追加
function ensureLeaveFields() {
  const data = loadStaff();
  let changed = false;
  for (const s of data.staff) {
    if (s.hire_date === undefined)              { s.hire_date = null;              changed = true; }
    if (s.leave_granted === undefined)          { s.leave_granted = 0;             changed = true; }
    if (s.leave_grant_date === undefined)       { s.leave_grant_date = null;       changed = true; }
    if (s.leave_carried_over === undefined)     { s.leave_carried_over = 0;        changed = true; }
    if (s.leave_manual_adjustment === undefined){ s.leave_manual_adjustment = 0;   changed = true; }
    // leave_balance は廃止（都度計算する）
    if (s.leave_balance !== undefined)          { delete s.leave_balance;          changed = true; }
    if (s.oncall_eligible === undefined)        { s.oncall_eligible = false;       changed = true; }
    if (s.oncall_leave_granted === undefined)   { s.oncall_leave_granted = 0;      changed = true; }
    if (s.email === undefined)                  { s.email = null;                  changed = true; }
    if (s.celebration_days === undefined)       { s.celebration_days = 3;          changed = true; }
    if (s.celebration_used_adj === undefined)   { s.celebration_used_adj = 0;      changed = true; }
  }
  if (changed) { saveStaff(data); console.log('✅ 有給フィールドを初期化しました'); }
}

// 起動時：管理者フィールドがないスタッフにデフォルト値を追加
function ensureAdminFields() {
  const data = loadStaff();
  let changed = false;
  for (const s of data.staff) {
    if (s.is_admin === undefined) { s.is_admin = false; changed = true; }
    // TOTP廃止: 旧フィールドがあれば削除
    if (s.totp_secret !== undefined)      { delete s.totp_secret;       changed = true; }
    if (s.totp_backup_codes !== undefined) { delete s.totp_backup_codes; changed = true; }
  }
  if (changed) { saveStaff(data); console.log('✅ 管理者フィールドを初期化しました'); }
}

// 起動時：INITIAL_ADMIN_STAFF_ID が設定されていればそのスタッフを管理者にする
function ensureFirstAdmin() {
  const initialId = process.env.INITIAL_ADMIN_STAFF_ID;
  const data = loadStaff();
  const hasAdmin = data.staff.some(s => s.is_admin && !s.archived);
  if (hasAdmin) return;

  if (initialId) {
    const staff = data.staff.find(s => s.id === initialId && !s.archived);
    if (staff) {
      staff.is_admin = true;
      saveStaff(data);
      console.log(`✅ 初回管理者を設定しました: ${staff.name} (${staff.id})`);
    } else {
      console.warn(`⚠️ INITIAL_ADMIN_STAFF_ID=${initialId} に該当するスタッフが見つかりません`);
    }
  } else {
    console.warn('⚠️ 管理者が未設定です。INITIAL_ADMIN_STAFF_ID 環境変数を設定してください。');
  }
}

// 起動時：release-notes.json に未配信の更新があればお知らせを自動作成
function publishReleaseNotes() {
  const __rootdir = path.resolve(__dirname, '..');
  const releasePath = path.join(__rootdir, 'release-notes.json');
  if (!fs.existsSync(releasePath)) return;

  let releases;
  try {
    releases = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
  } catch (e) {
    console.error('[release-notes] JSON解析エラー:', e.message);
    return;
  }
  if (!Array.isArray(releases) || releases.length === 0) return;

  const data = loadNotices();
  const existingIds = new Set(data.notices.map(n => n.id));
  let added = 0;

  for (const r of releases) {
    if (!r.id || !r.title) continue;
    const noticeId = `release-${r.id}`;
    if (existingIds.has(noticeId)) continue;

    const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
    data.notices.push({
      id: noticeId,
      date: r.date || now.toISOString().slice(0, 10),
      title: r.title,
      body: r.body || '',
      source: 'system',
      createdAt: now.toISOString(),
    });
    added++;
    console.log(`[release-notes] お知らせ配信: ${r.title}`);
  }

  if (added > 0) {
    saveNotices(data);
    console.log(`[release-notes] ${added}件の更新お知らせを配信しました`);
  }
}

module.exports = {
  ensurePasswordsHashed,
  syncNewStaffFromSource,
  syncLeaveFieldsFromSource,
  ensureLeaveFields,
  ensureAdminFields,
  ensureFirstAdmin,
  publishReleaseNotes,
};
