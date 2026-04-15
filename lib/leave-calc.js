'use strict';
// 有給計算モジュール（付与日数・残日数の計算）

const { getTodayJST, toDateStr } = require('./helpers');
const { loadLeave } = require('./data');
const { LEAVE_GRANT_TABLE } = require('./constants');

// 入社日から月加算した日付を返す（月末オーバーフロー対策：末日にクランプ）
function addMonthsToDate(base, months) {
  const d = new Date(base);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

// 入社日からの経過で、付与基準日に達しているか判定（日付ベース）
function hasReachedGrantDate(hire, now, months) {
  const grantDate = addMonthsToDate(hire, months);
  return now >= grantDate;
}

// 現在の付与日数を計算（todayStr省略時はJST今日）
function calcLeaveGrantDays(hireDate, todayStr) {
  if (!hireDate) return 0;
  const hire = new Date(hireDate);
  const now  = new Date(todayStr || getTodayJST());
  let granted = 0;
  for (const t of LEAVE_GRANT_TABLE) {
    if (hasReachedGrantDate(hire, now, t.months)) granted = t.days;
  }
  return granted;
}

// 次回有給付与日・付与日数・お祝い休暇情報を計算（todayStr省略時はJST今日）
function calcNextGrant(hireDate, todayStr, celebrationExpiryMonths = 6) {
  if (!hireDate) return null;
  const hire = new Date(hireDate);
  const now  = new Date(todayStr || getTodayJST());

  // お祝い休暇（入職〜celebrationExpiryMonthsヶ月）
  const celebrationExpiry = addMonthsToDate(hire, celebrationExpiryMonths);
  const celebrationActive = now < celebrationExpiry;

  // 次回付与を探す
  for (const t of LEAVE_GRANT_TABLE) {
    if (!hasReachedGrantDate(hire, now, t.months)) {
      const nextDate = addMonthsToDate(hire, t.months);
      const daysUntil = Math.ceil((nextDate - now) / (24 * 60 * 60 * 1000));
      return {
        next_grant_date: toDateStr(nextDate),
        next_grant_days: t.days,
        days_until_next: daysUntil,
        celebration_expiry: toDateStr(celebrationExpiry),
        celebration_active: celebrationActive,
        celebration_days_left: celebrationActive ? Math.ceil((celebrationExpiry - now) / (24 * 60 * 60 * 1000)) : 0,
      };
    }
  }
  // 既に最大付与(20日)に到達 → 次回は直近の付与周期から1年後
  const lastEntry = LEAVE_GRANT_TABLE[LEAVE_GRANT_TABLE.length - 1];
  // 最大付与到達後、何回目の年次更新かを日付ベースで求める
  let nextMonths = lastEntry.months + 12;
  while (hasReachedGrantDate(hire, now, nextMonths)) {
    nextMonths += 12;
  }
  const nextDate = addMonthsToDate(hire, nextMonths);
  const daysUntil = Math.ceil((nextDate - now) / (24 * 60 * 60 * 1000));
  return {
    next_grant_date: toDateStr(nextDate),
    next_grant_days: lastEntry.days,
    days_until_next: daysUntil,
    celebration_expiry: toDateStr(celebrationExpiry),
    celebration_active: false,
    celebration_days_left: 0,
  };
}

// OC有給の消化期限を算出（付与時点から「次の次の有給付与日」）
// 戻り値: Date オブジェクト（期限日）。hireDate 未設定なら null
function calcOncallLeaveExpiry(hireDate, grantedAtDate) {
  if (!hireDate) return null;
  const hire = new Date(hireDate);
  const grantedAt = new Date(grantedAtDate);

  // 付与時点以降の付与日を2つ見つける（2つ目が消化期限）
  let futureCount = 0;
  for (const t of LEAVE_GRANT_TABLE) {
    if (addMonthsToDate(hire, t.months) > grantedAt) {
      futureCount++;
      if (futureCount === 2) return addMonthsToDate(hire, t.months);
    }
  }

  // テーブル以降は12ヶ月周期で延長
  const lastMonth = LEAVE_GRANT_TABLE[LEAVE_GRANT_TABLE.length - 1].months;
  let m = lastMonth + 12;
  while (addMonthsToDate(hire, m) <= grantedAt) m += 12;
  while (futureCount < 2) {
    futureCount++;
    if (futureCount === 2) return addMonthsToDate(hire, m);
    m += 12;
  }
  return null;
}

// 期限内OC有給のみ合計（todayStr省略時はJST今日）
// oncall_leave_history 未設定 or 空 → oncall_leave_granted にフォールバック（後方互換）
function calcValidOncallLeave(staff, todayStr) {
  const history = staff.oncall_leave_history;
  if (!history || history.length === 0) {
    return staff.oncall_leave_granted || 0;
  }
  const today = todayStr || getTodayJST();
  let valid = 0;
  for (const entry of history) {
    if (!entry.expiresAt || entry.expiresAt > today) {
      valid += entry.days;
    }
  }
  return valid;
}

// お祝い休暇の残日数を返す（バリデーション用）
// 有効期限超過または hire_date 未設定なら 0
function calcCelebrationRemaining(staff, todayStr) {
  if (!staff.hire_date) return 0;
  const hire = new Date(staff.hire_date);
  const now  = new Date(todayStr || getTodayJST());
  const expiryMonths = staff.celebration_expiry_months || 6;
  const expiry = addMonthsToDate(hire, expiryMonths);
  if (now >= expiry) return 0;
  const celebrationDays = staff.celebration_days || 3;
  const adj = staff.celebration_used_adj || 0;
  return Math.max(0, celebrationDays - adj);
}

// スタッフの有給残日数を計算（承認済み使用日数を考慮）
// approvedRequests を渡すとloadLeave()を使わず直接計算（テスト用）
function calcLeaveBalance(staff, approvedRequests) {
  let approved;
  if (approvedRequests !== undefined) {
    approved = approvedRequests;
  } else {
    const leaveData = loadLeave();
    approved = leaveData.requests.filter(r =>
      r.staffId === staff.id && r.status === 'approved'
    );
  }
  let usedDays = 0;
  for (const r of approved) {
    const perDate = (r.type === 'half_am' || r.type === 'half_pm') ? 0.5 : 1;
    usedDays += r.dates.length * perDate;
  }
  const granted = staff.leave_granted || 0;
  const carriedOver = staff.leave_carried_over || 0;
  const manualAdj = staff.leave_manual_adjustment || 0;
  const oncallLeave = calcValidOncallLeave(staff);
  // 0.5日単位の浮動小数点誤差を防止（小数第1位で丸め）
  return Math.round((granted + carriedOver + manualAdj + oncallLeave - usedDays) * 10) / 10;
}

module.exports = {
  addMonthsToDate,
  hasReachedGrantDate,
  calcLeaveGrantDays,
  calcNextGrant,
  calcCelebrationRemaining,
  calcOncallLeaveExpiry,
  calcValidOncallLeave,
  calcLeaveBalance,
};
