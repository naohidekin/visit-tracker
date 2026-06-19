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
    const label = (d.getMonth() + 1) + '月（締期間）';
    sel.innerHTML += `<option value="${val}">${label}</option>`;
  }
}
async function loadOncallSummary() {
  const month = document.getElementById('oncallMonth').value;
  if (!month) return;
  document.getElementById('oncallCSVBtn').style.display = 'none';
  lastOncallSummary = [];
  document.getElementById('oncallSpinner').style.display = '';
  document.getElementById('oncallContent').style.display = 'none';
  document.getElementById('oncallEmpty').style.display = 'none';
  document.getElementById('oncallDetail').style.display = 'none';
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
      <tr class="oncall-summary-row" data-staff-id="${esc(s.staffId)}" data-staff-name="${esc(s.name)}">
        <td style="padding:8px 6px;border-bottom:1px solid #f0f4f8;font-weight:600">${esc(s.name)} <span style="font-size:11px;color:var(--muted)">▶</span></td>
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

// ── スタッフ別詳細ドリルダウン ─────────────────────────
const WD_ONCALL = ['日','月','火','水','木','金','土'];

document.getElementById('oncallBody').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-staff-id]');
  if (!row) return;
  showOncallDetail(row.dataset.staffId, row.dataset.staffName);
});

document.getElementById('oncallDetailClose').addEventListener('click', () => {
  document.getElementById('oncallDetail').style.display = 'none';
});

async function showOncallDetail(staffId, staffName) {
  const month = document.getElementById('oncallMonth').value;
  if (!month) return;
  const detail = document.getElementById('oncallDetail');
  const title = document.getElementById('oncallDetailTitle');
  const body = document.getElementById('oncallDetailBody');

  title.textContent = staffName + ' の詳細';
  body.innerHTML = '<tr><td colspan="3" style="padding:12px;text-align:center;color:var(--muted)">読み込み中...</td></tr>';
  detail.style.display = '';

  try {
    const res = await fetch('/api/admin/oncall/records?month=' + month + '&staffId=' + staffId);
    const { records } = await res.json();
    if (!records.length) {
      body.innerHTML = '<tr><td colspan="3" style="padding:12px;text-align:center;color:var(--muted)">記録なし</td></tr>';
      return;
    }
    body.innerHTML = records.map(r => {
      const d = new Date(r.date + 'T00:00:00');
      const dateLabel = (d.getMonth()+1) + '/' + d.getDate() + '（' + WD_ONCALL[d.getDay()] + '）';
      return `<tr>
        <td style="padding:6px;border-bottom:1px solid #f0f4f8">${dateLabel}</td>
        <td style="padding:6px;border-bottom:1px solid #f0f4f8;text-align:center">${(r.totalMinutes/60).toFixed(1)}h</td>
        <td style="padding:6px;border-bottom:1px solid #f0f4f8;text-align:center">${r.transportCount}件</td>
      </tr>`;
    }).join('');
    detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch {
    body.innerHTML = '<tr><td colspan="3" style="padding:12px;text-align:center;color:var(--danger)">取得に失敗しました</td></tr>';
  }
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
