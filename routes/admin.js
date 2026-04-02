'use strict';
// 管理者ルート（スタッフ管理・記録編集・インセンティブ・待機/雨の日・監査ログ等）

const express = require('express');
const router = express.Router();
const fs = require('fs');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const XLSX = require('xlsx');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const {
  loadStaff, saveStaff, loadRegistry, loadExcelResults, saveExcelResults,
  loadStandby, saveStandby, loadLeave, loadOncall, loadAttendance, loadNotices, saveNotices,
  withFileLock,
} = require('../lib/data');
const { requireAdmin } = require('../lib/auth-middleware');
const { requireStaff, setCsrfCookie, _invalidatedStaffIds } = require('../lib/auth-middleware');
const { checkRateLimit, lockedRoute, isValidDate, validateUnitValue, validateNum } = require('../lib/helpers');
const { auditLog, loadAuditLog, verifyAuditChain } = require('../lib/audit');
const { getSheets, sheetsRetry, getSpreadsheetIdForYear, createSpreadsheetForYear, colToIdx, idxToCol } = require('../lib/sheets');
const { calcLeaveBalance, calcLeaveGrantDays } = require('../lib/leave-calc');
const {
  STAFF_PATH, SPREADSHEET_ID, STANDBY_PATH, NOTICES_PATH,
  DATA_START_ROW, HEADER_ROW, MONTHS, WD, ALL_HOLIDAYS,
} = require('../lib/constants');

// ヘルパー: JST今日の日付
function getTodayJST() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function formatLocalDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function isWorkday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;
  if (ALL_HOLIDAYS.has(dateStr)) return false;
  return true;
}

function getStandbyFeeWithCustom(dateStr, customHols) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay();
  if (ALL_HOLIDAYS.has(dateStr) || customHols.has(dateStr)) return { fee: 10000, category: '祝日' };
  if (dow === 0) return { fee: 10000, category: '日曜' };
  if (dow === 6) return { fee: 5000, category: '土曜' };
  return { fee: 2000, category: '平日' };
}

function isOnLeaveToday(staffId, dateStr) {
  const leaveData = loadLeave();
  return leaveData.requests.some(r =>
    r.staffId === staffId &&
    (r.status === 'approved') &&
    r.dates.includes(dateStr)
  );
}

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

// ─── API: 診断 ──────────────────────────────────────────────────
router.get('/api/debug/sheets', requireAdmin, async (_req, res) => {
  const debugSid = getSpreadsheetIdForYear(new Date().getFullYear());
  try {
    const api = await getSheets();
    const meta = await api.spreadsheets.get({ spreadsheetId: debugSid });
    const mimeType = meta.data.spreadsheetId ? 'google-sheets' : 'unknown';
    const sheets = meta.data.sheets.map(s => ({
      title: s.properties.title,
      sheetId: s.properties.sheetId,
      merges: s.merges?.length ?? 0,
    }));
    // 1月シートの3月1日行をテスト読み取り
    let readTest = null;
    try {
      const r = await api.spreadsheets.values.get({
        spreadsheetId: debugSid,
        range: '1月!A5:M5',
      });
      readTest = r.data.values;
    } catch (re) {
      readTest = re.response?.data?.error?.message || re.message;
    }
    res.json({ mimeType, sheets, readTest });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// ─── API: 管理者用 月別日別明細 ────────────────────────────────
router.get('/api/admin/monthly-detail', requireAdmin, async (req, res) => {
  const { staffId, year, month } = req.query;
  if (!staffId || !year || !month) return res.status(400).json({ error: 'パラメータ不足' });

  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  const y   = Number(year), m = Number(month);
  const sid = getSpreadsheetIdForYear(y);
  const daysInMonth = new Date(y, m, 0).getDate();
  const endRow = DATA_START_ROW + daysInMonth - 1;
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
      const rawLineAN   = (staff.incentive_line != null) ? staff.incentive_line : iDef.nurse;
      const workRatioAN = (staff.work_hours != null) ? staff.work_hours / 8.0 : 1.0;
      const ilineAN     = Math.round(rawLineAN * workRatioAN * 100) / 100;
      const avg = working_days > 0 ? total / working_days : 0;
      const thresholdAN    = ilineAN * working_days;
      const over_hoursAN   = Math.max(0, total - thresholdAN);
      const incentive_countAN  = Math.floor(over_hoursAN / 0.5);
      const incentive_amountAN = incentive_countAN * 2000;
      res.json({ type: 'nurse', year: y, month: m, days,
        stats: { total_kaigo, total_iryo, total, working_days,
                 incentive_line: ilineAN, incentive_triggered: avg > ilineAN,
                 over_hours: Math.round(over_hoursAN * 10) / 10,
                 incentive_amount: incentive_amountAN,
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
      const avg = working_days > 0 ? total_units / working_days : 0;
      const threshold        = ilineAR * working_days;
      const over_units       = Math.max(0, total_units - threshold);
      const incentive_amount = Math.floor(over_units) * 500;
      res.json({ type: staff.type === 'nurse' ? 'nurse' : 'rehab', staffType: staff.type, year: y, month: m, days,
        stats: { total_units, working_days,
                 incentive_line: ilineAR, incentive_triggered: avg > ilineAR,
                 over_units: Math.floor(over_units), incentive_amount,
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
  const activeStaff = staffData.staff.filter(s => !s.archived && s.type !== 'office');

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
          const threshold = effectiveLine * working_days;
          const overHours = Math.max(0, total - threshold);
          const amount = Math.floor(overHours / 0.5) * 2000;
          total_amount += amount;
          results.push({
            id: staff.id, name: staff.name, type: 'nurse',
            work_hours: staff.work_hours ?? null,
            incentive_line: rawLine, effective_line: effectiveLine,
            working_days, threshold: Math.round(threshold * 100) / 100,
            total: Math.round(total * 10) / 10,
            total_kaigo: Math.round(total_kaigo * 10) / 10,
            total_iryo: Math.round(total_iryo * 10) / 10,
            over: Math.round(overHours * 10) / 10, amount
          });
        } else if (staff.type !== 'office' && staff.col) {
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
          const threshold = effectiveLine * working_days;
          const overUnits = Math.max(0, total_units - threshold);
          const amount = Math.floor(overUnits) * 500;
          total_amount += amount;
          results.push({
            id: staff.id, name: staff.name, type: staff.type,
            work_hours: staff.work_hours ?? null,
            incentive_line: rawLine, effective_line: effectiveLine,
            working_days, threshold: Math.round(threshold * 100) / 100,
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

// ─── API: 管理者用 記録書き込み ─────────────────────────────────
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

// ─── API: インセンティブ設定 ────────────────────────────────────
router.get('/api/admin/incentive', requireAdmin, (_req, res) => {
  const data = loadStaff();
  res.json({
    defaults: data.incentive_defaults || { nurse: 3.5, rehab: 20.0 },
    staff: data.staff.filter(s => !s.archived).map(s => ({
      id: s.id, name: s.name, type: s.type,
      furigana_family: s.furigana_family, furigana_given: s.furigana_given,
      incentive_line: s.incentive_line ?? null,
      work_hours: s.work_hours ?? null,
    })),
  });
});

router.post('/api/admin/incentive/defaults', requireAdmin, lockedRoute(STAFF_PATH, (req, res) => {
  const { nurse, rehab } = req.body;
  const nv = validateNum(nurse, { min: 0, max: 100 });
  const rv = validateNum(rehab, { min: 0, max: 100 });
  if (!nv.valid || !rv.valid) return res.status(400).json({ error: 'インセンティブラインは0〜100の数値で入力してください' });
  const data = loadStaff();
  data.incentive_defaults = { nurse: nv.value, rehab: rv.value };
  saveStaff(data);
  auditLog(req, 'incentive.defaults_update', { type: 'incentive' }, { nurse: nv.value, rehab: rv.value });
  res.json({ success: true });
}));

router.post('/api/admin/staff/:id/incentive', requireAdmin, lockedRoute(STAFF_PATH, (req, res) => {
  const data  = loadStaff();
  const staff = data.staff.find(s => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });
  const { line } = req.body;
  const lv = validateNum(line, { min: 0, max: 100, allowNull: true });
  if (!lv.valid) return res.status(400).json({ error: 'インセンティブラインは0〜100の数値で入力してください' });
  staff.incentive_line = lv.value;
  saveStaff(data);
  auditLog(req, 'incentive.staff_update', { type: 'incentive', id: staff.id, label: staff.name }, { line: staff.incentive_line });
  res.json({ success: true });
}));

router.post('/api/admin/staff/:id/work-hours', requireAdmin, lockedRoute(STAFF_PATH, (req, res) => {
  const data  = loadStaff();
  const staff = data.staff.find(s => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });
  const { work_hours } = req.body;
  const wv = validateNum(work_hours, { min: 0, max: 24, allowNull: true, allowEmpty: true });
  if (!wv.valid) return res.status(400).json({ error: '勤務時間は0〜24の数値で入力してください' });
  staff.work_hours = wv.value;
  saveStaff(data);
  auditLog(req, 'staff.work_hours_update', { type: 'staff', id: staff.id, label: staff.name }, { work_hours: staff.work_hours });
  res.json({ success: true });
}));

// ─── API: 管理者認証 ────────────────────────────────────────────
router.post('/api/admin/login', (req, res) => {
  // ブルートフォース対策: IP単位5回/5分
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (!checkRateLimit(`admin-login-ip:${ip}`, 5, 300000))
    return res.status(429).json({ error: 'ログイン試行回数が上限を超えました。しばらく待ってから再度お試しください' });

  if (req.body.password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    setCsrfCookie(res);
    auditLog(req, 'auth.admin_login', { type: 'auth', label: '管理者' });
    res.json({ success: true });
  } else {
    auditLog(req, 'auth.admin_login_failed', { type: 'auth', label: '管理者ログイン失敗' });
    res.status(401).json({ error: 'パスワードが正しくありません' });
  }
});
router.post('/api/admin/logout', (req, res) => {
  auditLog(req, 'auth.admin_logout', { type: 'auth', label: '管理者' });
  req.session.isAdmin = false;
  res.json({ success: true });
});

// ─── API: スタッフ管理 ──────────────────────────────────────────
router.get('/api/admin/staff', requireAdmin, (req, res) => {
  const data = loadStaff();
  const includeArchived = req.query.includeArchived === 'true';
  const staff = includeArchived ? data.staff : data.staff.filter(s => !s.archived);
  res.json(staff);
});

router.patch('/api/admin/staff/:id/archive', requireAdmin, lockedRoute(STAFF_PATH, (req, res) => {
  const data  = loadStaff();
  const staff = data.staff.find(s => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });
  staff.archived = !staff.archived;
  saveStaff(data);
  // アーカイブ時は即座にセッションを無効化、復帰時はブラックリストから除去
  if (staff.archived) {
    _invalidatedStaffIds.add(staff.id);
  } else {
    _invalidatedStaffIds.delete(staff.id);
  }
  auditLog(req, 'staff.archive_toggle', { type: 'staff', id: staff.id, label: staff.name }, { archived: staff.archived });
  res.json({ success: true, archived: staff.archived, staff: data.staff });
}));

router.post('/api/admin/staff', requireAdmin, lockedRoute(STAFF_PATH, async (req, res) => {
  const { name, furigana_family, furigana_given, type, loginId, initialPw, hire_date, oncall, email } = req.body;
  if (!name || !type || !loginId || !initialPw)
    return res.status(400).json({ error: 'パラメータが不足しています' });
  const VALID_STAFF_TYPES = ['nurse', 'PT', 'OT', 'ST', 'office'];
  if (!VALID_STAFF_TYPES.includes(type))
    return res.status(400).json({ error: `スタッフ種別が不正です（${VALID_STAFF_TYPES.join('/')}）` });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'メールアドレスの形式が正しくありません' });

  const data = loadStaff();
  if (data.staff.find(s => s.id === loginId))
    return res.status(400).json({ error: 'そのログインIDは既に使用されています' });

  // seq重複防止: 既存の最大seq + 1（削除済みスタッフのseqも考慮）
  const allSeqs = data.staff.map(s => s.seq || 0);
  const nextSeq = allSeqs.length > 0 ? Math.max(...allSeqs) + 1 : 1;

  try {
    const api = await getSheets();

    // 全登録済みスプレッドシートIDを取得
    const registry  = loadRegistry();
    const allSids   = [...new Set([SPREADSHEET_ID, ...Object.values(registry)])];

    let newEntry;
    if (type === 'nurse') {
      // C(index 2) + 看護師人数 × 2列 = 新看護師の介護列
      const nurseCount = data.staff.filter(s => s.type === 'nurse' && !s.archived).length;
      const kaigoIdx = 2 + nurseCount * 2;
      const kaigoCol = idxToCol(kaigoIdx);
      const iryoCol  = idxToCol(kaigoIdx + 1);
      // 太線の旧位置（追加前の最終iryo列）
      const oldDividerIdx = nurseCount > 0 ? kaigoIdx - 1 : null;
      const newDividerIdx = kaigoIdx + 1;

      const NURSE_DARK_BG  = { red: 0.18431373, green: 0.45882353, blue: 0.70980392 };
      const NURSE_NAME_BG  = { red: 0.8392157,  green: 0.89411765, blue: 0.9411765  };
      const NURSE_KAIGO_BG = { red: 221/255,    green: 238/255,    blue: 1.0        };
      const NURSE_IRYO_BG  = { red: 234/255,    green: 244/255,    blue: 1.0        };
      const TOTAL_BG       = { red: 1.0,        green: 242/255,    blue: 204/255    };
      const SUN_BG         = { red: 0.9882353,  green: 0.89411765, blue: 0.8392157  };
      // ssId → 年 の逆引きマップ
      const yearBySsId = Object.fromEntries(Object.entries(registry).map(([y, id]) => [id, parseInt(y)]));
      const SOLID        = { style: 'SOLID',       color: { red:0, green:0, blue:0 } };
      const SOLID_MEDIUM = { style: 'SOLID_MEDIUM', color: { red:0, green:0, blue:0 } };
      const familyName   = furigana_family ? name.split(/[\s　]/)[0] : name.split(/[\s　]/)[0];

      const sheetErrors = [];
      for (const ssId of allSids) {
        try {
        const ssYear = yearBySsId[ssId] || new Date().getFullYear();
        const ss = await api.spreadsheets.get({ spreadsheetId: ssId });
        const sm = {};
        for (const s of ss.data.sheets) sm[s.properties.title] = s.properties.sheetId;
        const vm = MONTHS.filter(m => sm[m] !== undefined);

        // 1. 列を挿入
        await api.spreadsheets.batchUpdate({
          spreadsheetId: ssId,
          requestBody: { requests: vm.map(m => ({
            insertDimension: { range: { sheetId: sm[m], dimension: 'COLUMNS',
              startIndex: kaigoIdx, endIndex: kaigoIdx + 2 }, inheritFromBefore: false },
          })) },
        });

        // 2. 行3（氏名）・行4（介護/医療）の値を書き込み
        await api.spreadsheets.values.batchUpdate({
          spreadsheetId: ssId,
          requestBody: { valueInputOption: 'USER_ENTERED', data: vm.flatMap(m => ([
            { range: `${m}!${kaigoCol}3:${iryoCol}3`,
              values: [[familyName, '']] },
            { range: `${m}!${kaigoCol}${HEADER_ROW}:${iryoCol}${HEADER_ROW}`,
              values: [['介護', '医療']] },
          ])) },
        });

        // 3. フォーマット・太線・ヘッダー結合を各シートに適用
        const fmtReqs = vm.flatMap(m => {
          const sid = sm[m];
          return [
            // 行2 看護ヘッダー結合を拡張（C〜新iryo列）
            { unmergeCells: { range: { sheetId: sid, startRowIndex: 1, endRowIndex: 2,
                startColumnIndex: 2, endColumnIndex: kaigoIdx + 2 } } },
            { mergeCells:   { range: { sheetId: sid, startRowIndex: 1, endRowIndex: 2,
                startColumnIndex: 2, endColumnIndex: kaigoIdx + 2 },
                mergeType: 'MERGE_ALL' } },
            // 行2 色（新列）
            { repeatCell: { range: { sheetId: sid, startRowIndex: 1, endRowIndex: 2,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 2 },
                cell: { userEnteredFormat: { backgroundColor: NURSE_DARK_BG,
                  textFormat: { bold: true }, horizontalAlignment: 'CENTER' } },
                fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } },
            // 行3 氏名セルを結合・色付け（Meiryo/10/bold/center）
            { unmergeCells: { range: { sheetId: sid, startRowIndex: 2, endRowIndex: 3,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 2 } } },
            { mergeCells: { range: { sheetId: sid, startRowIndex: 2, endRowIndex: 3,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 2 },
                mergeType: 'MERGE_ALL' } },
            { repeatCell: { range: { sheetId: sid, startRowIndex: 2, endRowIndex: 3,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 2 },
                cell: { userEnteredFormat: { backgroundColor: NURSE_NAME_BG,
                  textFormat: { fontFamily: 'Meiryo', fontSize: 10, bold: true },
                  horizontalAlignment: 'CENTER' } },
                fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } },
            // 行4 介護列（Meiryo/9/bold/center）
            { repeatCell: { range: { sheetId: sid, startRowIndex: 3, endRowIndex: 4,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 1 },
                cell: { userEnteredFormat: { backgroundColor: NURSE_KAIGO_BG,
                  textFormat: { fontFamily: 'Meiryo', fontSize: 9, bold: true },
                  horizontalAlignment: 'CENTER' } },
                fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } },
            // 行4 医療列（Meiryo/9/bold/center）
            { repeatCell: { range: { sheetId: sid, startRowIndex: 3, endRowIndex: 4,
                startColumnIndex: kaigoIdx + 1, endColumnIndex: kaigoIdx + 2 },
                cell: { userEnteredFormat: { backgroundColor: NURSE_IRYO_BG,
                  textFormat: { fontFamily: 'Meiryo', fontSize: 9, bold: true },
                  horizontalAlignment: 'CENTER' } },
                fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } },
            // 行5以降 データ列（介護）
            { repeatCell: { range: { sheetId: sid, startRowIndex: 4, endRowIndex: 36,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 1 },
                cell: { userEnteredFormat: { backgroundColor: NURSE_KAIGO_BG,
                  horizontalAlignment: 'CENTER' } },
                fields: 'userEnteredFormat(backgroundColor,horizontalAlignment)' } },
            // 行5以降 データ列（医療）
            { repeatCell: { range: { sheetId: sid, startRowIndex: 4, endRowIndex: 36,
                startColumnIndex: kaigoIdx + 1, endColumnIndex: kaigoIdx + 2 },
                cell: { userEnteredFormat: { backgroundColor: NURSE_IRYO_BG,
                  horizontalAlignment: 'CENTER' } },
                fields: 'userEnteredFormat(backgroundColor,horizontalAlignment)' } },
            // 日曜行のカラー（既存看護師と同じピンク）
            ...(() => {
              const monthNum = parseInt(m);
              const daysInMonth = new Date(ssYear, monthNum, 0).getDate();
              const sunReqs = [];
              for (let d = 1; d <= daysInMonth; d++) {
                if (new Date(ssYear, monthNum - 1, d).getDay() !== 0) continue;
                const rowIdx = DATA_START_ROW - 1 + (d - 1);
                sunReqs.push(
                  { repeatCell: { range: { sheetId: sid, startRowIndex: rowIdx, endRowIndex: rowIdx + 1,
                      startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 2 },
                      cell: { userEnteredFormat: { backgroundColor: SUN_BG } },
                      fields: 'userEnteredFormat.backgroundColor' } }
                );
              }
              return sunReqs;
            })(),
            // 旧太線を解除
            ...(oldDividerIdx !== null ? [
              { updateBorders: { range: { sheetId: sid, startRowIndex: 1, endRowIndex: 36,
                  startColumnIndex: oldDividerIdx, endColumnIndex: oldDividerIdx + 1 },
                  right: SOLID } },
              { updateBorders: { range: { sheetId: sid, startRowIndex: 1, endRowIndex: 36,
                  startColumnIndex: oldDividerIdx + 1, endColumnIndex: oldDividerIdx + 2 },
                  left: SOLID } },
            ] : []),
            // 新太線を設定（リハビリ職がいない場合のみ新iryo列右に設定。いる場合は最終PT列右で管理）
            ...(() => {
              const rehabCount = data.staff.filter(s => !['nurse','office'].includes(s.type) && !s.archived).length;
              if (rehabCount > 0) return []; // リハビリがいる場合は太線を動かさない
              return [
                { updateBorders: { range: { sheetId: sid, startRowIndex: 1, endRowIndex: 36,
                    startColumnIndex: newDividerIdx, endColumnIndex: newDividerIdx + 1 },
                    right: SOLID_MEDIUM } },
              ];
            })(),
            // 列幅を既存看護師と同じ 48px に設定
            { updateDimensionProperties: {
                range: { sheetId: sid, dimension: 'COLUMNS',
                  startIndex: kaigoIdx, endIndex: kaigoIdx + 2 },
                properties: { pixelSize: 48 },
                fields: 'pixelSize' } },
          ];
        });
        await api.spreadsheets.batchUpdate({ spreadsheetId: ssId, requestBody: { requests: fmtReqs } });

        // 4. 合計行・個人計行のフォーマットと数式を設定
        for (const m of vm) {
          const sheetVals = await api.spreadsheets.values.get({
            spreadsheetId: ssId, range: `${m}!A1:A40` });
          const totalRowIdx = (sheetVals.data.values || []).findIndex(r => r[0]?.includes('合'));
          if (totalRowIdx < 0) continue;
          const tI = totalRowIdx;
          const kI = totalRowIdx + 1;
          const tRow = tI + 1; // 1-based
          const kRow = kI + 1;
          const dataEnd = tI; // データ最終行（1-based）
          const sid = sm[m];

          // 合計行 新列のフォーマット
          const totalFmt = [
            { repeatCell: { range: { sheetId: sid, startRowIndex: tI, endRowIndex: tI + 1,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 2 },
                cell: { userEnteredFormat: { backgroundColor: TOTAL_BG,
                  textFormat: { fontFamily: 'Meiryo', fontSize: 11, bold: true },
                  horizontalAlignment: 'CENTER' } },
                fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } },
            { updateBorders: { range: { sheetId: sid, startRowIndex: tI, endRowIndex: tI + 1,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 2 },
                top: SOLID_MEDIUM, bottom: SOLID_MEDIUM, left: SOLID, right: SOLID } },
            // 個人計行 新列を結合・フォーマット
            { unmergeCells: { range: { sheetId: sid, startRowIndex: kI, endRowIndex: kI + 1,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 2 } } },
            { mergeCells: { range: { sheetId: sid, startRowIndex: kI, endRowIndex: kI + 1,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 2 },
                mergeType: 'MERGE_ALL' } },
            { repeatCell: { range: { sheetId: sid, startRowIndex: kI, endRowIndex: kI + 1,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 2 },
                cell: { userEnteredFormat: { backgroundColor: NURSE_KAIGO_BG,
                  textFormat: { fontFamily: 'Meiryo', fontSize: 11, bold: true },
                  horizontalAlignment: 'CENTER',
                  numberFormat: { type: 'NUMBER', pattern: '0.0' } } },
                fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,numberFormat)' } },
            { updateBorders: { range: { sheetId: sid, startRowIndex: kI, endRowIndex: kI + 1,
                startColumnIndex: kaigoIdx, endColumnIndex: kaigoIdx + 2 },
                top: SOLID, bottom: SOLID_MEDIUM, left: SOLID,
                right: (kaigoIdx + 1 === newDividerIdx) ? SOLID_MEDIUM : SOLID } },
            // 旧個人計の右ボーダーを修正（前の看護師の結合セル右端）
            ...(oldDividerIdx !== null ? [
              { updateBorders: { range: { sheetId: sid, startRowIndex: kI, endRowIndex: kI + 1,
                  startColumnIndex: oldDividerIdx - 1, endColumnIndex: oldDividerIdx + 1 },
                  right: SOLID } },
            ] : []),
          ];
          await api.spreadsheets.batchUpdate({ spreadsheetId: ssId, requestBody: { requests: totalFmt } });

          // 合計行 数式、個人計行 数式
          await api.spreadsheets.values.batchUpdate({ spreadsheetId: ssId, requestBody: {
            valueInputOption: 'USER_ENTERED', data: [
              { range: `${m}!${kaigoCol}${tRow}`,
                values: [[`=SUM(${kaigoCol}5:${kaigoCol}${dataEnd})`]] },
              { range: `${m}!${iryoCol}${tRow}`,
                values: [[`=SUM(${iryoCol}5:${iryoCol}${dataEnd})`]] },
              { range: `${m}!${kaigoCol}${kRow}`,
                values: [[`=${kaigoCol}${tRow}+${iryoCol}${tRow}`]] },
            ]}});
        }
        } catch (sheetErr) {
          console.error(`⚠️ スプレッドシート ${ssId} への列追加に失敗:`, sheetErr.message);
          sheetErrors.push(ssId);
        }
      }
      for (const s of data.staff)
        if (s.type !== 'nurse') s.col = idxToCol(colToIdx(s.col) + 2);

      newEntry = { id: loginId, name,
        furigana_family: furigana_family || '', furigana_given: furigana_given || '',
        type: 'nurse', kaigo_col: kaigoCol, iryo_col: iryoCol,
        seq: nextSeq, initial_pw: initialPw,
        hire_date: hire_date || null,
        oncall: oncall || '無',
        email: email || null,
        password_hash: await bcrypt.hash(initialPw, 10) };

    } else if (type === 'office') {
      // 事務職 — スプレッドシートに列を追加しない（有給管理のみ）
      newEntry = { id: loginId, name,
        furigana_family: furigana_family || '', furigana_given: furigana_given || '',
        type: 'office',
        seq: nextSeq, initial_pw: initialPw,
        hire_date: hire_date || null,
        email: email || null,
        password_hash: await bcrypt.hash(initialPw, 10) };

    } else {
      // C(index 2) + 看護師人数 × 2列 + リハビリ人数 = 新リハビリの列
      const nurseCount = data.staff.filter(s => s.type === 'nurse' && !s.archived).length;
      const rehabCount = data.staff.filter(s => !['nurse','office'].includes(s.type) && !s.archived).length;
      const newColIdx = 2 + nurseCount * 2 + rehabCount;
      const newCol    = idxToCol(newColIdx);
      // 旧最終スタッフ列（太線を移動する元の列）
      const oldLastColIdx = rehabCount > 0
        ? 2 + nurseCount * 2 + rehabCount - 1   // 直前のリハビリ最終列
        : 2 + nurseCount * 2 - 1;                // リハビリ未登録時は看護師最終iryo列
      const SOLID        = { style: 'SOLID',        color: { red:0, green:0, blue:0 } };
      const SOLID_MEDIUM = { style: 'SOLID_MEDIUM', color: { red:0, green:0, blue:0 } };

      const sheetErrors = [];
      for (const ssId of allSids) {
        try {
        const ss = await api.spreadsheets.get({ spreadsheetId: ssId });
        const sm = {};
        for (const s of ss.data.sheets) sm[s.properties.title] = s.properties.sheetId;
        const vm = MONTHS.filter(m => sm[m] !== undefined);
        // 列挿入
        await api.spreadsheets.batchUpdate({
          spreadsheetId: ssId,
          requestBody: { requests: vm.map(m => ({
            insertDimension: { range: { sheetId: sm[m], dimension: 'COLUMNS',
              startIndex: newColIdx, endIndex: newColIdx + 1 }, inheritFromBefore: false },
          })) },
        });
        // ヘッダー名
        await api.spreadsheets.values.batchUpdate({
          spreadsheetId: ssId,
          requestBody: { valueInputOption: 'USER_ENTERED', data: vm.map(m => ({
            range: `${m}!${newCol}${HEADER_ROW}`, values: [[name]],
          })) },
        });
        // 太線を旧最終列右から新最終列右へ移動
        await api.spreadsheets.batchUpdate({
          spreadsheetId: ssId,
          requestBody: { requests: vm.flatMap(m => {
            const sid = sm[m];
            const rowRange = (ci) => ({ sheetId: sid, startRowIndex: 0, endRowIndex: 37, startColumnIndex: ci, endColumnIndex: ci + 1 });
            return [
              { updateBorders: { range: rowRange(oldLastColIdx), right: SOLID } },        // 旧太線を解除
              { updateBorders: { range: rowRange(newColIdx),     right: SOLID_MEDIUM } }, // 新太線を設定
            ];
          }) },
        });
        } catch (sheetErr) {
          console.error(`⚠️ スプレッドシート ${ssId} への列追加に失敗:`, sheetErr.message);
          sheetErrors.push(ssId);
        }
      }
      newEntry = { id: loginId, name,
        furigana_family: furigana_family || '', furigana_given: furigana_given || '',
        type: type, col: newCol,
        seq: nextSeq, initial_pw: initialPw,
        hire_date: hire_date || null,
        email: email || null,
        password_hash: await bcrypt.hash(initialPw, 10) };
    }

    data.staff.push(newEntry);
    saveStaff(data);
    auditLog(req, 'staff.create', { type: 'staff', id: loginId, label: name }, { type, loginId });
    const result = { success: true, staff: data.staff };
    if (sheetErrors.length > 0) {
      result.warning = `${sheetErrors.length}件のスプレッドシートへの反映に失敗しました。管理者にお知らせください。`;
      console.error('⚠️ スタッフ追加: 一部スプレッドシート反映失敗:', sheetErrors);
    }
    res.json(result);
  } catch (e) {
    console.error('❌ スタッフ追加エラー:', e);
    res.status(500).json({ error: 'スタッフの追加に失敗しました' });
  }
}));

router.patch('/api/admin/staff/:id', requireAdmin, lockedRoute(STAFF_PATH, (req, res) => {
  const { name, furigana_family, furigana_given, email } = req.body;
  if (!name) return res.status(400).json({ error: '氏名は必須です' });
  if (email !== undefined && email !== null && email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'メールアドレスの形式が正しくありません' });
  const data  = loadStaff();
  const staff = data.staff.find(s => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });
  staff.name             = name;
  staff.furigana_family  = furigana_family  ?? staff.furigana_family;
  staff.furigana_given   = furigana_given   ?? staff.furigana_given;
  if (email !== undefined) staff.email = email || null;
  saveStaff(data);
  auditLog(req, 'staff.update', { type: 'staff', id: staff.id, label: name });
  res.json({ success: true, staff: data.staff });
}));

router.delete('/api/admin/staff/:id', requireAdmin, lockedRoute(STAFF_PATH, async (req, res) => {
  const data = loadStaff();
  const idx  = data.staff.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'スタッフが見つかりません' });
  const [removed] = data.staff.splice(idx, 1);

  try {
    const api      = await getSheets();
    const registry = loadRegistry();
    const allSids  = [...new Set([SPREADSHEET_ID, ...Object.values(registry)])];

    const sheetErrors = [];
    if (removed.type === 'nurse') {
      const delStart = colToIdx(removed.kaigo_col);
      const activeNursesBeforeDel = data.staff.filter(s => s.type === 'nurse' && !s.archived);
      const oldDividerIdx = activeNursesBeforeDel.length > 0
        ? Math.max(...activeNursesBeforeDel.map(s => colToIdx(s.iryo_col))) : null;

      for (const ssId of allSids) {
        try {
          const ss = await api.spreadsheets.get({ spreadsheetId: ssId });
          const sm = {};
          for (const s of ss.data.sheets) sm[s.properties.title] = s.properties.sheetId;
          const vm = MONTHS.filter(m => sm[m] !== undefined);
          await api.spreadsheets.batchUpdate({
            spreadsheetId: ssId,
            requestBody: { requests: vm.map(m => ({
              deleteDimension: { range: { sheetId: sm[m], dimension: 'COLUMNS',
                startIndex: delStart, endIndex: delStart + 2 } },
            })) },
          });
        } catch (sheetErr) {
          console.error(`⚠️ スプレッドシート ${ssId} の列削除に失敗:`, sheetErr.message);
          sheetErrors.push(ssId);
        }
      }
      for (const s of data.staff) {
        if (s.type === 'nurse' && colToIdx(s.kaigo_col) > delStart) {
          s.kaigo_col = idxToCol(colToIdx(s.kaigo_col) - 2);
          s.iryo_col  = idxToCol(colToIdx(s.iryo_col)  - 2);
        }
      }
      for (const s of data.staff) {
        if (s.type !== 'nurse') s.col = idxToCol(colToIdx(s.col) - 2);
      }
      const activeNursesAfterDel = data.staff.filter(s => s.type === 'nurse' && !s.archived);
      const newDividerIdx = activeNursesAfterDel.length > 0
        ? Math.max(...activeNursesAfterDel.map(s => colToIdx(s.iryo_col))) : null;
      const SOLID        = { style: 'SOLID',       color: { red:0, green:0, blue:0 } };
      const SOLID_MEDIUM = { style: 'SOLID_MEDIUM', color: { red:0, green:0, blue:0 } };
      for (const ssId of allSids) {
        try {
          const ss = await api.spreadsheets.get({ spreadsheetId: ssId });
          const sm = {};
          for (const s of ss.data.sheets) sm[s.properties.title] = s.properties.sheetId;
          const vm = MONTHS.filter(m => sm[m] !== undefined);
          const borderReqs = vm.flatMap(m => {
            const sid = sm[m];
            return [
              ...(oldDividerIdx !== null ? [
                { updateBorders: { range: { sheetId: sid, startRowIndex: 1, endRowIndex: 36,
                    startColumnIndex: oldDividerIdx - 2, endColumnIndex: oldDividerIdx - 1 },
                    right: SOLID } },
                { updateBorders: { range: { sheetId: sid, startRowIndex: 1, endRowIndex: 36,
                    startColumnIndex: oldDividerIdx - 1, endColumnIndex: oldDividerIdx },
                    left: SOLID } },
              ] : []),
              ...(newDividerIdx !== null ? [
                { updateBorders: { range: { sheetId: sid, startRowIndex: 1, endRowIndex: 36,
                    startColumnIndex: newDividerIdx, endColumnIndex: newDividerIdx + 1 },
                    right: SOLID_MEDIUM } },
                { updateBorders: { range: { sheetId: sid, startRowIndex: 1, endRowIndex: 36,
                    startColumnIndex: newDividerIdx + 1, endColumnIndex: newDividerIdx + 2 },
                    left: SOLID_MEDIUM } },
              ] : []),
            ];
          });
          if (borderReqs.length > 0)
            await api.spreadsheets.batchUpdate({ spreadsheetId: ssId, requestBody: { requests: borderReqs } });
        } catch (sheetErr) {
          console.error(`⚠️ スプレッドシート ${ssId} の太線更新に失敗:`, sheetErr.message);
          if (!sheetErrors.includes(ssId)) sheetErrors.push(ssId);
        }
      }
    } else if (removed.col) {
      const delIdx = colToIdx(removed.col);
      for (const ssId of allSids) {
        try {
          const ss = await api.spreadsheets.get({ spreadsheetId: ssId });
          const sm = {};
          for (const s of ss.data.sheets) sm[s.properties.title] = s.properties.sheetId;
          const vm = MONTHS.filter(m => sm[m] !== undefined);
          await api.spreadsheets.batchUpdate({
            spreadsheetId: ssId,
            requestBody: { requests: vm.map(m => ({
              deleteDimension: { range: { sheetId: sm[m], dimension: 'COLUMNS',
                startIndex: delIdx, endIndex: delIdx + 1 } },
            })) },
          });
        } catch (sheetErr) {
          console.error(`⚠️ スプレッドシート ${ssId} の列削除に失敗:`, sheetErr.message);
          sheetErrors.push(ssId);
        }
      }
      for (const s of data.staff) {
        if (s.type !== 'nurse' && colToIdx(s.col) > delIdx) {
          s.col = idxToCol(colToIdx(s.col) - 1);
        }
      }
    }

    saveStaff(data);
    auditLog(req, 'staff.delete', { type: 'staff', id: removed.id, label: removed.name });
    const result = { success: true, removed, staff: data.staff };
    if (sheetErrors.length > 0) {
      result.warning = `${sheetErrors.length}件のスプレッドシートへの反映に失敗しました。手動確認が必要です。`;
      console.error('⚠️ スタッフ削除: 一部スプレッドシート反映失敗:', sheetErrors);
    }
    res.json(result);
  } catch (e) {
    console.error('❌ スタッフ削除エラー:', e);
    res.status(500).json({ error: 'スタッフの削除に失敗しました' });
  }
}));

router.post('/api/admin/staff/:id/reset-password', requireAdmin, lockedRoute(STAFF_PATH, async (req, res) => {
  const data  = loadStaff();
  const staff = data.staff.find(s => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });
  // initial_pwがあればそれを使用、なければランダム4桁パスワードを生成
  const newPw = staff.initial_pw || Math.random().toString(36).slice(-4).toUpperCase();
  staff.password_hash = await bcrypt.hash(newPw, 10);
  saveStaff(data);
  auditLog(req, 'staff.reset_password', { type: 'staff', id: staff.id, label: staff.name });
  res.json({ success: true, initial_pw: newPw });
}));

// ─── API: 一時修正 – 列ズレ修正 v2（森部・佐原バグ対応） ─────────
router.post('/api/admin/fix-staff-columns', requireAdmin, lockedRoute(STAFF_PATH, (req, res) => {
  try {
    const data = loadStaff();
    const changes = [];

    // PT の列を修正（既に正しい場合はスキップ）
    const ptFixes = { nakashima05: 'O', ozawa06: 'P', ooe07: 'Q' };
    for (const s of data.staff) {
      if (ptFixes[s.id] && s.col !== ptFixes[s.id]) {
        changes.push(`${s.name}: col ${s.col}→${ptFixes[s.id]}`);
        s.col = ptFixes[s.id];
      }
    }

    // 正規の森部・佐原エントリの列を確定（IDで特定）
    const nurseFixes = {
      moribe10: { kaigo_col: 'K', iryo_col: 'L' },
      sahara11: { kaigo_col: 'M', iryo_col: 'N' },
    };
    for (const s of data.staff) {
      if (nurseFixes[s.id]) {
        const fix = nurseFixes[s.id];
        if (s.kaigo_col !== fix.kaigo_col) {
          changes.push(`${s.name}(${s.id}): kaigo_col ${s.kaigo_col}→${fix.kaigo_col}`);
          s.kaigo_col = fix.kaigo_col;
          s.iryo_col  = fix.iryo_col;
        }
      }
    }

    // 重複エントリ（morobe08/sahara09）をスタッフリストから削除（スプレッドシートは触らない）
    const duplicateIds = ['morobe08', 'sahara09'];
    const before = data.staff.length;
    data.staff = data.staff.filter(s => !duplicateIds.includes(s.id));
    const removedCount = before - data.staff.length;
    if (removedCount > 0) changes.push(`重複エントリ削除: ${duplicateIds.join(', ')} (${removedCount}件)`);

    saveStaff(data);
    res.json({ success: true, changes, staff: data.staff });
  } catch (e) {
    console.error('❌ staff sync error:', e);
    res.status(500).json({ error: 'スタッフ同期に失敗しました' });
  }
}));

// ─── API: 翌年スプレッドシート作成 ─────────────────────────────
router.post('/api/admin/create-next-year-sheet', requireAdmin, async (_req, res) => {
  const nextYear = new Date().getFullYear() + 1;
  try {
    const newId = await createSpreadsheetForYear(nextYear);
    res.json({
      success: true, year: nextYear, spreadsheetId: newId,
      url: `https://docs.google.com/spreadsheets/d/${newId}`,
    });
  } catch (e) {
    if (e.message.startsWith('already_exists:')) {
      const existingId = e.message.slice('already_exists:'.length);
      return res.json({
        success: false, already_exists: true, year: nextYear, spreadsheetId: existingId,
        url: `https://docs.google.com/spreadsheets/d/${existingId}`,
      });
    }
    console.error('❌ create-next-year-sheet error:', e.message);
    res.status(500).json({ error: '翌年スプレッドシートの作成に失敗しました' });
  }
});

// ─── API: スプレッドシートレジストリ取得 ───────────────────────
router.get('/api/admin/registry', requireAdmin, (_req, res) => {
  const reg = loadRegistry();
  res.json(Object.entries(reg).map(([year, id]) => ({
    year, spreadsheetId: id,
    url: `https://docs.google.com/spreadsheets/d/${id}`,
  })));
});

// ─── API: Excel集計（visitCntDetail） ────────────────────────────
router.post('/api/admin/analyze-excel', requireAdmin, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'ファイルが必要です' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const results = [];

    // Load registered (non-archived) staff for filtering
    const staffData = JSON.parse(fs.readFileSync(STAFF_PATH, 'utf8'));
    const registeredNames = staffData.staff
      .filter(s => !s.archived)
      .map(s => s.name.replace(/\s+/g, ''));

    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      // Fix !ref: the exported Excel often has truncated range
      let maxR = 0, maxC = 0;
      for (const key of Object.keys(ws)) {
        if (key[0] === '!') continue;
        const cell = XLSX.utils.decode_cell(key);
        if (cell.r > maxR) maxR = cell.r;
        if (cell.c > maxC) maxC = cell.c;
      }
      if (maxR > 0) ws['!ref'] = 'A1:' + XLSX.utils.encode_cell({ r: maxR, c: maxC });
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
      if (rows.length < 6) continue;

      // Row 1 (index 1): name and qualification
      const nameQual = String(rows[1]?.[0] || '');
      const qualMatch = nameQual.match(/[（(](看護師|PT|OT|ST)[）)]/);
      if (!qualMatch) continue;

      const staffName = nameQual.replace(/[（(](看護師|PT|OT|ST)[）)]/, '').trim();

      // Only include registered (full-time) staff
      const normalized = staffName.replace(/\s+/g, '');
      if (!registeredNames.includes(normalized)) continue;
      const qualification = qualMatch[1];
      const isNurse = qualification === '看護師';

      // Header row at index 5, data starts at index 6
      const headerRow = rows[5];
      if (!headerRow) continue;
      // Find column indices
      let colTime = -1, colInsurance = -1;
      for (let c = 0; c < headerRow.length; c++) {
        const h = String(headerRow[c] || '');
        if (h === '提供時間' && colTime < 0) colTime = c;
        if (h === '保険適用') colInsurance = c;
      }
      if (colTime < 0 || colInsurance < 0) continue;

      let totalMinutes = 0;      // for nurses
      let totalUnits = 0;        // for rehab
      let visitCount = 0;
      const visits = [];

      for (let r = 6; r < rows.length; r++) {
        const row = rows[r];
        if (!row || row[colTime] == null) continue;
        // Skip summary/total rows
        const firstCell = String(row[0] || '');
        if (firstCell === '合計' || firstCell === '小計') continue;
        const rawMin = parseInt(row[colTime], 10);
        if (isNaN(rawMin) || rawMin <= 0) continue;
        const insurance = String(row[colInsurance] || '');
        visitCount++;

        if (isNurse) {
          // Round: 29→30, 59→60, 89→90
          let rounded = rawMin;
          if (rawMin >= 25 && rawMin <= 34) rounded = 30;
          else if (rawMin >= 55 && rawMin <= 64) rounded = 60;
          else if (rawMin >= 85 && rawMin <= 94) rounded = 90;
          totalMinutes += rounded;
          visits.push({ raw: rawMin, rounded, insurance });
        } else {
          // Rehab: medical=4 units, kaigo=minutes/10
          let units = 0;
          if (insurance === '医療') {
            units = 4;
          } else {
            units = Math.round(rawMin / 10);
          }
          totalUnits += units;
          visits.push({ raw: rawMin, units, insurance });
        }
      }

      const entry = {
        sheetName,
        staffName,
        qualification,
        isNurse,
        visitCount,
      };
      if (isNurse) {
        entry.totalMinutes = totalMinutes;
        entry.totalHours = Math.round(totalMinutes / 60 * 10) / 10;
      } else {
        entry.totalUnits = totalUnits;
      }
      results.push(entry);
    }

    // Sort: nurses first, then rehab
    results.sort((a, b) => {
      if (a.isNurse !== b.isNurse) return a.isNurse ? -1 : 1;
      return 0;
    });

    // Auto-save results
    const ym = req.body.yearMonth || (() => {
      const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
      return `${jst.getFullYear()}-${String(jst.getMonth()+1).padStart(2,'0')}`;
    })();
    const allResults = loadExcelResults();
    allResults[ym] = {
      analyzedAt: new Date().toISOString(),
      fileName: req.file.originalname || '',
      results,
    };
    saveExcelResults(allResults);

    res.json({ success: true, results, savedYearMonth: ym });
  } catch (e) {
    console.error('Excel analyze error:', e);
    res.status(500).json({ error: 'Excel解析に失敗しました。ファイル形式を確認してください' });
  }
});

// ─── API: Excel集計履歴 ──────────────────────────────────────
router.get('/api/admin/excel-results', requireAdmin, (_req, res) => {
  const data = loadExcelResults();
  const periods = Object.keys(data).sort().reverse().map(ym => ({
    yearMonth: ym,
    analyzedAt: data[ym].analyzedAt,
    fileName: data[ym].fileName,
  }));
  res.json(periods);
});

router.get('/api/admin/excel-results/:yearMonth', requireAdmin, (req, res) => {
  const data = loadExcelResults();
  const entry = data[req.params.yearMonth];
  if (!entry) return res.status(404).json({ error: '該当期間のデータがありません' });
  res.json(entry);
});

// ─── API: 待機管理（管理者向け） ──────────────────────────────

// 待機対象スタッフ一覧（看護師 + oncall_eligible）
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
router.post('/api/admin/standby/records', requireAdmin, lockedRoute(STANDBY_PATH, (req, res) => {
  const { date, staffId } = req.body;
  if (!date) return res.status(400).json({ error: 'date は必須です' });
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
  auditLog(req, 'standby.upsert', { type: 'standby', id: date }, { date, staffId: staffId || '(削除)' });
  res.json({ ok: true });
}));

// 待機記録削除
router.delete('/api/admin/standby/records/:date', requireAdmin, lockedRoute(STANDBY_PATH, (req, res) => {
  const data = loadStandby();
  const idx = data.records.findIndex(r => r.date === req.params.date);
  if (idx < 0) return res.status(404).json({ error: '記録が見つかりません' });
  data.records.splice(idx, 1);
  saveStandby(data);
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
router.post('/api/admin/standby/custom-holidays', requireAdmin, lockedRoute(STANDBY_PATH, (req, res) => {
  const { dates } = req.body;
  if (!Array.isArray(dates)) return res.status(400).json({ error: 'dates は配列で指定してください' });
  const data = loadStandby();
  data.customHolidays = dates.sort();
  saveStandby(data);
  auditLog(req, 'standby.custom_holidays', { type: 'standby', id: 'custom-holidays' }, { count: dates.length });
  res.json({ ok: true, customHolidays: data.customHolidays });
}));

// ─── API: 雨の日管理（管理者向け） ──────────────────────────────

router.post('/api/admin/rainy/toggle', requireAdmin, lockedRoute(STANDBY_PATH, (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'date は必須です' });
  const data = loadStandby();
  const idx = data.rainyDays.indexOf(date);
  if (idx >= 0) {
    data.rainyDays.splice(idx, 1);
  } else {
    data.rainyDays.push(date);
    data.rainyDays.sort();
  }
  saveStandby(data);
  const isRainy = data.rainyDays.includes(date);
  auditLog(req, 'rainy.toggle', { type: 'rainy', id: date }, { rainy: isRainy });
  res.json({ ok: true, rainy: isRainy });
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

// ─── API: 監査ログ（管理者向け） ──────────────────────────────
router.get('/api/admin/audit-log', requireAdmin, (req, res) => {
  const log = loadAuditLog();
  const { from, to, action, actor, page = 1, limit = 50 } = req.query;
  let filtered = log;

  if (from) filtered = filtered.filter(e => e.timestamp >= from);
  if (to)   filtered = filtered.filter(e => e.timestamp <= to + 'T23:59:59');
  if (action) filtered = filtered.filter(e => e.action.startsWith(action));
  if (actor)  filtered = filtered.filter(e => e.actor.staffId === actor || e.actor.type === actor);

  // 新しい順
  filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const total = filtered.length;
  const p = Math.max(1, Number(page));
  const l = Math.min(100, Math.max(1, Number(limit)));
  const start = (p - 1) * l;
  const entries = filtered.slice(start, start + l);

  res.json({ total, page: p, limit: l, pages: Math.ceil(total / l), entries });
});

router.get('/api/admin/audit-log/verify', requireAdmin, (_req, res) => {
  const result = verifyAuditChain();
  res.json(result);
});

// ─── 出勤確定 月次集計 API ──────────────────────────────────────
router.get('/api/admin/attendance/monthly', requireAdmin, async (req, res) => {
  const { month } = req.query;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: '月の形式が不正です (YYYY-MM)' });

  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  const m = Number(monthStr);
  const daysInMonth = new Date(year, m, 0).getDate();

  const staffData = loadStaff();
  const activeStaff = staffData.staff.filter(s => !s.archived && s.type !== 'office');
  const attendanceData = loadAttendance();
  const leaveData = loadLeave();

  // 雨の日データを待機データから取得
  const standbyData = loadStandby();
  const rainyDaysSet = new Set((standbyData.rainyDays || []).filter(d => d.startsWith(month)));

  // スタッフ別集計初期化
  const summary = {};
  for (const s of activeStaff) {
    summary[s.id] = {
      staffId: s.id, name: s.name, type: s.type,
      workDays: 0, confirmedDays: 0, absentDays: 0, leaveDays: 0,
      unconfirmedDays: 0, rainyDayAttendance: 0,
    };
  }

  // 日ごとに集計
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${yearStr}-${monthStr}-${String(d).padStart(2, '0')}`;
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

  res.json({
    month,
    rainyDays: Array.from(rainyDaysSet).sort(),
    rainyDayCount: rainyDaysSet.size,
    staff: Object.values(summary),
  });
});

module.exports = router;
