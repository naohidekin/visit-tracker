// admin-oncall.js — オンコール集計

// ── オンコール管理 ────────────────────────────────────────────
let oncallMonthInited = false;
let lastOncallSummary = [];
function initOncallMonth() {
  if (oncallMonthInited) return;
  oncallMonthInited = true;
  const sel = document.getElementById('oncallMonth');
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const val = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const label = d.getFullYear() + '年' + (d.getMonth() + 1) + '月';
    sel.innerHTML += `<option value="${val}">${label}</option>`;
  }
}
async function loadOncallSummary() {
  const month = document.getElementById('oncallMonth').value;
  if (!month) return;
  document.getElementById('oncallSpinner').classList.remove('d-none');
  document.getElementById('oncallContent').classList.add('d-none');
  document.getElementById('oncallEmpty').classList.add('d-none');
  try {
    const res = await fetch('/api/admin/oncall/summary?month=' + month);
    const { summary } = await res.json();
    const hasData = summary.some(s => s.recordDays > 0);
    if (!hasData) {
      document.getElementById('oncallSpinner').classList.add('d-none');
      document.getElementById('oncallEmpty').classList.remove('d-none');
      return;
    }
    const body = document.getElementById('oncallBody');
    body.innerHTML = summary.filter(s => s.recordDays > 0).map(s => `
      <tr>
        <td class="oncall-td-name">${esc(s.name)}</td>
        <td class="oncall-td-center">${s.totalCount}件</td>
        <td class="oncall-td-center">${(s.totalMinutes/60).toFixed(1)}h</td>
        <td class="oncall-td-center">${s.totalTransportCount}件</td>
        <td class="oncall-td-center">${s.recordDays}日</td>
      </tr>
    `).join('');
    const totals = summary.reduce((a, s) => ({
      count: a.count + s.totalCount,
      min: a.min + s.totalMinutes,
      trans: a.trans + s.totalTransportCount,
      days: a.days + s.recordDays,
    }), { count: 0, min: 0, trans: 0, days: 0 });
    document.getElementById('oncallFoot').innerHTML = `
      <tr class="summary-foot-row">
        <td class="td-foot">合計</td>
        <td class="td-foot">${totals.count}件</td>
        <td class="td-foot">${(totals.min/60).toFixed(1)}h</td>
        <td class="td-foot">${totals.trans}件</td>
        <td class="td-foot">${totals.days}日</td>
      </tr>
    `;
    document.getElementById('oncallSpinner').classList.add('d-none');
    document.getElementById('oncallContent').classList.remove('d-none');
    document.getElementById('oncallCSVBtn').classList.remove('d-none');
    lastOncallSummary = summary;
  } catch (e) {
    document.getElementById('oncallSpinner').classList.add('d-none');
    document.getElementById('oncallEmpty').textContent = 'データの取得に失敗しました';
    document.getElementById('oncallEmpty').classList.remove('d-none');
  }
}
function oncallMinToHM(min) {
  if (!min) return '0:00';
  return Math.floor(min / 60) + ':' + String(min % 60).padStart(2, '0');
}

// ── 翌年スプレッドシート作成 ──────────────────────────────────
document.getElementById('nextYearLabel').textContent = new Date().getFullYear() + 1;

async function createNextYearSheet() {
  const btn = document.getElementById('createNextYearBtn');
  const box = document.getElementById('createSheetResult');
  btn.disabled = true; btn.textContent = '作成中...';
  box.style.display = 'none';
  try {
    const res  = await apiFetch('/api/admin/create-next-year-sheet', { method: 'POST' });
    const data = await res.json();
    if (data.already_exists) {
      box.innerHTML = `<div class="info-box-warning">
        ✅ ${data.year}年のスプレッドシートはすでに作成済みです。<br>
        <a href="${data.url}" target="_blank" class="info-link">${data.url}</a>
      </div>`;
    } else if (data.success) {
      box.innerHTML = `<div class="info-box-ok">
        ✅ ${data.year}年のスプレッドシートを作成しました！<br>
        <a href="${data.url}" target="_blank" class="info-link">${data.url}</a>
      </div>`;
    } else {
      box.innerHTML = `<div class="info-box-error">❌ ${esc(data.error || 'エラーが発生しました')}</div>`;
    }
  } catch (e) {
    box.innerHTML = `<div class="info-box-error">❌ ${esc(e.message)}</div>`;
  }
  box.style.display = 'block';
  btn.disabled = false; btn.textContent = '翌年シートを作成';
}
