'use strict';

const express = require('express');
const router = express.Router();

const { loadStaff, loadStandby, saveStandby, atomicModify, getSpreadsheetIdForYear } = require('../lib/data');
const { requireAdmin } = require('../lib/auth-middleware');
const { asyncRoute, formatLocalDate, getStandbyFeeWithCustom, isOnLeaveToday } = require('../lib/helpers');
const { auditLog } = require('../lib/audit');
const { getSheets, sheetsRetry } = require('../lib/sheets');
const { DATA_START_ROW } = require('../lib/constants');

// 全スタッフの入力状況を一括取得（batchGet で効率化）
async function getAllStaffRecordStatus(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const row = DATA_START_ROW + d.getDate() - 1;
  const sid = getSpreadsheetIdForYear(year);

  const staffData = loadStaff();
  const activeStaff = staffData.staff.filter(s => !s.archived);

  // batchGet用のレンジを構築
  const ranges = [];
  const staffMap = [];
  for (const s of activeStaff) {
    if (s.type === 'nurse') {
      ranges.push(`${month}月!${s.kaigo_col}${row}:${s.iryo_col}${row}`);
    } else {
      ranges.push(`${month}月!${s.col}${row}`);
    }
    staffMap.push(s);
  }

  try {
    const api = await getSheets();
    const resp = await sheetsRetry(() => api.spreadsheets.values.batchGet({
      spreadsheetId: sid,
      ranges,
    }));

    const results = { missing: [], entered: [], onLeave: [] };
    const valueRanges = resp.data.valueRanges || [];

    for (let i = 0; i < staffMap.length; i++) {
      const s = staffMap[i];
      const info = { id: s.id, name: s.name, type: s.type };

      if (isOnLeaveToday(s.id, dateStr)) {
        results.onLeave.push(info);
        continue;
      }

      const vals = valueRanges[i]?.values?.[0] ?? [];
      let hasRecord = false;
      if (s.type === 'nurse') {
        hasRecord = (vals[0] !== undefined && vals[0] !== '') || (vals[1] !== undefined && vals[1] !== '');
      } else {
        hasRecord = vals[0] !== undefined && vals[0] !== '';
      }

      if (hasRecord) {
        results.entered.push(info);
      } else {
        results.missing.push(info);
      }
    }
    return results;
  } catch (e) {
    console.error('⚠️ 全スタッフ入力状況チェックエラー:', e.message);
    return { missing: [], entered: [], onLeave: [], error: e.message };
  }
}

router.get('/api/admin/standby/eligible-staff', requireAdmin, (req, res) => {
  const staffData = loadStaff();
  const eligible = staffData.staff
    .filter(s => !s.archived && s.type === 'nurse' && s.oncall_eligible)
    .map(s => ({ id: s.id, name: s.name }));
  res.json({ staff: eligible });
});

// 待機記録取得（16日〜15日期間）
router.get('/api/admin/standby/records', requireAdmin, (req, res) => {
  const month = req.query.month; // 支払月 YYYY-MM
  if (!month) return res.status(400).json({ error: 'month は必須です' });
  const data = loadStandby();
  const [y, m] = month.split('-').map(Number);
  const startDate = new Date(y, m - 2, 16);
  const endDate = new Date(y, m - 1, 15);
  const startStr = formatLocalDate(startDate);
  const endStr = formatLocalDate(endDate);
  const records = data.records.filter(r => r.date >= startStr && r.date <= endStr);
  const rainyDays = (data.rainyDays || []).filter(d => d >= startStr && d <= endStr);
  const customHolidays = data.customHolidays || [];
  res.json({ records, rainyDays, customHolidays, startDate: startStr, endDate: endStr });
});

// 待機者登録/更新
router.post('/api/admin/standby/records', requireAdmin, asyncRoute((req, res) => {
  const { date, staffId } = req.body;
  if (!date) return res.status(400).json({ error: 'date は必須です' });
  atomicModify(() => {
    const data = loadStandby();
    const idx = data.records.findIndex(r => r.date === date);
    if (!staffId || staffId === '') {
      if (idx >= 0) data.records.splice(idx, 1);
    } else {
      const now = new Date().toISOString();
      if (idx >= 0) {
        data.records[idx].staffId = staffId;
        data.records[idx].updatedAt = now;
      } else {
        data.records.push({ date, staffId, createdAt: now, updatedAt: now });
      }
    }
    saveStandby(data);
  });
  auditLog(req, 'standby.upsert', { type: 'standby', id: date }, { date, staffId: staffId || '(削除)' });
  res.json({ ok: true });
}));

// 待機記録削除
router.delete('/api/admin/standby/records/:date', requireAdmin, asyncRoute((req, res) => {
  const result = atomicModify(() => {
    const data = loadStandby();
    const idx = data.records.findIndex(r => r.date === req.params.date);
    if (idx < 0) return { error: '記録が見つかりません', status: 404 };
    data.records.splice(idx, 1);
    saveStandby(data);
    return {};
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  auditLog(req, 'standby.delete', { type: 'standby', id: req.params.date }, {});
  res.json({ ok: true });
}));

// 待機集計（16日〜15日締め）
router.get('/api/admin/standby/summary', requireAdmin, (req, res) => {
  const month = req.query.month;
  if (!month) return res.status(400).json({ error: 'month は必須です' });
  const data = loadStandby();
  const customHols = new Set(data.customHolidays || []);
  const [y, m] = month.split('-').map(Number);
  const startDate = new Date(y, m - 2, 16);
  const endDate = new Date(y, m - 1, 15);
  const startStr = formatLocalDate(startDate);
  const endStr = formatLocalDate(endDate);
  const records = data.records.filter(r => r.date >= startStr && r.date <= endStr);

  const staffData = loadStaff();
  const staffMap = {};
  for (const s of staffData.staff) staffMap[s.id] = s.name;

  const summary = {};
  for (const rec of records) {
    if (!summary[rec.staffId]) {
      summary[rec.staffId] = { staffId: rec.staffId, name: staffMap[rec.staffId] || rec.staffId, weekday: 0, saturday: 0, sundayHoliday: 0, total: 0 };
    }
    const { fee, category } = getStandbyFeeWithCustom(rec.date, customHols);
    summary[rec.staffId].total += fee;
    if (category === '平日') summary[rec.staffId].weekday++;
    else if (category === '土曜') summary[rec.staffId].saturday++;
    else summary[rec.staffId].sundayHoliday++;
  }

  const rainyDays = (data.rainyDays || []).filter(d => d >= startStr && d <= endStr);
  res.json({ summary: Object.values(summary), rainyDayCount: rainyDays.length });
});

// カスタム祝日取得
router.get('/api/admin/standby/custom-holidays', requireAdmin, (req, res) => {
  const data = loadStandby();
  res.json({ customHolidays: data.customHolidays || [] });
});

// カスタム祝日設定
router.post('/api/admin/standby/custom-holidays', requireAdmin, asyncRoute((req, res) => {
  const { dates } = req.body;
  if (!Array.isArray(dates)) return res.status(400).json({ error: 'dates は配列で指定してください' });
  const result = atomicModify(() => {
    const data = loadStandby();
    data.customHolidays = dates.sort();
    saveStandby(data);
    return { customHolidays: data.customHolidays };
  });
  auditLog(req, 'standby.custom_holidays', { type: 'standby', id: 'custom-holidays' }, { count: dates.length });
  res.json({ ok: true, customHolidays: result.customHolidays });
}));

// ─── API: 雨の日管理（管理者向け） ──────────────────────────────

router.post('/api/admin/rainy/toggle', requireAdmin, asyncRoute((req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'date は必須です' });
  const result = atomicModify(() => {
    const data = loadStandby();
    const idx = data.rainyDays.indexOf(date);
    if (idx >= 0) {
      data.rainyDays.splice(idx, 1);
    } else {
      data.rainyDays.push(date);
      data.rainyDays.sort();
    }
    saveStandby(data);
    return { isRainy: data.rainyDays.includes(date) };
  });
  auditLog(req, 'rainy.toggle', { type: 'rainy', id: date }, { rainy: result.isRainy });
  res.json({ ok: true, rainy: result.isRainy });
}));

// 雨の日集計（16日〜15日締め、出勤判定付き）
router.get('/api/admin/rainy/summary', requireAdmin, async (req, res) => {
  const month = req.query.month;
  if (!month) return res.status(400).json({ error: 'month は必須です' });
  const data = loadStandby();
  const [y, m] = month.split('-').map(Number);
  const startDate = new Date(y, m - 2, 16);
  const endDate = new Date(y, m - 1, 15);
  const startStr = formatLocalDate(startDate);
  const endStr = formatLocalDate(endDate);
  const rainyDays = (data.rainyDays || []).filter(d => d >= startStr && d <= endStr).sort();

  if (rainyDays.length === 0) {
    return res.json({ summary: [], rainyDayCount: 0, details: [] });
  }

  // 各雨の日の出勤者を取得
  const staffCounts = {}; // staffId => { name, days }
  const details = []; // 日別詳細
  for (const dateStr of rainyDays) {
    try {
      const status = await getAllStaffRecordStatus(dateStr);
      const worked = status.entered || [];
      details.push({ date: dateStr, workedStaff: worked.map(s => s.name) });
      for (const s of worked) {
        if (!staffCounts[s.id]) staffCounts[s.id] = { name: s.name, days: 0 };
        staffCounts[s.id].days++;
      }
    } catch (e) {
      console.error(`雨の日集計エラー (${dateStr}):`, e.message);
      details.push({ date: dateStr, workedStaff: [], error: e.message });
    }
  }

  const summary = Object.values(staffCounts)
    .map(s => ({ name: s.name, days: s.days, amount: s.days * 500 }))
    .sort((a, b) => b.days - a.days);

  res.json({ summary, rainyDayCount: rainyDays.length, details });
});

module.exports = router;
