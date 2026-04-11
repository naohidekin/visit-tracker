// admin-auth.js — 管理者認証（パスワード・Face ID）

// ── 状態 ──────────────────────────────────────────────────
let checkedStaffId = '';   // 最後にcheckした staffId
let checkedHasFaceId = false;

function showLoginCard(cardId) {
  document.getElementById('loginCard').style.display = cardId === 'loginCard' ? 'block' : 'none';
}

function onLoginSuccess() {
  document.getElementById('loginCard').style.display = 'none';
  document.getElementById('appLayout').style.display = 'flex';
  loadAdminIdentity();
  loadStaff();
  loadDashboard();
}

function showLoginErr(msg) {
  const err = document.getElementById('loginErr');
  err.textContent = msg;
  err.style.display = 'block';
}
function hideLoginErr() {
  const err = document.getElementById('loginErr');
  err.style.display = 'none';
  // PASSWORD_TOO_SHORT 用の導線リンクが残っていれば消す
  const link = document.getElementById('pwChangeLink');
  if (link) link.remove();
}

// スタッフID入力後の自動判定（Face ID登録済み？）
async function checkStaffId() {
  const staffId = document.getElementById('staffIdInput').value.trim();
  hideLoginErr();
  document.getElementById('faceIdSection').style.display = 'none';
  document.getElementById('passwordSection').style.display = 'none';
  checkedStaffId = '';
  checkedHasFaceId = false;

  if (!staffId) return;

  try {
    const res = await fetch('/api/admin/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staffId }),
    });
    const data = await res.json();
    if (!data.exists) {
      showLoginErr('管理者として登録されていません');
      return;
    }
    checkedStaffId = staffId;
    checkedHasFaceId = data.hasFaceId;
    if (data.hasFaceId) {
      // Face ID登録済み → Face IDボタンを表示
      document.getElementById('faceIdSection').style.display = 'block';
    } else {
      // Face ID未登録 → パスワード欄を表示
      document.getElementById('passwordSection').style.display = 'block';
      document.getElementById('pwInput').focus();
    }
  } catch {
    showLoginErr('サーバーに接続できません');
  }
}

// Face IDログイン
async function faceIdLogin() {
  const staffId = document.getElementById('staffIdInput').value.trim();
  hideLoginErr();
  if (!staffId) { showLoginErr('スタッフIDを入力してください'); return; }

  try {
    // 認証オプション取得
    const optRes = await fetch('/api/admin/webauthn/login-options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staffId }),
    });
    const options = await optRes.json();
    if (options.error) { showLoginErr(options.error); return; }

    // Face ID / 指紋認証ダイアログ起動
    const authResp = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });

    // サーバーで検証
    const verRes = await fetch('/api/admin/webauthn/login-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authResp),
    });
    const result = await verRes.json();
    if (result.success) { onLoginSuccess(); }
    else { showLoginErr(result.error || '認証に失敗しました'); }
  } catch (e) {
    if (e.name === 'NotAllowedError') {
      showLoginErr('Face ID / 指紋認証がキャンセルされました。もう一度お試しください。');
    } else {
      showLoginErr('Face ID認証でエラーが発生しました: ' + e.message);
    }
  }
}

// パスワードログイン
async function passwordLogin() {
  const staffId = document.getElementById('staffIdInput').value.trim();
  const pw = document.getElementById('pwInput').value;
  hideLoginErr();

  if (!staffId || !pw) {
    showLoginErr('スタッフIDとパスワードを入力してください');
    return;
  }
  if (pw.length < 8) {
    showLoginErr('パスワードは8文字以上で入力してください');
    return;
  }

  try {
    const res = await apiFetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staffId, password: pw }),
    });
    const data = await res.json();
    if (data.success) { onLoginSuccess(); }
    else if (data.code === 'PASSWORD_TOO_SHORT') {
      showLoginErr(data.error || 'パスワードは8文字以上必要です');
      // スタッフ画面でパスワードを変更する導線
      const err = document.getElementById('loginErr');
      if (err && !document.getElementById('pwChangeLink')) {
        const link = document.createElement('a');
        link.id = 'pwChangeLink';
        link.href = '/login.html';
        link.textContent = 'スタッフ画面でパスワードを変更する →';
        link.style.cssText = 'display:block;margin-top:8px;color:#1F497D;font-weight:700;text-decoration:underline';
        err.appendChild(link);
      }
    }
    else { showLoginErr(data.error || 'ログイン失敗'); }
  } catch {
    showLoginErr('サーバーに接続できません');
  }
}

// 管理者ID表示
async function loadAdminIdentity() {
  try {
    const res = await fetch('/api/admin/me');
    if (!res.ok) return;
    const data = await res.json();
    const el = document.getElementById('adminNameDisplay');
    if (el && data.name) el.textContent = data.name;
  } catch {}
}

// ── イベントリスナー: ログイン ──
// スタッフID入力 → Enter or blur で自動判定
document.getElementById('staffIdInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); checkStaffId(); }
});
document.getElementById('staffIdInput').addEventListener('blur', () => {
  const val = document.getElementById('staffIdInput').value.trim();
  if (val && val !== checkedStaffId) checkStaffId();
});
// Face IDボタン
document.getElementById('faceIdLoginBtn').addEventListener('click', faceIdLogin);
// 「パスワードでログイン」リンク
document.getElementById('showPasswordLink').addEventListener('click', e => {
  e.preventDefault();
  document.getElementById('faceIdSection').style.display = 'none';
  document.getElementById('passwordSection').style.display = 'block';
  document.getElementById('pwInput').focus();
});
// パスワード入力 → Enter でログイン
document.getElementById('pwInput').addEventListener('keydown', e => { if (e.key === 'Enter') passwordLogin(); });
document.getElementById('loginBtn').addEventListener('click', passwordLogin);
async function adminLogout() {
  await apiFetch('/api/admin/logout', { method: 'POST' });
  location.reload();
}

// ── セッション確認（管理者セッションが既にある場合） ──────────
fetch('/api/admin/staff').then(r => {
  if (r.ok) {
    document.getElementById('loginCard').style.display = 'none';
    document.getElementById('appLayout').style.display = 'flex';
    loadAdminIdentity();
    loadDashboard();
    r.json().then(list => {
      staffList = list;
      renderTable();
      loadIncentive();
      updateAdminStaffSelect();
      loadAdminSchedules();
      initAdminMonthlySelectors();
      initExcelSelectors();
    });
  }
}).catch(() => {});

// ── ページ読み込み時: 既存セッションの復元 ──
(async function checkExistingSession() {
  try {
    const res = await fetch('/api/admin/me');
    if (res.ok) {
      const data = await res.json();
      if (data.staffId) {
        onLoginSuccess();
        return;
      }
    }
  } catch (e) { /* セッションなし → ログイン画面を表示 */ }
})();