// admin-excel.js — Excel取込・分析

// ── Excel集計 ────────────────────────────────────────────────
(function() {
  const dropZone = document.getElementById('excelDropZone');
  const fileInput = document.getElementById('excelFileInput');
  const spinner = document.getElementById('excelSpinner');
  const errEl = document.getElementById('excelErr');
  const resultEl = document.getElementById('excelResult');
  const fileNameEl = document.getElementById('excelFileName');

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.style.borderColor = 'var(--blue)'; dropZone.style.background = '#f0f6ff'; });
  dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = 'var(--border)'; dropZone.style.background = ''; });
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.style.borderColor = 'var(--border)'; dropZone.style.background = '';
    if (e.dataTransfer.files.length) analyzeExcel(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => { if (fileInput.files.length) analyzeExcel(fileInput.files[0]); });

  async function analyzeExcel(file) {
    errEl.style.display = 'none'; resultEl.style.display = 'none';
    fileNameEl.textContent = '📄 ' + file.name; fileNameEl.style.display = 'block';
    spinner.style.display = 'block';
    try {
      const fd = new FormData();
      fd.append('file', file);
      const y = document.getElementById('excelYear').value;
      const m = document.getElementById('excelMonth').value;
      fd.append('yearMonth', `${y}-${String(m).padStart(2,'0')}`);
      const r = await apiFetch('/api/admin/analyze-excel', { method: 'POST', body: fd });
      const data = await r.json();
      spinner.style.display = 'none';
      if (!r.ok || !data.success) { errEl.textContent = data.error || 'エラー'; errEl.style.display = 'block'; return; }
      renderExcelResult(data.results);
    } catch (e) {
      spinner.style.display = 'none';
      errEl.textContent = e.message; errEl.style.display = 'block';
    }
  }

  function renderExcelResult(results) {
    const nurses = results.filter(r => r.isNurse);
    const rehabs = results.filter(r => !r.isNurse);
    const nurseSection = document.getElementById('excelNurseSection');
    const rehabSection = document.getElementById('excelRehabSection');
    const nurseBody = document.getElementById('excelNurseBody');
    const rehabBody = document.getElementById('excelRehabBody');

    if (nurses.length) {
      nurseBody.innerHTML = nurses.map(n =>
        `<tr><td>${esc(n.staffName)}</td><td class="excel-td-right">${n.visitCount}回</td><td class="excel-td-right-bold">${n.totalHours}時間</td></tr>`
      ).join('') + `<tr class="excel-foot-row"><td class="excel-foot-label">合計</td><td class="excel-td-right-bold">${nurses.reduce((s,n)=>s+n.visitCount,0)}回</td><td class="excel-td-right-bold">${Math.round(nurses.reduce((s,n)=>s+n.totalMinutes,0)/60*10)/10}時間</td></tr>`;
      nurseSection.style.display = 'block';
    } else {
      nurseSection.style.display = 'none';
    }

    if (rehabs.length) {
      rehabBody.innerHTML = rehabs.map(r =>
        `<tr><td>${esc(r.staffName)}</td><td class="excel-td-right">${esc(r.qualification)}</td><td class="excel-td-right">${r.visitCount}回</td><td class="excel-td-right-bold">${r.totalUnits}単位</td></tr>`
      ).join('') + `<tr class="excel-foot-row"><td class="excel-foot-label">合計</td><td></td><td class="excel-td-right-bold">${rehabs.reduce((s,r)=>s+r.visitCount,0)}回</td><td class="excel-td-right-bold">${rehabs.reduce((s,r)=>s+r.totalUnits,0)}単位</td></tr>`;
      rehabSection.style.display = 'block';
    } else {
      rehabSection.style.display = 'none';
    }

    resultEl.style.display = 'block';
  }
})();

// ── Excel集計履歴 ──────────────────────────────────────────
function initExcelSelectors() {
  const now = new Date();
  const y = String(now.getFullYear());
  const m = String(now.getMonth() + 1);
  document.getElementById('excelYear').value = y;
  document.getElementById('excelMonth').value = m;
  document.getElementById('histYear').value = y;
  document.getElementById('histMonth').value = m;
}

async function loadExcelHistory() {
  const y = document.getElementById('histYear').value;
  const m = document.getElementById('histMonth').value;
  const ym = `${y}-${String(m).padStart(2,'0')}`;

  document.getElementById('histErr').style.display = 'none';
  document.getElementById('histResult').style.display = 'none';
  document.getElementById('histSpinner').style.display = 'block';

  try {
    const res = await fetch(`/api/admin/excel-results/${ym}`);
    document.getElementById('histSpinner').style.display = 'none';
    if (!res.ok) {
      const data = await res.json();
      document.getElementById('histErr').textContent = data.error || 'データがありません';
      document.getElementById('histErr').style.display = 'block';
      return;
    }
    const entry = await res.json();
    renderHistoryResult(entry, ym);
  } catch (e) {
    document.getElementById('histSpinner').style.display = 'none';
    document.getElementById('histErr').textContent = e.message;
    document.getElementById('histErr').style.display = 'block';
  }
}

function renderHistoryResult(entry, ym) {
  const results = entry.results;
  const nurses = results.filter(r => r.isNurse);
  const rehabs = results.filter(r => !r.isNurse);

  const [yy, mm] = ym.split('-');
  document.getElementById('histTitle').textContent = `${yy}年${parseInt(mm)}月 集計結果`;

  const nurseSection = document.getElementById('histNurseSection');
  const nurseBody = document.getElementById('histNurseBody');
  if (nurses.length) {
    nurseBody.innerHTML = nurses.map(n =>
      `<tr><td>${esc(n.staffName)}</td><td class="excel-td-right">${n.visitCount}回</td><td class="excel-td-right-bold">${n.totalHours}時間</td></tr>`
    ).join('') + `<tr class="excel-foot-row"><td class="excel-foot-label">合計</td><td class="excel-td-right-bold">${nurses.reduce((s,n)=>s+n.visitCount,0)}回</td><td class="excel-td-right-bold">${Math.round(nurses.reduce((s,n)=>s+n.totalMinutes,0)/60*10)/10}時間</td></tr>`;
    nurseSection.style.display = 'block';
  } else {
    nurseSection.style.display = 'none';
  }

  const rehabSection = document.getElementById('histRehabSection');
  const rehabBody = document.getElementById('histRehabBody');
  if (rehabs.length) {
    rehabBody.innerHTML = rehabs.map(r =>
      `<tr><td>${esc(r.staffName)}</td><td class="excel-td-right">${esc(r.qualification)}</td><td class="excel-td-right">${r.visitCount}回</td><td class="excel-td-right-bold">${r.totalUnits}単位</td></tr>`
    ).join('') + `<tr class="excel-foot-row"><td class="excel-foot-label">合計</td><td></td><td class="excel-td-right-bold">${rehabs.reduce((s,r)=>s+r.visitCount,0)}回</td><td class="excel-td-right-bold">${rehabs.reduce((s,r)=>s+r.totalUnits,0)}単位</td></tr>`;
    rehabSection.style.display = 'block';
  } else {
    rehabSection.style.display = 'none';
  }

  document.getElementById('histMeta').textContent = `ファイル: ${entry.fileName} / 集計日時: ${new Date(entry.analyzedAt).toLocaleString('ja-JP')}`;
  document.getElementById('histResult').style.display = 'block';
}
