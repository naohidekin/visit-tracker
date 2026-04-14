// admin-leave.js — 有給管理（申請・承認・残高）

// ── 有給休暇管理 ────────────────────────────────────────────
let leaveModalAction = null;
let leaveModalRequestId = null;
let leaveEditStaffId = null;

function switchLeaveTab(btn) {
  document.querySelectorAll('.leave-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  const tabId = btn.dataset.tab;
  ['leavePending', 'leaveHistory', 'leaveBalance'].forEach(id => {
    document.getElementById(id).style.display = id === tabId ? '' : 'none';
  });
  if (tabId === 'leavePending') loadLeavePending();
  if (tabId === 'leaveHistory') loadLeaveHistory();
  if (tabId === 'leaveBalance') loadLeaveBalanceSummary();
}

async function loadLeavePending() {
  const spinner = document.getElementById('leavePendingSpinner');
  const empty = document.getElementById('leavePendingEmpty');
  const wrap = document.getElementById('leavePendingTableWrap');
  spinner.style.display = ''; empty.style.display = 'none'; wrap.style.display = 'none';

  const res = await fetch('/api/admin/leave/requests?status=pending');
  const { requests } = await res.json();
  spinner.style.display = 'none';

  if (!requests.length) { empty.style.display = ''; return; }
  wrap.style.display = '';

  document.getElementById('leavePendingBody').innerHTML = requests.map(r => {
    const dateStr = r.dates.length === 1 ? r.dates[0] : r.dates[0] + '〜' + r.dates[r.dates.length - 1];
    const typeLabel = r.type === 'full' ? '全日' : r.type === 'half_am' ? '午前半休' : '午後半休';
    const created = r.createdAt ? new Date(r.createdAt).toLocaleDateString('ja-JP', {month:'numeric',day:'numeric'}) : '';
    return `<tr>
      <td>${esc(r.staffName)}</td>
      <td style="white-space:nowrap">${dateStr}</td>
      <td>${typeLabel}</td>
      <td style="font-size:14px">${esc(r.reason || '-')}</td>
      <td style="font-size:14px">${created}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-blue btn-sm" data-action="leave-approve" data-id="${esc(r.id)}">承認</button>
        <button class="btn btn-sm" style="background:#fee2e2;color:#b91c1c" data-action="leave-reject" data-id="${esc(r.id)}">却下</button>
      </td>
    </tr>`;
  }).join('');
}

// ── #leavePendingBody イベント委譲 ──────────────────────────────
document.getElementById('leavePendingBody').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'leave-approve') openLeaveModal('approve', btn.dataset.id);
  if (btn.dataset.action === 'leave-reject')  openLeaveModal('reject', btn.dataset.id);
});

// ── #leaveBalanceBody イベント委譲 ─────────────────────────────
document.getElementById('leaveBalanceBody').addEventListener('click', e => {
  const btn = e.target.closest('[data-action="edit-leave"]');
  if (!btn) return;
  const d = btn.dataset;
  openLeaveEdit(d.id, d.name, d.hire, Number(d.auto), Number(d.granted), Number(d.carried), Number(d.adj), Number(d.celebDays), Number(d.celebAdj));
});

function openLeaveModal(action, requestId) {
  leaveModalAction = action;
  leaveModalRequestId = requestId;
  document.getElementById('leaveModalTitle').textContent = action === 'approve' ? '有給申請を承認' : '有給申請を却下';
  document.getElementById('leaveModalBtn').textContent = action === 'approve' ? '承認する' : '却下する';
  document.getElementById('leaveModalBtn').style.background = action === 'approve' ? 'var(--blue)' : '#c0392b';
  document.getElementById('leaveModalComment').value = '';
  document.getElementById('leaveModal').style.display = 'flex';
}
function closeLeaveModal() {
  document.getElementById('leaveModal').style.display = 'none';
}

async function executeLeaveAction() {
  const comment = document.getElementById('leaveModalComment').value;
  const url = `/api/admin/leave/requests/${leaveModalRequestId}/${leaveModalAction}`;
  const res = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment }),
  });
  if (!res.ok) {
    closeLeaveModal();
    showToast('エラー: サーバーエラー (' + res.status + ')');
    return;
  }
  const data = await res.json();
  closeLeaveModal();
  if (data.ok) {
    showToast(leaveModalAction === 'approve' ? '承認しました' : '却下しました');
    loadLeavePending();
  } else {
    showToast('エラー: ' + (data.error || '失敗'));
  }
}

async function loadLeaveHistory() {
  const spinner = document.getElementById('leaveHistorySpinner');
  const empty = document.getElementById('leaveHistoryEmpty');
  const wrap = document.getElementById('leaveHistoryTableWrap');
  spinner.style.display = ''; empty.style.display = 'none'; wrap.style.display = 'none';

  // スタッフドロップダウン更新
  const staffSel = document.getElementById('leaveHistoryStaff');
  if (staffSel.options.length <= 1) {
    const sRes = await fetch('/api/admin/staff');
    const staff = await sRes.json();
    staff.filter(s => !s.archived).forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id; opt.textContent = s.name;
      staffSel.appendChild(opt);
    });
  }

  let url = '/api/admin/leave/requests';
  const status = document.getElementById('leaveHistoryStatus').value;
  if (status) url += '?status=' + status;

  const res = await fetch(url);
  let { requests } = await res.json();
  spinner.style.display = 'none';

  const staffFilter = staffSel.value;
  if (staffFilter) requests = requests.filter(r => r.staffId === staffFilter);

  if (!requests.length) { empty.style.display = ''; return; }
  wrap.style.display = '';

  const statusLabels = { pending: '承認待ち', approved: '承認済', rejected: '却下', cancelled: '取消済' };
  document.getElementById('leaveHistoryBody').innerHTML = requests.map(r => {
    const dateStr = r.dates.length === 1 ? r.dates[0] : r.dates[0] + '〜' + r.dates[r.dates.length - 1];
    const typeLabel = r.type === 'full' ? '全日' : r.type === 'half_am' ? '午前半休' : '午後半休';
    const created = r.createdAt ? new Date(r.createdAt).toLocaleDateString('ja-JP', {month:'numeric',day:'numeric'}) : '';
    return `<tr>
      <td>${esc(r.staffName)}</td>
      <td style="white-space:nowrap">${dateStr}</td>
      <td>${typeLabel}</td>
      <td><span class="leave-status ${r.status}">${statusLabels[r.status]}</span></td>
      <td style="font-size:14px">${esc(r.adminComment || '-')}</td>
      <td style="font-size:14px">${created}</td>
    </tr>`;
  }).join('');
}

async function loadLeaveBalanceSummary() {
  const spinner = document.getElementById('leaveBalanceSpinner');
  const wrap = document.getElementById('leaveBalanceTableWrap');
  spinner.style.display = ''; wrap.style.display = 'none';

  const res = await fetch('/api/admin/leave/summary');
  const { summary } = await res.json();
  spinner.style.display = 'none';
  wrap.style.display = '';

  document.getElementById('leaveBalanceBody').innerHTML = summary.map(s => {
    const adjStr = (s.manual_adjustment >= 0 ? '+' : '') + s.manual_adjustment;
    const balColor = s.balance <= 0 ? '#c0392b' : 'var(--text)';
    const editBtn = `<button class="btn btn-blue btn-sm" data-action="edit-leave" data-id="${esc(s.id)}" data-name="${esc(s.name)}" data-hire="${s.hire_date||''}" data-auto="${s.auto_grant_days}" data-granted="${s.granted}" data-carried="${s.carried_over}" data-adj="${s.manual_adjustment}" data-celeb-days="${s.celebration_days||3}" data-celeb-adj="${s.celebration_used_adj||0}">編集</button>`;
    return `<tr>
      <td class="leave-name">${esc(s.name)}</td>
      <td data-label="入社日" style="font-size:13px">${s.hire_date || '未設定'}</td>
      <td data-label="付与">${s.granted}日</td>
      <td data-label="繰越">${s.carried_over}日</td>
      <td data-label="調整">${adjStr}</td>
      <td data-label="使用">${s.used}日</td>
      <td class="leave-balance" data-label="残" style="font-weight:700;color:${balColor}">${s.balance}日</td>
      <td data-label="">${editBtn}</td>
    </tr>`;
  }).join('');
}

function openLeaveEdit(id, name, hireDate, autoGrant, granted, carried, adj, celebDays, celebAdj) {
  leaveEditStaffId = id;
  document.getElementById('leaveEditName').textContent = name;
  document.getElementById('leaveEditHireDate').value = hireDate;
  document.getElementById('leaveEditAutoGrant').textContent = hireDate ? `労基法自動計算: ${autoGrant}日` : '入社日を設定すると自動計算されます';
  document.getElementById('leaveEditGranted').value = granted;
  document.getElementById('leaveEditCarried').value = carried;
  document.getElementById('leaveEditAdj').value = adj;
  document.getElementById('leaveEditCelebDays').value = celebDays;
  document.getElementById('leaveEditCelebAdj').value = celebAdj;
  document.getElementById('leaveEditModal').style.display = 'flex';
}
function closeLeaveEditModal() {
  document.getElementById('leaveEditModal').style.display = 'none';
}

async function saveLeaveEdit() {
  const hireDate = document.getElementById('leaveEditHireDate').value;
  const granted = Number(document.getElementById('leaveEditGranted').value);
  const carried = Number(document.getElementById('leaveEditCarried').value);
  const adj = Number(document.getElementById('leaveEditAdj').value);
  const celebDays = Number(document.getElementById('leaveEditCelebDays').value);
  const celebAdj  = Number(document.getElementById('leaveEditCelebAdj').value);

  // 入社日を保存
  if (hireDate) {
    await apiFetch(`/api/admin/staff/${leaveEditStaffId}/hire-date`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hire_date: hireDate }),
    });
  }
  // 残日数・お祝い休暇を保存
  const res = await apiFetch(`/api/admin/staff/${leaveEditStaffId}/leave-balance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ granted, carried_over: carried, manual_adjustment: adj, celebration_days: celebDays, celebration_used_adj: celebAdj }),
  });
  const data = await res.json();
  closeLeaveEditModal();
  if (data.ok) {
    showToast('保存しました');
    loadLeaveBalanceSummary();
  } else {
    showToast('エラー: ' + (data.error || '保存失敗'));
  }
}
