/**
 * Google Sheets シート保護スクリプト
 * 1月〜12月の全シートを保護し、サービスアカウントのみ編集可能にします。
 *
 * 実行方法：
 *   node scripts/protect-sheets.js
 *
 * 既存の保護を再設定する場合（--reset オプション）：
 *   node scripts/protect-sheets.js --reset
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const MONTHS = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
const RESET  = process.argv.includes('--reset');

async function main() {
  if (!SPREADSHEET_ID) {
    console.error('❌ SPREADSHEET_ID が .env に設定されていません');
    process.exit(1);
  }

  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, '\n');

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // シートメタデータ取得
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetMap = {};
  for (const s of meta.data.sheets) {
    sheetMap[s.properties.title] = s.properties.sheetId;
  }

  const serviceEmail = creds.client_email;
  console.log(`サービスアカウント: ${serviceEmail}`);

  // --reset の場合は既存の保護を削除
  if (RESET) {
    const existingProtections = [];
    for (const s of meta.data.sheets) {
      if (MONTHS.includes(s.properties.title) && s.protectedRanges?.length) {
        for (const pr of s.protectedRanges) {
          existingProtections.push({ deleteProtectedRange: { protectedRangeId: pr.protectedRangeId } });
        }
      }
    }
    if (existingProtections.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests: existingProtections },
      });
      console.log(`🗑️  既存の保護 ${existingProtections.length} 件を削除しました`);
    } else {
      console.log('既存の保護はありませんでした');
    }
  }

  // 保護を設定
  const requests = [];
  const targets  = [];

  for (const month of MONTHS) {
    const sheetId = sheetMap[month];
    if (sheetId === undefined) {
      console.warn(`⚠️  シート "${month}" が見つかりません（スキップ）`);
      continue;
    }
    requests.push({
      addProtectedRange: {
        protectedRange: {
          range: { sheetId },
          description: `${month} — サービスアカウントのみ編集可`,
          warningOnly: false,
          editors: {
            users: [serviceEmail],
            domainUsersCanEdit: false,
          },
        },
      },
    });
    targets.push(month);
  }

  if (requests.length === 0) {
    console.log('保護対象のシートがありません');
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests },
  });

  console.log(`\n✅ ${targets.length} シートに保護を設定しました`);
  console.log(`   対象: ${targets.join('、')}`);
  console.log(`   編集可能: ${serviceEmail} のみ`);
}

main().catch(e => {
  console.error('❌ エラー:', e.response?.data?.error?.message || e.message);
  process.exit(1);
});
