'use strict';
// お祝い休暇の「二重付与」修正ツール（付け替え）
// 背景: 一部スタッフで お祝い休暇分が「有給付与日数」に二重に入っており、かつ実際に取得した
//       お祝い休暇が「通常有給」として記録されている。付与を正しい自動計算値に戻すと、通常有給の
//       使用分だけ残高がマイナスになる。
// 対応: 取得済みの通常有給（お祝い期間内）を お祝い休暇へ付け替え（celebration_days 部分消費として記録）、
//       有給付与を自動計算値に、お祝い付与を標準値(3)に揃える。
// 安全性: プレビュー（GET）で修正前後を提示し、適用（POST）はスタッフ単位で明示確認。冪等。

const express = require('express');
const router = express.Router();

const { loadStaff, saveStaff, loadLeave, saveLeave, atomicModify } = require('../lib/data');
const { requireAdmin } = require('../lib/auth-middleware');
const { asyncRoute, getTodayJST } = require('../lib/helpers');
const { auditLog } = require('../lib/audit');
const { calcLeaveGrantDays, calcLeaveBalance, addMonthsToDate } = require('../lib/leave-calc');

const DEFAULT_CELEBRATION_DAYS = 3;
const round1 = (n) => Math.round(n * 10) / 10;
const perDay = (type) => (type === 'half_am' || type === 'half_pm') ? 0.5 : 1;
// 申請の総日数（半休は0.5、type基準）
const fullDays = (r) => (r.dates || []).length * perDay(r.type);

// スタッフ1名分の付け替えプランを計算する（GET/POSTで共通利用＝プレビューと適用が一致）。
// mutate=true のとき requests / staff を実際に書き換える（呼び出し側でatomicModify内から使用）。
function computeReconcilePlan(staff, requests, todayStr, mutate) {
  const approved = requests.filter(r => r.staffId === staff.id && r.status === 'approved');
  const regularReqs = approved
    .filter(r => r.type !== 'celebration')
    .sort((a, b) => String((a.dates || [])[0] || '').localeCompare(String((b.dates || [])[0] || '')));

  // 現在の「通常有給」使用日数（既存のお祝い部分消費は除く）
  let appRegularUsed = 0;
  for (const r of regularReqs) appRegularUsed += fullDays(r) - (r.celebration_days || 0);
  appRegularUsed = round1(appRegularUsed);

  // 既存のお祝い使用（celebrationタイプ申請 + 手動調整）
  let existingCelebUsage = staff.celebration_used_adj || 0;
  for (const r of approved) {
    if (r.type === 'celebration') {
      const ot = r.originalType || r.type;
      existingCelebUsage += (r.dates || []).length * perDay(ot);
    }
  }
  existingCelebUsage = round1(existingCelebUsage);

  const autoGrant = calcLeaveGrantDays(staff.hire_date, todayStr);
  const leaveGranted = staff.leave_granted || 0;
  const celebrationDays = staff.celebration_days ?? DEFAULT_CELEBRATION_DAYS;

  // お祝い休暇の有効期間内か
  const expiryMonths = staff.celebration_expiry_months || 6;
  const celebrationActive = staff.hire_date
    ? (new Date(todayStr) < addMonthsToDate(new Date(staff.hire_date), expiryMonths))
    : false;

  const balanceBefore = calcLeaveBalance(staff, approved);

  // 付け替え対象: お祝い期間内で、通常有給の使用があり、かつ
  //   ・付与が自動計算より多い（二重で膨らんでいる） か
  //   ・すでに付与を下げた結果、残高がマイナス
  const eligible = celebrationActive && appRegularUsed > 0
    && (leaveGranted > autoGrant || balanceBefore < 0);

  // 付け替える日数（お祝い標準枠=3 を上限）
  const reclassify = Math.min(appRegularUsed, DEFAULT_CELEBRATION_DAYS);
  const proposedGranted = autoGrant;
  const proposedCelebrationDays = Math.max(DEFAULT_CELEBRATION_DAYS, round1(existingCelebUsage + reclassify));
  const afterRegularUsed = round1(appRegularUsed - reclassify);

  // 修正後の残高（通常有給）を予測
  const carried = staff.leave_carried_over || 0;
  const manualAdj = staff.leave_manual_adjustment || 0;
  const oncall = staff.oncall_leave_granted || 0;
  const balanceAfter = round1(proposedGranted + carried + manualAdj + oncall - afterRegularUsed);

  const warnings = [];
  if (appRegularUsed > DEFAULT_CELEBRATION_DAYS)
    warnings.push(`通常有給の使用(${appRegularUsed}日)がお祝い標準枠(${DEFAULT_CELEBRATION_DAYS}日)を超えています。超過分は通常有給のまま残ります。`);
  if (balanceAfter < 0)
    warnings.push('修正後も有給残がマイナスになります。個別に確認してください。');

  const plan = {
    id: staff.id, name: staff.name, type: staff.type, hire_date: staff.hire_date || null,
    celebration_active: celebrationActive,
    eligible,
    before: { granted: leaveGranted, celebration_days: celebrationDays, regular_used: appRegularUsed, balance: balanceBefore },
    after: { granted: proposedGranted, celebration_days: proposedCelebrationDays, regular_used: afterRegularUsed, balance: balanceAfter },
    reclassify_days: reclassify,
    auto_grant: autoGrant,
    warnings,
  };

  if (!mutate || !eligible) return plan;

  // ── ここから実書き換え ──
  let budget = reclassify;
  const touched = [];
  for (const r of regularReqs) {
    if (budget <= 0.0001) break;
    const curPortion = r.celebration_days || 0;
    const regPart = round1(fullDays(r) - curPortion);
    if (regPart <= 0) continue;
    const take = Math.min(regPart, budget);
    r.celebration_days = round1(curPortion + take);
    budget = round1(budget - take);
    touched.push({ id: r.id, dates: r.dates, portion: r.celebration_days });
  }
  staff.leave_granted = proposedGranted;
  staff.celebration_days = proposedCelebrationDays;
  plan.touched_requests = touched;
  return plan;
}

// プレビュー（読み取り専用）
router.get('/api/admin/leave-reconcile', requireAdmin, asyncRoute((_req, res) => {
  const staffData = loadStaff();
  const leaveData = loadLeave();
  const todayStr = getTodayJST();

  const all = staffData.staff
    .filter(s => !s.archived && s.type !== 'office' && s.type !== 'admin')
    .map(s => computeReconcilePlan(s, leaveData.requests, todayStr, false));

  const rows = all.filter(p => p.eligible);
  res.json({
    generatedFor: 'celebration leave reconcile',
    summary: { staffCount: all.length, eligible: rows.length },
    rows,
  });
}));

// 適用（スタッフ単位で明示。サーバ側で再計算し、それに基づいて書き換える）
router.post('/api/admin/leave-reconcile/apply', requireAdmin, asyncRoute((req, res) => {
  const staffId = req.body && req.body.staffId;
  if (!staffId || typeof staffId !== 'string')
    return res.status(400).json({ error: 'staffId を指定してください' });

  const todayStr = getTodayJST();
  const result = atomicModify(() => {
    const staffData = loadStaff();
    const leaveData = loadLeave();
    const staff = staffData.staff.find(s => s.id === staffId);
    if (!staff) return { error: '対象スタッフが見つかりません' };

    const plan = computeReconcilePlan(staff, leaveData.requests, todayStr, true);
    if (!plan.eligible) return { error: 'このスタッフは付け替えの対象ではありません（既に修正済みか条件に該当しません）' };
    if (plan.after.balance < 0)
      return { error: `修正後の有給残がマイナス（${plan.after.balance}日）になるため中止しました。個別に確認してください。` };

    saveLeave(leaveData);
    saveStaff(staffData);
    return { plan };
  });

  if (result.error) return res.status(400).json({ error: result.error });
  auditLog(req, 'leave.reconcile_celebration', { type: 'leave', id: staffId }, {
    name: result.plan.name,
    before: result.plan.before, after: result.plan.after,
    reclassify_days: result.plan.reclassify_days,
    touched_requests: result.plan.touched_requests,
  });
  res.json({ success: true, plan: result.plan });
}));

module.exports = router;
