// admin-attendance.js — 出勤集計

// ── 出勤確定 集計（月次 / 締め期間 切替） ───────────────────────
let attendanceMonthInited = false;
let attendanceMode = 'monthly'; // 'monthly' or 'billing'

function initAttendanceMonth() {
  if (attendanceMonthInited) return;
  attendanceMonthInited = true;
  repopulateAttendanceMonth();
  document.getElementById('attendanceModeMonthly').addEventListener('click', () => switchAttendanceMode('monthly'));
  document.getElementById('attendanceModeBilling').addEventListener('click', () => switchAttendanceMode('billing'));
}

function switchAttendanceMode(mode) {
  if (attendanceMode === mode) return;
  attendanceMode = mode;
  const btnM = document.getElementById('attendanceModeMonthly');
  const btnB = document.getElementById('attendanceModeBilling');
  if (mode === 'monthly') {
    btnM.style.background = 'var(--blue)'; btnM.style.color = '#fff';
    btnB.style.background = '#fff'; btnB.style.color = 'var(--blue)';
  } else {
    btnB.style.background = 'var(--blue)'; btnB.style.color = '#fff';
    btnM.style.background = '#fff'; btnM.style.color = 'var(--blue)';
  }
  repopulateAttendanceMonth();
  loadAttendanceMonthly();
}

function repopulateAttendanceMonth() {
  const sel = document.getElementById('attendanceMonth');
  const currentVal = sel.value;
  sel.innerHTML = '';
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;
  for (let offset = 2; offset >= -12; offset--) {
    let y = curY, m = curM - offset;
    if (m < 1) { y--; m += 12; }
    if (m > 12) { y++; m -= 12; }
    const val = `${y}-${String(m).padStart(2, '0')}`;
    let label;
    if (attendanceMode === 'billing') {
      const prevM = m === 1 ? 12 : m - 1;
      label = `${y}年${m}月月次（${prevM}/16〜${m}/15）`;
    } else {
      label = `${y}年${m}月`;
    }
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    if (val === currentVal || (offset === 0 && !currentVal)) opt.selected = true;
    sel.appendChild(opt);
  }
}

const TYPE_LABELS = { nurse: '看', PT: 'PT', OT: 'OT', ST: 'ST', office: '事' };

async function loadAttendanceMonthly() {
  const month = document.getElementById('attendanceMonth').value;
  if (!month) return;

  const spinner = document.getElementById('attendanceMonthlySpinner');
  const tableWrap = document.getElementById('attendanceMonthlyTableWrap');
  spinner.classList.remove('d-none');
  tableWrap.classList.add('d-none');

  try {
    const resp = await apiFetch(`/api/admin/attendance/monthly?month=${month}&mode=${attendanceMode}`);
    const data = await resp.json();
    spinner.classList.add('d-none');

    // 期間ラベル更新
    const label = document.getElementById('attendancePeriodLabel');
    if (attendanceMode === 'billing') {
      label.textContent = `締め期間: ${data.billingStart} 〜 ${data.billingEnd}（${data.billingLabel}）`;
    } else {
      label.textContent = '有給未申請＋訪問記録入力済み＝出勤として自動確定（毎日18時に集計）';
    }

    const tbody = document.getElementById('attendanceMonthlyBody');
    tbody.innerHTML = '';

    if (!data.staff || data.staff.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-msg-lg">データがありません</td></tr>';
      tableWrap.classList.remove('d-none');
      return;
    }

    for (const s of data.staff) {
      const tr = document.createElement('tr');
      const unconfClass = s.unconfirmedDays > 0 ? 'att-td-center att-unconfirmed-warn' : 'att-td-center color-muted';
      tr.innerHTML = `
        <td class="att-td">${esc(s.name)}</td>
        <td class="att-td-center fs-13">${esc(TYPE_LABELS[s.type] || s.type)}</td>
        <td class="att-td-center">${s.workDays}</td>
        <td class="att-td-center color-ok fw-600">${s.confirmedDays}</td>
        <td class="att-td-center color-danger">${s.absentDays}</td>
        <td class="att-td-center color-muted">${s.leaveDays}</td>
        <td class="${unconfClass}">${s.unconfirmedDays}</td>
        <td class="att-td-center att-rainy">${s.rainyDayAttendance}</td>`;
      tbody.appendChild(tr);
    }

    tableWrap.classList.remove('d-none');
  } catch (e) {
    spinner.classList.add('d-none');
    showToast('集計の取得に失敗しました');
  }
}

