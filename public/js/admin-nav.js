// admin-nav.js — セクション切り替え・ダッシュボード

// ── アコーディオン ──────────────────────────────────────────
function toggleAccordion(header) {
  const body = header.nextElementSibling;
  const icon = header.querySelector('.acc-icon');
  if (body.classList.contains('open')) {
    body.classList.remove('open');
    icon.textContent = '▼';
  } else {
    body.classList.add('open');
    icon.textContent = '▲';
    // セクション展開時に初期データ読み込み
    const h2 = header.querySelector('h2');
    if (h2 && h2.textContent.includes('有給休暇管理')) {
      loadLeavePending();
    }
    if (h2 && h2.textContent.includes('オンコール管理')) {
      initOncallMonth();
      loadOncallSummary();
    }
    if (h2 && h2.textContent.includes('待機・雨の日管理')) {
      initStandbyMonth();
      loadStandbyData();
    }
    if (h2 && h2.textContent.includes('出勤確定')) {
      initAttendanceMonth();
      loadAttendanceMonthly();
    }
    if (h2 && h2.textContent.includes('インセンティブ月次集計')) {
      initIncentiveSummaryMonth();
      loadIncentiveSummary();
    }
  }
}

// ── サイドバーナビゲーション ──────────────────────────────────
const SECTION_TITLES = {
  'dashboard': 'ダッシュボード',
  'sec-schedules': '未確定の予定一覧',
  'sec-staff': 'スタッフ一覧',
  'sec-notices': 'お知らせ管理',
  'sec-leave': '有給休暇管理',
  'sec-audit': '操作履歴',
  'sec-standby': '待機・雨の日管理',
  'sec-oncall': 'オンコール管理',
  'sec-monthly': '月次実績・インセンティブ',
  'sec-excel': 'iBow Excel集計',
  'sec-excel-history': 'iBow集計履歴',
  'sec-attendance': '出勤確定 集計',
  'sec-incentive-settings': 'インセンティブ設定',
  'sec-add-staff': 'スタッフ追加',
  'sec-next-year': '翌年スプレッドシート作成',
};

// セクション初期化済みフラグ
const sectionLoaded = {};

function navigateTo(sectionId) {
  // セクション切り替え
  document.querySelectorAll('.page-section').forEach(el => el.classList.remove('active'));
  const target = document.getElementById(sectionId);
  if (target) target.classList.add('active');

  // ナビアイテムのアクティブ状態
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const navItem = document.querySelector(`.nav-item[data-section="${sectionId}"]`);
  if (navItem) navItem.classList.add('active');

  // ページタイトル更新
  document.getElementById('pageTitle').textContent = SECTION_TITLES[sectionId] || '';

  // モバイル: サイドバーを閉じる
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('show');

  // セクション別の遅延ロード（初回: 初期化+データ取得、2回目以降: データのみ再取得）
  const isFirst = !sectionLoaded[sectionId];
  sectionLoaded[sectionId] = true;
  switch (sectionId) {
    case 'dashboard':
      loadDashboard(); break;
    case 'sec-schedules':
      loadAdminSchedules(); break;
    case 'sec-staff':
      loadStaff(); break;
    case 'sec-notices':
      loadAdminNotices(); break;
    case 'sec-leave':
      loadLeavePending(); break;
    case 'sec-audit':
      if (isFirst) loadAuditLog(1); break;
    case 'sec-oncall':
      if (isFirst) initOncallMonth();
      loadOncallSummary(); break;
    case 'sec-standby':
      if (isFirst) initStandbyMonth();
      loadStandbyData(); break;
    case 'sec-attendance':
      if (isFirst) initAttendanceMonth();
      loadAttendanceMonthly(); break;
    case 'sec-monthly':
      if (isFirst) initMonthlyListMonth();
      loadMonthlyList(); break;
  }

  // スクロール位置リセット
  document.getElementById('mainArea').scrollTop = 0;
}

// ダッシュボード読み込み
async function loadDashboard() {
  try {
    // 未確定予定の件数
    const sRes = await fetch('/api/admin/schedules');
    if (sRes.ok) {
      const schedules = await sRes.json();
      const pending = Array.isArray(schedules) ? schedules.filter(s => !s.confirmed).length : 0;
      document.getElementById('dashSchedules').textContent = pending;
      const badge = document.getElementById('badgeSchedules');
      if (pending > 0) { badge.textContent = pending; badge.classList.remove('d-none'); }
      else { badge.classList.add('d-none'); }
    }
  } catch {}
  try {
    // 未処理有給申請
    const lRes = await fetch('/api/admin/leave/requests');
    if (lRes.ok) {
      const leave = await lRes.json();
      const pendingLeave = Array.isArray(leave)
        ? leave.filter(r => r.status === 'pending').length : 0;
      document.getElementById('dashLeave').textContent = pendingLeave;
      const badge = document.getElementById('badgeLeave');
      if (pendingLeave > 0) { badge.textContent = pendingLeave; badge.classList.remove('d-none'); }
      else { badge.classList.add('d-none'); }
    }
  } catch {}
  // スタッフ数
  const activeCount = staffList ? staffList.filter(s => !s.archived).length : 0;
  document.getElementById('dashStaff').textContent = activeCount;

  // アラートリスト構築
  buildDashAlerts();
  // 仕様変更お知らせ読み込み
  loadDashChangelog();
}

function buildDashAlerts() {
  const list = document.getElementById('dashAlertList');
  const alerts = [];

  const schedCount = parseInt(document.getElementById('dashSchedules').textContent) || 0;
  if (schedCount > 0) alerts.push(`未確定の予定が ${schedCount} 件あります`);

  const leaveCount = parseInt(document.getElementById('dashLeave').textContent) || 0;
  if (leaveCount > 0) alerts.push(`未処理の有給申請が ${leaveCount} 件あります`);

  if (alerts.length === 0) {
    list.innerHTML = '<div class="dash-alert-none">対応が必要な項目はありません</div>';
  } else {
    list.innerHTML = alerts.map(a => `<div class="dash-alert-item">${esc(a)}</div>`).join('');
  }
}

// ── ダッシュボード: 仕様変更お知らせ ────────────────────────────
async function loadDashChangelog() {
  const el = document.getElementById('dashChangelogList');
  try {
    const res = await fetch('/api/admin/notices/changelog');
    const data = await res.json();
    const notices = data.notices || [];
    if (!notices.length) {
      el.innerHTML = '<div class="changelog-fallback">管理者向けの仕様変更お知らせはありません</div>';
      return;
    }
    el.innerHTML = notices.map(n => {
      const d = n.date || '';
      const m = d ? `${parseInt(d.slice(5,7))}月${parseInt(d.slice(8,10))}日` : '';
      return `<div class="changelog-item">
        <div class="changelog-header">
          <span class="changelog-title">${esc(n.title)}</span>
          <span class="changelog-date">${m}</span>
        </div>
        <div class="changelog-body">${esc(n.body)}</div>
      </div>`;
    }).join('');
  } catch {
    el.innerHTML = '<div class="changelog-fallback">読み込みに失敗しました</div>';
  }
}