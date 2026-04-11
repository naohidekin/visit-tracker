'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');

const { loadStaff, loadExcelResults, saveExcelResults } = require('../lib/data');
const { requireAdmin } = require('../lib/auth-middleware');
const { getYearMonthJST } = require('../lib/helpers');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ─── API: Excel集計（visitCntDetail） ────────────────────────────
router.post('/api/admin/analyze-excel', requireAdmin, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'ファイルが必要です' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const results = [];
    const warnings = [];

    // Header name aliases for fuzzy column matching
    const TIME_ALIASES = ['提供時間', '提供時間（分）', '提供時間(分)', 'サービス提供時間', 'サービス提供時間（分）', 'サービス提供時間(分)'];
    const INSURANCE_ALIASES = ['保険適用', '保険種別', '保険区分', '適用保険'];

    // Load registered (non-archived) staff for filtering
    const staffData = loadStaff();
    const activeStaff = staffData.staff.filter(s => !s.archived);
    const registeredNames = activeStaff.map(s => s.name.replace(/\s+/g, ''));

    // Normalize a name for fuzzy matching: remove all spaces/full-width spaces, full-width alphanumeric → half-width
    function normalizeName(name) {
      return String(name || '')
        .replace(/[\s\u3000]+/g, '')
        .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c =>
          String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
        .trim();
    }

    // Try to match a staff name: exact first, then fuzzy
    function matchStaffName(rawName) {
      const normalized = normalizeName(rawName);
      if (registeredNames.includes(normalized)) {
        return { matched: true, name: rawName, fuzzy: false };
      }
      for (const s of activeStaff) {
        if (normalizeName(s.name) === normalized) {
          return { matched: true, name: s.name, fuzzy: true, original: rawName };
        }
      }
      return { matched: false, name: rawName, fuzzy: false };
    }

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

      // Staff name matching with fuzzy fallback
      const nameMatch = matchStaffName(staffName);
      if (!nameMatch.matched) {
        warnings.push(`シート「${sheetName}」: スタッフ「${staffName}」が登録スタッフに見つかりません（スキップ）`);
        continue;
      }
      if (nameMatch.fuzzy) {
        warnings.push(`シート「${sheetName}」: スタッフ名「${nameMatch.original}」→「${nameMatch.name}」にファジーマッチしました`);
      }
      const resolvedName = nameMatch.name;
      const qualification = qualMatch[1];
      const isNurse = qualification === '看護師';

      // Header row at index 5, data starts at index 6
      const headerRow = rows[5];
      if (!headerRow) continue;
      // Find column indices with alias support
      let colTime = -1, colInsurance = -1;
      let colTimeAlias = null, colInsuranceAlias = null;
      for (let c = 0; c < headerRow.length; c++) {
        const h = String(headerRow[c] || '').trim();
        if (colTime < 0) {
          const timeIdx = TIME_ALIASES.indexOf(h);
          if (timeIdx >= 0) {
            colTime = c;
            if (timeIdx > 0) colTimeAlias = h;
          }
        }
        if (colInsurance < 0) {
          const insIdx = INSURANCE_ALIASES.indexOf(h);
          if (insIdx >= 0) {
            colInsurance = c;
            if (insIdx > 0) colInsuranceAlias = h;
          }
        }
      }
      if (colTimeAlias) {
        warnings.push(`シート「${sheetName}」: ヘッダー「${colTimeAlias}」を「提供時間」として認識しました`);
      }
      if (colInsuranceAlias) {
        warnings.push(`シート「${sheetName}」: ヘッダー「${colInsuranceAlias}」を「保険適用」として認識しました`);
      }
      if (colTime < 0 || colInsurance < 0) {
        const missing = [];
        if (colTime < 0) missing.push('提供時間');
        if (colInsurance < 0) missing.push('保険適用');
        warnings.push(`シート「${sheetName}」: 必要なヘッダー列（${missing.join(', ')}）が見つかりません（スキップ）`);
        continue;
      }

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
        if (isNaN(rawMin) || rawMin <= 0) {
          const cellVal = row[colTime];
          if (cellVal !== null && cellVal !== undefined && String(cellVal).trim() !== '') {
            warnings.push(`シート「${sheetName}」行${r + 1}: 提供時間「${String(cellVal).slice(0, 20)}」を数値として解析できません（スキップ）`);
          }
          continue;
        }
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
        staffName: resolvedName,
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
    const ym = req.body.yearMonth || getYearMonthJST();
    const allResults = loadExcelResults();
    allResults[ym] = {
      analyzedAt: new Date().toISOString(),
      fileName: req.file.originalname || '',
      results,
    };
    saveExcelResults(allResults);

    res.json({ success: true, results, savedYearMonth: ym, warnings });
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

module.exports = router;
