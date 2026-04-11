'use strict';
const express = require('express');
const router = express.Router();

const { requireAdmin } = require('../lib/auth-middleware');
const { loadAuditLog, verifyAuditChain } = require('../lib/audit');

router.get('/api/admin/audit-log', requireAdmin, (req, res) => {
  const log = loadAuditLog();
  const { from, to, action, actor, page = 1, limit = 50 } = req.query;
  let filtered = log;

  if (from) filtered = filtered.filter(e => e.timestamp >= from);
  if (to)   filtered = filtered.filter(e => e.timestamp <= to + 'T23:59:59');
  if (action) filtered = filtered.filter(e => e.action.startsWith(action));
  if (actor)  filtered = filtered.filter(e => e.actor.staffId === actor || e.actor.type === actor);

  // 新しい順
  filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const total = filtered.length;
  const p = Math.max(1, Number(page));
  const l = Math.min(100, Math.max(1, Number(limit)));
  const start = (p - 1) * l;
  const entries = filtered.slice(start, start + l);

  res.json({ total, page: p, limit: l, pages: Math.ceil(total / l), entries });
});

router.get('/api/admin/audit-log/verify', requireAdmin, (_req, res) => {
  const result = verifyAuditChain();
  res.json(result);
});

router.get('/api/admin/health', requireAdmin, (_req, res) => {
  const { runHealthChecks } = require('../lib/health');
  res.json(runHealthChecks());
});

router.get('/api/admin/health/last', requireAdmin, (_req, res) => {
  const { getLastHealthCheck } = require('../lib/health');
  const last = getLastHealthCheck();
  if (!last) return res.json({ ok: null, checkedAt: null, checks: [] });
  res.json(last);
});

module.exports = router;
