'use strict';
const express = require('express');
const router = express.Router();

const { loadStaff, getSpreadsheetIdForYear } = require('../lib/data');
const { requireAdmin } = require('../lib/auth-middleware');
const { validateUnitValue } = require('../lib/helpers');
const { auditLog } = require('../lib/audit');
const { getSheets, sheetsRetry } = require('../lib/sheets');
const { DATA_START_ROW } = require('../lib/constants');

router.post('/api/admin/record', requireAdmin, async (req, res) => {
  const { staffId, date } = req.body;
  if (!staffId || !date) return res.status(400).json({ error: 'パラメータ不足' });

  const d     = new Date(date);
  const year  = d.getFullYear();
  const month = d.getMonth() + 1;
  const row   = DATA_START_ROW + d.getDate() - 1;
  const sid   = getSpreadsheetIdForYear(year);

  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  try {
    const api = await getSheets();
    if (staff.type === 'nurse') {
      const { kaigo, iryo } = req.body;
      const kv = validateUnitValue(kaigo);
      const iv = validateUnitValue(iryo);
      if (!kv.valid || !iv.valid) return res.status(400).json({ error: '単位数は0〜9999の数値で入力してください' });
      const kVal = kv.value, iVal = iv.value;
      await sheetsRetry(() => api.spreadsheets.values.batchUpdate({
        spreadsheetId: sid,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${month}月!${staff.kaigo_col}${row}`, values: [[kVal]] },
            { range: `${month}月!${staff.iryo_col}${row}`, values: [[iVal]] },
          ],
        },
      }));
    } else {
      const { value } = req.body;
      const vv = validateUnitValue(value);
      if (!vv.valid) return res.status(400).json({ error: '単位数は0〜9999の数値で入力してください' });
      const val = vv.value;
      await sheetsRetry(() => api.spreadsheets.values.update({
        spreadsheetId: sid,
        range: `${month}月!${staff.col}${row}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[val]] },
      }));
    }
    auditLog(req, 'record.admin_edit', { type: 'visit_record', id: staffId, label: `${staff.name} ${date}` }, { date, ...req.body });
    res.json({ success: true });
  } catch (e) {
    console.error('❌ admin record POST error:', e.message);
    res.status(500).json({ error: '記録の保存に失敗しました' });
  }
});

module.exports = router;
