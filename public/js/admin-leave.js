// admin-leave.js — 有給管理（申請・承認・残高）

// ── 有給休暇管理 ────────────────────────────────────────────
let leaveModalAction = null;
let leaveModalRequestId = null;
let leaveEditStaffId = null;
let leaveSummaryById = {};        // 残日数サマリを id 別に保持（付与情報・履歴参照用）
let leaveEditRecordGrant = false; // 「付与を反映」操作が行われたか（保存時に付与履歴へ記録）

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
    const ot = r.originalType || r.type;
    const isHalf = (ot === 'half_am' || ot === 'half_pm');
    const isCeleb = r.type === 'celebration';
    const baseLabel = ot === 'half_am' ? '午前半休' : ot === 'half_pm' ? '午後半休' : isCeleb ? 'お祝い休暇' : '全日';
    const typeLabel = isCeleb && isHalf ? baseLabel + '（お祝い）' : baseLabel;
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
  const editBtn = e.target.closest('[data-action="edit-leave"]');
  if (editBtn) {
    openLeaveEdit(editBtn.dataset.id);
    return;
  }
  const nameLink = e.target.closest('[data-action="show-leave-dates"]');
  if (nameLink) {
    e.preventDefault();
    showStaffLeaveDates(nameLink.dataset.id, nameLink.dataset.name);
  }
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
    const ot = r.originalType || r.type;
    const isHalf = (ot === 'half_am' || ot === 'half_pm');
    const isCeleb = r.type === 'celebration';
    const baseLabel = ot === 'half_am' ? '午前半休' : ot === 'half_pm' ? '午後半休' : isCeleb ? 'お祝い休暇' : '全日';
    const typeLabel = isCeleb && isHalf ? baseLabel + '（お祝い）' : baseLabel;
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

  leaveSummaryById = {};
  summary.forEach(s => { leaveSummaryById[s.id] = s; });

  document.getElementById('leaveBalanceBody').innerHTML = summary.map(s => {
    const adjStr = (s.manual_adjustment >= 0 ? '+' : '') + s.manual_adjustment;
    const balColor = s.balance <= 0 ? '#c0392b' : 'var(--text)';
    const editBtn = `<button class="btn btn-blue btn-sm" data-action="edit-leave" data-id="${esc(s.id)}">編集</button>`;
    const grantBadge = s.pending_grant
      ? ` <span class="grant-alert-badge" title="${esc(s.pending_grant.tenure_label)}経過。付与規定では${s.pending_grant.grant_days}日を付与する時期です。付与日数を更新してください。">⚠付与時期</span>`
      : '';
    return `<tr>
      <td class="leave-name"><a href="#" data-action="show-leave-dates" data-id="${esc(s.id)}" data-name="${esc(s.name)}">${esc(s.name)}</a></td>
      <td data-label="入社日" style="font-size:13px">${s.hire_date || '未設定'}</td>
      <td data-label="付与">${s.granted}日${grantBadge}</td>
      <td data-label="繰越">${s.carried_over}日</td>
      <td data-label="調整">${adjStr}</td>
      <td data-label="使用">${s.used}日</td>
      <td class="leave-balance" data-label="残" style="font-weight:700;color:${balColor}">${s.balance}日</td>
      <td data-label="">${editBtn}</td>
    </tr>`;
  }).join('');
}

// 残日数サマリ（leaveSummaryById）から1行分を読み込んで編集モーダルを開く
function openLeaveEdit(id) {
  const s = leaveSummaryById[id] || {};
  leaveEditStaffId = id;
  leaveEditRecordGrant = false;
  document.getElementById('leaveEditName').textContent = s.name || '';
  document.getElementById('leaveEditHireDate').value = s.hire_date || '';
  document.getElementById('leaveEditAutoGrant').textContent = s.hire_date ? `付与規定（自動計算）: ${s.auto_grant_days}日` : '入社日を設定すると自動計算されます';
  document.getElementById('leaveEditGranted').value = s.granted || 0;
  document.getElementById('leaveEditCarried').value = s.carried_over || 0;
  document.getElementById('leaveEditAdj').value = s.manual_adjustment || 0;
  document.getElementById('leaveEditCelebDays').value = s.celebration_days || 3;
  document.getElementById('leaveEditCelebAdj').value = s.celebration_used_adj || 0;

  // 付与時期の案内 & 「付与を反映」ボタン
  const box = document.getElementById('leaveEditGrantBox');
  const pg = s.pending_grant;
  if (pg) {
    document.getElementById('leaveEditGrantMsg').textContent =
      `勤続${pg.tenure_label}に到達。付与規定では ${pg.grant_days}日 を付与する時期です。`;
    const isFirst = pg.reached_months === 6;
    document.getElementById('leaveEditGrantNote').textContent = isFirst
      ? '「反映する」で付与日数を自動入力します。内容を確認して保存すると本人にお知らせが届きます。'
      : `「反映する」で付与日数を ${pg.grant_days}日 に、前年度分（前年度付与＋旧繰越）を繰越に下書きします。時効・上限を確認・調整のうえ保存してください。`;
    box.style.display = '';
  } else {
    box.style.display = 'none';
  }

  // 付与履歴（ラベルはサーバ側で付与済み）
  const hist = s.grant_history || [];
  const histWrap = document.getElementById('leaveEditHistory');
  if (hist.length > 0) {
    document.getElementById('leaveEditHistoryList').innerHTML = hist.map(h =>
      `${esc(h.grantedAt)} ｜ 勤続${esc(h.label || '')} ｜ ${esc(String(h.days))}日付与`
    ).join('<br>');
    histWrap.style.display = '';
  } else {
    histWrap.style.display = 'none';
  }

  document.getElementById('leaveEditModal').style.display = 'flex';
}

// 「この付与を反映する」— 付与日数（と2年目以降は繰越）を下書きし、保存時に付与記録するフラグを立てる
function applyPendingGrant() {
  const s = leaveSummaryById[leaveEditStaffId] || {};
  const pg = s.pending_grant;
  if (!pg) return;
  document.getElementById('leaveEditGranted').value = pg.grant_days;
  // 2年目以降（初回=6ヶ月以外）は前年度分（前年度付与＋旧繰越）を繰越へ下書き。
  // 調整・OC・使用済みは各欄で保持されるため、ここで残日数を丸ごと入れると二重計上になる。
  if (pg.reached_months !== 6) {
    const prevCarry = (Number(s.granted) || 0) + (Number(s.carried_over) || 0);
    document.getElementById('leaveEditCarried').value = prevCarry > 0 ? prevCarry : 0;
  }
  leaveEditRecordGrant = true;
  showToast('付与内容を下書きしました。時効・繰越上限を確認して「保存」してください');
}
function closeLeaveEditModal() {
  document.getElementById('leaveEditModal').style.display = 'none';
}

function closeLeaveDatesModal() {
  document.getElementById('leaveDatesModal').style.display = 'none';
}

async function showStaffLeaveDates(staffId, staffName) {
  document.getElementById('leaveDatesName').textContent = staffName;
  document.getElementById('leaveDatesSummary').textContent = '';
  document.getElementById('leaveDatesBody').innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--muted);padding:16px 0">読み込み中...</td></tr>';
  document.getElementById('leaveDatesModal').style.display = 'flex';

  let requests;
  try {
    const res = await fetch('/api/admin/leave/requests?status=approved');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    ({ requests } = await res.json());
  } catch (e) {
    document.getElementById('leaveDatesBody').innerHTML =
      '<tr><td colspan="3" style="text-align:center;color:#c0392b;padding:16px 0">データの取得に失敗しました</td></tr>';
    return;
  }

  const staffRequests = requests.filter(r => r.staffId === staffId);
  const rows = [];
  for (const r of staffRequests) {
    if (!Array.isArray(r.dates)) continue;
    const ot = r.originalType || r.type;
    const isHalf = (ot === 'half_am' || ot === 'half_pm');
    const isCeleb = r.type === 'celebration';
    const baseLabel = ot === 'half_am' ? '午前半休' : ot === 'half_pm' ? '午後半休' : isCeleb ? 'お祝い休暇' : '全日';
    const typeLabel = isCeleb && isHalf ? baseLabel + '（お祝い）' : baseLabel;
    for (const d of r.dates) {
      if (typeof d !== 'string' || !d) continue;
      rows.push({ date: d, typeLabel, reason: r.reason || '' });
    }
  }

  rows.sort((a, b) => b.date.localeCompare(a.date));

  if (!rows.length) {
    document.getElementById('leaveDatesBody').innerHTML =
      '<tr><td colspan="3" style="text-align:center;color:var(--muted);padding:16px 0">取得済みの有給はありません</td></tr>';
    return;
  }

  const totalDays = rows.reduce((sum, r) => sum + (r.typeLabel.includes('半休') ? 0.5 : 1), 0);
  document.getElementById('leaveDatesSummary').textContent = '承認済み ' + rows.length + '件（' + totalDays + '日分）';

  document.getElementById('leaveDatesBody').innerHTML = rows.map(r => {
    const d = new Date(r.date + 'T00:00:00');
    const dow = ['日','月','火','水','木','金','土'][d.getDay()];
    const dateStr = (d.getMonth()+1) + '/' + d.getDate() + '（' + dow + '）';
    return '<tr>' +
      '<td style="white-space:nowrap;font-weight:600">' + dateStr + '</td>' +
      '<td>' + r.typeLabel + '</td>' +
      '<td style="font-size:13px;color:var(--muted)">' + esc(r.reason || '-') + '</td>' +
    '</tr>';
  }).join('');
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
    const hireRes = await apiFetch(`/api/admin/staff/${leaveEditStaffId}/hire-date`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hire_date: hireDate }),
    });
    if (!hireRes.ok) {
      const hireData = await hireRes.json().catch(() => ({}));
      showToast('エラー: ' + (hireData.error || '入社日の保存に失敗しました'));
      return;
    }
  }
  // 残日数・お祝い休暇を保存
  const res = await apiFetch(`/api/admin/staff/${leaveEditStaffId}/leave-balance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ granted, carried_over: carried, manual_adjustment: adj, celebration_days: celebDays, celebration_used_adj: celebAdj, record_grant: leaveEditRecordGrant }),
  });
  const data = await res.json();
  leaveEditRecordGrant = false;
  closeLeaveEditModal();
  if (data.ok) {
    showToast(data.grant_recorded ? '付与を記録し、本人にお知らせを送信しました' : '保存しました');
    loadLeaveBalanceSummary();
  } else {
    showToast('エラー: ' + (data.error || '保存失敗'));
  }
}
