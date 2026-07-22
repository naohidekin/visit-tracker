'use strict';
// スタッフ列割り当ての整合性チェック（読み取り専用の調査ツール）
// 過去のアーカイブ/追加で生じた「列ずれ」を検出する。データは一切変更しない。

const express = require('express');
const router = express.Router();

const { loadStaff, getSpreadsheetIdForYear } = require('../lib/data');
const { requireAdmin } = require('../lib/auth-middleware');
const { asyncRoute, idxToCol, colToIdx } = require('../lib/helpers');
const { getValues } = require('../lib/sheets');
const { HEADER_ROW } = require('../lib/constants');

// 氏名の姓部分（見出しは姓のみのことが多い）
const familyOf = (name) => String(name || '').split(/[\s　]/)[0];

router.get('/api/admin/column-audit', requireAdmin, asyncRoute(async (req, res) => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const sid = getSpreadsheetIdForYear(year);
  const staffData = loadStaff();

  // 列を持つ（訪問記録を入力する）スタッフのみ対象
  const colStaff = staffData.staff.filter(s => !s.archived && s.type !== 'office' && s.type !== 'admin');

  // ── ① メタ情報だけで分かる異常: 同じ列を複数人が指していないか ──
  const usage = {};
  for (const s of colStaff) {
    const cols = s.type === 'nurse' ? [s.kaigo_col, s.iryo_col] : [s.col];
    for (const c of cols) { if (!c) continue; (usage[c] ||= []).push(s.name); }
  }
  const duplicateCols = Object.entries(usage)
    .filter(([, names]) => names.length > 1)
    .map(([col, names]) => ({ col, staff: names }));
  const missingCols = colStaff
    .filter(s => s.type === 'nurse' ? (!s.kaigo_col || !s.iryo_col) : !s.col)
    .map(s => ({ id: s.id, name: s.name, type: s.type }));

  // ── ② シート見出しと突き合わせ（データが別列に取り残されていないか） ──
  const lastCol = idxToCol(39); // A..AN までを見る
  let headerRow3 = [], headerRow4 = [], sheetReadError = null;
  try {
    const [r3, r4] = await Promise.all([
      getValues(sid, `${month}月!A3:${lastCol}3`),
      getValues(sid, `${month}月!A${HEADER_ROW}:${lastCol}${HEADER_ROW}`),
    ]);
    headerRow3 = r3[0] || [];
    headerRow4 = r4[0] || [];
  } catch (e) {
    sheetReadError = e.message;
  }

  const headerAt = (idx) => `${headerRow3[idx] || ''}${headerRow4[idx] || ''}`.trim();

  const checks = colStaff.map(s => {
    const family = familyOf(s.name);
    if (s.type === 'nurse') {
      const kIdx = s.kaigo_col ? colToIdx(s.kaigo_col) : null;
      const iIdx = s.iryo_col ? colToIdx(s.iryo_col) : null;
      const kHead = kIdx != null ? headerAt(kIdx) : '';
      const iHead = iIdx != null ? headerAt(iIdx) : '';
      const nameMatch = !family || kHead.includes(family) || iHead.includes(family);
      return { id: s.id, name: s.name, type: s.type,
        stored: { kaigo_col: s.kaigo_col, iryo_col: s.iryo_col },
        headerAtStored: { kaigo: kHead, iryo: iHead },
        looksCorrect: nameMatch && (kHead.includes('介護') || iHead.includes('医療') || kHead.includes(family)) };
    } else {
      const idx = s.col ? colToIdx(s.col) : null;
      const head = idx != null ? headerAt(idx) : '';
      const nameMatch = !family || head.includes(family);
      return { id: s.id, name: s.name, type: s.type,
        stored: { col: s.col }, headerAtStored: head, looksCorrect: nameMatch };
    }
  });

  const suspects = checks.filter(c => !c.looksCorrect);

  res.json({
    year, month, spreadsheetId: sid,
    summary: {
      staffWithColumns: colStaff.length,
      duplicateColumnAssignments: duplicateCols.length,
      missingColumnAssignments: missingCols.length,
      headerMismatches: suspects.length,
      sheetReadError,
      likelyDesynced: duplicateCols.length > 0 || suspects.length > 0,
    },
    duplicateCols, missingCols, suspects,
    checks,
    // 参考: 見出し行の生データ（列→内容）
    header: headerRow4.map((v, i) => ({ col: idxToCol(i), row3: headerRow3[i] || '', row4: v || '' }))
      .filter(h => h.row3 || h.row4),
  });
}));

module.exports = router;
