'use strict';
// 訪問記録・月次統計・インセンティブ見込ルート

const express = require('express');
const router = express.Router();

const { loadStaff, loadLeave, loadStandby, getSpreadsheetIdForYear } = require('../lib/data');
const { requireStaff } = require('../lib/auth-middleware');
const { validateUnitValue, lockedRoute, isValidDate, getTodayJST, getNowJST, isWorkday, isOnLeaveToday } = require('../lib/helpers');
const { auditLog } = require('../lib/audit');
const { getSheets, sheetsRetry } = require('../lib/sheets');
const { DATA_START_ROW, WD, ALL_HOLIDAYS } = require('../lib/constants');

async function hasRecordForDate(staff, dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const row = DATA_START_ROW + d.getDate() - 1;
  const sid = getSpreadsheetIdForYear(year);

  try {
    const api = await getSheets();
    if (staff.type === 'nurse') {
      const resp = await sheetsRetry(() => api.spreadsheets.values.get({
        spreadsheetId: sid,
        range: `${month}月!${staff.kaigo_col}${row}:${staff.iryo_col}${row}`,
      }));
      const vals = resp.data.values?.[0] ?? [];
      return (vals[0] !== undefined && vals[0] !== '') || (vals[1] !== undefined && vals[1] !== '');
    } else {
      const resp = await sheetsRetry(() => api.spreadsheets.values.get({
        spreadsheetId: sid,
        range: `${month}月!${staff.col}${row}`,
      }));
      const val = resp.data.values?.[0]?.[0];
      return val !== undefined && val !== '';
    }
  } catch (e) {
    console.error(`⚠️ 未入力チェックエラー (${staff.id}):`, e.message);
    return true; // エラー時はリマインダーを出さない
  }
}

// ─── API: 記録の取得（上書きチェック用） ────────────────────────
router.get('/api/record', requireStaff, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'パラメータが不足しています' });

  const d     = new Date(date);
  const year  = d.getFullYear();
  const month = d.getMonth() + 1;
  const row   = DATA_START_ROW + d.getDate() - 1;
  const sid   = getSpreadsheetIdForYear(year);

  const data  = loadStaff();
  const staff = data.staff.find(s => s.id === req.session.staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  try {
    const api = await getSheets();
    if (staff.type === 'nurse') {
      const resp = await sheetsRetry(() => api.spreadsheets.values.get({
        spreadsheetId: sid,
        range: `${month}月!${staff.kaigo_col}${row}:${staff.iryo_col}${row}`,
      }));
      const vals = resp.data.values?.[0] ?? [];
      res.json({ kaigo: vals[0] ?? null, iryo: vals[1] ?? null });
    } else {
      const resp = await sheetsRetry(() => api.spreadsheets.values.get({
        spreadsheetId: sid,
        range: `${month}月!${staff.col}${row}`,
      }));
      res.json({ value: resp.data.values?.[0]?.[0] ?? null });
    }
  } catch (e) {
    console.error('❌ record GET error:', e.message);
    res.status(500).json({ error: '記録の取得に失敗しました' });
  }
});

// ─── API: 記録の送信 ─────────────────────────────────────────────
router.post('/api/record', requireStaff, async (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'パラメータが不足しています' });

  // 日付チェック（JST基準）
  const d = new Date(date);
  if (date > getTodayJST()) return res.status(400).json({ error: '未来の日付には記録できません' });

  // 締日チェック：1〜20日は前月16日、21日〜末日は当月16日より前は修正不可
  const now = getNowJST();
  let editYear = now.getUTCFullYear(), editMonth = now.getUTCMonth() + 1;
  if (now.getUTCDate() <= 20) {
    editMonth -= 1;
    if (editMonth <= 0) { editMonth = 12; editYear--; }
  }
  const editableFrom = new Date(`${editYear}-${String(editMonth).padStart(2,'0')}-16T00:00:00`);
  if (d < editableFrom) return res.status(400).json({ error: '締日（15日）以前の日付は修正できません' });

  const year  = d.getFullYear();
  const month = d.getMonth() + 1;
  const row   = DATA_START_ROW + d.getDate() - 1;
  const sid   = getSpreadsheetIdForYear(year);

  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === req.session.staffId);
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
            { range: `${month}月!${staff.iryo_col}${row}`,  values: [[iVal]] },
          ],
        },
      }));
      auditLog(req, 'record.create', { type: 'visit_record', id: staff.id, label: `${staff.name} ${date}` }, { date, kaigo: kVal, iryo: iVal });
      res.json({ success: true, kaigo: kVal, iryo: iVal });
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
      auditLog(req, 'record.create', { type: 'visit_record', id: staff.id, label: `${staff.name} ${date}` }, { date, value: val });
      res.json({ success: true, value: val });
    }
  } catch (e) {
    console.error('❌ record POST error:', JSON.stringify(e.response?.data ?? e.message));
    res.status(500).json({ error: '記録の保存に失敗しました' });
  }
});

// ─── API: 月別実績 ──────────────────────────────────────────────
router.get('/api/monthly-stats', requireStaff, async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'パラメータが不足しています' });

  const daysInMonth = new Date(Number(year), Number(month), 0).getDate();
  const endRow      = DATA_START_ROW + daysInMonth - 1;
  const sid         = getSpreadsheetIdForYear(Number(year));

  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === req.session.staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  try {
    const api = await getSheets();
    if (staff.type === 'nurse') {
      const resp = await sheetsRetry(() => api.spreadsheets.values.get({
        spreadsheetId: sid,
        range: `${month}月!${staff.kaigo_col}${DATA_START_ROW}:${staff.iryo_col}${endRow}`,
      }));
      const rows = resp.data.values ?? [];
      let total_kaigo = 0, total_iryo = 0, working_days = 0;
      for (const r of rows) {
        const k = parseFloat(r?.[0]) || 0;
        const i = parseFloat(r?.[1]) || 0;
        total_kaigo += k;
        total_iryo  += i;
        if (k > 0 || i > 0) working_days++;
      }
      const iDef = staffData.incentive_defaults || { nurse: 3.5, rehab: 20.0 };
      const rawLine   = (staff.incentive_line != null) ? staff.incentive_line : iDef.nurse;
      const workRatio = (staff.work_hours != null) ? staff.work_hours / 8.0 : 1.0;
      const iline     = Math.round(rawLine * workRatio * 100) / 100;
      const avg = working_days > 0 ? (total_kaigo + total_iryo) / working_days : 0;
      res.json({ total_kaigo, total_iryo, total: total_kaigo + total_iryo, working_days,
                 incentive_line: iline, incentive_triggered: avg > iline,
                 work_hours: staff.work_hours ?? null });
    } else {
      const resp = await sheetsRetry(() => api.spreadsheets.values.get({
        spreadsheetId: sid,
        range: `${month}月!${staff.col}${DATA_START_ROW}:${staff.col}${endRow}`,
      }));
      const rows = resp.data.values ?? [];
      let total_units = 0, working_days = 0;
      for (const r of rows) {
        const v = parseFloat(r?.[0]) || 0;
        total_units += v;
        if (v > 0) working_days++;
      }
      const iDef2     = staffData.incentive_defaults || { nurse: 3.5, rehab: 20.0 };
      const rawLine2  = (staff.incentive_line != null) ? staff.incentive_line : iDef2.rehab;
      const workRatio2 = (staff.work_hours != null) ? staff.work_hours / 8.0 : 1.0;
      const iline2    = Math.round(rawLine2 * workRatio2 * 100) / 100;
      const avg2      = working_days > 0 ? total_units / working_days : 0;
      const threshold2     = iline2 * working_days;
      const over_units2    = Math.max(0, total_units - threshold2);
      const incentive_amount2 = Math.floor(over_units2) * 500;
      res.json({ total_units, working_days,
                 incentive_line: iline2, incentive_triggered: avg2 > iline2,
                 over_units: Math.floor(over_units2), incentive_amount: incentive_amount2,
                 work_hours: staff.work_hours ?? null });
    }
  } catch (e) {
    console.error('❌ monthly-stats error:', e.message);
    res.status(500).json({ error: '月次統計の取得に失敗しました' });
  }
});

// ─── API: 月別日別明細 ──────────────────────────────────────────
router.get('/api/monthly-detail', requireStaff, async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'パラメータ不足' });

  const y   = Number(year), m = Number(month);
  const sid = getSpreadsheetIdForYear(y);
  const daysInMonth = new Date(y, m, 0).getDate();
  const endRow = DATA_START_ROW + daysInMonth - 1;

  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === req.session.staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  const iDef = staffData.incentive_defaults || { nurse: 3.5, rehab: 20.0 };

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
      const rawLineN   = (staff.incentive_line != null) ? staff.incentive_line : iDef.nurse;
      const workRatioN = (staff.work_hours != null) ? staff.work_hours / 8.0 : 1.0;
      const ilineN     = Math.round(rawLineN * workRatioN * 100) / 100;
      const avg = working_days > 0 ? total / working_days : 0;
      const thresholdN     = ilineN * working_days;
      const over_hoursN    = Math.max(0, total - thresholdN);
      const incentive_countN  = Math.floor(over_hoursN / 0.5);
      const incentive_amountN = incentive_countN * 2000;
      res.json({ type: 'nurse', year: y, month: m, days,
        stats: { total_kaigo, total_iryo, total, working_days,
                 incentive_line: ilineN, incentive_triggered: avg > ilineN,
                 over_hours: Math.round(over_hoursN * 10) / 10,
                 incentive_amount: incentive_amountN,
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
      const rawLineR   = (staff.incentive_line != null) ? staff.incentive_line : iDef.rehab;
      const workRatioR = (staff.work_hours != null) ? staff.work_hours / 8.0 : 1.0;
      const ilineR     = Math.round(rawLineR * workRatioR * 100) / 100;
      const avg = working_days > 0 ? total_units / working_days : 0;
      const threshold        = ilineR * working_days;
      const over_units       = Math.max(0, total_units - threshold);
      const incentive_amount = Math.floor(over_units) * 500;
      res.json({ type: 'rehab', year: y, month: m, days,
        stats: { total_units, working_days,
                 incentive_line: ilineR, incentive_triggered: avg > ilineR,
                 over_units: Math.floor(over_units), incentive_amount,
                 work_hours: staff.work_hours ?? null } });
    }
  } catch (e) {
    console.error('monthly-detail error:', e.message);
    res.status(500).json({ error: '月次明細の取得に失敗しました' });
  }
});

// ─── API: インセンティブ見込（16日〜15日締め） ─────────────────
router.get('/api/incentive-estimate', requireStaff, async (req, res) => {
  const { payMonth } = req.query;
  if (!payMonth || !/^\d{4}-\d{1,2}$/.test(payMonth))
    return res.status(400).json({ error: 'payMonth パラメータが必要です (YYYY-MM)' });

  const [payYear, payM] = payMonth.split('-').map(Number);
  // 対象期間: 前月16日 〜 当月15日
  const prevM    = payM === 1 ? 12 : payM - 1;
  const prevYear = payM === 1 ? payYear - 1 : payYear;
  const daysInPrev = new Date(prevYear, prevM, 0).getDate();

  const billingStart = `${prevYear}-${String(prevM).padStart(2,'0')}-16`;
  const billingEnd   = `${payYear}-${String(payM).padStart(2,'0')}-15`;
  const payDate      = `${payYear}-${String(payM).padStart(2,'0')}-25`;

  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === req.session.staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  const iDef = staffData.incentive_defaults || { nurse: 3.5, rehab: 20.0 };

  try {
    const api = await getSheets();
    const sidPrev = getSpreadsheetIdForYear(prevYear);
    const sidCur  = getSpreadsheetIdForYear(payYear);

    // 取得する列を決定
    const isNurse = staff.type === 'nurse';
    const colRange = isNurse
      ? `${staff.kaigo_col}%s:${staff.iryo_col}%s`
      : `${staff.col}%s:${staff.col}%s`;

    // Range A: 前月16日〜末日 (row = DATA_START_ROW + day - 1)
    const startRowA = DATA_START_ROW + 15; // 16日 = row 20
    const endRowA   = DATA_START_ROW + daysInPrev - 1;
    const rangeA = `${prevM}月!${colRange.replace('%s', startRowA).replace('%s', endRowA)}`;

    // Range B: 当月1日〜15日
    const startRowB = DATA_START_ROW;     // 1日 = row 5
    const endRowB   = DATA_START_ROW + 14; // 15日 = row 19
    const rangeB = `${payM}月!${colRange.replace('%s', startRowB).replace('%s', endRowB)}`;

    // 並列フェッチ
    const [respA, respB] = await Promise.all([
      sheetsRetry(() => api.spreadsheets.values.get({ spreadsheetId: sidPrev, range: rangeA })).catch(() => ({ data: { values: [] } })),
      sheetsRetry(() => api.spreadsheets.values.get({ spreadsheetId: sidCur,  range: rangeB })).catch(() => ({ data: { values: [] } })),
    ]);

    const rowsA = respA.data.values ?? [];
    const rowsB = respB.data.values ?? [];

    // 今日の日付で残日数・確定判定
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    const isFinalized = todayStr > billingEnd;

    if (isNurse) {
      let total_kaigo = 0, total_iryo = 0, working_days = 0, daysRemaining = 0;

      // Range A: 前月16日〜末日
      for (let i = 0; i < (daysInPrev - 15); i++) {
        const day = 16 + i;
        const dateStr = `${prevYear}-${String(prevM).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        const row = rowsA[i] ?? [];
        const k = (row[0] !== undefined && row[0] !== '') ? (parseFloat(row[0]) || 0) : 0;
        const ir = (row[1] !== undefined && row[1] !== '') ? (parseFloat(row[1]) || 0) : 0;
        total_kaigo += k; total_iryo += ir;
        if (k > 0 || ir > 0) working_days++;
        if (!isFinalized && dateStr >= todayStr && k === 0 && ir === 0) daysRemaining++;
      }
      // Range B: 当月1日〜15日
      for (let i = 0; i < 15; i++) {
        const day = 1 + i;
        const dateStr = `${payYear}-${String(payM).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        const row = rowsB[i] ?? [];
        const k = (row[0] !== undefined && row[0] !== '') ? (parseFloat(row[0]) || 0) : 0;
        const ir = (row[1] !== undefined && row[1] !== '') ? (parseFloat(row[1]) || 0) : 0;
        total_kaigo += k; total_iryo += ir;
        if (k > 0 || ir > 0) working_days++;
        if (!isFinalized && dateStr >= todayStr && k === 0 && ir === 0) daysRemaining++;
      }

      const total = total_kaigo + total_iryo;
      const rawLine   = (staff.incentive_line != null) ? staff.incentive_line : iDef.nurse;
      const workRatio = (staff.work_hours != null) ? staff.work_hours / 8.0 : 1.0;
      const iline     = Math.round(rawLine * workRatio * 100) / 100;
      const threshold     = iline * working_days;
      const over_hours    = Math.max(0, total - threshold);
      const incentive_count  = Math.floor(over_hours / 0.5);
      const incentive_amount = incentive_count * 2000;

      res.json({
        type: 'nurse', billing_start: billingStart, billing_end: billingEnd, pay_date: payDate,
        total, total_kaigo, total_iryo, working_days,
        incentive_line: iline, threshold: Math.round(threshold * 10) / 10,
        over_hours: Math.round(over_hours * 10) / 10,
        incentive_amount, incentive_triggered: over_hours > 0,
        days_remaining: daysRemaining, is_finalized: isFinalized,
      });
    } else {
      let total_units = 0, working_days = 0, daysRemaining = 0;

      for (let i = 0; i < (daysInPrev - 15); i++) {
        const day = 16 + i;
        const dateStr = `${prevYear}-${String(prevM).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        const row = rowsA[i] ?? [];
        const v = (row[0] !== undefined && row[0] !== '') ? (parseFloat(row[0]) || 0) : 0;
        if (v > 0) { total_units += v; working_days++; }
        if (!isFinalized && dateStr >= todayStr && v === 0) daysRemaining++;
      }
      for (let i = 0; i < 15; i++) {
        const day = 1 + i;
        const dateStr = `${payYear}-${String(payM).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        const row = rowsB[i] ?? [];
        const v = (row[0] !== undefined && row[0] !== '') ? (parseFloat(row[0]) || 0) : 0;
        if (v > 0) { total_units += v; working_days++; }
        if (!isFinalized && dateStr >= todayStr && v === 0) daysRemaining++;
      }

      const rawLine   = (staff.incentive_line != null) ? staff.incentive_line : iDef.rehab;
      const workRatio = (staff.work_hours != null) ? staff.work_hours / 8.0 : 1.0;
      const iline     = Math.round(rawLine * workRatio * 100) / 100;
      const threshold       = iline * working_days;
      const over_units      = Math.max(0, total_units - threshold);
      const incentive_amount = Math.floor(over_units) * 500;

      res.json({
        type: 'rehab', billing_start: billingStart, billing_end: billingEnd, pay_date: payDate,
        total_units, working_days,
        incentive_line: iline, threshold: Math.round(threshold * 10) / 10,
        over_units: Math.floor(over_units),
        incentive_amount, incentive_triggered: over_units > 0,
        days_remaining: daysRemaining, is_finalized: isFinalized,
      });
    }
  } catch (e) {
    console.error('incentive-estimate error:', e.message);
    res.status(500).json({ error: 'インセンティブ見込の取得に失敗しました' });
  }
});

// ─── API: スタッフ向け 今日の入力状況 ────────────────────────────
router.get('/api/reminder/today-status', requireStaff, async (req, res) => {
  const today = getTodayJST();
  const workday = isWorkday(today);

  if (!workday) {
    return res.json({ date: today, hasRecord: true, isWorkday: false, isOnLeave: false });
  }

  const onLeave = isOnLeaveToday(req.session.staffId, today);
  if (onLeave) {
    return res.json({ date: today, hasRecord: true, isWorkday: true, isOnLeave: true });
  }

  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === req.session.staffId);
  if (!staff) return res.json({ date: today, hasRecord: true, isWorkday: true, isOnLeave: false });

  const hasRecord = await hasRecordForDate(staff, today);
  res.json({ date: today, hasRecord, isWorkday: true, isOnLeave: false });
});

module.exports = router;
