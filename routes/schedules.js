'use strict';
// 予定管理ルート

const express = require('express');
const router = express.Router();

const { loadStaff, loadSchedules, saveSchedules, getSpreadsheetIdForYear } = require('../lib/data');
const { requireStaff, requireAdmin } = require('../lib/auth-middleware');
const { lockedRoute } = require('../lib/helpers');
const { auditLog } = require('../lib/audit');
const { getSheets, sheetsRetry } = require('../lib/sheets');
const { SCHEDULES_PATH, DATA_START_ROW } = require('../lib/constants');

// ヘルパー: JST今日の日付
function getTodayJST() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

// ─── API: 予定管理 ──────────────────────────────────────────────
router.get('/api/schedules', requireStaff, (req, res) => {
  const data = loadSchedules();
  res.json(data.schedules.filter(s => s.staffId === req.session.staffId));
});

router.post('/api/schedules', requireStaff, lockedRoute(SCHEDULES_PATH, (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'パラメータが不足しています' });
  if (date <= getTodayJST()) return res.status(400).json({ error: '予定登録は翌日以降の日付のみ可能です' });

  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === req.session.staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  const data = loadSchedules();
  // 同一スタッフ・同一日付の予定は上書き
  data.schedules = data.schedules.filter(s => !(s.staffId === req.session.staffId && s.date === date));

  const id = `${req.session.staffId}-${date}-${Date.now()}`;
  const entry = {
    id,
    staffId: req.session.staffId,
    staffName: req.session.staffName,
    jobType: staff.type,
    date,
    kaigo: null, iryo: null, units: null,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  if (staff.type === 'nurse') {
    const { kaigo, iryo } = req.body;
    entry.kaigo = (kaigo !== '' && kaigo !== null && kaigo !== undefined) ? Number(kaigo) : null;
    entry.iryo  = (iryo  !== '' && iryo  !== null && iryo  !== undefined) ? Number(iryo)  : null;
  } else {
    const { value } = req.body;
    entry.units = (value !== '' && value !== null && value !== undefined) ? Number(value) : null;
  }

  data.schedules.push(entry);
  saveSchedules(data);
  auditLog(req, 'schedule.create', { type: 'schedule', id: entry.id, label: `${req.session.staffName} ${date}` });
  res.json({ success: true, schedule: entry });
}));

router.post('/api/schedules/:id/confirm', requireStaff, lockedRoute(SCHEDULES_PATH, async (req, res) => {
  const data = loadSchedules();
  const idx = data.schedules.findIndex(s => s.id === req.params.id && s.staffId === req.session.staffId);
  if (idx === -1) return res.status(404).json({ error: '予定が見つかりません' });
  const schedule = data.schedules[idx];

  if (schedule.date > getTodayJST()) return res.status(400).json({ error: 'まだ確定できません（翌日以降の予定です）' });

  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === schedule.staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  const d     = new Date(schedule.date + 'T00:00:00');
  const year  = d.getFullYear();
  const month = d.getMonth() + 1;
  const row   = DATA_START_ROW + d.getDate() - 1;
  const sid   = getSpreadsheetIdForYear(year);

  try {
    const api = await getSheets();
    if (staff.type === 'nurse') {
      const kVal = schedule.kaigo != null ? schedule.kaigo : '';
      const iVal = schedule.iryo  != null ? schedule.iryo  : '';
      await sheetsRetry(() => api.spreadsheets.values.batchUpdate({
        spreadsheetId: sid,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${month}月!${staff.kaigo_col}${row}`, values: [[kVal]] },
            { range: `${month}月!${staff.iryo_col}${row}`,  values: [[iVal]] },
          ],
        },
      }));
    } else {
      const val = schedule.units != null ? schedule.units : '';
      await sheetsRetry(() => api.spreadsheets.values.update({
        spreadsheetId: sid,
        range: `${month}月!${staff.col}${row}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[val]] },
      }));
    }
    data.schedules.splice(idx, 1);
    saveSchedules(data);
    auditLog(req, 'record.confirm_schedule', { type: 'schedule', id: req.params.id, label: `${schedule.staffName || req.session.staffName} ${schedule.date}` });
    res.json({ success: true });
  } catch (e) {
    console.error('❌ schedule confirm error:', e.message);
    res.status(500).json({ error: '予定の確定に失敗しました' });
  }
}));

router.delete('/api/schedules/:id', requireStaff, lockedRoute(SCHEDULES_PATH, (req, res) => {
  const data = loadSchedules();
  const idx = data.schedules.findIndex(s => s.id === req.params.id && s.staffId === req.session.staffId);
  if (idx === -1) return res.status(404).json({ error: '予定が見つかりません' });
  const removed = data.schedules[idx];
  data.schedules.splice(idx, 1);
  saveSchedules(data);
  auditLog(req, 'schedule.delete', { type: 'schedule', id: req.params.id, label: `${req.session.staffName} ${removed.date}` });
  res.json({ success: true });
}));

router.get('/api/admin/schedules', requireAdmin, (_req, res) => {
  res.json(loadSchedules().schedules);
});

router.delete('/api/admin/schedules/:id', requireAdmin, lockedRoute(SCHEDULES_PATH, (req, res) => {
  const data = loadSchedules();
  const idx = data.schedules.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '予定が見つかりません' });
  const removed = data.schedules[idx];
  data.schedules.splice(idx, 1);
  saveSchedules(data);
  auditLog(req, 'schedule.admin_delete', { type: 'schedule', id: req.params.id, label: `${removed.staffName} ${removed.date}` });
  res.json({ success: true });
}));

module.exports = router;
