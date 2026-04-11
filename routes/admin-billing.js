'use strict';

const express = require('express');
const router = express.Router();

const { loadStaff, getSpreadsheetIdForYear } = require('../lib/data');
const { requireAdmin } = require('../lib/auth-middleware');
const { getExpectedWorkingDays, getExpectedWorkingDaysRange } = require('../lib/helpers');
const { getSheets, sheetsRetry } = require('../lib/sheets');
const { DATA_START_ROW, WD } = require('../lib/constants');

// ─── 管理者用 締め期間日別明細 ──────────────────────────────────
async function handleAdminBillingDetail(req, res) {
  const { staffId } = req.query;
  const y = Number(req.query.year), m = Number(req.query.month);
  const prevM = m === 1 ? 12 : m - 1;
  const prevYear = m === 1 ? y - 1 : y;
  const daysInPrev = new Date(prevYear, prevM, 0).getDate();
  const billingStart = `${prevYear}-${String(prevM).padStart(2,'0')}-16`;
  const billingEnd   = `${y}-${String(m).padStart(2,'0')}-15`;

  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });
  const iDef = staffData.incentive_defaults || { nurse: 3.5, rehab: 20.0 };
  const defNurseRate = (staffData.incentive_defaults || {}).nurse_rate ?? 4000;
  const defRehabRate = (staffData.incentive_defaults || {}).rehab_rate ?? 500;
  const isNurse = staff.type === 'nurse';

  try {
    const api = await getSheets();
    const sidPrev = getSpreadsheetIdForYear(prevYear);
    const sidCur  = getSpreadsheetIdForYear(y);
    const colRange = isNurse
      ? `${staff.kaigo_col}%s:${staff.iryo_col}%s`
      : `${staff.col}%s:${staff.col}%s`;

    const startRowA = DATA_START_ROW + 15;
    const endRowA   = DATA_START_ROW + daysInPrev - 1;
    const rangeA = `${prevM}月!${colRange.replace('%s', startRowA).replace('%s', endRowA)}`;
    const startRowB = DATA_START_ROW;
    const endRowB   = DATA_START_ROW + 14;
    const rangeB = `${m}月!${colRange.replace('%s', startRowB).replace('%s', endRowB)}`;

    const [respA, respB] = await Promise.all([
      sheetsRetry(() => api.spreadsheets.values.get({ spreadsheetId: sidPrev, range: rangeA })).catch(() => ({ data: { values: [] } })),
      sheetsRetry(() => api.spreadsheets.values.get({ spreadsheetId: sidCur,  range: rangeB })).catch(() => ({ data: { values: [] } })),
    ]);
    const rowsA = respA.data.values ?? [];
    const rowsB = respB.data.values ?? [];

    const days = [];
    let total_kaigo = 0, total_iryo = 0, total_units = 0, working_days = 0;

    for (let i = 0; i < (daysInPrev - 15); i++) {
      const day = 16 + i;
      const row = rowsA[i] ?? [];
      if (isNurse) {
        const kaigo = (row[0] !== undefined && row[0] !== '') ? parseFloat(row[0]) : null;
        const iryo  = (row[1] !== undefined && row[1] !== '') ? parseFloat(row[1]) : null;
        if (kaigo != null) total_kaigo += kaigo;
        if (iryo  != null) total_iryo  += iryo;
        if (kaigo != null || iryo != null) working_days++;
        const total = (kaigo != null || iryo != null) ? (kaigo || 0) + (iryo || 0) : null;
        days.push({ day, month: prevM, weekday: WD[new Date(prevYear, prevM - 1, day).getDay()], kaigo, iryo, total });
      } else {
        const value = (row[0] !== undefined && row[0] !== '') ? parseFloat(row[0]) : null;
        if (value != null) { total_units += value; working_days++; }
        days.push({ day, month: prevM, weekday: WD[new Date(prevYear, prevM - 1, day).getDay()], value });
      }
    }
    for (let i = 0; i < 15; i++) {
      const day = 1 + i;
      const row = rowsB[i] ?? [];
      if (isNurse) {
        const kaigo = (row[0] !== undefined && row[0] !== '') ? parseFloat(row[0]) : null;
        const iryo  = (row[1] !== undefined && row[1] !== '') ? parseFloat(row[1]) : null;
        if (kaigo != null) total_kaigo += kaigo;
        if (iryo  != null) total_iryo  += iryo;
        if (kaigo != null || iryo != null) working_days++;
        const total = (kaigo != null || iryo != null) ? (kaigo || 0) + (iryo || 0) : null;
        days.push({ day, month: m, weekday: WD[new Date(y, m - 1, day).getDay()], kaigo, iryo, total });
      } else {
        const value = (row[0] !== undefined && row[0] !== '') ? parseFloat(row[0]) : null;
        if (value != null) { total_units += value; working_days++; }
        days.push({ day, month: m, weekday: WD[new Date(y, m - 1, day).getDay()], value });
      }
    }

    const rawLine = isNurse
      ? ((staff.incentive_line != null) ? staff.incentive_line : iDef.nurse)
      : ((staff.incentive_line != null) ? staff.incentive_line : iDef.rehab);
    const workRatio = (staff.work_hours != null) ? staff.work_hours / 8.0 : 1.0;
    const iline = Math.round(rawLine * workRatio * 100) / 100;
    const expectedDays = getExpectedWorkingDaysRange(staff.id, billingStart, billingEnd);
    const targetTotal = Math.round(iline * expectedDays * 10) / 10;

    if (isNurse) {
      const total = total_kaigo + total_iryo;
      const over_hours = Math.max(0, total - targetTotal);
      const rate = staff.incentive_rate ?? defNurseRate;
      const incentive_amount = Math.floor(over_hours / 0.5) * Math.round(rate / 2);
      res.json({ type: 'nurse', year: y, month: m, mode: 'billing',
        billing_start: billingStart, billing_end: billingEnd, days,
        stats: { total_kaigo, total_iryo, total, working_days,
                 expected_working_days: expectedDays, target_total: targetTotal,
                 incentive_line: iline, incentive_triggered: total >= targetTotal,
                 over_hours: Math.round(over_hours * 10) / 10, incentive_amount,
                 incentive_rate: rate, work_hours: staff.work_hours ?? null } });
    } else {
      const over_units = Math.max(0, total_units - targetTotal);
      const rate = staff.incentive_rate ?? defRehabRate;
      const incentive_amount = Math.floor(over_units) * rate;
      res.json({ type: staff.type === 'nurse' ? 'nurse' : 'rehab', staffType: staff.type,
        year: y, month: m, mode: 'billing',
        billing_start: billingStart, billing_end: billingEnd, days,
        stats: { total_units, working_days,
                 expected_working_days: expectedDays, target_total: targetTotal,
                 incentive_line: iline, incentive_triggered: total_units >= targetTotal,
                 over_units: Math.floor(over_units), incentive_amount,
                 incentive_rate: rate, work_hours: staff.work_hours ?? null } });
    }
  } catch (e) {
    console.error('admin billing-detail error:', e.message);
    res.status(500).json({ error: '締め期間明細の取得に失敗しました' });
  }
}

// ─── API: 管理者用 月別日別明細 ────────────────────────────────
router.get('/api/admin/monthly-detail', requireAdmin, async (req, res) => {
  const { staffId, year, month, mode } = req.query;
  if (!staffId || !year || !month) return res.status(400).json({ error: 'パラメータ不足' });

  if (mode === 'billing') return handleAdminBillingDetail(req, res);

  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  const y   = Number(year), m = Number(month);
  const sid = getSpreadsheetIdForYear(y);
  const daysInMonth = new Date(y, m, 0).getDate();
  const endRow = DATA_START_ROW + daysInMonth - 1;
  const iDef = staffData.incentive_defaults || { nurse: 3.5, rehab: 20.0 };
  const defNurseRate = (staffData.incentive_defaults || {}).nurse_rate ?? 4000;
  const defRehabRate = (staffData.incentive_defaults || {}).rehab_rate ?? 500;

  try {
    const api = await getSheets();
    if (staff.type === 'nurse') {
      const resp = await sheetsRetry(() => api.spreadsheets.values.get({
        spreadsheetId: sid,
        range: `${m}月!${staff.kaigo_col}${DATA_START_ROW}:${staff.iryo_col}${endRow}`,
      }));
      const rows = resp.data.values ?? [];
      let total_kaigo = 0, total_iryo = 0, working_days = 0;
      const days = [];
      for (let d = 1; d <= daysInMonth; d++) {
        const row = rows[d - 1] ?? [];
        const kaigo = (row[0] !== undefined && row[0] !== '') ? parseFloat(row[0]) : null;
        const iryo  = (row[1] !== undefined && row[1] !== '') ? parseFloat(row[1]) : null;
        if (kaigo != null) total_kaigo += kaigo;
        if (iryo  != null) total_iryo  += iryo;
        if (kaigo != null || iryo != null) working_days++;
        const total = (kaigo != null || iryo != null) ? (kaigo || 0) + (iryo || 0) : null;
        days.push({ day: d, weekday: WD[new Date(y, m - 1, d).getDay()], kaigo, iryo, total });
      }
      const total = total_kaigo + total_iryo;
      const rawLineAN   = (staff.incentive_line != null) ? staff.incentive_line : iDef.nurse;
      const workRatioAN = (staff.work_hours != null) ? staff.work_hours / 8.0 : 1.0;
      const ilineAN     = Math.round(rawLineAN * workRatioAN * 100) / 100;
      const expectedDaysAN = getExpectedWorkingDays(staff.id, y, m);
      const targetTotalAN = Math.round(ilineAN * expectedDaysAN * 10) / 10;
      const over_hoursAN   = Math.max(0, total - targetTotalAN);
      const rateAN = staff.incentive_rate ?? defNurseRate;
      const incentive_countAN  = Math.floor(over_hoursAN / 0.5);
      const incentive_amountAN = incentive_countAN * Math.round(rateAN / 2);
      res.json({ type: 'nurse', year: y, month: m, days,
        stats: { total_kaigo, total_iryo, total, working_days,
                 expected_working_days: expectedDaysAN, target_total: targetTotalAN,
                 incentive_line: ilineAN, incentive_triggered: total >= targetTotalAN,
                 over_hours: Math.round(over_hoursAN * 10) / 10,
                 incentive_amount: incentive_amountAN,
                 incentive_rate: rateAN,
                 work_hours: staff.work_hours ?? null } });
    } else {
      const resp = await sheetsRetry(() => api.spreadsheets.values.get({
        spreadsheetId: sid,
        range: `${m}月!${staff.col}${DATA_START_ROW}:${staff.col}${endRow}`,
      }));
      const rows = resp.data.values ?? [];
      let total_units = 0, working_days = 0;
      const days = [];
      for (let d = 1; d <= daysInMonth; d++) {
        const row = rows[d - 1] ?? [];
        const value = (row[0] !== undefined && row[0] !== '') ? parseFloat(row[0]) : null;
        if (value != null) { total_units += value; working_days++; }
        days.push({ day: d, weekday: WD[new Date(y, m - 1, d).getDay()], value });
      }
      const rawLineAR   = (staff.incentive_line != null) ? staff.incentive_line : iDef.rehab;
      const workRatioAR = (staff.work_hours != null) ? staff.work_hours / 8.0 : 1.0;
      const ilineAR     = Math.round(rawLineAR * workRatioAR * 100) / 100;
      const expectedDaysAR = getExpectedWorkingDays(staff.id, y, m);
      const targetTotalAR = Math.round(ilineAR * expectedDaysAR * 10) / 10;
      const over_units       = Math.max(0, total_units - targetTotalAR);
      const rateAR = staff.incentive_rate ?? defRehabRate;
      const incentive_amount = Math.floor(over_units) * rateAR;
      res.json({ type: staff.type === 'nurse' ? 'nurse' : 'rehab', staffType: staff.type, year: y, month: m, days,
        stats: { total_units, working_days,
                 expected_working_days: expectedDaysAR, target_total: targetTotalAR,
                 incentive_line: ilineAR, incentive_triggered: total_units >= targetTotalAR,
                 over_units: Math.floor(over_units), incentive_amount,
                 incentive_rate: rateAR,
                 work_hours: staff.work_hours ?? null } });
    }
  } catch (e) {
    console.error('❌ admin monthly-detail error:', e.message);
    res.status(500).json({ error: '月次明細の取得に失敗しました' });
  }
});

// ─── API: 管理者用 インセンティブ月次集計 ──────────────────────────
router.get('/api/admin/incentive-summary', requireAdmin, async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'パラメータ不足' });

  const y = Number(year), m = Number(month);
  const sid = getSpreadsheetIdForYear(y);
  const daysInMonth = new Date(y, m, 0).getDate();
  const endRow = DATA_START_ROW + daysInMonth - 1;

  const staffData = loadStaff();
  const iDef = staffData.incentive_defaults || { nurse: 3.5, rehab: 20.0 };
  const defNurseRate = (staffData.incentive_defaults || {}).nurse_rate ?? 4000;
  const defRehabRate = (staffData.incentive_defaults || {}).rehab_rate ?? 500;
  const activeStaff = staffData.staff.filter(s => !s.archived && s.type !== 'office' && s.type !== 'admin');

  try {
    const api = await getSheets();
    const results = [];
    let total_amount = 0;

    for (const staff of activeStaff) {
      try {
        if (staff.type === 'nurse') {
          const resp = await sheetsRetry(() => api.spreadsheets.values.get({
            spreadsheetId: sid,
            range: `${m}月!${staff.kaigo_col}${DATA_START_ROW}:${staff.iryo_col}${endRow}`,
          }));
          const rows = resp.data.values ?? [];
          let total_kaigo = 0, total_iryo = 0, working_days = 0;
          for (const r of rows) {
            const k = parseFloat(r?.[0]) || 0;
            const i = parseFloat(r?.[1]) || 0;
            total_kaigo += k; total_iryo += i;
            if (k > 0 || i > 0) working_days++;
          }
          const total = total_kaigo + total_iryo;
          const rawLine = (staff.incentive_line != null) ? staff.incentive_line : iDef.nurse;
          const workRatio = (staff.work_hours != null) ? staff.work_hours / 8.0 : 1.0;
          const effectiveLine = Math.round(rawLine * workRatio * 100) / 100;
          const expectedDays = getExpectedWorkingDays(staff.id, y, m);
          const threshold = effectiveLine * expectedDays;
          const overHours = Math.max(0, total - threshold);
          const rate = staff.incentive_rate ?? defNurseRate;
          const amount = Math.floor(overHours / 0.5) * Math.round(rate / 2);
          total_amount += amount;
          results.push({
            id: staff.id, name: staff.name, type: 'nurse',
            work_hours: staff.work_hours ?? null,
            incentive_line: rawLine, effective_line: effectiveLine,
            incentive_rate: rate,
            working_days, expected_working_days: expectedDays,
            threshold: Math.round(threshold * 100) / 100,
            total: Math.round(total * 10) / 10,
            total_kaigo: Math.round(total_kaigo * 10) / 10,
            total_iryo: Math.round(total_iryo * 10) / 10,
            over: Math.round(overHours * 10) / 10, amount
          });
        } else if (staff.col) {
          // リハビリ職共通（PT/OT/ST）: 単一列構造
          const resp = await sheetsRetry(() => api.spreadsheets.values.get({
            spreadsheetId: sid,
            range: `${m}月!${staff.col}${DATA_START_ROW}:${staff.col}${endRow}`,
          }));
          const rows = resp.data.values ?? [];
          let total_units = 0, working_days = 0;
          for (const r of rows) {
            const v = parseFloat(r?.[0]) || 0;
            total_units += v;
            if (v > 0) working_days++;
          }
          const rawLine = (staff.incentive_line != null) ? staff.incentive_line : iDef.rehab;
          const workRatio = (staff.work_hours != null) ? staff.work_hours / 8.0 : 1.0;
          const effectiveLine = Math.round(rawLine * workRatio * 100) / 100;
          const expectedDays = getExpectedWorkingDays(staff.id, y, m);
          const threshold = effectiveLine * expectedDays;
          const overUnits = Math.max(0, total_units - threshold);
          const rate = staff.incentive_rate ?? defRehabRate;
          const amount = Math.floor(overUnits) * rate;
          total_amount += amount;
          results.push({
            id: staff.id, name: staff.name, type: staff.type,
            work_hours: staff.work_hours ?? null,
            incentive_line: rawLine, effective_line: effectiveLine,
            incentive_rate: rate,
            working_days, expected_working_days: expectedDays,
            threshold: Math.round(threshold * 100) / 100,
            total: total_units,
            over: Math.floor(overUnits), amount
          });
        }
      } catch (staffErr) {
        results.push({
          id: staff.id, name: staff.name, type: staff.type,
          error: staffErr.message
        });
      }
    }

    res.json({ year: y, month: m, staff: results, total_amount });
  } catch (e) {
    console.error('❌ admin incentive-summary error:', e.message);
    res.status(500).json({ error: 'インセンティブ集計の取得に失敗しました' });
  }
});

module.exports = router;
