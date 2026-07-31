'use strict';
// 有給・お祝い休暇の整合性チェック（読み取り専用の調査ツール）
// 「付与日数（有給）にお祝い休暇分が二重に入っていないか」「アプリ申請で実際に使われた分」を一覧化する。
// データは一切変更しない。

const express = require('express');
const router = express.Router();

const { loadStaff, loadLeave } = require('../lib/data');
const { requireAdmin } = require('../lib/auth-middleware');
const { asyncRoute } = require('../lib/helpers');
const { calcLeaveGrantDays, calcLeaveBalance, calcCelebrationRemaining } = require('../lib/leave-calc');

const round1 = (n) => Math.round(n * 10) / 10;

router.get('/api/admin/leave-audit', requireAdmin, asyncRoute((_req, res) => {
  const staffData = loadStaff();
  const leaveData = loadLeave();

  const rows = staffData.staff
    .filter(s => !s.archived && s.type !== 'office' && s.type !== 'admin')
    .map(s => {
      const approved = leaveData.requests.filter(r => r.staffId === s.id && r.status === 'approved');

      // アプリ申請で実際に使われた分（承認済み）を「通常有給」「お祝い休暇」に分けて集計
      let appRegularUsed = 0, appCelebUsed = 0;
      const usedList = [];
      for (const r of approved) {
        const ot = r.originalType || r.type;
        const per = (ot === 'half_am' || ot === 'half_pm') ? 0.5 : 1;
        const total = (r.dates || []).length * per;
        let reg = 0, celeb = 0;
        if (r.type === 'celebration') {
          celeb = total;
        } else {
          const portion = r.celebration_days || 0;
          reg = total - portion;
          celeb = portion;
        }
        appRegularUsed += reg;
        appCelebUsed += celeb;
        usedList.push({
          dates: r.dates || [], type: r.type, originalType: r.originalType || null,
          days: total, regular: round1(reg), celebration: round1(celeb),
        });
      }
      appRegularUsed = round1(appRegularUsed);
      appCelebUsed = round1(appCelebUsed);

      const autoGrant = calcLeaveGrantDays(s.hire_date);
      const leaveGranted = s.leave_granted || 0;
      const celebrationDays = s.celebration_days ?? 3;
      const celebUsedAdj = s.celebration_used_adj || 0;

      // 二重の疑い: 付与日数（有給）が お祝い休暇日数 と一致し、かつ 自動計算より多い
      const doubleSuspect = celebrationDays > 0 && leaveGranted === celebrationDays && leaveGranted > autoGrant;
      // 付与を自動計算に戻すと残がマイナスになる場合の警告（アプリで通常有給を消化済み）
      const wouldGoNegativeIfAuto = autoGrant < appRegularUsed;

      return {
        id: s.id, name: s.name, type: s.type, hire_date: s.hire_date || null,
        auto_grant: autoGrant,
        leave_granted: leaveGranted,
        celebration_days: celebrationDays,
        celebration_used_adj: celebUsedAdj,
        app_regular_used: appRegularUsed,
        app_celebration_used: appCelebUsed,
        celebration_remaining: calcCelebrationRemaining(s),
        balance: calcLeaveBalance(s, approved),
        double_suspect: doubleSuspect,
        suggested_granted: doubleSuspect ? Math.max(autoGrant, appRegularUsed) : leaveGranted,
        would_go_negative_if_auto: doubleSuspect && wouldGoNegativeIfAuto,
        used_list: usedList,
      };
    });

  res.json({
    generatedFor: 'leave/celebration audit',
    summary: {
      staffCount: rows.length,
      doubleSuspects: rows.filter(r => r.double_suspect).length,
    },
    rows,
  });
}));

module.exports = router;
