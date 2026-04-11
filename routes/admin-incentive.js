'use strict';
const express = require('express');
const router = express.Router();

const { loadStaff, saveStaff, atomicModify } = require('../lib/data');
const { requireAdmin } = require('../lib/auth-middleware');
const { asyncRoute, validateNum } = require('../lib/helpers');
const { auditLog } = require('../lib/audit');

router.get('/api/admin/incentive', requireAdmin, (_req, res) => {
  const data = loadStaff();
  const defs = data.incentive_defaults || { nurse: 3.5, rehab: 20.0 };
  res.json({
    defaults: {
      nurse: defs.nurse ?? 3.5, rehab: defs.rehab ?? 20.0,
      nurse_rate: defs.nurse_rate ?? 4000, rehab_rate: defs.rehab_rate ?? 500,
    },
    staff: data.staff.filter(s => !s.archived && s.type !== 'office').map(s => ({
      id: s.id, name: s.name, type: s.type,
      furigana_family: s.furigana_family, furigana_given: s.furigana_given,
      incentive_line: s.incentive_line ?? null,
      work_hours: s.work_hours ?? null,
      incentive_rate: s.incentive_rate ?? null,
    })),
  });
});

router.post('/api/admin/incentive/defaults', requireAdmin, asyncRoute((req, res) => {
  const { nurse, rehab, nurse_rate, rehab_rate } = req.body;
  const nv = validateNum(nurse, { min: 0, max: 100 });
  const rv = validateNum(rehab, { min: 0, max: 100 });
  if (!nv.valid || !rv.valid) return res.status(400).json({ error: 'インセンティブラインは0〜100の数値で入力してください' });
  const nrv = validateNum(nurse_rate, { min: 0, max: 100000 });
  const rrv = validateNum(rehab_rate, { min: 0, max: 100000 });
  if (!nrv.valid || !rrv.valid) return res.status(400).json({ error: '単価は0以上の数値で入力してください' });
  atomicModify(() => {
    const data = loadStaff();
    const prev = data.incentive_defaults || {};
    data.incentive_defaults = { nurse: nv.value, rehab: rv.value, nurse_rate: nrv.value, rehab_rate: rrv.value };
    saveStaff(data);
  });
  auditLog(req, 'incentive.defaults_update', { type: 'incentive' }, { nurse: nv.value, rehab: rv.value, nurse_rate: nrv.value, rehab_rate: rrv.value });
  res.json({ success: true });
}));

router.post('/api/admin/staff/:id/incentive', requireAdmin, asyncRoute((req, res) => {
  const { line } = req.body;
  const lv = validateNum(line, { min: 0, max: 100, allowNull: true });
  if (!lv.valid) return res.status(400).json({ error: 'インセンティブラインは0〜100の数値で入力してください' });
  const result = atomicModify(() => {
    const data  = loadStaff();
    const staff = data.staff.find(s => s.id === req.params.id);
    if (!staff) return { error: 'スタッフが見つかりません', status: 404 };
    staff.incentive_line = lv.value;
    saveStaff(data);
    return { staffId: staff.id, staffName: staff.name, line: staff.incentive_line };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  auditLog(req, 'incentive.staff_update', { type: 'incentive', id: result.staffId, label: result.staffName }, { line: result.line });
  res.json({ success: true });
}));

router.post('/api/admin/staff/:id/work-hours', requireAdmin, asyncRoute((req, res) => {
  const { work_hours } = req.body;
  const wv = validateNum(work_hours, { min: 0, max: 24, allowNull: true, allowEmpty: true });
  if (!wv.valid) return res.status(400).json({ error: '勤務時間は0〜24の数値で入力してください' });
  const result = atomicModify(() => {
    const data  = loadStaff();
    const staff = data.staff.find(s => s.id === req.params.id);
    if (!staff) return { error: 'スタッフが見つかりません', status: 404 };
    staff.work_hours = wv.value;
    saveStaff(data);
    return { staffId: staff.id, staffName: staff.name, work_hours: staff.work_hours };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  auditLog(req, 'staff.work_hours_update', { type: 'staff', id: result.staffId, label: result.staffName }, { work_hours: result.work_hours });
  res.json({ success: true });
}));

router.post('/api/admin/staff/:id/incentive-rate', requireAdmin, asyncRoute((req, res) => {
  const { rate } = req.body;
  const rv = validateNum(rate, { min: 0, max: 100000, allowNull: true, allowEmpty: true });
  if (!rv.valid) return res.status(400).json({ error: '単価は0以上の数値で入力してください' });
  const result = atomicModify(() => {
    const data  = loadStaff();
    const staff = data.staff.find(s => s.id === req.params.id);
    if (!staff) return { error: 'スタッフが見つかりません', status: 404 };
    staff.incentive_rate = rv.value;
    saveStaff(data);
    return { staffId: staff.id, staffName: staff.name, rate: staff.incentive_rate };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  auditLog(req, 'incentive.rate_update', { type: 'incentive', id: result.staffId, label: result.staffName }, { rate: result.rate });
  res.json({ success: true });
}));

module.exports = router;
