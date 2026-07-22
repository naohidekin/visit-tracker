'use strict';
// スタッフ列割り当ての整合性チェック＆修復（列ずれ調査/修復ツール）
// 検査は読み取り専用。修復は「列番号メタ情報」だけを直し、シートの記録データは触らない
// （＝可逆。もし誤っても再チェックして直せる）。正はシートの見出し行（氏名）。

const express = require('express');
const router = express.Router();

const { loadStaff, saveStaff, getSpreadsheetIdForYear, atomicModify } = require('../lib/data');
const { requireAdmin } = require('../lib/auth-middleware');
const { asyncRoute, idxToCol, colToIdx } = require('../lib/helpers');
const { auditLog } = require('../lib/audit');
const { getValues } = require('../lib/sheets');
const { HEADER_ROW } = require('../lib/constants');

const noSpace = (s) => String(s || '').replace(/[\s　]/g, '');
const stripMark = (s) => noSpace(s).replace(/[（(]?(介護|医療)[）)]?/g, '');

// シートの見出し（row3=姓, row4=介護/医療 または リハビリ氏名 / 初期作成分は row4="氏名(介護)"）を
// 列ごとに分類する。
function buildColumnMap(row3, row4, maxIdx) {
  const cols = [];
  for (let i = 2; i <= maxIdx; i++) {
    const r3 = noSpace(row3[i]);
    const r4raw = String(row4[i] || '');
    const r4 = noSpace(r4raw);
    if (!r3 && !r4) continue;
    let kind = null, surname = '';
    if (/介護/.test(r4)) { kind = 'kaigo'; surname = r3 || stripMark(r4); }
    else if (/医療/.test(r4)) { kind = 'iryo'; surname = r3 || ''; }
    else if (r4) { kind = 'rehab'; surname = r3 || r4; }
    else if (r3) { kind = 'rehab'; surname = r3; }
    cols.push({ idx: i, col: idxToCol(i), kind, surname, raw3: row3[i] || '', raw4: r4raw });
  }
  return cols;
}

// 氏名（漢字）と見出しの姓が一致するか（どちらかがもう一方の前方一致）
function nameMatches(staffName, surname) {
  const a = noSpace(staffName), b = noSpace(surname);
  if (!a || !b) return false;
  return a.startsWith(b) || b.startsWith(a);
}

// 各スタッフの「正しい列」をシート見出しから推定する
function proposeMapping(colStaff, colMap) {
  // kaigo列 → 直後のiryo列 をペアに
  const kaigoCols = colMap.filter(c => c.kind === 'kaigo');
  const rehabCols = colMap.filter(c => c.kind === 'rehab');

  return colStaff.map(s => {
    const cur = s.type === 'nurse' ? { kaigo_col: s.kaigo_col || null, iryo_col: s.iryo_col || null } : { col: s.col || null };
    if (s.type === 'nurse') {
      const hits = kaigoCols.filter(c => nameMatches(s.name, c.surname));
      if (hits.length === 1) {
        const k = hits[0];
        return { id: s.id, name: s.name, type: s.type, current: cur,
          proposed: { kaigo_col: k.col, iryo_col: idxToCol(k.idx + 1) },
          headerSurname: k.surname, status: 'matched' };
      }
      return { id: s.id, name: s.name, type: s.type, current: cur, proposed: null,
        status: hits.length === 0 ? 'unmatched' : 'ambiguous',
        candidates: hits.map(h => h.col) };
    } else {
      const hits = rehabCols.filter(c => nameMatches(s.name, c.surname));
      if (hits.length === 1) {
        return { id: s.id, name: s.name, type: s.type, current: cur,
          proposed: { col: hits[0].col }, headerSurname: hits[0].surname, status: 'matched' };
      }
      return { id: s.id, name: s.name, type: s.type, current: cur, proposed: null,
        status: hits.length === 0 ? 'unmatched' : 'ambiguous',
        candidates: hits.map(h => h.col) };
    }
  });
}

async function readHeader(sid, month) {
  const lastCol = idxToCol(45);
  const [r3, r4] = await Promise.all([
    getValues(sid, `${month}月!A3:${lastCol}3`),
    getValues(sid, `${month}月!A${HEADER_ROW}:${lastCol}${HEADER_ROW}`),
  ]);
  return { row3: r3[0] || [], row4: r4[0] || [], maxIdx: 45 };
}

router.get('/api/admin/column-audit', requireAdmin, asyncRoute(async (req, res) => {
  const now = new Date();
  const year = now.getFullYear(), month = now.getMonth() + 1;
  const sid = getSpreadsheetIdForYear(year);
  const staffData = loadStaff();
  const colStaff = staffData.staff.filter(s => !s.archived && s.type !== 'office' && s.type !== 'admin');

  // メタ情報だけで分かる異常
  const usage = {};
  for (const s of colStaff) for (const c of (s.type === 'nurse' ? [s.kaigo_col, s.iryo_col] : [s.col])) {
    if (c) (usage[c] ||= []).push(s.name);
  }
  const duplicateCols = Object.entries(usage).filter(([, n]) => n.length > 1).map(([col, staff]) => ({ col, staff }));
  const missingCols = colStaff.filter(s => s.type === 'nurse' ? (!s.kaigo_col || !s.iryo_col) : !s.col)
    .map(s => ({ id: s.id, name: s.name, type: s.type }));

  let columnMap = [], proposals = [], sheetReadError = null;
  try {
    const { row3, row4, maxIdx } = await readHeader(sid, month);
    columnMap = buildColumnMap(row3, row4, maxIdx);
    proposals = proposeMapping(colStaff, columnMap);
  } catch (e) { sheetReadError = e.message; }

  // 修復が必要な件数（現状と提案が異なる or 見つからない）
  const changed = proposals.filter(p => {
    if (p.status !== 'matched') return true;
    if (p.type === 'nurse') return p.current.kaigo_col !== p.proposed.kaigo_col || p.current.iryo_col !== p.proposed.iryo_col;
    return p.current.col !== p.proposed.col;
  });

  res.json({
    year, month, spreadsheetId: sid,
    summary: {
      staffWithColumns: colStaff.length,
      duplicateColumnAssignments: duplicateCols.length,
      missingColumnAssignments: missingCols.length,
      needsRepair: changed.length,
      unresolved: proposals.filter(p => p.status !== 'matched').length,
      sheetReadError,
      likelyDesynced: duplicateCols.length > 0 || changed.length > 0,
    },
    duplicateCols, missingCols,
    proposals,
    columnMap,
  });
}));

// 修復の適用（列番号メタ情報のみ更新。シートの記録データは触らない）
router.post('/api/admin/column-audit/apply', requireAdmin, asyncRoute((req, res) => {
  const changes = Array.isArray(req.body?.changes) ? req.body.changes : null;
  if (!changes || changes.length === 0) return res.status(400).json({ error: '適用する変更がありません' });

  const colRe = /^[A-Z]{1,2}$/;
  for (const c of changes) {
    if (!c || !c.id) return res.status(400).json({ error: '不正な変更データです' });
    for (const v of [c.kaigo_col, c.iryo_col, c.col]) if (v != null && !colRe.test(v)) return res.status(400).json({ error: `列指定が不正です: ${v}` });
  }

  const result = atomicModify(() => {
    const data = loadStaff();
    const applied = [];
    for (const c of changes) {
      const staff = data.staff.find(s => s.id === c.id);
      if (!staff) continue;
      const before = staff.type === 'nurse' ? { kaigo_col: staff.kaigo_col, iryo_col: staff.iryo_col } : { col: staff.col };
      if (staff.type === 'nurse') {
        if (c.kaigo_col) staff.kaigo_col = c.kaigo_col;
        if (c.iryo_col) staff.iryo_col = c.iryo_col;
      } else if (c.col) {
        staff.col = c.col;
      }
      applied.push({ id: staff.id, name: staff.name, before, after: staff.type === 'nurse' ? { kaigo_col: staff.kaigo_col, iryo_col: staff.iryo_col } : { col: staff.col } });
    }
    // 適用後に重複が無いか検証（あれば巻き戻し）
    const used = {};
    for (const s of data.staff.filter(s => !s.archived && s.type !== 'office' && s.type !== 'admin')) {
      for (const col of (s.type === 'nurse' ? [s.kaigo_col, s.iryo_col] : [s.col])) {
        if (!col) continue;
        if (used[col]) return { error: `適用すると列 ${col} が ${used[col]} と ${s.name} で重複します。修復案を見直してください。` };
        used[col] = s.name;
      }
    }
    saveStaff(data);
    return { applied };
  });

  if (result.error) return res.status(400).json({ error: result.error });
  auditLog(req, 'staff.column_repair', { type: 'staff' }, { changes: result.applied });
  res.json({ success: true, applied: result.applied });
}));

module.exports = router;
