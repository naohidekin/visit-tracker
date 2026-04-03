'use strict';
// お知らせ管理ルート（スタッフ向け・管理者向け）

const express = require('express');
const router = express.Router();

const { loadNotices, saveNotices } = require('../lib/data');
const { requireStaff, requireAdmin } = require('../lib/auth-middleware');
const { lockedRoute } = require('../lib/helpers');
const { auditLog } = require('../lib/audit');
const { NOTICES_PATH } = require('../lib/constants');

// ─── API: お知らせ（スタッフ向け） ─────────────────────────────
router.get('/api/notices', requireStaff, (_req, res) => {
  const { notices, readStatus } = loadNotices();
  const staffId = _req.session.staffId;
  const readIds = readStatus[staffId] || [];
  const list = notices
    .filter(n => !n.targetStaffId || n.targetStaffId === staffId)
    .filter(n => n.target !== 'admin')  // 管理者向けお知らせはスタッフに表示しない
    .map(n => ({ ...n, isRead: readIds.includes(n.id) }))
    .sort((a, b) => (b.createdAt || b.date || '').localeCompare(a.createdAt || a.date || ''));
  res.json({ notices: list });
});

router.get('/api/notices/unread-count', requireStaff, (req, res) => {
  const { notices, readStatus } = loadNotices();
  const staffId = req.session.staffId;
  const readIds = readStatus[staffId] || [];
  const count = notices
    .filter(n => !n.targetStaffId || n.targetStaffId === staffId)
    .filter(n => n.target !== 'admin')
    .filter(n => !readIds.includes(n.id)).length;
  res.json({ count });
});

router.post('/api/notices/:id/read', requireStaff, lockedRoute(NOTICES_PATH, (req, res) => {
  const data = loadNotices();
  const staffId = req.session.staffId;
  if (!data.readStatus[staffId]) data.readStatus[staffId] = [];
  if (!data.readStatus[staffId].includes(req.params.id)) {
    data.readStatus[staffId].push(req.params.id);
    saveNotices(data);
  }
  res.json({ ok: true });
}));

// ─── API: お知らせ（管理者向け） ──────────────────────────────
router.get('/api/admin/notices', requireAdmin, (_req, res) => {
  const { notices } = loadNotices();
  const sorted = [...notices].sort((a, b) => (b.createdAt || b.date || '').localeCompare(a.createdAt || a.date || ''));
  res.json({ notices: sorted });
});

// 管理者ダッシュボード用: 管理者向け仕様変更お知らせ
router.get('/api/admin/notices/changelog', requireAdmin, (_req, res) => {
  const { notices } = loadNotices();
  const adminNotices = notices
    .filter(n => n.target === 'admin')
    .sort((a, b) => (b.createdAt || b.date || '').localeCompare(a.createdAt || a.date || ''))
    .slice(0, 10);  // 直近10件
  res.json({ notices: adminNotices });
});

router.post('/api/admin/notices', requireAdmin, lockedRoute(NOTICES_PATH, (req, res) => {
  const { title, body, source, target } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'タイトルと本文は必須です' });
  const data = loadNotices();
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const noticeSource = (source === 'system') ? 'system' : 'admin';
  const notice = {
    id: noticeSource === 'system' ? 'sys-' + Date.now() : String(Date.now()),
    date: now.toISOString().slice(0, 10),
    title,
    body,
    source: noticeSource,
    createdAt: now.toISOString()
  };
  // 対象画面: "staff" = スタッフ向け, "admin" = 管理者向け, 未指定 = 全員
  if (target === 'staff' || target === 'admin') notice.target = target;
  data.notices.push(notice);
  saveNotices(data);
  auditLog(req, 'notice.create', { type: 'notice', id: notice.id, label: title });
  res.json({ ok: true, notice });
}));

router.patch('/api/admin/notices/:id', requireAdmin, lockedRoute(NOTICES_PATH, (req, res) => {
  const data = loadNotices();
  const notice = data.notices.find(n => n.id === req.params.id);
  if (!notice) return res.status(404).json({ error: 'お知らせが見つかりません' });
  if (req.body.title) notice.title = req.body.title;
  if (req.body.body) notice.body = req.body.body;
  if (req.body.target === 'staff' || req.body.target === 'admin') notice.target = req.body.target;
  else if (req.body.target === '') delete notice.target;  // 全員に戻す
  saveNotices(data);
  auditLog(req, 'notice.update', { type: 'notice', id: notice.id, label: notice.title });
  res.json({ ok: true, notice });
}));

router.delete('/api/admin/notices/:id', requireAdmin, lockedRoute(NOTICES_PATH, (req, res) => {
  const data = loadNotices();
  const idx = data.notices.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'お知らせが見つかりません' });
  const removedNotice = data.notices[idx];
  data.notices.splice(idx, 1);
  // readStatus からも削除
  for (const staffId in data.readStatus) {
    data.readStatus[staffId] = data.readStatus[staffId].filter(id => id !== req.params.id);
  }
  saveNotices(data);
  auditLog(req, 'notice.delete', { type: 'notice', id: req.params.id, label: removedNotice.title });
  res.json({ ok: true });
}));

module.exports = router;
