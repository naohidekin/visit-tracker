// admin-notice.js — お知らせ・スケジュール管理

// ── 予定一覧 ─────────────────────────────────────────────────
async function loadAdminSchedules() {
  document.getElementById('schedulesSpinner').style.display = 'block';
  document.getElementById('schedulesEmpty').style.display   = 'none';
  document.getElementById('schedulesTableWrap').style.display = 'none';
  try {
    const res  = await fetch('/api/admin/schedules');
    if (!res.ok) { document.getElementById('schedulesSpinner').style.display = 'none'; return; }
    const list = await res.json();
    document.getElementById('schedulesSpinner').style.display = 'none';
    if (!list.length) {
      document.getElementById('schedulesEmpty').style.display = 'block';
      return;
    }
    const WEEKDAYS = ['日','月','火','水','木','金','土'];
    function fmtDateJP(dateStr) {
      const d = new Date(dateStr + 'T00:00:00');
      return `${d.getMonth()+1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）`;
    }
    const tbody = document.getElementById('schedulesBody');
    tbody.innerHTML = '';
    for (const s of list) {
      let valText = '';
      if (s.jobType === 'nurse') {
        const k = s.kaigo != null ? s.kaigo.toFixed(1) + '時間' : '—';
        const i = s.iryo  != null ? s.iryo.toFixed(1)  + '時間' : '—';
        valText = `介護：${k} ／ 医療：${i}`;
      } else {
        valText = s.units != null ? `${s.units}単位` : '—';
      }
      const createdAt = new Date(s.createdAt).toLocaleString('ja-JP', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' });
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${esc(s.staffName)}</strong></td>
        <td class="schedule-td-date">${fmtDateJP(s.date)}</td>
        <td>${staffTypeBadge(s.jobType)}</td>
        <td class="schedule-td-val">${valText}</td>
        <td class="schedule-td-meta">${createdAt}</td>
        <td><button class="btn btn-sm btn-danger" data-action="delete-schedule" data-id="${esc(s.id)}" data-name="${esc(s.staffName)}" data-date="${esc(s.date)}">削除</button></td>`;
      tbody.appendChild(tr);
    }
    document.getElementById('schedulesTableWrap').style.display = 'block';
  } catch (e) {
    document.getElementById('schedulesSpinner').style.display = 'none';
  }
}

// ── #schedulesBody イベント委譲 ─────────────────────────────────
document.getElementById('schedulesBody').addEventListener('click', e => {
  const btn = e.target.closest('[data-action="delete-schedule"]');
  if (btn) deleteAdminSchedule(btn.dataset.id, btn.dataset.name, btn.dataset.date);
});

async function deleteAdminSchedule(id, name, date) {
  if (!confirm(`${name} の ${date} の予定を削除しますか？`)) return;
  const res  = await apiFetch(`/api/admin/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await res.json();
  if (data.success) { showToast('🗑️ 予定を削除しました'); loadAdminSchedules(); }
  else showToast('エラー: ' + (data.error || '削除失敗'));
}

// ── お知らせ管理 ────────────────────────────────────────────
let editingNoticeId = null;
let noticesCache = [];

async function loadAdminNotices() {
  const spinner = document.getElementById('noticesSpinner');
  const empty   = document.getElementById('noticesEmpty');
  const wrap    = document.getElementById('noticesTableWrap');
  const body    = document.getElementById('noticesBody');
  spinner.style.display = 'block';
  empty.style.display   = 'none';
  wrap.style.display    = 'none';

  const res  = await fetch('/api/admin/notices');
  const data = await res.json();
  spinner.style.display = 'none';
  noticesCache = data.notices || [];

  if (!noticesCache.length) {
    empty.style.display = 'block';
    return;
  }
  wrap.style.display = 'block';
  body.innerHTML = noticesCache.map(n => {
    const isSystem = n.source === 'system';
    const badge = isSystem
      ? '<span class="notice-badge-system">運営</span>'
      : '<span class="notice-badge-admin">管理者</span>';
    const targetLabel = n.target === 'admin' ? '<span class="notice-target-admin">管理者</span>'
      : n.target === 'staff' ? '<span class="notice-target-staff">スタッフ</span>'
      : '<span class="notice-target-all">全員</span>';
    const btns = `<button class="btn-xs btn-edit" data-action="edit-notice" data-id="${esc(n.id)}">編集</button><button class="btn-xs btn-danger" data-action="delete-notice" data-id="${esc(n.id)}">削除</button>`;
    return `<tr>
      <td>${badge}</td>
      <td>${targetLabel}</td>
      <td class="notice-title-cell">${esc(n.title)}</td>
      <td class="notice-date-cell">${n.date || ''}</td>
      <td class="td-btns">${btns}</td>
    </tr>`;
  }).join('');
}

// ── #noticesBody イベント委譲 ────────────────────────────────────
document.getElementById('noticesBody').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'edit-notice')   startEditNotice(btn.dataset.id);
  if (btn.dataset.action === 'delete-notice') deleteNotice(btn.dataset.id);
});

// ── お知らせ作成/更新ボタン ────────────────────────────────────
document.getElementById('noticeSubmitBtn').addEventListener('click', () => {
  if (editingNoticeId) updateNotice();
  else createNotice();
});

function startEditNotice(id) {
  const n = noticesCache.find(x => x.id === id);
  if (!n) return;
  editingNoticeId = id;
  document.getElementById('noticeSource').value = n.source || 'admin';
  document.getElementById('noticeTarget').value = n.target || '';
  document.getElementById('noticeTitle').value = n.title;
  document.getElementById('noticeBody').value  = n.body;
  const msgEl = document.getElementById('noticeMsg');
  msgEl.style.display = 'block';
  msgEl.className = 'msg ok';
  msgEl.textContent = '編集モード: 内容を変更して「更新」を押してください';
  document.getElementById('noticeSubmitBtn').textContent = '更新';
}

async function createNotice() {
  const title = document.getElementById('noticeTitle').value.trim();
  const body  = document.getElementById('noticeBody').value.trim();
  const msgEl = document.getElementById('noticeMsg');
  if (!title || !body) {
    msgEl.style.display = 'block'; msgEl.className = 'msg err'; msgEl.textContent = 'タイトルと本文を入力してください';
    return;
  }
  const source = document.getElementById('noticeSource').value;
  const target = document.getElementById('noticeTarget').value;
  const res = await apiFetch('/api/admin/notices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, source, target })
  });
  const data = await res.json();
  if (data.ok) {
    showToast('📢 お知らせを作成しました');
    document.getElementById('noticeTitle').value = '';
    document.getElementById('noticeBody').value  = '';
    document.getElementById('noticeSource').value = 'admin';
    document.getElementById('noticeTarget').value = 'staff';
    msgEl.style.display = 'none';
    loadAdminNotices();
  } else {
    msgEl.style.display = 'block'; msgEl.className = 'msg err'; msgEl.textContent = data.error || '作成失敗';
  }
}

async function updateNotice() {
  if (!editingNoticeId) return;
  const title = document.getElementById('noticeTitle').value.trim();
  const body  = document.getElementById('noticeBody').value.trim();
  const msgEl = document.getElementById('noticeMsg');
  if (!title || !body) {
    msgEl.style.display = 'block'; msgEl.className = 'msg err'; msgEl.textContent = 'タイトルと本文を入力してください';
    return;
  }
  const target = document.getElementById('noticeTarget').value;
  const res = await apiFetch(`/api/admin/notices/${editingNoticeId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, target })
  });
  const data = await res.json();
  if (data.ok) {
    showToast('📢 お知らせを更新しました');
    cancelEditNotice();
    loadAdminNotices();
  } else {
    msgEl.style.display = 'block'; msgEl.className = 'msg err'; msgEl.textContent = data.error || '更新失敗';
  }
}

function cancelEditNotice() {
  editingNoticeId = null;
  document.getElementById('noticeSource').value = 'admin';
  document.getElementById('noticeTarget').value = 'staff';
  document.getElementById('noticeTitle').value = '';
  document.getElementById('noticeBody').value  = '';
  const msgEl = document.getElementById('noticeMsg');
  msgEl.style.display = 'none';
  document.getElementById('noticeSubmitBtn').textContent = '新規作成';
}

async function deleteNotice(id) {
  if (!confirm('このお知らせを削除しますか？')) return;
  const res = await apiFetch(`/api/admin/notices/${id}`, { method: 'DELETE' });
  const data = await res.json();
  if (data.ok) { showToast('🗑️ お知らせを削除しました'); loadAdminNotices(); }
  else showToast('エラー: ' + (data.error || '削除失敗'));
}
