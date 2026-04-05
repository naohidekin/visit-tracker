'use strict';
// 有給休暇管理ルート（スタッフ向け・管理者向け）

const express = require('express');
const router = express.Router();

const { loadStaff, saveStaff, loadLeave, saveLeave, loadNotices, saveNotices } = require('../lib/data');
const { requireStaff, requireAdmin } = require('../lib/auth-middleware');
const { lockedRoute, isValidDate, validateNum, withFileLock, getTodayJST, getNowJST, toDateStr } = require('../lib/helpers');
const { auditLog } = require('../lib/audit');
const { calcLeaveBalance, calcLeaveGrantDays, calcNextGrant } = require('../lib/leave-calc');
const { STAFF_PATH, LEAVE_PATH, NOTICES_PATH } = require('../lib/constants');

// 有給通知ヘルパー（個人宛お知らせ）
async function createStaffNotice(staffId, title, body) {
  return await withFileLock(NOTICES_PATH, async () => {
    const data = loadNotices();
    const now = getNowJST();
    const notice = {
      id: 'leave-' + Date.now(),
      date: now.toISOString().slice(0, 10),
      title,
      body,
      source: 'system',
      targetStaffId: staffId,
      createdAt: now.toISOString()
    };
    data.notices.push(notice);
    saveNotices(data);
    return notice;
  });
}

// ─── API: 有給休暇（スタッフ向け） ─────────────────────────────
router.get('/api/leave/balance', requireStaff,(req, res) => {
  const data = loadStaff();
  const staff = data.staff.find(s => s.id === req.session.staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  const leaveData = loadLeave();
  const approved = leaveData.requests.filter(r =>
    r.staffId === staff.id && r.status === 'approved'
  );
  let usedDays = 0;
  for (const r of approved) {
    const perDate = (r.type === 'half_am' || r.type === 'half_pm') ? 0.5 : 1;
    usedDays += r.dates.length * perDate;
  }
  usedDays = Math.round(usedDays * 10) / 10;
  const granted     = staff.leave_granted || 0;
  const carriedOver = staff.leave_carried_over || 0;
  const manualAdj   = staff.leave_manual_adjustment || 0;
  const oncallLeave = staff.oncall_leave_granted || 0;
  const balance     = calcLeaveBalance(staff);
  const autoGrantDays = calcLeaveGrantDays(staff.hire_date);

  const nextGrant = calcNextGrant(staff.hire_date);

  // お祝い休暇の使用日数を計算（手動調整 + 入職半年以内の承認済み申請から自動消化）
  const celebrationDays = staff.celebration_days || 3;
  const celebrationAdj = staff.celebration_used_adj || 0;
  let celebrationUsed = celebrationAdj;
  if (staff.hire_date) {
    const hireDate = new Date(staff.hire_date);
    const celebrationExpiry = new Date(hireDate);
    celebrationExpiry.setMonth(celebrationExpiry.getMonth() + 6);
    for (const r of approved) {
      if (celebrationUsed >= celebrationDays) break;
      for (const d of r.dates) {
        if (celebrationUsed >= celebrationDays) break;
        if (new Date(d) < celebrationExpiry) {
          const perDate = (r.type === 'half_am' || r.type === 'half_pm') ? 0.5 : 1;
          celebrationUsed += perDate;
        }
      }
    }
    celebrationUsed = Math.round(Math.min(celebrationUsed, celebrationDays) * 10) / 10;
  }

  res.json({
    balance,
    granted,
    carried_over: carriedOver,
    manual_adjustment: manualAdj,
    oncall_leave: oncallLeave,
    used: usedDays,
    hire_date: staff.hire_date,
    auto_grant_days: autoGrantDays,
    grant_date: staff.leave_grant_date,
    next_grant: nextGrant,
    celebration_days: celebrationDays,
    celebration_used: celebrationUsed,
  });
});

router.get('/api/leave/requests', requireStaff,(req, res) => {
  const leaveData = loadLeave();
  const mine = leaveData.requests
    .filter(r => r.staffId === req.session.staffId)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({ requests: mine });
});

router.post('/api/leave/requests', requireStaff,lockedRoute(LEAVE_PATH, (req, res) => {
  const { type, startDate, endDate, reason } = req.body;
  if (!type || !startDate) return res.status(400).json({ error: '種別と開始日は必須です' });
  if (!['full', 'half_am', 'half_pm', 'celebration'].includes(type))
    return res.status(400).json({ error: '種別が不正です' });
  if (!isValidDate(startDate)) return res.status(400).json({ error: '開始日の形式が不正です' });
  if (endDate && !isValidDate(endDate)) return res.status(400).json({ error: '終了日の形式が不正です' });

  const today = getTodayJST();
  const start = startDate;
  const end   = endDate || startDate;
  if (start > end) return res.status(400).json({ error: '終了日は開始日以降にしてください' });
  if (start <= today) return res.status(400).json({ error: '翌日以降の日付を指定してください' });

  // 日付配列を展開
  const dates = [];
  const d = new Date(start);
  const e = new Date(end);
  while (d <= e) {
    dates.push(toDateStr(d));
    d.setDate(d.getDate() + 1);
  }

  // 残日数チェック
  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === req.session.staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });
  const leaveData = loadLeave();

  if (type === 'celebration') {
    // お祝い休暇: 入職6ヶ月以内かチェック
    if (!staff.hire_date) return res.status(400).json({ error: 'お祝い休暇は入職日が設定されている場合のみ利用できます' });
    const hire = new Date(staff.hire_date);
    const celebrationExpiry = new Date(hire);
    celebrationExpiry.setMonth(celebrationExpiry.getMonth() + 6);
    const now = new Date(getTodayJST());
    if (now >= celebrationExpiry) return res.status(400).json({ error: 'お祝い休暇の有効期限（入職から6ヶ月）が過ぎています' });

    // 残日数チェック（celebration は常に1日/date）
    const celebrationDays = staff.celebration_days || 3;
    const celebrationUsed = leaveData.requests.filter(r =>
      r.staffId === staff.id && r.status === 'approved' && r.type === 'celebration'
    ).reduce((sum, r) => sum + r.dates.length, 0);
    const celebrationPending = leaveData.requests.filter(r =>
      r.staffId === staff.id && r.status === 'pending' && r.type === 'celebration'
    ).reduce((sum, r) => sum + r.dates.length, 0);
    const celebrationRemaining = celebrationDays - celebrationUsed - celebrationPending;
    if (celebrationRemaining < dates.length)
      return res.status(400).json({ error: 'お祝い休暇の残日数が不足しています' });
  } else {
    const balance = calcLeaveBalance(staff);
    const requestDays = (type === 'half_am' || type === 'half_pm') ? dates.length * 0.5 : dates.length;
    // pending 分も考慮（celebration以外のpending）
    const pendingDays = leaveData.requests
      .filter(r => r.staffId === staff.id && r.status === 'pending' && r.type !== 'celebration')
      .reduce((sum, r) => {
        const per = (r.type === 'half_am' || r.type === 'half_pm') ? 0.5 : 1;
        return sum + r.dates.length * per;
      }, 0);
    if (balance - pendingDays < requestDays)
      return res.status(400).json({ error: '有給残日数が不足しています' });
  }

  // 重複チェック（同日の種別を考慮: 全日は常にNG、半日は同じ区分のみNG）
  const existingByDate = {};   // { 'YYYY-MM-DD': Set<'full'|'half_am'|'half_pm'|'celebration'> }
  for (const r of leaveData.requests) {
    if (r.staffId === staff.id && (r.status === 'pending' || r.status === 'approved')) {
      for (const dd of r.dates) {
        if (!existingByDate[dd]) existingByDate[dd] = new Set();
        existingByDate[dd].add(r.type);
      }
    }
  }
  for (const dd of dates) {
    const ex = existingByDate[dd];
    if (!ex) continue;
    // 既に全日・お祝い休暇が入っていたら不可
    if (ex.has('full') || ex.has('celebration'))
      return res.status(400).json({ error: `${dd} は既に申請済みです` });
    // 今回が全日・お祝い休暇なら、既存の半日とも衝突
    if (type === 'full' || type === 'celebration')
      return res.status(400).json({ error: `${dd} は既に半日休暇が申請済みのため、全日申請できません` });
    // 半日同士: 同じ区分（午前/午前, 午後/午後）ならNG
    if (ex.has(type))
      return res.status(400).json({ error: `${dd} は既に同じ区分（${type === 'half_am' ? '午前' : '午後'}）で申請済みです` });
    // 午前+午後で合計1日 → 残日数を追加消費するのでチェック
    if ((type === 'half_am' && ex.has('half_pm')) || (type === 'half_pm' && ex.has('half_am'))) {
      // 許可するが、合計1日分消費されることは残日数チェックで既に考慮済み
    }
  }

  const request = {
    id: `${staff.id}-${start}-${Date.now()}`,
    staffId: staff.id,
    staffName: staff.name,
    type,
    dates,
    reason: reason || '',
    status: 'pending',
    adminComment: null,
    createdAt: getNowJST().toISOString(),
    reviewedAt: null,
    cancelledAt: null,
  };
  leaveData.requests.push(request);
  saveLeave(leaveData);
  auditLog(req, 'leave.request', { type: 'leave', id: request.id, label: `${staff.name} ${start}` }, { type, dates });
  res.json({ ok: true, request });
}));

router.post('/api/leave/requests/:id/cancel', requireStaff,lockedRoute(LEAVE_PATH, (req, res) => {
  const leaveData = loadLeave();
  const request = leaveData.requests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: '申請が見つかりません' });
  if (request.staffId !== req.session.staffId)
    return res.status(403).json({ error: '自分の申請のみ取消できます' });
  if (request.status !== 'pending' && request.status !== 'approved')
    return res.status(400).json({ error: 'この申請は取消できません' });

  request.status = 'cancelled';
  request.cancelledAt = getNowJST().toISOString();
  saveLeave(leaveData);
  auditLog(req, 'leave.cancel', { type: 'leave', id: request.id, label: `${request.staffName} ${request.dates[0]}` });
  res.json({ ok: true });
}));

// ─── API: 有給休暇（管理者向け） ───────────────────────────────
router.get('/api/admin/leave/requests', requireAdmin, (req, res) => {
  const leaveData = loadLeave();
  let requests = leaveData.requests;
  if (req.query.status) {
    requests = requests.filter(r => r.status === req.query.status);
  }
  requests.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({ requests });
});

router.post('/api/admin/leave/requests/:id/approve', requireAdmin, lockedRoute(LEAVE_PATH, async (req, res) => {
  const leaveData = loadLeave();
  const request = leaveData.requests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: '申請が見つかりません' });
  if (request.status !== 'pending')
    return res.status(400).json({ error: '承認待ちの申請のみ承認できます' });

  // 残日数チェック
  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === request.staffId);
  if (staff) {
    const balance = calcLeaveBalance(staff);
    const requestDays = (request.type === 'half_am' || request.type === 'half_pm')
      ? request.dates.length * 0.5 : request.dates.length;
    if (balance < requestDays)
      return res.status(400).json({ error: '残日数が不足しています' });
  }

  request.status = 'approved';
  request.adminComment = req.body.comment || null;
  request.reviewedAt = getNowJST().toISOString();
  saveLeave(leaveData);
  auditLog(req, 'leave.approve', { type: 'leave', id: request.id, label: `${request.staffName} ${(request.dates || [])[0]}` });

  // 通知を作成（失敗しても承認自体は確定済みなのでエラーを握りつぶす）
  try {
    const dates    = request.dates || [];
    const dateStr  = dates.length === 0 ? '(日付不明)'
      : dates.length === 1 ? dates[0]
      : `${dates[0]}〜${dates[dates.length - 1]}`;
    const typeLabel = request.type === 'full' ? '全日' : request.type === 'half_am' ? '午前半休' : '午後半休';
    await createStaffNotice(request.staffId,
      '✅ 有給申請が承認されました',
      `${dateStr}（${typeLabel}）の有給申請が承認されました。${request.adminComment ? '\nコメント: ' + request.adminComment : ''}`
    );
  } catch (e) {
    console.error('[leave.approve] 通知の作成に失敗:', e.message);
  }

  res.json({ ok: true });
}));

router.post('/api/admin/leave/requests/:id/reject', requireAdmin, lockedRoute(LEAVE_PATH, async (req, res) => {
  const leaveData = loadLeave();
  const request = leaveData.requests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: '申請が見つかりません' });
  if (request.status !== 'pending')
    return res.status(400).json({ error: '承認待ちの申請のみ却下できます' });

  request.status = 'rejected';
  request.adminComment = req.body.comment || null;
  request.reviewedAt = getNowJST().toISOString();
  saveLeave(leaveData);
  auditLog(req, 'leave.reject', { type: 'leave', id: request.id, label: `${request.staffName} ${(request.dates || [])[0]}` });

  // 通知を作成（失敗しても却下自体は確定済みなのでエラーを握りつぶす）
  try {
    const dates    = request.dates || [];
    const dateStr  = dates.length === 0 ? '(日付不明)'
      : dates.length === 1 ? dates[0]
      : `${dates[0]}〜${dates[dates.length - 1]}`;
    const typeLabel = request.type === 'full' ? '全日' : request.type === 'half_am' ? '午前半休' : '午後半休';
    await createStaffNotice(request.staffId,
      '❌ 有給申請が却下されました',
      `${dateStr}（${typeLabel}）の有給申請が却下されました。${request.adminComment ? '\nコメント: ' + request.adminComment : ''}`
    );
  } catch (e) {
    console.error('[leave.reject] 通知の作成に失敗:', e.message);
  }

  res.json({ ok: true });
}));

router.get('/api/admin/leave/summary', requireAdmin, (_req, res) => {
  const staffData = loadStaff();
  const leaveData = loadLeave();
  const summary = staffData.staff
    .filter(s => !s.archived)
    .map(s => {
      const approved = leaveData.requests.filter(r =>
        r.staffId === s.id && r.status === 'approved'
      );
      let usedDays = 0;
      for (const r of approved) {
        const per = (r.type === 'half_am' || r.type === 'half_pm') ? 0.5 : 1;
        usedDays += r.dates.length * per;
      }
      const pending = leaveData.requests.filter(r =>
        r.staffId === s.id && r.status === 'pending'
      );
      let pendingDays = 0;
      for (const r of pending) {
        const per = (r.type === 'half_am' || r.type === 'half_pm') ? 0.5 : 1;
        pendingDays += r.dates.length * per;
      }
      usedDays = Math.round(usedDays * 10) / 10;
      pendingDays = Math.round(pendingDays * 10) / 10;
      const granted      = s.leave_granted || 0;
      const carriedOver  = s.leave_carried_over || 0;
      const manualAdj    = s.leave_manual_adjustment || 0;
      const oncallLeave  = s.oncall_leave_granted || 0;
      // calcLeaveBalance と同じ計算式を使用（oncall_leave_granted を含む）
      const balance      = Math.round((granted + carriedOver + manualAdj + oncallLeave - usedDays) * 10) / 10;
      return {
        id: s.id,
        name: s.name,
        type: s.type,
        hire_date: s.hire_date,
        auto_grant_days: calcLeaveGrantDays(s.hire_date),
        granted,
        carried_over: carriedOver,
        manual_adjustment: manualAdj,
        oncall_leave: oncallLeave,
        used: usedDays,
        pending: pendingDays,
        balance,
        grant_date: s.leave_grant_date,
      };
    });
  res.json({ summary });
});

router.post('/api/admin/staff/:id/leave-balance', requireAdmin, lockedRoute(STAFF_PATH, (req, res) => {
  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  const { granted, carried_over, manual_adjustment, grant_date } = req.body;
  if (granted !== undefined) {
    const v = validateNum(granted, { min: 0, max: 365 });
    if (!v.valid) return res.status(400).json({ error: '付与日数が不正です（0〜365）' });
    staff.leave_granted = v.value;
  }
  if (carried_over !== undefined) {
    const v = validateNum(carried_over, { min: 0, max: 365 });
    if (!v.valid) return res.status(400).json({ error: '繰越日数が不正です（0〜365）' });
    staff.leave_carried_over = v.value;
  }
  if (manual_adjustment !== undefined) {
    const v = validateNum(manual_adjustment, { min: -365, max: 365 });
    if (!v.valid) return res.status(400).json({ error: '手動調整値が不正です（-365〜365）' });
    staff.leave_manual_adjustment = v.value;
  }
  if (grant_date !== undefined) {
    if (grant_date !== null && grant_date !== '' && !isValidDate(grant_date))
      return res.status(400).json({ error: '付与日の形式が不正です' });
    staff.leave_grant_date = grant_date || null;
  }

  saveStaff(staffData);
  auditLog(req, 'leave.balance_update', { type: 'leave', id: staff.id, label: staff.name }, { granted, carried_over, manual_adjustment, grant_date });
  res.json({ ok: true, balance: calcLeaveBalance(staff) });
}));

router.post('/api/admin/staff/:id/hire-date', requireAdmin, lockedRoute(STAFF_PATH, (req, res) => {
  const staffData = loadStaff();
  const staff = staffData.staff.find(s => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });

  const { hire_date, auto_apply } = req.body;
  if (!hire_date) return res.status(400).json({ error: '入社日は必須です' });
  if (!isValidDate(hire_date)) return res.status(400).json({ error: '入社日の形式が不正です' });

  staff.hire_date = hire_date;
  // 自動計算を適用する場合
  if (auto_apply) {
    const autoGrant = calcLeaveGrantDays(hire_date);
    staff.leave_granted = autoGrant;
    staff.leave_grant_date = getTodayJST();
  }
  saveStaff(staffData);
  auditLog(req, 'staff.hire_date_update', { type: 'staff', id: staff.id, label: staff.name }, { hire_date, auto_apply });
  res.json({ ok: true, auto_grant_days: calcLeaveGrantDays(hire_date) });
}));

module.exports = router;
