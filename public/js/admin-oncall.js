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
  document.getElementById('oncallSpinner').style.display = '';
  document.getElementById('oncallContent').style.display = 'none';
  document.getElementById('oncallEmpty').style.display = 'none';
  try {
    const res = await fetch('/api/admin/oncall/summary?month=' + month);
    const { summary } = await res.json();
    const hasData = summary.some(s => s.recordDays > 0);
    if (!hasData) {
      document.getElementById('oncallSpinner').style.display = 'none';
      document.getElementById('oncallEmpty').style.display = '';
      return;
    }
    const body = document.getElementById('oncallBody');
    body.innerHTML = summary.filter(s => s.recordDays > 0).map(s => `
      <tr>
        <td style="padding:8px 6px;border-bottom:1px solid #f0f4f8;font-weight:600">${esc(s.name)}</td>
        <td style="padding:8px 6px;border-bottom:1px solid #f0f4f8;text-align:center">${s.totalCount}件</td>
        <td style="padding:8px 6px;border-bottom:1px solid #f0f4f8;text-align:center">${(s.totalMinutes/60).toFixed(1)}h</td>
        <td style="padding:8px 6px;border-bottom:1px solid #f0f4f8;text-align:center">${s.totalTransportCount}件</td>
        <td style="padding:8px 6px;border-bottom:1px solid #f0f4f8;text-align:center">${s.recordDays}日</td>
      </tr>
    `).join('');
    const totals = summary.reduce((a, s) => ({
      count: a.count + s.totalCount,
      min: a.min + s.totalMinutes,
      trans: a.trans + s.totalTransportCount,
      days: a.days + s.recordDays,
    }), { count: 0, min: 0, trans: 0, days: 0 });
    document.getElementById('oncallFoot').innerHTML = `
      <tr style="background:#f0f4f8;font-weight:800">
        <td style="padding:8px 6px;border-top:2px solid var(--border)">合計</td>
        <td style="padding:8px 6px;border-top:2px solid var(--border);text-align:center">${totals.count}件</td>
        <td style="padding:8px 6px;border-top:2px solid var(--border);text-align:center">${(totals.min/60).toFixed(1)}h</td>
        <td style="padding:8px 6px;border-top:2px solid var(--border);text-align:center">${totals.trans}件</td>
        <td style="padding:8px 6px;border-top:2px solid var(--border);text-align:center">${totals.days}日</td>
      </tr>
    `;
    document.getElementById('oncallSpinner').style.display = 'none';
    document.getElementById('oncallContent').style.display = '';
    document.getElementById('oncallCSVBtn').style.display = '';
    lastOncallSummary = summary;
  } catch (e) {
    document.getElementById('oncallSpinner').style.display = 'none';
    document.getElementById('oncallEmpty').textContent = 'データの取得に失敗しました';
    document.getElementById('oncallEmpty').style.display = '';
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
      box.innerHTML = `<div style="background:#fff3cd;color:#856404;border-radius:8px;padding:10px 14px;font-size:13px">
        ✅ ${data.year}年のスプレッドシートはすでに作成済みです。<br>
        <a href="${data.url}" target="_blank" style="color:#1e40af;word-break:break-all">${data.url}</a>
      </div>`;
    } else if (data.success) {
      box.innerHTML = `<div style="background:#e6f7ef;color:#0a7c42;border-radius:8px;padding:10px 14px;font-size:13px">
        ✅ ${data.year}年のスプレッドシートを作成しました！<br>
        <a href="${data.url}" target="_blank" style="color:#1e40af;word-break:break-all">${data.url}</a>
      </div>`;
    } else {
      box.innerHTML = `<div style="background:#fee;color:#c0392b;border-radius:8px;padding:10px 14px;font-size:13px">❌ ${esc(data.error || 'エラーが発生しました')}</div>`;
    }
  } catch (e) {
    box.innerHTML = `<div style="background:#fee;color:#c0392b;border-radius:8px;padding:10px 14px;font-size:13px">❌ ${esc(e.message)}</div>`;
  }
  box.style.display = 'block';
  btn.disabled = false; btn.textContent = '翌年シートを作成';
}
