'use strict';

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

const { loadStaff, saveStaff, loadRegistry, atomicModify, getSpreadsheetIdForYear } = require('../lib/data');
const { requireAdmin } = require('../lib/auth-middleware');
const { asyncRoute, colToIdx, idxToCol } = require('../lib/helpers');
const { auditLog } = require('../lib/audit');
const { getSheets, sheetsRetry } = require('../lib/sheets');
const { SPREADSHEET_ID, DATA_START_ROW, HEADER_ROW, MONTHS } = require('../lib/constants');

router.get('/api/admin/staff', requireAdmin, (req, res) => {
  const data = loadStaff();
  const includeArchived = req.query.includeArchived === 'true';
  const staff = includeArchived ? data.staff : data.staff.filter(s => !s.archived);
  // password_hash は秘密情報なので除外
  const safe = staff.map(s => {
    const { password_hash, ...rest } = s;
    return rest;
  });
  res.json(safe);
});

router.patch('/api/admin/staff/:id/archive', requireAdmin, asyncRoute((req, res) => {
  const result = atomicModify(() => {
    const data  = loadStaff();
    const staff = data.staff.find(s => s.id === req.params.id);
    if (!staff) return { error: 'スタッフが見つかりません', status: 404 };
    staff.archived = !staff.archived;
    saveStaff(data);
    return { staffId: staff.id, staffName: staff.name, archived: staff.archived, staff: data.staff };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  // requireStaff が毎リクエストDBを確認するため、即時に無効化が反映される
  auditLog(req, 'staff.archive_toggle', { type: 'staff', id: result.staffId, label: result.staffName }, { archived: result.archived });
  res.json({ success: true, archived: result.archived, staff: result.staff });
}));

router.post('/api/admin/staff', requireAdmin, asyncRoute(async (req, res) => {
  const { name, furigana_family, furigana_given, type, loginId, initialPw, hire_date, oncall, email } = req.body;
  if (!name || !type || !loginId || !initialPw)
    return res.status(400).json({ error: 'パラメータが不足しています' });
  if (initialPw.length < 8)
    return res.status(400).json({ error: '初期パスワードは8文字以上で設定してください' });
  const VALID_STAFF_TYPES = ['nurse', 'PT', 'OT', 'ST', 'office', 'admin'];
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

  const operations = []; // 実行レポート用

  try {
    const api = await getSheets();

    // 全登録済みスプレッドシートIDを取得
    const registry  = loadRegistry();
    const allSids   = [...new Set([SPREADSHEET_ID, ...Object.values(registry)])];

    let newEntry;
    let sheetErrors = [];
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
        operations.push({ action: 'spreadsheet_updated', spreadsheetId: ssId, year: ssYear, columns: { kaigo: kaigoCol, iryo: iryoCol }, sheets: vm });
        } catch (sheetErr) {
          console.error(`⚠️ スプレッドシート ${ssId} への列追加に失敗:`, sheetErr.message);
          sheetErrors.push(ssId);
          operations.push({ action: 'spreadsheet_error', spreadsheetId: ssId, error: sheetErr.message });
        }
      }
      newEntry = { id: loginId, name,
        furigana_family: furigana_family || '', furigana_given: furigana_given || '',
        type: 'nurse', kaigo_col: kaigoCol, iryo_col: iryoCol,
        seq: nextSeq, initial_pw: initialPw,
        hire_date: hire_date || null,
        oncall: oncall || '無',
        email: email || null,
        password_hash: await bcrypt.hash(initialPw, 10) };
      operations.push({ action: 'staff_record_created', staffId: loginId, name, type: 'nurse', columns: { kaigo: kaigoCol, iryo: iryoCol } });

    } else if (type === 'office' || type === 'admin') {
      // 事務職・管理者 — スプレッドシートに列を追加しない
      newEntry = { id: loginId, name,
        furigana_family: furigana_family || '', furigana_given: furigana_given || '',
        type,
        seq: nextSeq, initial_pw: initialPw,
        hire_date: hire_date || null,
        email: email || null,
        password_hash: await bcrypt.hash(initialPw, 10) };
      operations.push({ action: 'staff_record_created', staffId: loginId, name, type, columns: null, note: 'スプレッドシート列なし' });

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

      const rehabYearBySsId = Object.fromEntries(Object.entries(registry).map(([y, id]) => [id, parseInt(y)]));
      for (const ssId of allSids) {
        try {
        const ssYear = rehabYearBySsId[ssId] || new Date().getFullYear();
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
        operations.push({ action: 'spreadsheet_updated', spreadsheetId: ssId, year: ssYear, columns: { col: newCol }, sheets: vm });
        } catch (sheetErr) {
          console.error(`⚠️ スプレッドシート ${ssId} への列追加に失敗:`, sheetErr.message);
          sheetErrors.push(ssId);
          operations.push({ action: 'spreadsheet_error', spreadsheetId: ssId, error: sheetErr.message });
        }
      }
      newEntry = { id: loginId, name,
        furigana_family: furigana_family || '', furigana_given: furigana_given || '',
        type: type, col: newCol,
        seq: nextSeq, initial_pw: initialPw,
        hire_date: hire_date || null,
        email: email || null,
        password_hash: await bcrypt.hash(initialPw, 10) };
      operations.push({ action: 'staff_record_created', staffId: loginId, name, type, columns: { col: newCol } });
    }

    const isNurseType = type === 'nurse';
    const savedData = atomicModify(() => {
      const freshData = loadStaff();
      if (isNurseType) {
        for (const s of freshData.staff)
          if (s.type !== 'nurse') s.col = idxToCol(colToIdx(s.col) + 2);
      }
      freshData.staff.push(newEntry);
      saveStaff(freshData);
      return { staff: freshData.staff };
    });
    operations.push({ action: 'staff_json_saved' });
    auditLog(req, 'staff.create', { type: 'staff', id: loginId, label: name }, { type, loginId });
    const result = { success: true, staff: savedData.staff, operations };
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

router.patch('/api/admin/staff/:id', requireAdmin, asyncRoute((req, res) => {
  const { name, furigana_family, furigana_given, email } = req.body;
  if (!name) return res.status(400).json({ error: '氏名は必須です' });
  if (email !== undefined && email !== null && email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'メールアドレスの形式が正しくありません' });
  const result = atomicModify(() => {
    const data  = loadStaff();
    const staff = data.staff.find(s => s.id === req.params.id);
    if (!staff) return { error: 'スタッフが見つかりません', status: 404 };
    staff.name             = name;
    staff.furigana_family  = furigana_family  ?? staff.furigana_family;
    staff.furigana_given   = furigana_given   ?? staff.furigana_given;
    if (email !== undefined) staff.email = email || null;
    saveStaff(data);
    return { staffId: staff.id, allStaff: data.staff };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  auditLog(req, 'staff.update', { type: 'staff', id: result.staffId, label: name });
  res.json({ success: true, staff: result.allStaff });
}));

router.delete('/api/admin/staff/:id', requireAdmin, asyncRoute(async (req, res) => {
  // Pre-read to get removed staff info for Sheets operations
  const preData = loadStaff();
  const preIdx  = preData.staff.findIndex(s => s.id === req.params.id);
  if (preIdx === -1) return res.status(404).json({ error: 'スタッフが見つかりません' });
  const removed = { ...preData.staff[preIdx] };

  try {
    const api      = await getSheets();
    const registry = loadRegistry();
    const allSids  = [...new Set([SPREADSHEET_ID, ...Object.values(registry)])];

    const sheetErrors = [];
    // Compute divider info from pre-read data (excluding the staff to be removed)
    const preStaffWithoutRemoved = preData.staff.filter(s => s.id !== req.params.id);
    if (removed.type === 'nurse') {
      const delStart = colToIdx(removed.kaigo_col);
      const activeNursesBeforeDel = preStaffWithoutRemoved.filter(s => s.type === 'nurse' && !s.archived);
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
      // Compute new divider after column shift (simulate shift on pre-read data)
      const shiftedNurses = activeNursesBeforeDel.map(s => {
        if (colToIdx(s.kaigo_col) > delStart) {
          return { ...s, kaigo_col: idxToCol(colToIdx(s.kaigo_col) - 2), iryo_col: idxToCol(colToIdx(s.iryo_col) - 2) };
        }
        return s;
      });
      const newDividerIdx = shiftedNurses.length > 0
        ? Math.max(...shiftedNurses.map(s => colToIdx(s.iryo_col))) : null;
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

      // Atomically re-load, remove, shift columns, and save
      const saveResult = atomicModify(() => {
        const data = loadStaff();
        const idx = data.staff.findIndex(s => s.id === req.params.id);
        if (idx === -1) return { error: 'スタッフが見つかりません', status: 404 };
        data.staff.splice(idx, 1);
        for (const s of data.staff) {
          if (s.type === 'nurse' && colToIdx(s.kaigo_col) > delStart) {
            s.kaigo_col = idxToCol(colToIdx(s.kaigo_col) - 2);
            s.iryo_col  = idxToCol(colToIdx(s.iryo_col)  - 2);
          }
        }
        for (const s of data.staff) {
          if (s.type !== 'nurse') s.col = idxToCol(colToIdx(s.col) - 2);
        }
        saveStaff(data);
        return { staff: data.staff };
      });
      if (saveResult.error) return res.status(saveResult.status).json({ error: saveResult.error });

      auditLog(req, 'staff.delete', { type: 'staff', id: removed.id, label: removed.name });
      const result = { success: true, removed, staff: saveResult.staff };
      if (sheetErrors.length > 0) {
        result.warning = `${sheetErrors.length}件のスプレッドシートへの反映に失敗しました。手動確認が必要です。`;
        console.error('⚠️ スタッフ削除: 一部スプレッドシート反映失敗:', sheetErrors);
      }
      res.json(result);
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

      // Atomically re-load, remove, shift columns, and save
      const saveResult = atomicModify(() => {
        const data = loadStaff();
        const idx = data.staff.findIndex(s => s.id === req.params.id);
        if (idx === -1) return { error: 'スタッフが見つかりません', status: 404 };
        data.staff.splice(idx, 1);
        for (const s of data.staff) {
          if (s.type !== 'nurse' && colToIdx(s.col) > delIdx) {
            s.col = idxToCol(colToIdx(s.col) - 1);
          }
        }
        saveStaff(data);
        return { staff: data.staff };
      });
      if (saveResult.error) return res.status(saveResult.status).json({ error: saveResult.error });

      auditLog(req, 'staff.delete', { type: 'staff', id: removed.id, label: removed.name });
      const result = { success: true, removed, staff: saveResult.staff };
      if (sheetErrors.length > 0) {
        result.warning = `${sheetErrors.length}件のスプレッドシートへの反映に失敗しました。手動確認が必要です。`;
        console.error('⚠️ スタッフ削除: 一部スプレッドシート反映失敗:', sheetErrors);
      }
      res.json(result);
    } else {
      // No column to delete (e.g., office/admin type)
      const saveResult = atomicModify(() => {
        const data = loadStaff();
        const idx = data.staff.findIndex(s => s.id === req.params.id);
        if (idx === -1) return { error: 'スタッフが見つかりません', status: 404 };
        data.staff.splice(idx, 1);
        saveStaff(data);
        return { staff: data.staff };
      });
      if (saveResult.error) return res.status(saveResult.status).json({ error: saveResult.error });

      auditLog(req, 'staff.delete', { type: 'staff', id: removed.id, label: removed.name });
      res.json({ success: true, removed, staff: saveResult.staff });
    }
  } catch (e) {
    console.error('❌ スタッフ削除エラー:', e);
    res.status(500).json({ error: 'スタッフの削除に失敗しました' });
  }
}));

router.post('/api/admin/staff/:id/reset-password', requireAdmin, asyncRoute(async (req, res) => {
  // First read to get initial_pw (read-only, outside atomicModify)
  const preData = loadStaff();
  const preStaff = preData.staff.find(s => s.id === req.params.id);
  if (!preStaff) return res.status(404).json({ error: 'スタッフが見つかりません' });
  // initial_pwがあればそれを使用、なければランダム4桁パスワードを生成
  const newPw = preStaff.initial_pw || Math.random().toString(36).slice(-4).toUpperCase();
  const hash = await bcrypt.hash(newPw, 10);
  const result = atomicModify(() => {
    const data  = loadStaff();
    const staff = data.staff.find(s => s.id === req.params.id);
    if (!staff) return { error: 'スタッフが見つかりません', status: 404 };
    staff.password_hash = hash;
    saveStaff(data);
    return { staffId: staff.id, staffName: staff.name };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  auditLog(req, 'staff.reset_password', { type: 'staff', id: result.staffId, label: result.staffName });
  res.json({ success: true, initial_pw: newPw });
}));

// ─── API: 一時修正 – 列ズレ修正 v2（森部・佐原バグ対応） ─────────
router.post('/api/admin/fix-staff-columns', requireAdmin, asyncRoute((req, res) => {
  try {
    const result = atomicModify(() => {
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
      return { changes, allStaff: data.staff };
    });
    res.json({ success: true, changes: result.changes, staff: result.allStaff });
  } catch (e) {
    console.error('❌ staff sync error:', e);
    res.status(500).json({ error: 'スタッフ同期に失敗しました' });
  }
}));

module.exports = router;
