'use strict';
// Google Sheets API モジュール（認証、リトライ、ヘッダー構築、年次作成、入力状況チェック）

const { google } = require('googleapis');
const { colToIdx, isOnLeaveToday } = require('./helpers');
const { loadStaff, loadRegistry, saveRegistry, getSpreadsheetIdForYear } = require('./data');
const { MONTHS, DATA_START_ROW, WD, SPREADSHEET_ID } = require('./constants');

// ─── Google Sheets 認証 ─────────────────────────────────────────
function getAuth() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheets() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

// ─── Sheets APIリトライラッパー（429/5xx対策 + タイムアウト） ────
async function sheetsRetry(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await Promise.race([
        fn(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Sheets API タイムアウト (30秒)')), 30000)
        ),
      ]);
    } catch (e) {
      const status = e?.response?.status || e?.code;
      if ((status === 429 || status >= 500 || e.message?.includes('タイムアウト')) && i < maxRetries - 1) {
        const wait = Math.pow(2, i) * 1000 + Math.random() * 500;
        console.warn(`⚠️ Sheets API ${status || 'timeout'}, ${wait.toFixed(0)}ms後にリトライ (${i + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw e;
      }
    }
  }
}

// ─── ヘッダー行構築 ────────────────────────────────────────────
function buildSheetHeaderRow(staffList) {
  if (staffList.length === 0) return ['日付', '曜日'];
  const maxIdx = Math.max(
    ...staffList.map(s => s.type === 'nurse' ? colToIdx(s.iryo_col) : colToIdx(s.col))
  );
  const row = new Array(maxIdx + 1).fill('');
  row[0] = '日付'; row[1] = '曜日';
  for (const s of staffList) {
    if (s.type === 'nurse') {
      row[colToIdx(s.kaigo_col)] = `${s.name}(介護)`;
      row[colToIdx(s.iryo_col)]  = `${s.name}(医療)`;
    } else {
      row[colToIdx(s.col)] = s.name;
    }
  }
  return row;
}

// ─── 新年スプレッドシート作成 ───────────────────────────────────
async function createSpreadsheetForYear(year) {
  const registry = loadRegistry();
  if (registry[String(year)]) {
    throw new Error(`already_exists:${registry[String(year)]}`);
  }

  const api       = await getSheets();
  const staffData = loadStaff();
  const headerRow = buildSheetHeaderRow(staffData.staff);

  const created = await api.spreadsheets.create({
    requestBody: {
      properties: { title: `訪問件数カウント ${year}` },
      sheets: MONTHS.map((title, i) => ({ properties: { title, sheetId: i, index: i } })),
    },
  });
  const newId = created.data.spreadsheetId;

  const batchData = [];
  for (let mi = 0; mi < MONTHS.length; mi++) {
    const m           = mi + 1;
    const daysInMonth = new Date(year, m, 0).getDate();
    const values      = [
      [`${year}年${m}月実績表`], [], [],
      headerRow,
    ];
    for (let d = 1; d <= daysInMonth; d++) {
      values.push([d, WD[new Date(year, m - 1, d).getDay()],
        ...new Array(Math.max(0, headerRow.length - 2)).fill('')]);
    }
    batchData.push({ range: `${MONTHS[mi]}!A1`, values });
  }
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: newId,
    requestBody: { valueInputOption: 'USER_ENTERED', data: batchData },
  });

  // タイトル行（行1）を中央揃えに設定
  await api.spreadsheets.batchUpdate({
    spreadsheetId: newId,
    requestBody: {
      requests: MONTHS.map((_, i) => ({
        repeatCell: {
          range: { sheetId: i, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
          cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
          fields: 'userEnteredFormat.horizontalAlignment',
        },
      })),
    },
  });

  registry[String(year)] = newId;
  saveRegistry(registry);
  console.log(`✅ ${year}年スプレッドシートを作成しました: ${newId}`);
  return newId;
}

// ─── 特定スタッフの特定日のSheets記録有無を確認 ─────────────────
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

// ─── 全スタッフの入力状況を一括取得（batchGet で効率化） ────────
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

module.exports = {
  getAuth,
  getSheets,
  sheetsRetry,
  buildSheetHeaderRow,
  createSpreadsheetForYear,
  hasRecordForDate,
  getAllStaffRecordStatus,
};
