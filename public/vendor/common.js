/**
 * 共通UIロジック（スタッフ画面用）
 * メニュー、トースト、ログアウト、HTMLエスケープ、初期化を一元管理
 */
'use strict';

// ── HTMLエスケープ ──────────────────────────────────────────────
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

// ── メニュー制御 ────────────────────────────────────────────────
function toggleMenu() {
  const overlay = document.getElementById('menuOverlay');
  const drawer  = document.getElementById('menuDrawer');
  if (!overlay || !drawer) return;
  const open = drawer.classList.toggle('open');
  overlay.classList.toggle('open', open);
}
function closeMenu() {
  const overlay = document.getElementById('menuOverlay');
  const drawer  = document.getElementById('menuDrawer');
  if (overlay) overlay.classList.remove('open');
  if (drawer)  drawer.classList.remove('open');
}

// ── トースト通知 ────────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg, durationMs) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), durationMs || 2500);
}

// ── ログアウト ──────────────────────────────────────────────────
async function logout() {
  await apiFetch('/api/logout', { method: 'POST' });
  location.href = '/login';
}

// ── 共通イベント登録（DOMContentLoaded後に呼ぶ） ────────────────
function initCommonUI() {
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  const menuOverlay  = document.getElementById('menuOverlay');
  const menuDrawer   = document.getElementById('menuDrawer');
  const menuLogoutBtn = document.getElementById('menuLogoutBtn');

  if (hamburgerBtn) hamburgerBtn.addEventListener('click', toggleMenu);
  if (menuOverlay)  menuOverlay.addEventListener('click', closeMenu);
  if (menuDrawer) {
    menuDrawer.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') closeMenu();
    });
  }
  if (menuLogoutBtn) menuLogoutBtn.addEventListener('click', logout);

  // 未読バッジ更新
  updateUnreadBadge();
}

// ── 未読バッジ ──────────────────────────────────────────────────
async function updateUnreadBadge() {
  const badge = document.getElementById('menuBadge');
  if (!badge) return;
  try {
    const r = await apiFetch('/api/notices/unread-count');
    if (r.ok) {
      const d = await r.json();
      if (d.count > 0) {
        badge.textContent = d.count;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    }
  } catch { /* ignore */ }
}
