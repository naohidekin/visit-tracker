// admin-standby.js — 待機・雨天管理

// ── 待機・雨の日管理 ─────────────────────────────────────────
let standbyMonthInited = false;
let standbyEligibleStaff = [];
let lastStandbyRecords = [];
let lastRainyDays = [];
let lastCustomHolidays = [];
let lastStandbyStartDate = '';
let lastStandbyEndDate = '';

const DOW_NAMES = ['日', '月', '火', '水', '木', '金', '土'];
function fmtDate(d) { return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
const NATIONAL_HOLIDAYS = new Set([
  '2026-01-01','2026-01-12','2026-02-11','2026-02-23',
  '2026-03-20','2026-04-29','2026-05-03','2026-05-04','2026-05-05','2026-05-06',
  '2026-07-20','2026-08-11','2026-09-21','2026-09-22','2026-09-23',
  '2026-10-12','2026-11-03','2026-11-23',
  '2027-01-01','2027-01-11','2027-02-11','2027-02-23',
  '2027-03-21','2027-04-29','2027-05-03','2027-05-04','2027-05-05',
  '2027-07-19','2027-08-11','2027-09-20','2027-09-23',
  '2027-10-11','2027-11-03','2027-11-23',
]);

function initStandbyMonth() {
  if (standbyMonthInited) return;
  standbyMonthInited = true;
  const sel = document.getElementById('standbyMonth');
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const val = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const label = d.getFullYear() + '年' + (d.getMonth() + 1) + '月（' + (d.getMonth() === 0 ? 12 : d.getMonth()) + '/16〜' + (d.getMonth() + 1) + '/15）';
    sel.innerHTML += `<option value="${val}">${label}</option>`;
  }
}

function getDateCategory(dateStr, customHols) {
  const chSet = new Set(customHols || []);
  if (NATIONAL_HOLIDAYS.has(dateStr) || chSet.has(dateStr)) return { category: '祝日', fee: 10000 };
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay();
  if (dow === 0) return { category: '日曜', fee: 10000 };
  if (dow === 6) return { category: '土曜', fee: 5000 };
  return { category: '平日', fee: 2000 };
}

async function loadStandbyData() {
  const month = document.getElementById('standbyMonth').value;
  if (!month) return;
  document.getElementById('standbySpinner').style.display = '';
  document.getElementById('standbyContent').style.display = 'none';
  document.getElementById('standbyEmpty').style.display = 'none';
  try {
    const [staffRes, recRes] = await Promise.all([
      fetch('/api/admin/standby/eligible-staff').then(r => r.json()),
      fetch('/api/admin/standby/records?month=' + month).then(r => r.json()),
    ]);
    standbyEligibleStaff = staffRes.staff || [];
    lastStandbyRecords = recRes.records || [];
    lastRainyDays = recRes.rainyDays || [];
    lastCustomHolidays = recRes.customHolidays || [];
    lastStandbyStartDate = recRes.startDate;
    lastStandbyEndDate = recRes.endDate;

    renderStandbyTable();
    await loadStandbySummary(month);
  } catch (e) {
    console.error('standby load error:', e);
    showToast('待機データの読み込みに失敗しました');
  }
  document.getElementById('standbySpinner').style.display = 'none';
}

function renderStandbyTable() {
  const recordMap = {};
  for (const r of lastStandbyRecords) recordMap[r.date] = r.staffId;
  const rainySet = new Set(lastRainyDays);

  const start = new Date(lastStandbyStartDate + 'T00:00:00');
  const end = new Date(lastStandbyEndDate + 'T00:00:00');
  let html = '';
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = fmtDate(d);
    const dow = d.getDay();
    const dowName = DOW_NAMES[dow];
    const { category, fee } = getDateCategory(dateStr, lastCustomHolidays);
    const selectedStaff = recordMap[dateStr] || '';
    const isRainy = rainySet.has(dateStr);

    let rowBg = '';
    if (category === '日曜' || category === '祝日') rowBg = 'background:#fff0f0;';
    else if (category === '土曜') rowBg = 'background:#f0f4ff;';

    const dowColor = dow === 0 || category === '祝日' ? 'color:#c0392b;' : dow === 6 ? 'color:#2E75B6;' : '';

    let optionsHtml = '<option value="">--</option>';
    for (const s of standbyEligibleStaff) {
      const sel = s.id === selectedStaff ? ' selected' : '';
      optionsHtml += `<option value="${esc(s.id)}"${sel}>${esc(s.name)}</option>`;
    }

    const displayDate = (d.getMonth() + 1) + '/' + d.getDate();
    const feeDisplay = selectedStaff ? '¥' + fee.toLocaleString() : '-';

    html += `<tr style="${rowBg}">
      <td style="padding:5px 6px;border-bottom:1px solid #eef0f4;font-size:14px;white-space:nowrap">${displayDate}</td>
      <td style="padding:5px 6px;border-bottom:1px solid #eef0f4;text-align:center;${dowColor}font-weight:600">${dowName}</td>
      <td style="padding:5px 6px;border-bottom:1px solid #eef0f4;text-align:center;font-size:13px">${category}</td>
      <td style="padding:5px 6px;border-bottom:1px solid #eef0f4">
        <select data-action="standby-select" data-date="${dateStr}" style="width:100%;padding:4px 6px;border:1px solid var(--border);border-radius:6px;font-size:14px;font-family:inherit">
          ${optionsHtml}
        </select>
      </td>
      <td style="padding:5px 6px;border-bottom:1px solid #eef0f4;text-align:right;font-size:14px;font-weight:600">${feeDisplay}</td>
      <td style="padding:5px 6px;border-bottom:1px solid #eef0f4;text-align:center">
        <span data-action="rainy-toggle" data-date="${dateStr}" data-rainy="${isRainy ? '1' : '0'}" style="cursor:pointer;font-size:18px;user-select:none;line-height:1">${isRainy ? '✅' : '⬜'}</span>
      </td>
    </tr>`;
  }
  document.getElementById('standbyBody').innerHTML = html;
  document.getElementById('standbyContent').style.display = '';
  document.getElementById('standbyCSVBtn').style.display = '';

  // 雨の日集計を読み込み
  const month = document.getElementById('standbyMonth').value;
  loadRainySummary(month);
}

async function saveStandbyRecord(date, staffId) {
  try {
    const res = await apiFetch('/api/admin/standby/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, staffId }),
    });
    if (!res.ok) {
      showToast('待機記録の保存に失敗しました');
      loadStandbyData(); // サーバーの正しい状態に戻す
      return;
    }
    // ローカルデータも更新
    const idx = lastStandbyRecords.findIndex(r => r.date === date);
    if (!staffId) {
      if (idx >= 0) lastStandbyRecords.splice(idx, 1);
    } else {
      if (idx >= 0) lastStandbyRecords[idx].staffId = staffId;
      else lastStandbyRecords.push({ date, staffId });
    }
    renderStandbyTable();
    const month = document.getElementById('standbyMonth').value;
    loadStandbySummary(month);
  } catch (e) {
    showToast('保存に失敗しました');
  }
}

async function toggleRainyDay(date, el) {
  // 現在の状態を取得して反転
  const wasRainy = el.dataset.rainy === '1';
  const newState = !wasRainy;

  // 即座にUIを更新（楽観的更新）
  el.textContent = newState ? '✅' : '⬜';
  el.dataset.rainy = newState ? '1' : '0';
  if (newState) { if (!lastRainyDays.includes(date)) lastRainyDays.push(date); }
  else { const i = lastRainyDays.indexOf(date); if (i >= 0) lastRainyDays.splice(i, 1); }

  try {
    const res = await apiFetch('/api/admin/rainy/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date }),
    });
    if (!res.ok) {
      // 失敗時: 元に戻す
      el.textContent = wasRainy ? '✅' : '⬜';
      el.dataset.rainy = wasRainy ? '1' : '0';
      if (wasRainy) { if (!lastRainyDays.includes(date)) lastRainyDays.push(date); }
      else { const i = lastRainyDays.indexOf(date); if (i >= 0) lastRainyDays.splice(i, 1); }
      showToast('保存に失敗しました');
    }
  } catch (e) {
    // エラー時: 元に戻す
    el.textContent = wasRainy ? '✅' : '⬜';
    el.dataset.rainy = wasRainy ? '1' : '0';
    if (wasRainy) { if (!lastRainyDays.includes(date)) lastRainyDays.push(date); }
    else { const i = lastRainyDays.indexOf(date); if (i >= 0) lastRainyDays.splice(i, 1); }
    showToast('エラーが発生しました');
  }
}

async function loadStandbySummary(month) {
  try {
    const res = await fetch('/api/admin/standby/summary?month=' + month);
    const data = await res.json();
    const summaryBody = document.getElementById('standbySummaryBody');
    const summaryFoot = document.getElementById('standbySummaryFoot');
    if (!data.summary || data.summary.length === 0) {
      summaryBody.innerHTML = '<tr><td colspan="5" style="padding:8px;text-align:center;color:#999">待機記録なし</td></tr>';
      summaryFoot.innerHTML = '';
      return;
    }
    summaryBody.innerHTML = data.summary.map(s => `
      <tr>
        <td style="padding:6px;border-bottom:1px solid #eef0f4;font-weight:600">${esc(s.name)}</td>
        <td style="padding:6px;border-bottom:1px solid #eef0f4;text-align:center">${s.weekday}日</td>
        <td style="padding:6px;border-bottom:1px solid #eef0f4;text-align:center">${s.saturday}日</td>
        <td style="padding:6px;border-bottom:1px solid #eef0f4;text-align:center">${s.sundayHoliday}日</td>
        <td style="padding:6px;border-bottom:1px solid #eef0f4;text-align:right;font-weight:700">¥${s.total.toLocaleString()}</td>
      </tr>
    `).join('');
    const totals = data.summary.reduce((a, s) => ({
      weekday: a.weekday + s.weekday,
      saturday: a.saturday + s.saturday,
      sundayHoliday: a.sundayHoliday + s.sundayHoliday,
      total: a.total + s.total,
    }), { weekday: 0, saturday: 0, sundayHoliday: 0, total: 0 });
    summaryFoot.innerHTML = `
      <tr style="background:#f0f4f8;font-weight:800">
        <td style="padding:6px;border-top:2px solid var(--border)">合計</td>
        <td style="padding:6px;border-top:2px solid var(--border);text-align:center">${totals.weekday}日</td>
        <td style="padding:6px;border-top:2px solid var(--border);text-align:center">${totals.saturday}日</td>
        <td style="padding:6px;border-top:2px solid var(--border);text-align:center">${totals.sundayHoliday}日</td>
        <td style="padding:6px;border-top:2px solid var(--border);text-align:right">¥${totals.total.toLocaleString()}</td>
      </tr>
    `;
  } catch (e) {
    console.error('standby summary error:', e);
  }
}

async function loadRainySummary(month) {
  const table = document.getElementById('rainySummaryTable');
  const empty = document.getElementById('rainyEmpty');
  const loading = document.getElementById('rainyLoading');
  const body = document.getElementById('rainySummaryBody');
  const foot = document.getElementById('rainySummaryFoot');

  if (lastRainyDays.length === 0) {
    table.style.display = 'none';
    loading.style.display = 'none';
    empty.style.display = '';
    return;
  }

  empty.style.display = 'none';
  table.style.display = 'none';
  loading.style.display = '';

  try {
    const res = await fetch('/api/admin/rainy/summary?month=' + month);
    const data = await res.json();
    loading.style.display = 'none';

    if (!data.summary || data.summary.length === 0) {
      body.innerHTML = '<tr><td colspan="3" style="padding:8px;text-align:center;color:#999">出勤者データなし（雨の日: ' + data.rainyDayCount + '日）</td></tr>';
      foot.innerHTML = '';
      table.style.display = '';
      return;
    }

    body.innerHTML = data.summary.map(s => `
      <tr>
        <td style="padding:6px;border-bottom:1px solid #eef0f4;font-weight:600">${esc(s.name)}</td>
        <td style="padding:6px;border-bottom:1px solid #eef0f4;text-align:center">${s.days}日</td>
        <td style="padding:6px;border-bottom:1px solid #eef0f4;text-align:right;font-weight:700">¥${s.amount.toLocaleString()}</td>
      </tr>
    `).join('');

    const totalDays = data.summary.reduce((a, s) => a + s.days, 0);
    const totalAmount = data.summary.reduce((a, s) => a + s.amount, 0);
    foot.innerHTML = `
      <tr style="background:#f0f4f8;font-weight:800">
        <td style="padding:6px;border-top:2px solid var(--border)">合計（雨の日: ${data.rainyDayCount}日）</td>
        <td style="padding:6px;border-top:2px solid var(--border);text-align:center">${totalDays}日</td>
        <td style="padding:6px;border-top:2px solid var(--border);text-align:right">¥${totalAmount.toLocaleString()}</td>
      </tr>
    `;
    table.style.display = '';
  } catch (e) {
    loading.style.display = 'none';
    empty.textContent = '雨の日集計の取得に失敗しました';
    empty.style.display = '';
    console.error('rainy summary error:', e);
  }
}

function toggleCustomHolidays() {
  const sec = document.getElementById('customHolidaySection');
  sec.style.display = sec.style.display === 'none' ? '' : 'none';
  if (sec.style.display !== 'none') renderCustomHolidays();
}

async function renderCustomHolidays() {
  try {
    const res = await fetch('/api/admin/standby/custom-holidays');
    const data = await res.json();
    lastCustomHolidays = data.customHolidays || [];
    const list = document.getElementById('customHolidayList');
    if (lastCustomHolidays.length === 0) {
      list.innerHTML = '<span style="color:#999">追加祝日なし</span>';
      return;
    }
    list.innerHTML = lastCustomHolidays.map(d => {
      const dt = new Date(d + 'T00:00:00');
      const label = (dt.getMonth() + 1) + '/' + dt.getDate() + '(' + DOW_NAMES[dt.getDay()] + ')';
      return `<span style="display:inline-block;background:#fff;border:1px solid #d4b84a;border-radius:4px;padding:2px 8px;margin:2px 4px 2px 0;font-size:14px">${label} <span data-action="remove-holiday" data-date="${esc(d)}" style="color:#c0392b;cursor:pointer;font-weight:700;margin-left:4px">&times;</span></span>`;
    }).join('');
  } catch (e) {
    console.error('custom holidays error:', e);
  }
}

async function addCustomHoliday() {
  const input = document.getElementById('customHolidayDate');
  const date = input.value;
  if (!date) { showToast('日付を選択してください'); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { showToast('日付の形式が不正です'); return; }
  if (lastCustomHolidays.includes(date)) { showToast('既に追加済みです'); return; }
  const newDates = [...lastCustomHolidays, date].sort();
  try {
    await apiFetch('/api/admin/standby/custom-holidays', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dates: newDates }),
    });
    lastCustomHolidays = newDates;
    input.value = '';
    renderCustomHolidays();
    loadStandbyData();
  } catch (e) {
    showToast('祝日の追加に失敗しました');
  }
}

// ── #customHolidayList イベント委譲 ──────────────────────────────
document.getElementById('customHolidayList').addEventListener('click', e => {
  const el = e.target.closest('[data-action="remove-holiday"]');
  if (el) removeCustomHoliday(el.dataset.date);
});

async function removeCustomHoliday(date) {
  const newDates = lastCustomHolidays.filter(d => d !== date);
  try {
    await apiFetch('/api/admin/standby/custom-holidays', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dates: newDates }),
    });
    lastCustomHolidays = newDates;
    renderCustomHolidays();
    loadStandbyData();
  } catch (e) {
    showToast('祝日の削除に失敗しました');
  }
}
  const month = document.getElementById('standbyMonth').value;
  const recordMap = {};
  for (const r of lastStandbyRecords) recordMap[r.date] = r.staffId;
  const staffMap = {};
  for (const s of standbyEligibleStaff) staffMap[s.id] = s.name;
  const rainySet = new Set(lastRainyDays);

  const headers = ['日付', '曜日', '区分', '待機者', '待機料', '雨の日'];
  const rows = [];
  const start = new Date(lastStandbyStartDate + 'T00:00:00');
  const end = new Date(lastStandbyEndDate + 'T00:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = fmtDate(d);
    const { category, fee } = getDateCategory(dateStr, lastCustomHolidays);
    const staffId = recordMap[dateStr] || '';
    rows.push([
      dateStr,
      DOW_NAMES[d.getDay()],
      category,
      staffId ? (staffMap[staffId] || staffId) : '',
      staffId ? fee : '',
      rainySet.has(dateStr) ? '○' : '',
    ]);
  }
  downloadCSV(headers, rows, `待機一覧_${month}.csv`);
}
