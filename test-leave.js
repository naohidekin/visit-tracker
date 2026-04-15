/**
 * 有給休暇計算ロジックのユニットテスト
 * 実行: node test-leave.js
 *
 * lib/ モジュールから直接インポートしてテスト。
 */
'use strict';
const assert = require('assert');

// ── lib/ モジュールからインポート ──────────────────────────────────
const {
  addMonthsToDate,
  hasReachedGrantDate,
  calcLeaveGrantDays,
  calcNextGrant,
  calcCelebrationRemaining,
  calcOncallLeaveExpiry,
  calcValidOncallLeave,
  calcLeaveBalance,
} = require('./lib/leave-calc');
const { toDateStr } = require('./lib/helpers');
const { LEAVE_GRANT_TABLE } = require('./lib/constants');

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

test('月末日の処理: 2024-01-31 + 1ヶ月 → 2024-02-29 (閏年末日クランプ)', () => {
  // 月末クランプ対応: 1/31 + 1 → 2/29 (2024年閏年の末日)
  const r = addMonthsToDate(new Date('2024-01-31'), 1);
  assert.strictEqual(toDateStr(r), '2024-02-29');
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

test('月末入社の付与日: 2024-08-31入社、6ヶ月後 → 2025-02-28 (末日クランプ)', () => {
  // 月末クランプ対応: 8/31 + 6 → 2/28 (2025年2月末日)
  // よって 2025-02-27 時点ではまだ0日
  assert.strictEqual(calcLeaveGrantDays('2024-08-31', '2025-02-27'), 0);
  // 2025-02-28 以降で10日
  assert.strictEqual(calcLeaveGrantDays('2024-08-31', '2025-02-28'), 10);
});

// ─── calcCelebrationRemaining ───
console.log('\n📌 calcCelebrationRemaining');

test('hire_dateなし → 0', () => {
  const staff = { celebration_days: 3, celebration_used_adj: 0 };
  assert.strictEqual(calcCelebrationRemaining(staff, '2026-01-01'), 0);
});

test('有効期間内（入社3ヶ月）→ celebration_days - adj', () => {
  const staff = { hire_date: '2025-10-01', celebration_days: 3, celebration_used_adj: 0 };
  assert.strictEqual(calcCelebrationRemaining(staff, '2026-01-01'), 3);
});

test('有効期間内 + 手動調整1 → 2', () => {
  const staff = { hire_date: '2025-10-01', celebration_days: 3, celebration_used_adj: 1 };
  assert.strictEqual(calcCelebrationRemaining(staff, '2026-01-01'), 2);
});

test('期限切れ（入社6ヶ月以上）→ 0', () => {
  const staff = { hire_date: '2025-04-01', celebration_days: 3, celebration_used_adj: 0 };
  assert.strictEqual(calcCelebrationRemaining(staff, '2025-10-01'), 0);
});

test('期限ちょうど（入社6ヶ月当日）→ 0', () => {
  const staff = { hire_date: '2025-04-01', celebration_days: 3, celebration_used_adj: 0 };
  assert.strictEqual(calcCelebrationRemaining(staff, '2025-10-01'), 0);
});

test('期限前日 → 3', () => {
  const staff = { hire_date: '2025-04-01', celebration_days: 3, celebration_used_adj: 0 };
  assert.strictEqual(calcCelebrationRemaining(staff, '2025-09-30'), 3);
});

test('celebration_days未定義 → デフォルト3', () => {
  const staff = { hire_date: '2025-10-01' };
  assert.strictEqual(calcCelebrationRemaining(staff, '2026-01-01'), 3);
});

test('celebration_expiry_months=12: 入職6ヶ月超過でも残日数が返る', () => {
  const staff = { hire_date: '2026-03-01', celebration_days: 10, celebration_expiry_months: 12 };
  assert.strictEqual(calcCelebrationRemaining(staff, '2026-09-02'), 10);
});

test('celebration_expiry_months=12: 入職12ヶ月超過 → 0', () => {
  const staff = { hire_date: '2026-03-01', celebration_days: 10, celebration_expiry_months: 12 };
  assert.strictEqual(calcCelebrationRemaining(staff, '2027-03-02'), 0);
});

test('celebration_expiry_months未設定: デフォルト6ヶ月で期限切れ → 0', () => {
  const staff = { hire_date: '2026-03-01', celebration_days: 10 };
  assert.strictEqual(calcCelebrationRemaining(staff, '2026-09-02'), 0);
});

// ─── お祝い休暇統合バリデーション ───
console.log('\n📌 お祝い休暇統合バリデーション');

test('celebration期間中（granted=0, celebration=3）→ 3日分申請可能', () => {
  const staff = { hire_date: '2025-10-01', leave_granted: 0, leave_carried_over: 0,
    leave_manual_adjustment: 0, oncall_leave_granted: 0, celebration_days: 3, celebration_used_adj: 0 };
  const balance = calcLeaveBalance(staff, []);
  const celebRemaining = calcCelebrationRemaining(staff, '2026-01-01');
  assert.strictEqual(balance + celebRemaining, 3);
});

test('celebration期間中 + OC有給2 → 5日分申請可能', () => {
  const staff = { hire_date: '2025-10-01', leave_granted: 0, leave_carried_over: 0,
    leave_manual_adjustment: 0, oncall_leave_granted: 2, celebration_days: 3, celebration_used_adj: 0 };
  const balance = calcLeaveBalance(staff, []);
  const celebRemaining = calcCelebrationRemaining(staff, '2026-01-01');
  assert.strictEqual(balance + celebRemaining, 5);
});

test('celebration期間中に3日使用済み → OC2日のみ利用可能', () => {
  const staff = { hire_date: '2025-10-01', leave_granted: 0, leave_carried_over: 0,
    leave_manual_adjustment: 0, oncall_leave_granted: 2, celebration_days: 3, celebration_used_adj: 0 };
  const requests = [
    { type: 'full', dates: ['2025-11-01', '2025-11-02', '2025-11-03'] },
  ];
  const balance = calcLeaveBalance(staff, requests);
  const celebRemaining = calcCelebrationRemaining(staff, '2026-01-01');
  assert.strictEqual(balance + celebRemaining, 2);
});

test('celebration期限切れ + 通常有給0 → 0（申請不可）', () => {
  const staff = { hire_date: '2025-04-01', leave_granted: 0, leave_carried_over: 0,
    leave_manual_adjustment: 0, oncall_leave_granted: 0, celebration_days: 3, celebration_used_adj: 0 };
  const balance = calcLeaveBalance(staff, []);
  const celebRemaining = calcCelebrationRemaining(staff, '2025-10-01');
  assert.strictEqual(balance + celebRemaining, 0);
});

test('celebration期限切れ + 通常有給10 → 10', () => {
  const staff = { hire_date: '2025-04-01', leave_granted: 10, leave_carried_over: 0,
    leave_manual_adjustment: 0, oncall_leave_granted: 0, celebration_days: 3, celebration_used_adj: 0 };
  const balance = calcLeaveBalance(staff, []);
  const celebRemaining = calcCelebrationRemaining(staff, '2025-10-01');
  assert.strictEqual(balance + celebRemaining, 10);
});

// ─── calcOncallLeaveExpiry ───
console.log('\n📌 calcOncallLeaveExpiry');

test('hire_dateなし → null', () => {
  assert.strictEqual(calcOncallLeaveExpiry(null, '2026-01-01'), null);
});

test('入職3ヶ月で付与 → 18ヶ月時点が期限（次の次: 6→18）', () => {
  // hire=2025-01-01, granted=2025-04-01 (3ヶ月)
  // 次の付与: 6ヶ月(2025-07-01), 次の次: 18ヶ月(2026-07-01)
  const expiry = calcOncallLeaveExpiry('2025-01-01', '2025-04-01');
  assert.strictEqual(toDateStr(expiry), '2026-07-01');
});

test('入職6ヶ月ちょうどで付与 → 30ヶ月時点が期限（次の次: 18→30）', () => {
  // hire=2025-01-01, granted=2025-07-01 (6ヶ月目、付与日当日)
  // 6ヶ月の付与日は grantedAt と同日なので future ではない
  // 次の付与: 18ヶ月, 次の次: 30ヶ月
  const expiry = calcOncallLeaveExpiry('2025-01-01', '2025-07-01');
  assert.strictEqual(toDateStr(expiry), '2027-07-01');
});

test('入職12ヶ月で付与 → 30ヶ月時点が期限（次の次: 18→30）', () => {
  const expiry = calcOncallLeaveExpiry('2025-01-01', '2026-01-01');
  assert.strictEqual(toDateStr(expiry), '2027-07-01');
});

test('入職54ヶ月で付与 → 78ヶ月時点が期限（次の次: 66→78）', () => {
  // hire=2025-01-01, granted=2029-07-01 (54ヶ月目)
  // 54ヶ月は付与日当日 → future ではない
  // 次: 66ヶ月(2030-07-01), 次の次: 78ヶ月(2031-07-01)
  const expiry = calcOncallLeaveExpiry('2025-01-01', '2029-07-01');
  assert.strictEqual(toDateStr(expiry), '2031-07-01');
});

test('入職70ヶ月で付与（66超）→ 90ヶ月時点が期限（12ヶ月周期: 78→90）', () => {
  // hire=2025-01-01, granted=2030-11-01 (70ヶ月)
  // 次: 78ヶ月(2031-07-01), 次の次: 90ヶ月(2032-07-01)
  const expiry = calcOncallLeaveExpiry('2025-01-01', '2030-11-01');
  assert.strictEqual(toDateStr(expiry), '2032-07-01');
});

test('入職0ヶ月（入職日に付与）→ 18ヶ月時点が期限（次の次: 6→18）', () => {
  const expiry = calcOncallLeaveExpiry('2025-01-01', '2025-01-01');
  assert.strictEqual(toDateStr(expiry), '2026-07-01');
});

// ─── calcValidOncallLeave ───
console.log('\n📌 calcValidOncallLeave');

test('history未設定 → oncall_leave_granted にフォールバック', () => {
  const staff = { oncall_leave_granted: 3 };
  assert.strictEqual(calcValidOncallLeave(staff), 3);
});

test('history空配列 → oncall_leave_granted にフォールバック', () => {
  const staff = { oncall_leave_granted: 2, oncall_leave_history: [] };
  assert.strictEqual(calcValidOncallLeave(staff), 2);
});

test('全エントリ期限内 → 全日数合計', () => {
  const staff = { oncall_leave_granted: 3, oncall_leave_history: [
    { grantedAt: '2025-01-01', days: 1, expiresAt: '2027-01-01' },
    { grantedAt: '2025-06-01', days: 2, expiresAt: '2028-01-01' },
  ]};
  assert.strictEqual(calcValidOncallLeave(staff, '2026-06-01'), 3);
});

test('全エントリ期限切れ → 0', () => {
  const staff = { oncall_leave_granted: 2, oncall_leave_history: [
    { grantedAt: '2025-01-01', days: 1, expiresAt: '2026-01-01' },
    { grantedAt: '2025-06-01', days: 1, expiresAt: '2026-06-01' },
  ]};
  assert.strictEqual(calcValidOncallLeave(staff, '2026-06-01'), 0);
});

test('混在: 期限内1 + 期限切れ1 → 期限内のみ', () => {
  const staff = { oncall_leave_granted: 3, oncall_leave_history: [
    { grantedAt: '2025-01-01', days: 1, expiresAt: '2026-01-01' },
    { grantedAt: '2025-06-01', days: 2, expiresAt: '2028-01-01' },
  ]};
  assert.strictEqual(calcValidOncallLeave(staff, '2026-06-01'), 2);
});

test('expiresAt が null → 期限なし扱い（有効）', () => {
  const staff = { oncall_leave_granted: 1, oncall_leave_history: [
    { grantedAt: '2025-01-01', days: 1, expiresAt: null },
  ]};
  assert.strictEqual(calcValidOncallLeave(staff, '2030-01-01'), 1);
});

test('calcLeaveBalance が期限切れOC有給を除外すること', () => {
  const staff = { leave_granted: 10, leave_carried_over: 0,
    leave_manual_adjustment: 0, oncall_leave_granted: 3,
    oncall_leave_history: [
      { grantedAt: '2024-01-01', days: 1, expiresAt: '2025-01-01' },
      { grantedAt: '2025-06-01', days: 2, expiresAt: '2030-01-01' },
    ]};
  // 期限切れ1日を除外 → validOC=2, balance=10+2=12
  assert.strictEqual(calcLeaveBalance(staff, []), 12);
});

// ── 結果サマリー ────────────────────────────────────────────────
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`結果: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('✨ All tests passed!\n');
}
