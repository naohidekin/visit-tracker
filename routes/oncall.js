'use strict';
// オンコール管理ルート（スタッフ向け・管理者向け）

const express = require('express');
const router = express.Router();

const { loadStaff, saveStaff, loadOncall, saveOncall, atomicModify } = require('../lib/data');
const { requireStaff, requireAdmin } = require('../lib/auth-middleware');
const { asyncRoute, validateNum, getNowJST } = require('../lib/helpers');
const { auditLog } = require('../lib/audit');

// オンコール累計時間から有給付与日数を再計算し、staffデータを更新
function updateOncallLeave(staffId) {
  atomicModify(() => {
    const data = loadOncall();
    const allRecords = data.records.filter(r => r.staffId === staffId);
    const totalMinutes = allRecords.reduce((s, r) => s + (r.totalMinutes || 0), 0);
    const days = Math.floor(totalMinutes / 900); // 900分 = 15時間
    const staffData = loadStaff();
    const staff = staffData.staff.find(s => s.id === staffId);
    if (staff && staff.oncall_leave_granted !== days) {
      staff.oncall_leave_granted = days;
      saveStaff(staffData);
    }
  });
}

// ─── API: オンコール（スタッフ向け） ─────────────────────────────
router.get('/api/oncall/records', requireStaff, (req, res) => {
  const month = req.query.month;
  const data = loadOncall();
  let records = data.records.filter(r => r.staffId === req.session.staffId);
  if (month) records = records.filter(r => r.date.startsWith(month));
  records.sort((a, b) => a.date.localeCompare(b.date));
  res.json({ records });
});

router.post('/api/oncall/records', requireStaff, asyncRoute(async (req, res) => {
  const { date, count, totalHours, totalMinutes, transportCount } = req.body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: '日付が不正です' });
  const cv = validateNum(count, { min: 0, max: 100 });
  const tcv = validateNum(transportCount, { min: 0, max: 100 });
  if (!cv.valid || !tcv.valid)
    return res.status(400).json({ error: '回数は0〜100の数値で入力してください' });
  const c = cv.value || 0;
  const tc = tcv.value || 0;
  let tm;
  if (totalHours != null) {
    const thv = validateNum(totalHours, { min: 0, max: 1440 });
    if (!thv.valid) return res.status(400).json({ error: '時間の値が不正です' });
    tm = Math.round(thv.value * 60);
  } else {
    const tmv = validateNum(totalMinutes, { min: 0, max: 86400 });
    if (!tmv.valid) return res.status(400).json({ error: '分数の値が不正です' });
    tm = tmv.value || 0;
  }

  atomicModify(() => {
    const data = loadOncall();
    const existing = data.records.find(r => r.staffId === req.session.staffId && r.date === date);
    const now = getNowJST().toISOString();

    if (existing) {
      existing.count = c;
      existing.totalMinutes = tm;
      existing.transportCount = tc;
      existing.updatedAt = now;
    } else {
      data.records.push({
        id: `${req.session.staffId}-${date}-${Date.now()}`,
        staffId: req.session.staffId,
        date,
        count: c,
        totalMinutes: tm,
        transportCount: tc,
        createdAt: now,
        updatedAt: now,
      });
    }
    saveOncall(data);
  });

  updateOncallLeave(req.session.staffId);

  auditLog(req, 'oncall.upsert', { type: 'oncall', id: req.session.staffId, label: `${req.session.staffName} ${date}` }, { date, count: c, totalMinutes: tm, transportCount: tc });
  res.json({ ok: true });
}));

router.delete('/api/oncall/records/:id', requireStaff, asyncRoute(async (req, res) => {
  const removed = atomicModify(() => {
    const data = loadOncall();
    const idx = data.records.findIndex(r => r.id === req.params.id);
    if (idx === -1) return null;
    if (data.records[idx].staffId !== req.session.staffId) return 'forbidden';
    const r = data.records[idx];
    data.records.splice(idx, 1);
    saveOncall(data);
    return r;
  });
  if (!removed) return res.status(404).json({ error: 'レコードが見つかりません' });
  if (removed === 'forbidden') return res.status(403).json({ error: '自分のレコードのみ削除できます' });

  updateOncallLeave(req.session.staffId);
  auditLog(req, 'oncall.delete', { type: 'oncall', id: req.session.staffId, label: `${req.session.staffName} ${removed.date}` });
  res.json({ ok: true });
}));

router.get('/api/oncall/monthly-summary', requireStaff, (req, res) => {
  const month = req.query.month;
  if (!month) return res.status(400).json({ error: 'month パラメータが必要です' });
  const data = loadOncall();
  const myRecords = data.records.filter(r => r.staffId === req.session.staffId);
  const monthRecords = myRecords.filter(r => r.date.startsWith(month));

  const summary = {
    totalCount: monthRecords.reduce((s, r) => s + (r.count || 0), 0),
    totalMinutes: monthRecords.reduce((s, r) => s + (r.totalMinutes || 0), 0),
    totalTransportCount: monthRecords.reduce((s, r) => s + (r.transportCount || 0), 0),
    recordDays: monthRecords.length,
  };

  const allTimeTotalMinutes = myRecords.reduce((s, r) => s + (r.totalMinutes || 0), 0);
  const oncallLeaveDays = Math.floor(allTimeTotalMinutes / 900);
  const nextThresholdMinutes = (oncallLeaveDays + 1) * 900;

  res.json({
    summary,
    allTimeTotalMinutes,
    oncallLeaveDays,
    nextThresholdMinutes,
  });
});

// ─── API: オンコール（管理者向け） ───────────────────────────────
router.get('/api/admin/oncall/summary', requireAdmin, (req, res) => {
  const month = req.query.month;
  if (!month) return res.status(400).json({ error: 'month パラメータが必要です' });
  const staffData = loadStaff();
  const oncallData = loadOncall();
  const summary = staffData.staff
    .filter(s => !s.archived && s.oncall_eligible)
    .map(s => {
      const records = oncallData.records.filter(r => r.staffId === s.id && r.date.startsWith(month));
      return {
        staffId: s.id,
        name: s.name,
        type: s.type,
        totalCount: records.reduce((sum, r) => sum + (r.count || 0), 0),
        totalMinutes: records.reduce((sum, r) => sum + (r.totalMinutes || 0), 0),
        totalTransportCount: records.reduce((sum, r) => sum + (r.transportCount || 0), 0),
        recordDays: records.length,
      };
    });
  res.json({ summary });
});

router.get('/api/admin/oncall/records', requireAdmin, (req, res) => {
  const month = req.query.month;
  const staffId = req.query.staffId;
  const data = loadOncall();
  let records = data.records;
  if (month) records = records.filter(r => r.date.startsWith(month));
  if (staffId) records = records.filter(r => r.staffId === staffId);
  records.sort((a, b) => a.date.localeCompare(b.date));
  res.json({ records });
});

router.post('/api/admin/staff/:id/oncall-eligible', requireAdmin, asyncRoute((req, res) => {
  atomicModify(() => {
    const staffData = loadStaff();
    const staff = staffData.staff.find(s => s.id === req.params.id);
    if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });
    staff.oncall_eligible = !!req.body.oncall_eligible;
    saveStaff(staffData);
    auditLog(req, 'oncall.eligible_update', { type: 'staff', id: staff.id, label: staff.name }, { oncall_eligible: staff.oncall_eligible });
    res.json({ ok: true, oncall_eligible: staff.oncall_eligible });
  });
}));

module.exports = router;
