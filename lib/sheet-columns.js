'use strict';
// シート見出し（訪問件数）の「列 → スタッフ」対応づけ用ヘルパー。
// 列ずれ調査(admin-column-audit)と過去データ移行(admin-visit-migrate)で共通利用し、
// 対応づけロジックを必ず一致させる。

const { idxToCol } = require('./helpers');

const noSpace = (s) => String(s || '').replace(/[\s　]/g, '');
const stripMark = (s) => noSpace(s).replace(/[（(]?(介護|医療)[）)]?/g, '');

// シートの見出し（row3=姓, row4=介護/医療 または リハビリ氏名 / 初期作成分は row4="氏名(介護)"）を
// 列ごとに分類する。idx は 0 起点（A=0）。C列(idx2)以降を対象。
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

module.exports = { noSpace, stripMark, buildColumnMap, nameMatches };
