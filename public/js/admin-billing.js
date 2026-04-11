// admin-billing.js — 月次詳細・インセンティブ設定・月次集計

// ── スタッフ月次実績 ──────────────────────────────────────────
let currentAdminData = null;
let adminDetailMode = 'billing';

function initAdminMonthlySelectors() {
  const now = new Date();
  document.getElementById('viewYear').value  = String(now.getFullYear());
  repopulateAdminDetailMonth();
  document.getElementById('viewMonth').value = String(now.getMonth() + 1);
}

function repopulateAdminDetailMonth() {
  const sel = document.getElementById('viewMonth');
  const prev = sel.value;
  sel.innerHTML = '';
  for (let m = 1; m <= 12; m++) {
    const opt = document.createElement('option');
    opt.value = String(m);
    if (adminDetailMode === 'billing') {
      let prevM = m - 1;
      if (prevM <= 0) prevM = 12;
      opt.textContent = `${m}月月次（${prevM}/16〜${m}/15）`;
    } else {
      opt.textContent = `${m}月`;
    }
    sel.appendChild(opt);
  }
  if (prev) sel.value = prev;
}

function switchAdminDetailMode(mode) {
  if (adminDetailMode === mode) return;
  adminDetailMode = mode;
  const btnB = document.getElementById('adminDetailModeBilling');
  const btnM = document.getElementById('adminDetailModeMonthly');
  if (mode === 'billing') {
    btnB.style.background = 'var(--blue)'; btnB.style.color = '#fff';
    btnM.style.background = '#fff'; btnM.style.color = 'var(--blue)';
  } else {
    btnM.style.background = 'var(--blue)'; btnM.style.color = '#fff';
    btnB.style.background = '#fff'; btnB.style.color = 'var(--blue)';
  }
  repopulateAdminDetailMonth();
  const staffId = document.getElementById('viewStaff').value;
  if (staffId) loadAdminMonthly();
}

function updateAdminStaffSelect() {
  const sel = document.getElementById('viewStaff');
  const cur = sel.value;
  sel.innerHTML = '<option value="">スタッフを選択してください</option>';
  for (const s of staffList) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name + `（${s.type === 'nurse' ? '看護師' : s.type === 'office' ? '事務' : s.type === 'admin' ? '役員' : s.type}）`;
    sel.appendChild(opt);
  }
  if (cur) sel.value = cur;
}

async function loadAdminMonthly() {
  const staffId = document.getElementById('viewStaff').value;
  const year    = document.getElementById('viewYear').value;
  const month   = document.getElementById('viewMonth').value;
  if (!staffId) { showToast('スタッフを選択してください'); return; }

  document.getElementById('adminMonthlyResult').style.display  = 'block';
  document.getElementById('adminMonthlySpinner').style.display = 'block';
  document.getElementById('adminStatsSection').style.display   = 'none';
  document.getElementById('adminTableSection').style.display   = 'none';

  try {
    const modeParam = adminDetailMode === 'billing' ? '&mode=billing' : '';
    const res = await fetch(`/api/admin/monthly-detail?staffId=${encodeURIComponent(staffId)}&year=${year}&month=${month}${modeParam}`);
    if (!res.ok) throw new Error((await res.json()).error);
    currentAdminData = await res.json();
    renderAdminTable(currentAdminData);
    document.getElementById('adminMonthlySpinner').style.display = 'none';
    document.getElementById('adminTableSection').style.display   = 'block';
    document.getElementById('monthlyCSVBtn').classList.remove('d-none');
    if (adminDetailMode === 'billing') {
      renderAdminMonthlyCard(currentAdminData);
      document.getElementById('adminStatsSection').style.display = 'block';
    } else {
      document.getElementById('adminStatsSection').style.display = 'none';
    }
  } catch (e) {
    document.getElementById('adminMonthlySpinner').textContent = 'エラー: ' + e.message;
  }
}

function renderAdminMonthlyCard(data) {
  const s = data.stats;
  const isIncentive = !!s.incentive_triggered;
  const cls  = isIncentive ? ' incentive' : '';
  const targetTotal = s.target_total ?? 0;
  const worked = s.working_days || 0;
  const expected = s.expected_working_days || 0;
  const remainDays = Math.max(0, expected - worked);

  let goalLine, bigLabel, bigNum, bigUnit, subCols, subHtml, diffHtml;

  if (data.type === 'nurse') {
    const total = s.total || 0;
    if (data.billing_start && data.billing_end) {
      const bsM = new Date(data.billing_start + 'T00:00:00');
      const beM = new Date(data.billing_end + 'T00:00:00');
      const periodLabel = `${bsM.getMonth()+1}/${bsM.getDate()}〜${beM.getMonth()+1}/${beM.getDate()}`;
      goalLine = `${periodLabel} のインセンティブ目安時間：${targetTotal.toFixed(1)}時間`;
    } else {
      goalLine = `今月のインセンティブ目安時間：${targetTotal.toFixed(1)}時間`;
    }
    bigLabel = '合計時間'; bigNum = total.toFixed(1); bigUnit = '時間';
    subCols  = 'cols-3';
    subHtml  = `
      <div class="result-sub-box">
        <div class="result-sub-label">介護</div>
        <div class="result-sub-val">${(s.total_kaigo||0).toFixed(1)}<span class="result-sub-unit">時間</span></div>
      </div>
      <div class="result-sub-box">
        <div class="result-sub-label">医療</div>
        <div class="result-sub-val">${(s.total_iryo||0).toFixed(1)}<span class="result-sub-unit">時間</span></div>
      </div>
      <div class="result-sub-box">
        <div class="result-sub-label">稼働日数</div>
        <div class="result-sub-val">${worked}<span class="result-sub-unit">日</span></div>
      </div>`;
    const diff = targetTotal - total;
    diffHtml = diff > 0
      ? `<p class="result-diff-line remain">目安時間まであと ${diff.toFixed(1)}時間（残${remainDays}日）</p>`
      : '<p class="result-diff-line reached">インセンティブに到達しました 🎉</p>';
  } else {
    const actual = s.total_units || 0;
    if (data.billing_start && data.billing_end) {
      const bsM = new Date(data.billing_start + 'T00:00:00');
      const beM = new Date(data.billing_end + 'T00:00:00');
      const periodLabel = `${bsM.getMonth()+1}/${bsM.getDate()}〜${beM.getMonth()+1}/${beM.getDate()}`;
      goalLine = `${periodLabel} のインセンティブ目安単位：${targetTotal.toFixed(1)}単位`;
    } else {
      goalLine = `今月のインセンティブ目安単位：${targetTotal.toFixed(1)}単位`;
    }
    bigLabel = '合計単位数'; bigNum = String(actual); bigUnit = '単位';
    subCols  = 'cols-2';
    subHtml  = `
      <div class="result-sub-box">
        <div class="result-sub-label">合計単位数</div>
        <div class="result-sub-val">${actual}<span class="result-sub-unit">単位</span></div>
      </div>
      <div class="result-sub-box">
        <div class="result-sub-label">稼働日数</div>
        <div class="result-sub-val">${worked}<span class="result-sub-unit">日</span></div>
      </div>`;
    const diff = targetTotal - actual;
    diffHtml = diff > 0
      ? `<p class="result-diff-line remain">目安単位まであと ${Math.ceil(diff)}単位（残${remainDays}日）</p>`
      : '<p class="result-diff-line reached">インセンティブに到達しました 🎉</p>';
  }

  const rate = s.incentive_rate || 0;
  const rateInfo = rate > 0 ? ` (単価: ¥${rate.toLocaleString()})` : '';

  document.getElementById('adminStatsCard').innerHTML = `
    <div class="result-card${cls}">
      <p class="result-goal-line">${goalLine}${esc(rateInfo)}</p>
      <div class="result-big-total">
        <span class="result-big-label">${bigLabel}</span>
        <span class="result-big-num">${bigNum}</span>
        <span class="result-big-label">${bigUnit}</span>
      </div>
      ${diffHtml}
      <div class="result-sub-grid ${subCols}">${subHtml}</div>
    </div>`;
}

function buildNurseOptHtml(selected) {
  let html = '<option value="">空白</option>';
  for (let v = 0.5; v <= 10.0 + 0.001; v += 0.5) {
    const val = Math.round(v * 10) / 10;
    const sel = (selected != null && Math.abs(val - selected) < 0.001) ? ' selected' : '';
    html += `<option value="${val}"${sel}>${val.toFixed(1)}時間</option>`;
  }
  return html;
}
function buildRehabOptHtml(selected) {
  let html = '<option value="">空白</option>';
  for (let v = 1; v <= 50; v++) {
    const sel = (selected != null && v === selected) ? ' selected' : '';
    html += `<option value="${v}"${sel}>${v}単位</option>`;
  }
  return html;
}

function buildAdminRowHtml(d, data, dateStr, isEdit) {
  const wdClass = d.weekday === '土' ? 'sat-a' : d.weekday === '日' ? 'sun-a' : '';
  const dm = d.month != null ? d.month : data.month;
  const dateCell = `<td class="date-cell-a"><span class="${wdClass}">${dm}/${d.day}（${d.weekday}）</span></td>`;
  if (isEdit) {
    const saveBtns = `<div class="td-btns">
      <button class="btn btn-sm btn-blue" data-action="save-admin-row" data-day="${d.day}" data-date="${esc(dateStr)}">保存</button>
      <button class="btn btn-sm btn-cancel-edit" data-action="cancel-admin-edit" data-day="${d.day}">×</button>
    </div>`;
    if (data.type === 'nurse') {
      return dateCell +
        `<td><select id="eK_${d.day}" class="edit-sel">${buildNurseOptHtml(d.kaigo)}</select></td>` +
        `<td><select id="eI_${d.day}" class="edit-sel">${buildNurseOptHtml(d.iryo)}</select></td>` +
        `<td>—</td><td>${saveBtns}</td>`;
    } else {
      return dateCell +
        `<td><select id="eV_${d.day}" class="edit-sel">${buildRehabOptHtml(d.value)}</select></td>` +
        `<td>${saveBtns}</td>`;
    }
  } else {
    if (data.type === 'nurse') {
      return dateCell +
        `<td>${d.kaigo != null ? d.kaigo.toFixed(1) : '—'}</td>` +
        `<td>${d.iryo  != null ? d.iryo.toFixed(1)  : '—'}</td>` +
        `<td>${d.total != null ? d.total.toFixed(1) : '—'}</td>` +
        `<td><button class="btn btn-sm btn-blue" data-action="edit-admin-row" data-day="${d.day}">修正</button></td>`;
    } else {
      return dateCell +
        `<td>${d.value != null ? d.value : '—'}</td>` +
        `<td><button class="btn btn-sm btn-blue" data-action="edit-admin-row" data-day="${d.day}">修正</button></td>`;
    }
  }
}

function renderAdminTable(data) {
  const head = document.getElementById('adminTableHead');
  const body = document.getElementById('adminTableBody');
  body.innerHTML = '';
  if (data.type === 'nurse') {
    head.innerHTML = '<tr><th>日付</th><th><span class="badge badge-nurse fs-14">介護</span></th><th><span class="badge badge-iryo">医療</span></th><th>合計</th><th></th></tr>';
  } else {
    head.innerHTML = '<tr><th>日付</th><th>単位数</th><th></th></tr>';
  }
  for (const d of data.days) {
    const dm = d.month != null ? d.month : data.month;
    let dy = data.year;
    if (d.month != null && d.month > data.month) dy = data.year - 1;
    const dateStr = `${dy}-${String(dm).padStart(2,'0')}-${String(d.day).padStart(2,'0')}`;
    const tr = document.createElement('tr');
    tr.id = `aRow_${d.day}`;
    tr.innerHTML = buildAdminRowHtml(d, data, dateStr, false);
    body.appendChild(tr);
  }
}

// ── #adminTableBody イベント委譲 ──────────────────────────────────
document.getElementById('adminTableBody').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const day = Number(btn.dataset.day);
  if (btn.dataset.action === 'edit-admin-row')    editAdminRow(day);
  else if (btn.dataset.action === 'save-admin-row')    saveAdminRow(day, btn.dataset.date);
  else if (btn.dataset.action === 'cancel-admin-edit') cancelAdminEdit(day);
});

function editAdminRow(day) {
  const d = currentAdminData.days.find(x => x.day === day);
  const dm = d.month != null ? d.month : currentAdminData.month;
  let dy = currentAdminData.year;
  if (d.month != null && d.month > currentAdminData.month) dy = currentAdminData.year - 1;
  const dateStr = `${dy}-${String(dm).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  document.getElementById(`aRow_${day}`).innerHTML = buildAdminRowHtml(d, currentAdminData, dateStr, true);
}
function cancelAdminEdit(day) {
  const d = currentAdminData.days.find(x => x.day === day);
  const dm = d.month != null ? d.month : currentAdminData.month;
  let dy = currentAdminData.year;
  if (d.month != null && d.month > currentAdminData.month) dy = currentAdminData.year - 1;
  const dateStr = `${dy}-${String(dm).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  document.getElementById(`aRow_${day}`).innerHTML = buildAdminRowHtml(d, currentAdminData, dateStr, false);
}
async function saveAdminRow(day, dateStr) {
  const staffId = document.getElementById('viewStaff').value;
  let body;
  if (currentAdminData.type === 'nurse') {
    const kVal = document.getElementById(`eK_${day}`).value;
    const iVal = document.getElementById(`eI_${day}`).value;
    body = { staffId, date: dateStr, kaigo: kVal === '' ? null : Number(kVal), iryo: iVal === '' ? null : Number(iVal) };
  } else {
    const vVal = document.getElementById(`eV_${day}`).value;
    body = { staffId, date: dateStr, value: vVal === '' ? null : Number(vVal) };
  }
  const res = await apiFetch('/api/admin/record', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.success) { showToast('✅ 保存しました'); loadAdminMonthly(); }
  else showToast('エラー: ' + (data.error || '保存失敗'));
}

// ── インセンティブ設定 ────────────────────────────────────────
let incentiveData = null;

function buildNurseLineOpts() {
  const opts = [];
  for (let v = 0; v <= 5.0 + 0.001; v += 0.5) opts.push(Math.round(v * 10) / 10);
  return opts;
}
function buildRehabLineOpts() {
  const opts = [];
  for (let v = 0; v <= 20.0 + 0.001; v += 0.25) opts.push(Math.round(v * 100) / 100);
  return opts;
}
function buildSelectHtml(opts, selected, unit) {
  return opts.map(v => {
    const label = unit === 'h' ? v.toFixed(1) + ' 時間/日' : v.toFixed(2) + ' 単位/日';
    const sel = Math.abs(v - selected) < 0.001 ? ' selected' : '';
    return `<option value="${v}"${sel}>${label}</option>`;
  }).join('');
}

function buildRateOpts(type, selected) {
  // type: 'nurse' → 円/時間（500刻み 500〜10000）、'rehab' → 円/単位（100刻み 100〜5000）
  const isNurse = type === 'nurse';
  const step = isNurse ? 500 : 100;
  const max = isNurse ? 10000 : 5000;
  const unit = isNurse ? '円/時間' : '円/単位';
  let html = '';
  for (let v = step; v <= max; v += step) {
    const sel = (v === selected) ? ' selected' : '';
    html += `<option value="${v}"${sel}>¥${v.toLocaleString()} ${unit}</option>`;
  }
  return html;
}

async function loadIncentive() {
  document.getElementById('incentiveSpinner').style.display = 'block';
  const res = await fetch('/api/admin/incentive');
  if (!res.ok) { document.getElementById('incentiveSpinner').style.display = 'none'; return; }
  incentiveData = await res.json();
  document.getElementById('incentiveSpinner').style.display = 'none';

  const def = incentiveData.defaults;
  const nurseOpts = buildNurseLineOpts();
  const rehabOpts = buildRehabLineOpts();

  document.getElementById('defaultNurse').innerHTML = buildSelectHtml(nurseOpts, def.nurse, 'h');
  document.getElementById('defaultRehab').innerHTML = buildSelectHtml(rehabOpts, def.rehab, 'u');
  document.getElementById('defaultNurseRate').innerHTML = buildRateOpts('nurse', def.nurse_rate);
  document.getElementById('defaultRehabRate').innerHTML = buildRateOpts('rehab', def.rehab_rate);
  document.getElementById('incentiveDefaultSection').style.display = 'block';

  renderIncentiveTable(nurseOpts, rehabOpts);
  document.getElementById('incentiveStaffSection').style.display = 'block';
}

function buildWorkHoursOpts(selected) {
  const FULL = 8.0;
  let html = `<option value=""${selected == null ? ' selected' : ''}>フルタイム (8h)</option>`;
  for (let v = 4.0; v < FULL - 0.001; v += 0.5) {
    const rounded = Math.round(v * 10) / 10;
    const sel = (selected != null && Math.abs(selected - rounded) < 0.01) ? ' selected' : '';
    html += `<option value="${rounded}"${sel}>${rounded.toFixed(1)}h / 日</option>`;
  }
  return html;
}

function calcEffectiveLine(staffId) {
  const s = incentiveData.staff.find(x => x.id === staffId);
  if (!s) return null;
  const def = incentiveData.defaults;
  const lineEl = document.getElementById('iline_' + staffId);
  const whEl = document.getElementById('whours_' + staffId);
  const rawLine = lineEl ? parseFloat(lineEl.value) : ((s.incentive_line != null) ? s.incentive_line : (s.type === 'nurse' ? def.nurse : def.rehab));
  const wh = whEl && whEl.value ? parseFloat(whEl.value) : 8.0;
  const ratio = wh / 8.0;
  return Math.round(rawLine * ratio * 100) / 100;
}

function updateEffectiveLabel(staffId) {
  const s = incentiveData.staff.find(x => x.id === staffId);
  if (!s) return;
  const eff = calcEffectiveLine(staffId);
  const unitLabel = s.type === 'nurse' ? '時間/日' : '単位/日';
  const el = document.getElementById('eff_' + staffId);
  if (!el) return;
  const lineEl = document.getElementById('iline_' + staffId);
  const rawLine = lineEl ? parseFloat(lineEl.value) : 0;
  const isDiff = Math.abs(eff - rawLine) > 0.001;
  el.textContent = '実効ライン: ' + eff + ' ' + unitLabel;
  el.className = isDiff ? 'iline-eff-diff' : 'iline-eff-ok';
}

function buildStaffRateOpts(type, selected) {
  const isNurse = type === 'nurse';
  const def = incentiveData.defaults;
  const defRate = isNurse ? def.nurse_rate : def.rehab_rate;
  const step = isNurse ? 500 : 100;
  const max = isNurse ? 10000 : 5000;
  const unit = isNurse ? '円/時間' : '円/単位';
  let html = `<option value=""${selected == null ? ' selected' : ''}>デフォルト (¥${defRate.toLocaleString()})</option>`;
  for (let v = step; v <= max; v += step) {
    if (v === defRate) continue;
    const sel = (selected != null && v === selected) ? ' selected' : '';
    html += `<option value="${v}"${sel}>¥${v.toLocaleString()} ${unit}</option>`;
  }
  return html;
}

function renderIncentiveTable(nurseOpts, rehabOpts) {
  const container = document.getElementById('incentiveBody');
  container.innerHTML = '';
  const def = incentiveData.defaults;
  for (const s of incentiveData.staff) {
    const badge = staffTypeBadge(s.type);
    const opts = s.type === 'nurse' ? nurseOpts : rehabOpts;
    const unit = s.type === 'nurse' ? 'h' : 'u';
    const effective = (s.incentive_line != null) ? s.incentive_line
      : (s.type === 'nurse' ? def.nurse : def.rehab);
    const furi = (s.furigana_family || '') + (s.furigana_given || '');
    const wh = s.work_hours ?? 8.0;
    const effLine = Math.round(effective * (wh / 8.0) * 100) / 100;
    const unitLabel = s.type === 'nurse' ? '時間/日' : '単位/日';
    const isDiff = Math.abs(effLine - effective) > 0.001;
    const row = document.createElement('div');
    row.className = 'iline-row';
    row.innerHTML = `
      <div class="iline-name">
        <div class="name-furi">${esc(furi)}</div>
        <div class="name-kanji">${esc(s.name)}</div>
      </div>
      <div class="iline-type">${badge}</div>
      <div class="iline-col-wrap">
        <div class="iline-field-row">
          <span class="iline-label">目安ライン</span>
          <select class="iline-select flex-1" id="iline_${esc(s.id)}" data-action-change="update-effective" data-id="${esc(s.id)}">
            ${buildSelectHtml(opts, effective, unit)}
          </select>
          <button class="btn-save" data-action="save-incentive" data-id="${esc(s.id)}">保存</button>
        </div>
        <div class="iline-field-row">
          <span class="iline-label">時短勤務</span>
          <select class="iline-select flex-1" id="whours_${esc(s.id)}" data-action-change="update-effective" data-id="${esc(s.id)}">
            ${buildWorkHoursOpts(s.work_hours)}
          </select>
          <button class="btn-save" data-action="save-workhours" data-id="${esc(s.id)}">保存</button>
        </div>
        <div class="iline-field-row">
          <span class="iline-label">インセンティブ単価</span>
          <select class="iline-select flex-1" id="irate_${esc(s.id)}">
            ${buildStaffRateOpts(s.type, s.incentive_rate)}
          </select>
          <button class="btn-save" data-action="save-rate" data-id="${esc(s.id)}">保存</button>
        </div>
        <div id="eff_${esc(s.id)}" class="${isDiff ? 'iline-eff-diff' : 'iline-eff-ok'}">実効ライン: ${effLine} ${unitLabel}</div>
      </div>`;
    container.appendChild(row);
  }
}

async function saveDefaults() {
  const nurse = parseFloat(document.getElementById('defaultNurse').value);
  const rehab = parseFloat(document.getElementById('defaultRehab').value);
  const nurse_rate = parseInt(document.getElementById('defaultNurseRate').value, 10);
  const rehab_rate = parseInt(document.getElementById('defaultRehabRate').value, 10);
  const res = await apiFetch('/api/admin/incentive/defaults', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nurse, rehab, nurse_rate, rehab_rate }),
  });
  const data = await res.json();
  if (data.success) {
    incentiveData.defaults = { nurse, rehab, nurse_rate, rehab_rate };
    showToast('✅ デフォルトを保存しました');
  } else showToast('エラー: ' + (data.error || '保存失敗'));
}

// ── #incentiveBody イベント委譲 ─────────────────────────────────
document.getElementById('incentiveBody').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'save-incentive') saveStaffIncentive(btn.dataset.id);
  if (btn.dataset.action === 'save-workhours') saveWorkHours(btn.dataset.id);
  if (btn.dataset.action === 'save-rate') saveIncentiveRate(btn.dataset.id);
});
document.getElementById('incentiveBody').addEventListener('change', e => {
  const sel = e.target.closest('[data-action-change="update-effective"]');
  if (sel) updateEffectiveLabel(sel.dataset.id);
});

async function saveWorkHours(id) {
  const s = incentiveData.staff.find(x => x.id === id);
  const name = s ? s.name : id;
  const val = document.getElementById(`whours_${id}`).value;
  const work_hours = val === '' ? null : parseFloat(val);
  const res = await apiFetch(`/api/admin/staff/${encodeURIComponent(id)}/work-hours`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ work_hours }),
  });
  const data = await res.json();
  if (data.success) {
    if (s) s.work_hours = work_hours;
    showToast(`✅ ${name} の時短設定を保存しました`);
  } else showToast('エラー: ' + (data.error || '保存失敗'));
}

async function saveStaffIncentive(id) {
  const s = incentiveData.staff.find(x => x.id === id);
  const name = s ? s.name : id;
  const line = parseFloat(document.getElementById(`iline_${id}`).value);
  const res = await apiFetch(`/api/admin/staff/${encodeURIComponent(id)}/incentive`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ line }),
  });
  const data = await res.json();
  if (data.success) {
    if (s) s.incentive_line = line;
    showToast(`✅ ${name} のラインを保存しました`);
  } else showToast('エラー: ' + (data.error || '保存失敗'));
}

async function saveIncentiveRate(id) {
  const s = incentiveData.staff.find(x => x.id === id);
  const name = s ? s.name : id;
  const val = document.getElementById(`irate_${id}`).value;
  const rate = val === '' ? null : parseInt(val, 10);
  const res = await apiFetch(`/api/admin/staff/${encodeURIComponent(id)}/incentive-rate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rate }),
  });
  const data = await res.json();
  if (data.success) {
    if (s) s.incentive_rate = rate;
    showToast(`✅ ${name} の単価を保存しました`);
  } else showToast('エラー: ' + (data.error || '保存失敗'));
}

// ── インセンティブ月次集計 ────────────────────────────────────
// ── 月次一覧（統合: 月次実績 + インセンティブ）─────────────────
let monthlyListInited = false;
let monthlyListData = null;

function switchMonthlyTab(tab) {
  const listBtn = document.getElementById('monthlyTabList');
  const detailBtn = document.getElementById('monthlyTabDetail');
  const listMode = document.getElementById('monthlyListMode');
  const detailMode = document.getElementById('monthlyDetailMode');
  if (tab === 'list') {
    listBtn.style.background = 'var(--blue)'; listBtn.style.color = '#fff';
    detailBtn.style.background = '#fff'; detailBtn.style.color = 'var(--blue)';
    listMode.style.display = ''; detailMode.classList.add('d-none');
  } else {
    detailBtn.style.background = 'var(--blue)'; detailBtn.style.color = '#fff';
    listBtn.style.background = '#fff'; listBtn.style.color = 'var(--blue)';
    listMode.style.display = 'none'; detailMode.classList.remove('d-none');
  }
}

function initMonthlyListMonth() {
  if (monthlyListInited) return;
  monthlyListInited = true;
  const sel = document.getElementById('monthlyListMonth');
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const val = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const label = d.getFullYear() + '年' + (d.getMonth() + 1) + '月';
    sel.innerHTML += `<option value="${val}">${label}</option>`;
  }
}

async function loadMonthlyList() {
  const sel = document.getElementById('monthlyListMonth');
  if (!sel.value) return;
  const [year, month] = sel.value.split('-');

  document.getElementById('monthlyListSpinner').classList.remove('d-none');
  document.getElementById('monthlyListContent').classList.add('d-none');
  document.getElementById('monthlyListEmpty').classList.add('d-none');
  document.getElementById('monthlyListCSVBtn').classList.add('d-none');

  try {
    const res = await fetch(`/api/admin/incentive-summary?year=${year}&month=${parseInt(month)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    monthlyListData = data;
    renderMonthlyListTable(data);
  } catch (e) {
    document.getElementById('monthlyListSpinner').classList.add('d-none');
    document.getElementById('monthlyListEmpty').classList.remove('d-none');
    document.getElementById('monthlyListEmpty').textContent = 'エラー: ' + e.message;
  }
}

function renderMonthlyListTable(data) {
  document.getElementById('monthlyListSpinner').classList.add('d-none');
  const staffList = data.staff.filter(s => !s.error);
  if (staffList.length === 0) {
    document.getElementById('monthlyListEmpty').classList.remove('d-none');
    return;
  }
  document.getElementById('monthlyListContent').classList.remove('d-none');
  document.getElementById('monthlyListCSVBtn').classList.remove('d-none');

  const nurses = staffList.filter(s => s.type === 'nurse');
  const rehabs = staffList.filter(s => s.type !== 'nurse');

  const thC = 'ilist-th';
  const tdC = 'ilist-td';

  let html = '';

  // ── 看護職テーブル
  if (nurses.length > 0) {
    html += `<div class="ilist-section-nurse">🩺 看護職</div>`;
    html += `<div class="table-wrap"><table class="table-full-sm min-w-720">
      <thead><tr class="ilist-nurse-header">
        <th class="${thC} text-left">名前</th>
        <th class="${thC} text-center">日数</th>
        <th class="${thC} text-right">介護</th>
        <th class="${thC} text-right">医療</th>
        <th class="${thC} text-right fw-700">合計</th>
        <th class="${thC} text-center">ライン</th>
        <th class="${thC} text-right">閾値</th>
        <th class="${thC} text-right">超過</th>
        <th class="${thC} text-center">単価</th>
        <th class="${thC} text-right fw-700">支給額</th>
      </tr></thead><tbody>`;
    for (const s of nurses) {
      const amtClass = s.amount > 0 ? 'ilist-amt-ok' : 'ilist-amt-muted';
      const overClass = s.over > 0 ? 'ilist-over-warn' : '';
      const rate = Number(s.incentive_rate || 4000);
      html += `<tr class="ilist-row-border">
        <td class="${tdC}"><span class="ilist-name-link" data-staff-id="${esc(s.id)}" data-action="goto-detail">${esc(s.name)}</span></td>
        <td class="${tdC} text-center">${s.working_days}</td>
        <td class="${tdC} text-right">${(s.total_kaigo || 0).toFixed(1)}</td>
        <td class="${tdC} text-right">${(s.total_iryo || 0).toFixed(1)}</td>
        <td class="${tdC} text-right fw-600">${(s.total || 0).toFixed(1)}</td>
        <td class="${tdC} text-center">${s.effective_line}h/日</td>
        <td class="${tdC} text-right">${s.threshold}h</td>
        <td class="${tdC} text-right ${overClass}">${s.over > 0 ? '+' + s.over : '0'}h</td>
        <td class="${tdC} text-center fs-12">¥${rate.toLocaleString()}/h</td>
        <td class="${tdC} text-right ${amtClass}">${s.amount > 0 ? '¥' + s.amount.toLocaleString() : '—'}</td>
      </tr>`;
    }
    const nurseTotal = nurses.reduce((a, s) => a + s.amount, 0);
    html += `</tbody><tfoot><tr class="ilist-nurse-foot">
      <td colspan="9" class="${tdC} text-right fw-700">看護職 小計</td>
      <td class="${tdC} text-right ilist-amt-ok">¥${nurseTotal.toLocaleString()}</td>
    </tr></tfoot></table></div>`;
  }

  // ── リハビリ職テーブル
  if (rehabs.length > 0) {
    html += `<div class="ilist-section-rehab">🏃 リハビリ職</div>`;
    html += `<div class="table-wrap"><table class="table-full-sm min-w-600">
      <thead><tr class="ilist-rehab-header">
        <th class="${thC} text-left">名前</th>
        <th class="${thC} text-center">日数</th>
        <th class="${thC} text-right fw-700">単位数</th>
        <th class="${thC} text-center">ライン</th>
        <th class="${thC} text-right">閾値</th>
        <th class="${thC} text-right">超過</th>
        <th class="${thC} text-center">単価</th>
        <th class="${thC} text-right fw-700">支給額</th>
      </tr></thead><tbody>`;
    for (const s of rehabs) {
      const amtClass = s.amount > 0 ? 'ilist-amt-ok' : 'ilist-amt-muted';
      const overClass = s.over > 0 ? 'ilist-over-warn' : '';
      const rate = Number(s.incentive_rate || 500);
      html += `<tr class="ilist-row-border">
        <td class="${tdC}"><span class="ilist-name-link" data-staff-id="${esc(s.id)}" data-action="goto-detail">${esc(s.name)}</span></td>
        <td class="${tdC} text-center">${s.working_days}</td>
        <td class="${tdC} text-right fw-600">${s.total}</td>
        <td class="${tdC} text-center">${s.effective_line}単位/日</td>
        <td class="${tdC} text-right">${s.threshold}単位</td>
        <td class="${tdC} text-right ${overClass}">${s.over > 0 ? '+' + s.over : '0'}単位</td>
        <td class="${tdC} text-center fs-12">¥${rate.toLocaleString()}/単位</td>
        <td class="${tdC} text-right ${amtClass}">${s.amount > 0 ? '¥' + s.amount.toLocaleString() : '—'}</td>
      </tr>`;
    }
    const rehabTotal = rehabs.reduce((a, s) => a + s.amount, 0);
    html += `</tbody><tfoot><tr class="ilist-rehab-foot">
      <td colspan="7" class="${tdC} text-right fw-700">リハビリ職 小計</td>
      <td class="${tdC} text-right ilist-amt-ok">¥${rehabTotal.toLocaleString()}</td>
    </tr></tfoot></table></div>`;
  }

  // ── 合計
  html += `<div class="ilist-total-box">
    <span class="ilist-total-label">インセンティブ合計支給額</span>
    <span class="ilist-total-amount">¥${data.total_amount.toLocaleString()}</span>
  </div>`;

  document.getElementById('monthlyListContent').innerHTML = html;
}

// 名前クリック→個別詳細ジャンプ
document.getElementById('monthlyListContent') && document.getElementById('monthlyListContent').addEventListener('click', e => {
  const link = e.target.closest('[data-action="goto-detail"]');
  if (!link) return;
  const staffId = link.dataset.staffId;
  if (!staffId || !monthlyListData) return;
  // タブを個別詳細に切替
  switchMonthlyTab('detail');
  // スタッフと月を設定
  const staffSel = document.getElementById('viewStaff');
  staffSel.value = staffId;
  const [y, m] = document.getElementById('monthlyListMonth').value.split('-');
  document.getElementById('viewYear').value = y;
  document.getElementById('viewMonth').value = parseInt(m);
  // 自動表示
  loadAdminMonthly();
});
