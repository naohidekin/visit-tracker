'use strict';
const express = require('express');
const router = express.Router();

const { loadStaff, getSpreadsheetIdForYear, loadSchedules, saveSchedules, atomicModify } = require('../lib/data');
const { requireAdmin } = require('../lib/auth-middleware');
const { validateUnitValue } = require('../lib/helpers');
const { auditLog } = require('../lib/audit');
const { updateValues, batchUpdateValues } = require('../lib/sheets');
const { DATA_START_ROW } = require('../lib/constants');

// 記録が直接入力された日について、残っている「未確定の予定」を削除する。
// （routes/record.js と同じ整合性維持。古い予定の確定による実績上書きを防ぐ）
function clearPendingScheduleFor(staffId, date) {
  atomicModify(() => {
    const data = loadSchedules();
    const before = data.schedules.length;
    data.schedules = data.schedules.filter(s => !(s.staffId === staffId && s.date === date));
    if (data.schedules.length !== before) saveSchedules(data);
  });
}

router.post('/api/admin/record', requireAdmin, async (req, res) => {
  const { staffId, date } = req.body;
  if (!staffId || !date) return res.status(400).json({ error: 'パラメータ不足' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '日付形式が不正です' });

  const d     = new Date(date);
  const year  = d.getFullYear();
  const month = d.getMonth() + 1;
  const row   = DATA_START_ROW + d.getDate() - 1;
  const sid   = getSpreadsheetIdForYear(year);

  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });
  if (staff.type === 'nurse' ? (!staff.kaigo_col || !staff.iryo_col) : !staff.col) {
    return res.status(400).json({ error: 'このスタッフの列設定が未完了です' });
  }

  try {
    if (staff.type === 'nurse') {
      const { kaigo, iryo } = req.body;
      const kv = validateUnitValue(kaigo);
      const iv = validateUnitValue(iryo);
      if (!kv.valid || !iv.valid) return res.status(400).json({ error: '単位数は0〜9999の数値で入力してください' });
      await batchUpdateValues(sid, [
        { range: `${month}月!${staff.kaigo_col}${row}`, values: [[kv.value]] },
        { range: `${month}月!${staff.iryo_col}${row}`, values: [[iv.value]] },
      ]);
    } else {
      const { value } = req.body;
      const vv = validateUnitValue(value);
      if (!vv.valid) return res.status(400).json({ error: '単位数は0〜9999の数値で入力してください' });
      await updateValues(sid, `${month}月!${staff.col}${row}`, [[vv.value]]);
    }
    clearPendingScheduleFor(staffId, date);
    auditLog(req, 'record.admin_edit', { type: 'visit_record', id: staffId, label: `${staff.name} ${date}` }, { date, ...req.body });
    res.json({ success: true });
  } catch (e) {
    console.error('❌ admin record POST error:', e.message);
    res.status(500).json({ error: '記録の保存に失敗しました' });
  }
});

module.exports = router;
