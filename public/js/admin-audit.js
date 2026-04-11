// admin-audit.js — 監査ログ・ヘルスチェック

// ── システムヘルスチェック ──────────────────────────────────
function renderHealthResult(result) {
  const badge  = document.getElementById('healthStatusBadge');
  const body   = document.getElementById('healthCheckBody');
  const panel  = document.getElementById('healthResults');
  const lastRun = document.getElementById('healthLastRun');

  badge.textContent = result.ok ? '✅ 正常' : '❌ 異常あり';
  badge.className = result.ok ? 'health-badge-ok' : 'health-badge-fail';

  if (result.checkedAt) {
    const dt = new Date(result.checkedAt);
    lastRun.textContent = `前回: ${dt.toLocaleString('ja-JP')}`;
  }

  body.innerHTML = (result.checks || []).map(c => `
    <tr class="health-row">
      <td class="health-td">${esc(c.name)}</td>
      <td class="health-td-center">${c.ok ? '✅' : '❌'}</td>
      <td class="health-td ${c.ok ? 'color-muted' : 'color-danger'}">${esc(c.detail)}</td>
    </tr>`).join('');

  panel.style.display = 'block';
}

async function runHealthCheck() {
  const btn = document.getElementById('healthRunBtn');
  btn.disabled = true;
  btn.textContent = '実行中…';
  try {
    const res = await apiFetch('/api/admin/health');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    renderHealthResult(data);
  } catch (e) {
    showToast('ヘルスチェックに失敗しました: ' + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '今すぐ実行';
  }
}

async function loadLastHealthCheck() {
  try {
    const res = await apiFetch('/api/admin/health/last');
    if (!res.ok) return;
    const data = await res.json();
    if (data.checkedAt) renderHealthResult(data);
  } catch (_) {}
}

// ── 監査ログ ──────────────────────────────────────────────
const AUDIT_ACTION_LABELS = {
  'auth.login': 'ログイン',
  'auth.login_failed': 'ログイン失敗',
  'auth.logout': 'ログアウト',
  'auth.admin_login': '管理者ログイン',
  'auth.admin_login_failed': '管理者ログイン失敗',
  'auth.admin_logout': '管理者ログアウト',
  'auth.webauthn_login': 'WebAuthnログイン',
  'auth.webauthn_delete': 'WebAuthn削除',
  'auth.change_password': 'パスワード変更',
  'auth.reset_request': 'PWリセット申請',
  'auth.self_reset_password': 'PWセルフリセット',
  'record.create': '実績入力',
  'record.confirm_schedule': '予定確定',
  'record.admin_edit': '管理者実績編集',
  'schedule.create': '予定登録',
  'schedule.delete': '予定削除',
  'schedule.admin_delete': '管理者予定削除',
  'staff.create': 'スタッフ追加',
  'staff.update': 'スタッフ編集',
  'staff.delete': 'スタッフ削除',
  'staff.archive_toggle': '格納切替',
  'staff.reset_password': 'PW リセット',
  'staff.hire_date_update': '入社日変更',
  'leave.request': '有給申請',
  'leave.cancel': '有給取消',
  'leave.approve': '有給承認',
  'leave.reject': '有給却下',
  'leave.balance_update': '有給残調整',
  'oncall.upsert': 'OC記録登録',
  'oncall.delete': 'OC記録削除',
  'oncall.eligible_update': 'OC対象変更',
  'notice.create': 'お知らせ作成',
  'notice.update': 'お知らせ編集',
  'notice.delete': 'お知らせ削除',
  'incentive.defaults_update': 'インセンティブ既定変更',
  'incentive.staff_update': 'インセンティブ個別変更',
};

let auditCurrentPage = 1;
function loadAuditLog(page) {
  auditCurrentPage = page || 1;
  const action = document.getElementById('auditActionFilter').value;
  const from = document.getElementById('auditDateFrom').value;
  const to = document.getElementById('auditDateTo').value;
  const params = new URLSearchParams({ page: auditCurrentPage, limit: 30 });
  if (action) params.set('action', action);
  if (from)   params.set('from', from);
  if (to)     params.set('to', to);

  fetch('/api/admin/audit-log?' + params)
    .then(r => r.json())
    .then(data => {
      const tbody = document.getElementById('auditLogBody');
      if (data.entries.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-msg">ログがありません</td></tr>';
      } else {
        tbody.innerHTML = data.entries.map(e => {
          const dt = new Date(e.timestamp);
          const timeStr = `${dt.getMonth()+1}/${dt.getDate()} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
          const actorStr = esc(e.actor.staffName || e.actor.type);
          const actionLabel = esc(AUDIT_ACTION_LABELS[e.action] || e.action);
          const targetStr = esc(e.target?.label || '');
          return `<tr>
            <td class="audit-td-nowrap">${timeStr}</td>
            <td class="audit-td-nowrap">${actorStr}</td>
            <td class="audit-td-nowrap">${actionLabel}</td>
            <td class="audit-td">${targetStr}</td>
          </tr>`;
        }).join('');
      }
      document.getElementById('auditPageInfo').textContent = `${data.page}/${data.pages} (${data.total}件)`;
      document.getElementById('auditPrev').disabled = data.page <= 1;
      document.getElementById('auditNext').disabled = data.page >= data.pages;
    })
    .catch(err => console.error('Audit log error:', err));
}

function auditPageNav(dir) {
  loadAuditLog(auditCurrentPage + dir);
}

function verifyAuditChain() {
  fetch('/api/admin/audit-log/verify')
    .then(r => r.json())
    .then(data => {
      const el = document.getElementById('auditVerifyResult');
      if (data.valid) {
        el.innerHTML = `<span class="verify-ok">✅ 整合性OK (${data.entries}件)</span>`;
      } else {
        el.innerHTML = `<span class="verify-fail">❌ 不整合 ${data.errors.length}件検出</span>`;
      }
    });
}
