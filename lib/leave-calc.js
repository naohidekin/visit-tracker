'use strict';
// 有給計算モジュール（付与日数・残日数の計算）

const { getTodayJST, toDateStr } = require('./helpers');
const { loadLeave } = require('./data');
const { LEAVE_GRANT_TABLE } = require('./constants');

// 入社日から月加算した日付を返す（日付ベースで正確に計算）
function addMonthsToDate(base, months) {
  const d = new Date(base);
  d.setMonth(d.getMonth() + months);
  return d;
}

// 入社日からの経過で、付与基準日に達しているか判定（日付ベース）
function hasReachedGrantDate(hire, now, months) {
  const grantDate = addMonthsToDate(hire, months);
  return now >= grantDate;
}

// 現在の付与日数を計算
function calcLeaveGrantDays(hireDate) {
  if (!hireDate) return 0;
  const hire = new Date(hireDate);
  const now  = new Date(getTodayJST());
  let granted = 0;
  for (const t of LEAVE_GRANT_TABLE) {
    if (hasReachedGrantDate(hire, now, t.months)) granted = t.days;
  }
  return granted;
}

// 次回有給付与日・付与日数・お祝い休暇情報を計算
function calcNextGrant(hireDate) {
  if (!hireDate) return null;
  const hire = new Date(hireDate);
  const now  = new Date(getTodayJST());

  // お祝い休暇（入職〜6ヶ月）
  const celebrationExpiry = addMonthsToDate(hire, 6);
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

// スタッフの有給残日数を計算（承認済み使用日数を考慮）
function calcLeaveBalance(staff) {
  const leaveData = loadLeave();
  const approved = leaveData.requests.filter(r =>
    r.staffId === staff.id && r.status === 'approved'
  );
  let usedDays = 0;
  for (const r of approved) {
    const perDate = (r.type === 'half_am' || r.type === 'half_pm') ? 0.5 : 1;
    usedDays += r.dates.length * perDate;
  }
  const granted = staff.leave_granted || 0;
  const carriedOver = staff.leave_carried_over || 0;
  const manualAdj = staff.leave_manual_adjustment || 0;
  const oncallLeave = staff.oncall_leave_granted || 0;
  // 0.5日単位の浮動小数点誤差を防止（小数第1位で丸め）
  return Math.round((granted + carriedOver + manualAdj + oncallLeave - usedDays) * 10) / 10;
}

module.exports = {
  addMonthsToDate,
  hasReachedGrantDate,
  calcLeaveGrantDays,
  calcNextGrant,
  calcLeaveBalance,
};
