/**
 * 有給休暇計算ロジックのユニットテスト
 * 実行: node test-leave.js
 *
 * server.js 内の純粋関数をコピーしてテスト。
 * server.js を変更したらこちらも同期すること。
 */
'use strict';
const assert = require('assert');

// ── server.js からコピーした関数群 ──────────────────────────────

const LEAVE_GRANT_TABLE = [
  { months: 6,  days: 10 },
  { months: 18, days: 12 },
  { months: 30, days: 14 },
  { months: 42, days: 16 },
  { months: 54, days: 18 },
  { months: 66, days: 20 },
];

function addMonthsToDate(base, months) {
  const d = new Date(base);
  d.setMonth(d.getMonth() + months);
  return d;
}

function hasReachedGrantDate(hire, now, months) {
  const grantDate = addMonthsToDate(hire, months);
  return now >= grantDate;
}

function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// テスト用に「今日」を注入可能にしたバージョン
function calcLeaveGrantDays(hireDate, todayStr) {
  if (!hireDate) return 0;
  const hire = new Date(hireDate);
  const now  = new Date(todayStr);
  let granted = 0;
  for (const t of LEAVE_GRANT_TABLE) {
    if (hasReachedGrantDate(hire, now, t.months)) granted = t.days;
  }
  return granted;
}

function calcNextGrant(hireDate, todayStr) {
  if (!hireDate) return null;
  const hire = new Date(hireDate);
  const now  = new Date(todayStr);

  const celebrationExpiry = addMonthsToDate(hire, 6);
  const celebrationActive = now < celebrationExpiry;

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
  const lastEntry = LEAVE_GRANT_TABLE[LEAVE_GRANT_TABLE.length - 1];
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

function calcLeaveBalance(staff, approvedRequests) {
  let usedDays = 0;
  for (const r of approvedRequests) {
    const perDate = (r.type === 'half_am' || r.type === 'half_pm') ? 0.5 : 1;
    usedDays += r.dates.length * perDate;
  }
  const granted = staff.leave_granted || 0;
  const carriedOver = staff.leave_carried_over || 0;
  const manualAdj = staff.leave_manual_adjustment || 0;
  const oncallLeave = staff.oncall_leave_granted || 0;
  return granted + carriedOver + manualAdj + oncallLeave - usedDays;
}

// ── テストケース ────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

// ─── addMonthsToDate ───
console.log('\n📌 addMonthsToDate');

test('6ヶ月加算: 2024-04-01 → 2024-10-01', () => {
  const r = addMonthsToDate(new Date('2024-04-01'), 6);
  assert.strictEqual(toDateStr(r), '2024-10-01');
});

test('月末日の処理: 2024-01-31 + 1ヶ月 → 2024-03-02 or 2024-02-29 (閏年)', () => {
  // JS の setMonth は 1/31 + 1 → 3/2 (非閏年) or 2/29 (閏年)
  // 2024は閏年なので 1/31 + 1 → 2/29 にはならず、3/2 になる（JSの挙動）
  const r = addMonthsToDate(new Date('2024-01-31'), 1);
  // JS: 2024-01-31 setMonth(1) → 2024-03-02 (2月は29日までだから溢れ)
  assert.strictEqual(toDateStr(r), '2024-03-02');
});

test('12ヶ月加算: 2024-04-01 → 2025-04-01', () => {
  const r = addMonthsToDate(new Date('2024-04-01'), 12);
  assert.strictEqual(toDateStr(r), '2025-04-01');
});

// ─── calcLeaveGrantDays ───
console.log('\n📌 calcLeaveGrantDays');

test('入社日なし → 0', () => {
  assert.strictEqual(calcLeaveGrantDays(null, '2026-01-01'), 0);
});

test('入社5ヶ月（6ヶ月未満）→ 0日', () => {
  assert.strictEqual(calcLeaveGrantDays('2025-08-01', '2026-01-01'), 0);
});

test('入社ちょうど6ヶ月 → 10日', () => {
  assert.strictEqual(calcLeaveGrantDays('2025-04-01', '2025-10-01'), 10);
});

test('入社7ヶ月 → 10日', () => {
  assert.strictEqual(calcLeaveGrantDays('2025-04-01', '2025-11-01'), 10);
});

test('入社1年6ヶ月ちょうど → 12日', () => {
  assert.strictEqual(calcLeaveGrantDays('2024-04-01', '2025-10-01'), 12);
});

test('入社2年6ヶ月ちょうど → 14日', () => {
  assert.strictEqual(calcLeaveGrantDays('2023-04-01', '2025-10-01'), 14);
});

test('入社3年6ヶ月ちょうど → 16日', () => {
  assert.strictEqual(calcLeaveGrantDays('2022-04-01', '2025-10-01'), 16);
});

test('入社4年6ヶ月ちょうど → 18日', () => {
  assert.strictEqual(calcLeaveGrantDays('2021-04-01', '2025-10-01'), 18);
});

test('入社5年6ヶ月ちょうど → 20日（最大）', () => {
  assert.strictEqual(calcLeaveGrantDays('2020-04-01', '2025-10-01'), 20);
});

test('入社10年（5年6ヶ月超え）→ 20日（上限変わらず）', () => {
  assert.strictEqual(calcLeaveGrantDays('2016-04-01', '2026-04-01'), 20);
});

test('付与日前日は前の段階: 入社17ヶ月 → 10日（18ヶ月未満）', () => {
  assert.strictEqual(calcLeaveGrantDays('2024-04-01', '2025-09-01'), 10);
});

// ─── calcNextGrant ───
console.log('\n📌 calcNextGrant');

test('入社日なし → null', () => {
  assert.strictEqual(calcNextGrant(null, '2026-01-01'), null);
});

test('入社3ヶ月 → 次回は6ヶ月時点(10日), お祝い休暇有効', () => {
  const r = calcNextGrant('2025-10-01', '2026-01-01');
  assert.strictEqual(r.next_grant_date, '2026-04-01');
  assert.strictEqual(r.next_grant_days, 10);
  assert.strictEqual(r.celebration_active, true);
  assert.strictEqual(r.celebration_expiry, '2026-04-01');
  assert.ok(r.celebration_days_left > 0);
});

test('入社6ヶ月 → 次回は18ヶ月(12日), お祝い休暇切れ', () => {
  const r = calcNextGrant('2025-04-01', '2025-10-01');
  assert.strictEqual(r.next_grant_date, '2026-10-01');
  assert.strictEqual(r.next_grant_days, 12);
  assert.strictEqual(r.celebration_active, false);
});

test('入社5年6ヶ月以降 → 次回は6年6ヶ月(20日)', () => {
  // 2020-04-01入社、今日2025-10-01 (66ヶ月ちょうど) → 次回は78ヶ月
  const r = calcNextGrant('2020-04-01', '2025-10-01');
  assert.strictEqual(r.next_grant_date, '2026-10-01');
  assert.strictEqual(r.next_grant_days, 20);
});

test('入社10年 → 次回付与日は正しく計算', () => {
  // 2016-04-01入社、今日2026-03-30 → 118ヶ月経過
  // 最後のテーブル: 66ヶ月。66+12=78, 78+12=90, 90+12=102, 102+12=114, 114+12=126
  // 126ヶ月 = 2026-10-01 (入社から10年6ヶ月)
  const r = calcNextGrant('2016-04-01', '2026-03-30');
  assert.strictEqual(r.next_grant_days, 20);
  assert.ok(r.days_until_next > 0);
});

// ─── calcLeaveBalance ───
console.log('\n📌 calcLeaveBalance');

test('付与12日、繰越4日、使用なし → 16日', () => {
  const staff = { leave_granted: 12, leave_carried_over: 4, leave_manual_adjustment: 0, oncall_leave_granted: 0 };
  assert.strictEqual(calcLeaveBalance(staff, []), 16);
});

test('付与10日、使用2日（全日休） → 8日', () => {
  const staff = { leave_granted: 10, leave_carried_over: 0, leave_manual_adjustment: 0, oncall_leave_granted: 0 };
  const requests = [
    { type: 'full', dates: ['2026-01-10', '2026-01-11'] },
  ];
  assert.strictEqual(calcLeaveBalance(staff, requests), 8);
});

test('半日休2回 → 1日消費', () => {
  const staff = { leave_granted: 10, leave_carried_over: 0, leave_manual_adjustment: 0, oncall_leave_granted: 0 };
  const requests = [
    { type: 'half_am', dates: ['2026-01-10'] },
    { type: 'half_pm', dates: ['2026-01-11'] },
  ];
  assert.strictEqual(calcLeaveBalance(staff, requests), 9);
});

test('オンコール代休加算', () => {
  const staff = { leave_granted: 10, leave_carried_over: 2, leave_manual_adjustment: 0, oncall_leave_granted: 3 };
  assert.strictEqual(calcLeaveBalance(staff, []), 15);
});

test('手動調整（マイナス）', () => {
  const staff = { leave_granted: 10, leave_carried_over: 0, leave_manual_adjustment: -2, oncall_leave_granted: 0 };
  assert.strictEqual(calcLeaveBalance(staff, []), 8);
});

test('全フィールド未定義 → 0', () => {
  const staff = {};
  assert.strictEqual(calcLeaveBalance(staff, []), 0);
});

test('複合ケース: 付与12+繰越4+OC代休1+調整-1、全日3日+半日1日使用 → 12.5', () => {
  const staff = { leave_granted: 12, leave_carried_over: 4, leave_manual_adjustment: -1, oncall_leave_granted: 1 };
  const requests = [
    { type: 'full', dates: ['2026-02-01', '2026-02-02', '2026-02-03'] },
    { type: 'half_am', dates: ['2026-02-04'] },
  ];
  assert.strictEqual(calcLeaveBalance(staff, requests), 12.5);
});

// ─── 日付境界テスト ───
console.log('\n📌 日付境界テスト');

test('付与日当日は付与済み: 2024-04-01入社、2024-10-01時点 → 10日', () => {
  assert.strictEqual(calcLeaveGrantDays('2024-04-01', '2024-10-01'), 10);
});

test('付与日前日は未付与: 2024-04-01入社、2024-09-30時点 → 0日', () => {
  assert.strictEqual(calcLeaveGrantDays('2024-04-01', '2024-09-30'), 0);
});

test('月末入社の付与日: 2024-08-31入社、6ヶ月後 → 2025-02-28 (or 3/3)', () => {
  // JS: 8/31 + 6months → setMonth(8+6=14=翌年2月) → 2025-03-03 (2月は28日)
  // よって 2025-03-02 時点ではまだ0日
  assert.strictEqual(calcLeaveGrantDays('2024-08-31', '2025-03-02'), 0);
  // 2025-03-03 以降で10日
  assert.strictEqual(calcLeaveGrantDays('2024-08-31', '2025-03-03'), 10);
});

// ── 結果サマリー ────────────────────────────────────────────────
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`結果: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('✨ All tests passed!\n');
}
