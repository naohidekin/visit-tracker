// admin-staff.js — スタッフ管理（CRUD・アーカイブ・パスワード）

// ── 状態 ──────────────────────────────────────────────────
let staffList = [];
let deleteTarget = '', resetTarget = '';

// ── スタッフ一覧 ────────────────────────────────────────────
let showArchived = false;

async function loadStaff() {
  document.getElementById('tableSpinner').style.display = 'block';
  const url = showArchived ? '/api/admin/staff?includeArchived=true' : '/api/admin/staff';
  const res  = await fetch(url);
  staffList  = await res.json();
  document.getElementById('tableSpinner').style.display = 'none';
  renderTable();
  loadIncentive();
  initAdminMonthlySelectors();
  initExcelSelectors();
  updateAdminStaffSelect();
  loadAdminSchedules();
  loadAdminNotices();
}

function toggleArchivedView() {
  showArchived = !showArchived;
  const btn = document.getElementById('archiveToggleBtn');
  btn.textContent = showArchived ? '📦 格納済みを非表示' : '📦 格納済みを表示';
  loadStaff();
}

function buildStaffRowHtml(s, badge, colInfo, furi) {
  if (s.archived) {
    return `
      <td>
        <div class="name-furi">${esc(furi)}</div>
        <div class="name-kanji">${esc(s.name)}</div>
      </td>
      <td>${badge}</td>
      <td>
        <div class="td-btns">
          <button class="btn-xs btn-restore" data-action="restore" data-id="${esc(s.id)}">復元</button>
          <button class="btn-xs btn-danger" data-action="delete" data-id="${esc(s.id)}">削除</button>
        </div>
      </td>`;
  }
  const ocBtn = s.type === 'nurse'
    ? `<button class="btn-xs ${s.oncall_eligible ? 'btn-green' : 'btn-reset'}" data-action="toggle-oncall" data-id="${esc(s.id)}" data-eligible="${s.oncall_eligible ? 'true' : 'false'}" title="オンコール対象">${s.oncall_eligible ? 'OC有' : 'OC無'}</button>`
    : '';
  const adminBadge = s.is_admin ? '<span style="background:#e53935;color:#fff;font-size:11px;padding:1px 5px;border-radius:3px;margin-left:4px;font-weight:700">管</span>' : '';
  const adminBtn = s.is_admin
    ? `<button class="btn-xs btn-danger revoke-admin-btn" data-id="${esc(s.id)}" title="管理者権限剥奪">管理者解除</button>`
    : `<button class="btn-xs btn-green grant-admin-btn" data-id="${esc(s.id)}" title="管理者権限付与">管理者付与</button>`;
  const emailIcon = s.email ? `<span title="${esc(s.email)}" style="font-size:13px;cursor:help">✉️</span>` : `<span style="font-size:14px;color:#ccc" title="メール未登録">✉️</span>`;
  return `
    <td>
      <div class="name-furi">${esc(furi)} ${emailIcon}</div>
      <div class="name-kanji">${esc(s.name)}${adminBadge}</div>
    </td>
    <td>${badge}</td>
    <td>
      <div class="td-btns">
        ${ocBtn}
        ${adminBtn}
        <button class="btn-xs btn-edit" data-action="edit" data-id="${esc(s.id)}">編集</button>
        <button class="btn-xs btn-reset" data-action="reset-pw" data-id="${esc(s.id)}">PW</button>
        <button class="btn-xs btn-archive" data-action="archive" data-id="${esc(s.id)}">格納</button>
      </div>
    </td>`;
}

function renderTable() {
  const tbody = document.getElementById('staffBody');
  tbody.innerHTML = '';
  for (const s of staffList) {
    const furi  = (s.furigana_family || '') + (s.furigana_given || '');
    const badge = staffTypeBadge(s.type);
    const tr = document.createElement('tr');
    tr.dataset.staffId = s.id;
    if (s.archived) tr.classList.add('archived-row');
    tr.innerHTML = buildStaffRowHtml(s, badge, null, furi);
    tbody.appendChild(tr);
  }
}

// ── #staffBody イベント委譲 ─────────────────────────────────────
document.getElementById('staffBody').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.action;
  if (action === 'restore')       toggleArchive(id, false);
  else if (action === 'delete')   askDelete(id);
  else if (action === 'toggle-oncall') toggleOncallEligible(id, btn.dataset.eligible !== 'true');
  else if (action === 'edit')     editStaffRow(id);
  else if (action === 'reset-pw') askReset(id);
  else if (action === 'archive')  toggleArchive(id, true);
  else if (action === 'save-staff')  saveStaffRow(id);
  else if (action === 'cancel-edit') cancelStaffEdit(id);
});

async function toggleArchive(id, archive) {
  const s = staffList.find(x => x.id === id);
  const name = s ? s.name : id;
  const msg = archive ? `「${name}」を格納しますか？` : `「${name}」を復元しますか？`;
  if (!confirm(msg)) return;
  try {
    const res  = await apiFetch(`/api/admin/staff/${encodeURIComponent(id)}/archive`, { method: 'PATCH' });
    const data = await res.json();
    if (data.success) {
      showToast(archive ? `📦 ${name} を格納しました` : `✅ ${name} を復元しました`);
      loadStaff();
    } else {
      showToast('エラー: ' + (data.error || '失敗'));
    }
  } catch (e) {
    showToast('通信エラー: ' + e.message);
  }
}

function editStaffRow(id) {
  const s = staffList.find(x => x.id === id);
  if (!s) return;
  const tr = document.querySelector(`tr[data-staff-id="${id}"]`);
  if (!tr) return;
  const furi_f = s.furigana_family || '';
  const furi_g = s.furigana_given  || '';
  const email  = s.email || '';
  tr.innerHTML = `
    <td>
      <input class="edit-input" id="edit-name-${esc(id)}" value="${esc(s.name)}" placeholder="フルネーム" style="margin-bottom:4px">
      <input class="edit-input" id="edit-furi-f-${esc(id)}" value="${esc(furi_f)}" placeholder="姓ふりがな" style="margin-bottom:4px">
      <input class="edit-input" id="edit-furi-g-${esc(id)}" value="${esc(furi_g)}" placeholder="名ふりがな" style="margin-bottom:4px">
      <input class="edit-input" id="edit-email-${esc(id)}" value="${esc(email)}" placeholder="メールアドレス" type="email" style="font-size:14px">
    </td>
    <td style="font-size:13px;color:var(--muted)">変更不可</td>
    <td>
      <div class="td-btns">
        <button class="btn-xs btn-green" data-action="save-staff" data-id="${esc(id)}">保存</button>
        <button class="btn-xs btn-edit" data-action="cancel-edit" data-id="${esc(id)}">戻す</button>
      </div>
    </td>`;
}

function cancelStaffEdit(id) {
  const s = staffList.find(x => x.id === id);
  if (!s) return;
  const tr = document.querySelector(`tr[data-staff-id="${id}"]`);
  if (!tr) return;
  const furi  = (s.furigana_family || '') + (s.furigana_given || '');
  const badge = staffTypeBadge(s.type);
  tr.innerHTML = buildStaffRowHtml(s, badge, null, furi);
}

async function saveStaffRow(id) {
  const name    = document.getElementById(`edit-name-${id}`).value.trim();
  const furi_f  = document.getElementById(`edit-furi-f-${id}`).value.trim();
  const furi_g  = document.getElementById(`edit-furi-g-${id}`).value.trim();
  const email   = document.getElementById(`edit-email-${id}`).value.trim();
  if (!name) { alert('氏名を入力してください'); return; }
  const res  = await apiFetch(`/api/admin/staff/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, furigana_family: furi_f, furigana_given: furi_g, email: email || null }),
  });
  const data = await res.json();
  if (!data.success) { alert(data.error || '保存に失敗しました'); return; }
  staffList = data.staff;
  renderTable();
}

// ── スタッフ追加 ─────────────────────────────────────────────
function autoGenerate() {
  const fkana = document.getElementById('newFkana').value.trim();
  const gkana = document.getElementById('newGkana').value.trim();
  const nextSeq = Math.max(0, ...staffList.map(s => s.seq || 0)) + 1;
  const seqStr  = String(nextSeq).padStart(2, '0');

  if (fkana) {
    const fRomaji = hiraToRomaji(fkana);
    const loginId = fRomaji + seqStr;
    document.getElementById('newLoginId').value = loginId;
    document.getElementById('idAutoLabel').textContent = `自動生成: ${loginId}`;
  }
  if (fkana && gkana) {
    const fRomaji = hiraToRomaji(fkana);
    const gRomaji = hiraToRomaji(gkana);
    const fi = (fRomaji[0] || '').toUpperCase();
    const gi = (gRomaji[0] || '').toUpperCase();
    const pw = gi + fi + seqStr;
    document.getElementById('newInitialPw').value = pw;
    document.getElementById('pwAutoLabel').textContent = `自動生成: ${pw}`;
  }
  // 看護師のみオンコール欄を表示
  const type = document.getElementById('newType').value;
  document.getElementById('oncallField').style.display = type === 'nurse' ? '' : 'none';
}

async function addStaff() {
  const name     = document.getElementById('newName').value.trim();
  const fkana    = document.getElementById('newFkana').value.trim();
  const gkana    = document.getElementById('newGkana').value.trim();
  const type     = document.getElementById('newType').value;
  const loginId  = document.getElementById('newLoginId').value.trim();
  const initPw   = document.getElementById('newInitialPw').value.trim();
  const email    = document.getElementById('newEmail').value.trim() || null;
  const hireDate = document.getElementById('newHireDate').value || null;
  const oncall   = type === 'nurse' ? document.getElementById('newOncall').value : undefined;
  const err     = document.getElementById('addErr');
  const btn     = document.getElementById('addBtn');
  err.style.display = 'none';

  if (!name || !loginId || !initPw) {
    err.textContent = '名前・ログインID・初期PWは必須です'; err.style.display = 'block'; return;
  }
  if (initPw.length < 8) {
    err.textContent = '初期パスワードは8文字以上で設定してください'; err.style.display = 'block'; return;
  }

  btn.disabled = true; btn.textContent = '処理中（全月シート更新中）...';

  const res  = await apiFetch('/api/admin/staff', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, furigana_family: fkana, furigana_given: gkana,
                           type, loginId, initialPw: initPw,
                           hire_date: hireDate, oncall, email }),
  });
  const data = await res.json();

  if (data.success) {
    btn.disabled = false; btn.textContent = '追加する';
    staffList = data.staff;
    renderTable();
    // フォームリセット
    ['newName','newFkana','newGkana','newLoginId','newInitialPw','newEmail','newHireDate'].forEach(id => {
      document.getElementById(id).value = '';
    });
    document.getElementById('idAutoLabel').textContent = '';
    document.getElementById('pwAutoLabel').textContent = '';
    document.getElementById('newOncall').value = '無';
    document.getElementById('oncallField').style.display = 'none';
    showToast(`✅ ${name} を追加しました`);
  } else {
    btn.disabled = false; btn.textContent = '追加する';
    err.textContent = 'エラー: ' + (data.error || '追加失敗');
    err.style.display = 'block';
  }
}

// ── 削除 ────────────────────────────────────────────────────
async function toggleOncallEligible(id, val) {
  const res = await apiFetch(`/api/admin/staff/${encodeURIComponent(id)}/oncall-eligible`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oncall_eligible: val }),
  });
  const data = await res.json();
  if (data.ok) {
    const s = staffList.find(x => x.id === id);
    if (s) s.oncall_eligible = data.oncall_eligible;
    renderTable();
    showToast(val ? 'OC対象に設定しました' : 'OC対象を解除しました');
  } else {
    showToast('エラー: ' + (data.error || '失敗'));
  }
}

function askDelete(id) {
  deleteTarget = id;
  const s = staffList.find(x => x.id === id);
  const name = s ? s.name : id;
  document.getElementById('delMsg').textContent =
    `「${name}」を削除します。\nスプレッドシートの列は変更されません（手動で削除してください）。よろしいですか？`;
  document.getElementById('delModal').classList.add('show');
}
function closeDelModal() {
  document.getElementById('delModal').classList.remove('show');
  deleteTarget = '';
}
async function confirmDelete() {
  closeDelModal();
  const res  = await apiFetch(`/api/admin/staff/${encodeURIComponent(deleteTarget)}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  if (data.success) { staffList = data.staff; renderTable(); showToast(`🗑️ 削除しました`); }
  else showToast('エラー: ' + (data.error || '削除失敗'));
}

// ── PWリセット ───────────────────────────────────────────────
function askReset(id) {
  resetTarget = id;
  const s = staffList.find(x => x.id === id);
  const name = s ? s.name : id;
  document.getElementById('resetMsg').textContent =
    `「${name}」のパスワードを初期パスワードに戻します。よろしいですか？`;
  document.getElementById('resetResult').style.display = 'none';
  document.getElementById('resetBtns').style.display   = 'flex';
  document.getElementById('resetModal').classList.add('show');
}
function closeResetModal() {
  document.getElementById('resetModal').classList.remove('show');
  document.getElementById('resetCloseBtns').style.display = 'none';
  resetTarget = '';
}
async function confirmReset() {
  const res  = await apiFetch(`/api/admin/staff/${encodeURIComponent(resetTarget)}/reset-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  if (data.success) {
    document.getElementById('resetBtns').style.display      = 'none';
    document.getElementById('resetCloseBtns').style.display = 'flex';
    document.getElementById('resetResult').textContent      = `✅ リセット完了。初期PW：${data.initial_pw}`;
    document.getElementById('resetResult').style.display    = 'block';
  } else {
    showToast('エラー: ' + (data.error || 'リセット失敗'));
    closeResetModal();
  }
}