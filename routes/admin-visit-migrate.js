'use strict';
// 訪問件数の過去データ移行（段階2）＋照合（段階3）。
// Google Sheets を「読むだけ」で、各シートの見出し（氏名）を正として列→スタッフを対応づけ、
// 全年・全月の訪問件数を SQLite (visit_records) へ取り込む。Sheet は一切変更しない。
// 見出しに一致しない/曖昧な列（退職者の残列など）は取り込まず「Sheetバックアップのみ」として報告する。

const express = require('express');
const router = express.Router();

const { loadStaff, loadRegistry, insertVisitRecordIfAbsent, getVisitRecordsRange } = require('../lib/data');
const { requireAdmin } = require('../lib/auth-middleware');
const { asyncRoute, idxToCol } = require('../lib/helpers');
const { auditLog } = require('../lib/audit');
const { getValues } = require('../lib/sheets');
const { buildColumnMap, nameMatches } = require('../lib/sheet-columns');
const { DATA_START_ROW, HEADER_ROW, MONTHS } = require('../lib/constants');

const MAX_IDX = 51; // A..AZ まで走査（余裕を持たせる）
const normVal = (v) => { if (v === '' || v == null) return null; const n = Number(v); return isNaN(n) ? null : n; };

// 対象スタッフ（列を持つ＝office/admin以外。アーカイブ済みも過去分保全のため含む）
function columnedStaff(staffData) {
  return staffData.staff.filter(s => s.type !== 'office' && s.type !== 'admin');
}

// あるシートの見出しから「スタッフ→列」を対応づけ、未使用列（orphaned）を返す
function mapStaffToColumns(staffList, colMap) {
  const kaigoCols = colMap.filter(c => c.kind === 'kaigo');
  const rehabCols = colMap.filter(c => c.kind === 'rehab');
  const usedIdx = new Set();
  const mapping = [];
  for (const s of staffList) {
    if (s.type === 'nurse') {
      const hits = kaigoCols.filter(c => nameMatches(s.name, c.surname));
      if (hits.length === 1) {
        mapping.push({ staff: s, kaigoIdx: hits[0].idx, iryoIdx: hits[0].idx + 1 });
        usedIdx.add(hits[0].idx); usedIdx.add(hits[0].idx + 1);
      } else {
        mapping.push({ staff: s, status: hits.length === 0 ? 'unmatched' : 'ambiguous' });
      }
    } else {
      const hits = rehabCols.filter(c => nameMatches(s.name, c.surname));
      if (hits.length === 1) {
        mapping.push({ staff: s, colIdx: hits[0].idx });
        usedIdx.add(hits[0].idx);
      } else {
        mapping.push({ staff: s, status: hits.length === 0 ? 'unmatched' : 'ambiguous' });
      }
    }
  }
  const orphaned = colMap.filter(c => !usedIdx.has(c.idx));
  return { mapping, orphaned };
}

// 1シート・1月分を読み込む（row3=姓, row4=介護/医療, データ block）
async function readMonth(sid, monthLabel, daysInMonth) {
  const lastCol = idxToCol(MAX_IDX);
  const endRow = DATA_START_ROW + daysInMonth - 1;
  const [r3, r4, block] = await Promise.all([
    getValues(sid, `${monthLabel}!A3:${lastCol}3`).catch(() => [[]]),
    getValues(sid, `${monthLabel}!A${HEADER_ROW}:${lastCol}${HEADER_ROW}`).catch(() => [[]]),
    getValues(sid, `${monthLabel}!A${DATA_START_ROW}:${lastCol}${endRow}`).catch(() => []),
  ]);
  return { row3: r3[0] || [], row4: r4[0] || [], block: block || [] };
}

// mapping 1件からその月の記録を抽出（空セルは除外）
function extractRecords(m, year, monthNum, block) {
  const out = [];
  for (let i = 0; i < block.length; i++) {
    const row = block[i] || [];
    const date = `${year}-${String(monthNum).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
    if (m.staff.type === 'nurse') {
      const kaigo = normVal(row[m.kaigoIdx]);
      const iryo = normVal(row[m.iryoIdx]);
      if (kaigo == null && iryo == null) continue;
      out.push({ date, kaigo, iryo, value: null });
    } else {
      const value = normVal(row[m.colIdx]);
      if (value == null) continue;
      out.push({ date, kaigo: null, iryo: null, value });
    }
  }
  return out;
}

// 全年・全月を走査。doWrite=true で SQLite へ upsert。Sheet は読むだけ。
// 返り値: { perStaff: {id:{name, sheetCount}}, orphanCols: [...], unresolved: [...], years: [...], imported }
async function collect(doWrite) {
  const staffData = loadStaff();
  const staffList = columnedStaff(staffData);
  const registry = loadRegistry(); // { '2026': sid, ... }
  const years = Object.keys(registry).sort();

  const perStaff = {};
  for (const s of staffList) perStaff[s.id] = { id: s.id, name: s.name, type: s.type, sheetCount: 0 };
  const orphanAgg = {}; // key: `${year}/${col}:${surname}` -> count
  const unresolvedAgg = {}; // staffId -> Set(year:status)
  let imported = 0, skipped = 0;
  const yearsReport = [];

  for (const year of years) {
    const sid = registry[year];
    let yearRecords = 0;
    for (let mNum = 1; mNum <= 12; mNum++) {
      const monthLabel = MONTHS[mNum - 1];
      const daysInMonth = new Date(Number(year), mNum, 0).getDate();
      const { row3, row4, block } = await readMonth(sid, monthLabel, daysInMonth);
      if (!block.length) continue;
      const colMap = buildColumnMap(row3, row4, MAX_IDX);
      const { mapping, orphaned } = mapStaffToColumns(staffList, colMap);

      for (const m of mapping) {
        if (m.status) {
          (unresolvedAgg[m.staff.id] ||= new Set()).add(`${year}:${m.status}`);
          continue;
        }
        const recs = extractRecords(m, Number(year), mNum, block);
        perStaff[m.staff.id].sheetCount += recs.length;
        yearRecords += recs.length;
        if (doWrite) {
          for (const r of recs) {
            // 既存（二重書き込み済みの正しい値）は上書きしない。無い分だけ取り込む。
            if (insertVisitRecordIfAbsent(m.staff.id, r.date, { kaigo: r.kaigo, iryo: r.iryo, value: r.value })) imported++;
            else skipped++;
          }
        }
      }
      // orphaned列で、データが1つでもある列を集計（Sheetバックアップのみ）
      for (const c of orphaned) {
        let cnt = 0;
        for (const row of block) if (normVal((row || [])[c.idx]) != null) cnt++;
        if (cnt > 0) {
          const key = `${year}/${c.col}:${c.surname || '(無名)'}`;
          orphanAgg[key] = (orphanAgg[key] || 0) + cnt;
        }
      }
    }
    yearsReport.push({ year, sid, sheetRecords: yearRecords });
  }

  const unresolved = Object.entries(unresolvedAgg).map(([id, set]) => ({
    id, name: (perStaff[id] || {}).name || id, reasons: [...set],
  }));
  const orphanCols = Object.entries(orphanAgg).map(([k, count]) => ({ where: k, count }))
    .sort((a, b) => b.count - a.count);

  return { perStaff, orphanCols, unresolved, years: yearsReport, imported, skipped };
}

// ─── 状態確認（読み取り専用・照合） ───────────────────────────
router.get('/api/admin/visit-migrate/status', requireAdmin, asyncRoute(async (_req, res) => {
  const c = await collect(false);
  // SQLite側の件数と突合
  const rows = Object.values(c.perStaff).map(s => {
    const dbRecs = getVisitRecordsRange(s.id, '0000-00-00', '9999-99-99');
    return { ...s, sqliteCount: dbRecs.length, covered: dbRecs.length >= s.sheetCount };
  }).sort((a, b) => b.sheetCount - a.sheetCount);

  res.json({
    years: c.years,
    summary: {
      staffCount: rows.length,
      sheetTotal: rows.reduce((a, r) => a + r.sheetCount, 0),
      sqliteTotal: rows.reduce((a, r) => a + r.sqliteCount, 0),
      fullyCovered: rows.every(r => r.covered),
      orphanColumns: c.orphanCols.length,
      unresolvedStaff: c.unresolved.length,
    },
    rows,
    orphanCols: c.orphanCols,
    unresolved: c.unresolved,
  });
}));

// ─── 取り込み実行（Sheet→SQLite。Sheetは無変更） ───────────────
router.post('/api/admin/visit-migrate/backfill', requireAdmin, asyncRoute(async (req, res) => {
  const c = await collect(true);
  auditLog(req, 'visit.migrate_backfill', { type: 'visit_record' }, {
    imported: c.imported, skipped: c.skipped, years: c.years.map(y => y.year), orphanColumns: c.orphanCols.length,
  });
  res.json({
    success: true,
    imported: c.imported,
    skipped: c.skipped,
    years: c.years,
    perStaff: Object.values(c.perStaff),
    orphanCols: c.orphanCols,
    unresolved: c.unresolved,
  });
}));

module.exports = router;
