'use strict';
const express = require('express');
const router = express.Router();

const { loadRegistry, getSpreadsheetIdForYear } = require('../lib/data');
const { requireAdmin } = require('../lib/auth-middleware');
const { auditLog } = require('../lib/audit');
const { getSheets, sheetsRetry, createSpreadsheetForYear } = require('../lib/sheets');

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

router.get('/api/admin/registry', requireAdmin, (_req, res) => {
  const reg = loadRegistry();
  res.json(Object.entries(reg).map(([year, id]) => ({
    year, spreadsheetId: id,
    url: `https://docs.google.com/spreadsheets/d/${id}`,
  })));
});

module.exports = router;
