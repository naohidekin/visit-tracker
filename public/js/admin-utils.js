// admin-utils.js — 共通ユーティリティ（esc, toast, CSV export等）

// ── カテゴリ折りたたみ ──────────────────────────────────────
function toggleCard(h2) {
  const body = h2.nextElementSibling;
  if (!body) return;
  if (body.style.maxHeight && body.style.maxHeight !== '0px') {
    body.style.maxHeight = '0';
    body.style.overflow = 'hidden';
    h2.querySelector('span').textContent = '▼';
  } else {
    body.style.maxHeight = body.scrollHeight + 'px';
    body.style.overflow = 'visible';
    h2.querySelector('span').textContent = '▲';
  }
}

function toggleCategory(header) {
  const body = header.nextElementSibling;
  const icon = header.querySelector('.category-icon');
  if (body.classList.contains('collapsed')) {
    body.classList.remove('collapsed');
    body.classList.add('open');
    if (icon) icon.textContent = '▲';
  } else {
    body.classList.remove('open');
    body.classList.add('collapsed');
    if (icon) icon.textContent = '▼';
  }
}

// ── ひらがな → ヘボン式ローマ字 ──────────────────────────────
const HIRA = {
  'あ':'a','い':'i','う':'u','え':'e','お':'o',
  'か':'ka','き':'ki','く':'ku','け':'ke','こ':'ko',
  'さ':'sa','し':'shi','す':'su','せ':'se','そ':'so',
  'た':'ta','ち':'chi','つ':'tsu','て':'te','と':'to',
  'な':'na','に':'ni','ぬ':'nu','ね':'ne','の':'no',
  'は':'ha','ひ':'hi','ふ':'fu','へ':'he','ほ':'ho',
  'ま':'ma','み':'mi','む':'mu','め':'me','も':'mo',
  'や':'ya','ゆ':'yu','よ':'yo',
  'ら':'ra','り':'ri','る':'ru','れ':'re','ろ':'ro',
  'わ':'wa','を':'wo','ん':'n',
  'が':'ga','ぎ':'gi','ぐ':'gu','げ':'ge','ご':'go',
  'ざ':'za','じ':'ji','ず':'zu','ぜ':'ze','ぞ':'zo',
  'だ':'da','ぢ':'ji','づ':'zu','で':'de','ど':'do',
  'ば':'ba','び':'bi','ぶ':'bu','べ':'be','ぼ':'bo',
  'ぱ':'pa','ぴ':'pi','ぷ':'pu','ぺ':'pe','ぽ':'po',
  'きゃ':'kya','きゅ':'kyu','きょ':'kyo',
  'しゃ':'sha','しゅ':'shu','しょ':'sho',
  'ちゃ':'cha','ちゅ':'chu','ちょ':'cho',
  'にゃ':'nya','にゅ':'nyu','にょ':'nyo',
  'ひゃ':'hya','ひゅ':'hyu','ひょ':'hyo',
  'みゃ':'mya','みゅ':'myu','みょ':'myo',
  'りゃ':'rya','りゅ':'ryu','りょ':'ryo',
  'ぎゃ':'gya','ぎゅ':'gyu','ぎょ':'gyo',
  'じゃ':'ja','じゅ':'ju','じょ':'jo',
  'びゃ':'bya','びゅ':'byu','びょ':'byo',
  'ぴゃ':'pya','ぴゅ':'pyu','ぴょ':'pyo',
  'っ':'',
};
function hiraToRomaji(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const two = str.slice(i, i+2);
    if (HIRA[two] !== undefined) { out += HIRA[two]; i++; }
    else out += HIRA[str[i]] ?? '';
  }
  return out;
}

// ── ユーティリティ ────────────────────────────────────────
function staffTypeBadge(type) {
  if (type === 'nurse')  return '<span class="badge badge-nurse">看</span>';
  if (type === 'office') return '<span class="badge badge-office">事</span>';
  if (type === 'admin')  return '<span class="badge badge-office">役</span>';
  return `<span class="badge badge-rehab">${type}</span>`;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

// ── トースト ─────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, 3000);
}

// ── CSV エクスポート共通 ──────────────────────────────────────
function downloadCSV(headers, rows, filename) {
  const escape = v => {
    const s = String(v == null ? '' : v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))];
  const bom = '\uFEFF';
  const blob = new Blob([bom + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

const today = new Date().toISOString().slice(0, 10);

// 1) スタッフ一覧
function exportStaffCSV() {
  fetch('/api/admin/staff?includeArchived=true')
    .then(r => r.json())
    .then(list => {
      const headers = ['ID', '名前', 'ふりがな', '職種', '入社日', 'OC対象', '状態'];
      const rows = list.map(s => [
        s.id, s.name,
        (s.furigana_family || '') + ' ' + (s.furigana_given || ''),
        s.type === 'nurse' ? '看護師' : s.type,
        s.hire_date || '', s.oncall_eligible ? '○' : '',
        s.archived ? '格納済' : '有効'
      ]);
      downloadCSV(headers, rows, `スタッフ一覧_${today}.csv`);
    })
    .catch(e => showToast('CSV出力に失敗しました'));
}

// 2) スタッフ月次実績
function exportMonthlyCSV() {
  if (!currentAdminData) return;
  const d = currentAdminData;
  const staffName = document.getElementById('viewStaff').selectedOptions[0]?.textContent || '';
  const y = document.getElementById('viewYear').value;
  const m = document.getElementById('viewMonth').value;
  const dayLabel = r => r.month != null ? `${r.month}/${r.day}` : String(r.day);
  let headers, rows;
  if (d.type === 'nurse') {
    headers = ['日付', '曜日', '介護', '医療', '合計'];
    rows = d.days.map(r => [dayLabel(r), r.weekday, r.kaigo ?? '', r.iryo ?? '', r.total ?? '']);
    rows.push(['合計', '', d.stats.total_kaigo, d.stats.total_iryo, d.stats.total]);
    rows.push(['稼働日数', d.stats.working_days, '', '', '']);
  } else {
    headers = ['日付', '曜日', '単位数'];
    rows = d.days.map(r => [dayLabel(r), r.weekday, r.value ?? '']);
    rows.push(['合計', '', d.stats.total_units]);
    rows.push(['稼働日数', d.stats.working_days, '']);
  }
  const suffix = adminDetailMode === 'billing' ? `_締め期間` : '';
  downloadCSV(headers, rows, `月次実績_${staffName}_${y}年${m}月${suffix}.csv`);
}

// 3) 有給残日数
function exportLeaveBalanceCSV() {
  fetch('/api/admin/leave/summary')
    .then(r => r.json())
    .then(({ summary }) => {
      const headers = ['名前', '職種', '入社日', '最終付与', '付与', '繰越', '調整', '使用', '申請中', '残日数'];
      const rows = summary.map(s => [
        s.name, s.type === 'nurse' ? '看護師' : s.type,
        s.hire_date || '', s.auto_grant_days, s.granted, s.carried_over,
        s.manual_adjustment, s.used, s.pending, s.balance
      ]);
      downloadCSV(headers, rows, `有給残日数一覧_${today}.csv`);
    })
    .catch(e => showToast('CSV出力に失敗しました'));
}

// 4) 有給申請履歴
function exportLeaveHistoryCSV() {
  const staffFilter = document.getElementById('leaveHistoryStaff')?.value || '';
  const statusFilter = document.getElementById('leaveHistoryStatus')?.value || '';
  const params = new URLSearchParams();
  if (statusFilter) params.set('status', statusFilter);
  fetch('/api/admin/leave/requests?' + params)
    .then(r => r.json())
    .then(({ requests }) => {
      let filtered = requests;
      if (staffFilter) filtered = filtered.filter(r => r.staffId === staffFilter);
      const typeLabel = t => t === 'full' ? '全日' : t === 'half_am' ? '午前半休' : '午後半休';
      const statusLabel = s => ({pending:'承認待ち',approved:'承認済',rejected:'却下',cancelled:'取消済'}[s] || s);
      const headers = ['名前', '日付', '種別', 'ステータス', '理由', 'コメント', '申請日', '処理日'];
      const rows = filtered.map(r => [
        r.staffName, r.dates.join(' / '), typeLabel(r.type), statusLabel(r.status),
        r.reason || '', r.adminComment || '',
        r.createdAt ? r.createdAt.slice(0, 10) : '', r.reviewedAt ? r.reviewedAt.slice(0, 10) : ''
      ]);
      downloadCSV(headers, rows, `有給申請履歴_${today}.csv`);
    })
    .catch(e => showToast('CSV出力に失敗しました'));
}

// 5) オンコール集計
function exportOncallCSV() {
  if (!lastOncallSummary || lastOncallSummary.length === 0) return;
  const month = document.getElementById('oncallMonth').value;
  const headers = ['名前', '職種', '件数', '時間(h)', '交通費件数', '日数'];
  const rows = lastOncallSummary.filter(s => s.recordDays > 0).map(s => [
    s.name, s.type === 'nurse' ? '看護師' : s.type,
    s.totalCount, (s.totalMinutes / 60).toFixed(1), s.totalTransportCount, s.recordDays
  ]);
  downloadCSV(headers, rows, `オンコール集計_${month}.csv`);
}

function exportMonthlyListCSV() {
  if (!monthlyListData) return;
  const d = monthlyListData;
  const staffList = d.staff.filter(x => !x.error);
  const nurses = staffList.filter(s => s.type === 'nurse');
  const rehabs = staffList.filter(s => s.type !== 'nurse');
  const rows = [];

  // 看護職
  if (nurses.length > 0) {
    rows.push(['【看護職】']);
    rows.push(['名前','出勤日数','介護','医療','合計','ライン(日)','閾値(月)','超過','単価(円)','支給額']);
    for (const s of nurses) {
      const rate = s.incentive_rate || 4000;
      rows.push([s.name, s.working_days, s.total_kaigo || 0, s.total_iryo || 0, s.total, s.effective_line, s.threshold, s.over, rate, s.amount]);
    }
    rows.push(['','','','','','','','','小計', nurses.reduce((a, s) => a + s.amount, 0)]);
    rows.push([]);
  }

  // リハビリ職
  if (rehabs.length > 0) {
    rows.push(['【リハビリ職】']);
    rows.push(['名前','出勤日数','単位数','ライン(日)','閾値(月)','超過','単価(円)','支給額']);
    for (const s of rehabs) {
      const rate = s.incentive_rate || 500;
      rows.push([s.name, s.working_days, s.total, s.effective_line, s.threshold, s.over, rate, s.amount]);
    }
    rows.push(['','','','','','','小計', rehabs.reduce((a, s) => a + s.amount, 0)]);
    rows.push([]);
  }

  rows.push(['合計支給額', d.total_amount]);

  const bom = '\uFEFF';
  const csv = bom + rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `月次実績_インセンティブ_${d.year}年${d.month}月.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportStandbyCSV() {
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

function exportAttendanceCSV() {
  const month = document.getElementById('attendanceMonth').value;
  if (!month) return;
  apiFetch(`/api/admin/attendance/monthly?month=${month}&mode=${attendanceMode}`)
    .then(r => r.json())
    .then(data => {
      if (!data.staff) return;
      const headers = ['名前', '職種', '営業日数', '出勤日数', '欠勤', '休暇', '未確認', '雨の日出勤'];
      const rows = data.staff.map(s => [
        s.name, TYPE_LABELS[s.type] || s.type, s.workDays, s.confirmedDays,
        s.absentDays, s.leaveDays, s.unconfirmedDays, s.rainyDayAttendance,
      ]);
      const suffix = attendanceMode === 'billing' ? '締め期間' : '月次';
      downloadCSV(headers, rows, `出勤集計_${suffix}_${month}.csv`);
    })
    .catch(() => showToast('CSV出力に失敗しました'));
}

// 6) 監査ログ
function exportAuditCSV() {
  const action = document.getElementById('auditActionFilter').value;
  const from = document.getElementById('auditDateFrom').value;
  const to = document.getElementById('auditDateTo').value;
  const params = new URLSearchParams({ limit: 10000 });
  if (action) params.set('action', action);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  fetch('/api/admin/audit-log?' + params)
    .then(r => r.json())
    .then(data => {
      const headers = ['日時', '操作者', '操作', '対象', '詳細'];
      const rows = data.entries.map(e => {
        const dt = new Date(e.timestamp);
        const timeStr = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
        return [
          timeStr, e.actor.staffName || e.actor.type,
          AUDIT_ACTION_LABELS[e.action] || e.action,
          e.target?.label || '', JSON.stringify(e.details || {})
        ];
      });
      downloadCSV(headers, rows, `操作履歴_${today}.csv`);
    })
    .catch(e => showToast('CSV出力に失敗しました'));
}