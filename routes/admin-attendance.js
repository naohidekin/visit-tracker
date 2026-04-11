'use strict';

const express = require('express');
const router = express.Router();

const { loadStaff, loadLeave, loadAttendance, loadStandby } = require('../lib/data');
const { requireAdmin } = require('../lib/auth-middleware');
const { isWorkday, formatLocalDate } = require('../lib/helpers');

// ─── 出勤確定 集計 API（月次 / 締め期間 切替対応）──────────────────
// mode=billing: 前月16日〜当月15日  mode=monthly(デフォルト): 1日〜末日
router.get('/api/admin/attendance/monthly', requireAdmin, async (req, res) => {
  const { month, mode } = req.query;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: '月の形式が不正です (YYYY-MM)' });

  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  const m = Number(monthStr);
  const isBilling = mode === 'billing';

  // 集計対象の日付範囲を決定
  let startDate, endDate, billingLabel;
  if (isBilling) {
    let prevY = year, prevM = m - 1;
    if (prevM < 1) { prevY--; prevM = 12; }
    startDate = `${prevY}-${String(prevM).padStart(2, '0')}-16`;
    endDate   = `${year}-${String(m).padStart(2, '0')}-15`;
    billingLabel = `${prevM}/16〜${m}/15`;
  } else {
    const daysInMonth = new Date(year, m, 0).getDate();
    startDate = `${yearStr}-${monthStr}-01`;
    endDate   = `${yearStr}-${monthStr}-${String(daysInMonth).padStart(2, '0')}`;
  }

  const staffData = loadStaff();
  const activeStaff = staffData.staff.filter(s => !s.archived && s.type !== 'admin');
  const attendanceData = loadAttendance();
  const leaveData = loadLeave();

  // 雨の日データ（日付範囲でフィルタ）
  const standbyData = loadStandby();
  const rainyDaysSet = new Set((standbyData.rainyDays || []).filter(d => d >= startDate && d <= endDate));

  // スタッフ別集計初期化
  const summary = {};
  for (const s of activeStaff) {
    summary[s.id] = {
      staffId: s.id, name: s.name, type: s.type,
      workDays: 0, confirmedDays: 0, absentDays: 0, leaveDays: 0,
      unconfirmedDays: 0, rainyDayAttendance: 0,
    };
  }

  // 日付範囲をイテレート
  const cur = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  while (cur <= end) {
    const dd = cur.getFullYear();
    const mm = String(cur.getMonth() + 1).padStart(2, '0');
    const day = String(cur.getDate()).padStart(2, '0');
    const dateStr = `${dd}-${mm}-${day}`;
    cur.setDate(cur.getDate() + 1);

    if (!isWorkday(dateStr)) continue;

    const dayRecords = attendanceData.records[dateStr] || {};
    const isRainy = rainyDaysSet.has(dateStr);

    for (const s of activeStaff) {
      summary[s.id].workDays++;

      const manual = dayRecords[s.id];
      const onLeave = leaveData.requests.some(r =>
        r.staffId === s.id && r.status === 'approved' && r.dates.includes(dateStr)
      );

      let status;
      if (manual) {
        status = manual.status;
      } else if (onLeave) {
        status = 'leave';
      } else {
        status = 'unconfirmed';
      }

      if (status === 'confirmed') {
        summary[s.id].confirmedDays++;
        if (isRainy) summary[s.id].rainyDayAttendance++;
      } else if (status === 'absent') {
        summary[s.id].absentDays++;
      } else if (status === 'leave') {
        summary[s.id].leaveDays++;
      } else {
        summary[s.id].unconfirmedDays++;
      }
    }
  }

  const result = {
    month,
    mode: isBilling ? 'billing' : 'monthly',
    rainyDays: Array.from(rainyDaysSet).sort(),
    rainyDayCount: rainyDaysSet.size,
    staff: Object.values(summary),
  };
  if (isBilling) {
    result.billingStart = startDate;
    result.billingEnd = endDate;
    result.billingLabel = billingLabel;
  }
  res.json(result);
});

module.exports = router;
