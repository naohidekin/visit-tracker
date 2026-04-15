'use strict';
// 有給休暇管理ルート（スタッフ向け・管理者向け）

const express = require('express');
const router = express.Router();

const { loadStaff, saveStaff, loadLeave, saveLeave, loadNotices, saveNotices, atomicModify } = require('../lib/data');
const { requireStaff, requireAdmin } = require('../lib/auth-middleware');
const { asyncRoute, isValidDate, validateNum, getTodayJST, getNowJST, toDateStr } = require('../lib/helpers');
const { auditLog } = require('../lib/audit');
const { calcLeaveBalance, calcLeaveGrantDays, calcNextGrant, calcCelebrationRemaining, calcValidOncallLeave } = require('../lib/leave-calc');

// 有給通知ヘルパー（個人宛お知らせ）
function createStaffNotice(staffId, title, body) {
  atomicModify(() => {
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
  });
}

// ─── API: 有給休暇（スタッフ向け） ─────────────────────────────
router.get('/api/leave/balance', requireStaff, (req, res) => {
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
  const oncallLeaveValid = calcValidOncallLeave(staff);
  const oncallLeaveExpired = Math.max(0, oncallLeave - oncallLeaveValid);
  // 期限内エントリのうち最も近い期限日を取得
  let oncallLeaveExpiryDate = null;
  const history = staff.oncall_leave_history || [];
  const todayStr = getTodayJST();
  for (const entry of history) {
    if (entry.expiresAt && entry.expiresAt > todayStr) {
      if (!oncallLeaveExpiryDate || entry.expiresAt < oncallLeaveExpiryDate) {
        oncallLeaveExpiryDate = entry.expiresAt;
      }
    }
  }
  const balance     = calcLeaveBalance(staff);
  const autoGrantDays = calcLeaveGrantDays(staff.hire_date);

  const nextGrant = calcNextGrant(staff.hire_date, undefined, staff.celebration_expiry_months || 6);

  // お祝い休暇の使用日数を計算（手動調整 + 有効期限内の承認済み申請から自動消化）
  const celebrationDays = staff.celebration_days || 3;
  const celebrationAdj = staff.celebration_used_adj || 0;
  let celebrationUsed = celebrationAdj;
  if (staff.hire_date) {
    const hireDate = new Date(staff.hire_date);
    const celebrationExpiry = new Date(hireDate);
    celebrationExpiry.setMonth(celebrationExpiry.getMonth() + (staff.celebration_expiry_months || 6));
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
    oncall_leave_valid: oncallLeaveValid,
    oncall_leave_expired: oncallLeaveExpired,
    oncall_leave_expiry_date: oncallLeaveExpiryDate,
    used: usedDays,
    hire_date: staff.hire_date,
    auto_grant_days: autoGrantDays,
    grant_date: staff.leave_grant_date,
    next_grant: nextGrant,
    celebration_days: celebrationDays,
    celebration_used: celebrationUsed,
    celebration_remaining: Math.max(0, celebrationDays - celebrationUsed),
  });
});

router.get('/api/leave/requests', requireStaff, (req, res) => {
  const leaveData = loadLeave();
  const mine = leaveData.requests
    .filter(r => r.staffId === req.session.staffId)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({ requests: mine });
});

router.post('/api/leave/requests', requireStaff, asyncRoute((req, res) => {
  const { type, startDate, endDate } = req.body;
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 200) : '';
  if (!type || !startDate) return res.status(400).json({ error: '種別と開始日は必須です' });
  if (!['full', 'half_am', 'half_pm', 'celebration'].includes(type))
    return res.status(400).json({ error: '種別が不正です' });
  if (!isValidDate(startDate)) return res.status(400).json({ error: '開始日の形式が不正です' });
  if (endDate && !isValidDate(endDate)) return res.status(400).json({ error: '終了日の形式が不正です' });

  const today = getTodayJST();
  const start = startDate;
  const end   = endDate || startDate;
  if (start > end) return res.status(400).json({ error: '終了日は開始日以降にしてください' });
  if (start < today) return res.status(400).json({ error: '本日以降の日付を指定してください' });

  // 日付配列を展開
  const dates = [];
  const d = new Date(start);
  const e = new Date(end);
  while (d <= e) {
    dates.push(toDateStr(d));
    d.setDate(d.getDate() + 1);
  }

  // バリデーション後にアトミックに load-check-save
  const result = atomicModify(() => {
    const staffData = loadStaff();
    const staff = staffData.staff.find(s => s.id === req.session.staffId);
    if (!staff) return { error: 'スタッフが見つかりません', status: 404 };
    const leaveData = loadLeave();

    if (type === 'celebration') {
      if (!staff.hire_date) return { error: 'お祝い休暇は入職日が設定されている場合のみ利用できます', status: 400 };
      const hire = new Date(staff.hire_date);
      const expiryMonths = staff.celebration_expiry_months || 6;
      const celebrationExpiry = new Date(hire);
      celebrationExpiry.setMonth(celebrationExpiry.getMonth() + expiryMonths);
      const now = new Date(getTodayJST());
      if (now >= celebrationExpiry) return { error: `お祝い休暇の有効期限（入職から${expiryMonths}ヶ月）が過ぎています`, status: 400 };

      // HIGH-1: 各申請日が有効期限内かチェック
      const expiryStr = celebrationExpiry.toISOString().slice(0, 10);
      for (const d of dates) {
        if (new Date(d) >= celebrationExpiry)
          return { error: `${d} はお祝い休暇の有効期限（${expiryStr}）を超えています`, status: 400 };
      }

      // HIGH-2: GET /api/leave/balance と同じロジックで消化済み日数を計算
      const celebrationDays = staff.celebration_days || 3;
      const celebrationAdj = staff.celebration_used_adj || 0;
      let celebrationUsed = celebrationAdj;
      for (const r of leaveData.requests.filter(req => req.staffId === staff.id && req.status === 'approved')) {
        if (celebrationUsed >= celebrationDays) break;
        for (const d of r.dates) {
          if (celebrationUsed >= celebrationDays) break;
          if (new Date(d) < celebrationExpiry) {
            celebrationUsed += (r.type === 'half_am' || r.type === 'half_pm') ? 0.5 : 1;
          }
        }
      }
      celebrationUsed = Math.round(Math.min(celebrationUsed, celebrationDays) * 10) / 10;

      // 有効期限内の日付を含む保留中申請の日数
      let celebrationPending = 0;
      for (const r of leaveData.requests) {
        if (r.staffId !== staff.id || r.status !== 'pending') continue;
        for (const d of r.dates) {
          if (new Date(d) < celebrationExpiry)
            celebrationPending += (r.type === 'half_am' || r.type === 'half_pm') ? 0.5 : 1;
        }
      }
      celebrationPending = Math.round(celebrationPending * 10) / 10;

      const celebrationRemaining = Math.max(0, celebrationDays - celebrationUsed - celebrationPending);
      if (celebrationRemaining < dates.length)
        return { error: 'お祝い休暇の残日数が不足しています', status: 400 };
    } else {
      const balance = calcLeaveBalance(staff);
      const celebrationRemaining = calcCelebrationRemaining(staff);
      const totalAvailable = balance + celebrationRemaining;
      const requestDays = (type === 'half_am' || type === 'half_pm') ? dates.length * 0.5 : dates.length;
      const pendingDays = leaveData.requests
        .filter(r => r.staffId === staff.id && r.status === 'pending' && r.type !== 'celebration')
        .reduce((sum, r) => {
          const per = (r.type === 'half_am' || r.type === 'half_pm') ? 0.5 : 1;
          return sum + r.dates.length * per;
        }, 0);
      if (totalAvailable - pendingDays < requestDays)
        return { error: '有給残日数が不足しています', status: 400 };
    }

    // 重複チェック
    const existingByDate = {};
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
      if (ex.has('full') || ex.has('celebration'))
        return { error: `${dd} は既に申請済みです`, status: 400 };
      if (type === 'full' || type === 'celebration')
        return { error: `${dd} は既に半日休暇が申請済みのため、全日申請できません`, status: 400 };
      if (ex.has(type))
        return { error: `${dd} は既に同じ区分（${type === 'half_am' ? '午前' : '午後'}）で申請済みです`, status: 400 };
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
    return { ok: true, request };
  });

  if (result.error) return res.status(result.status).json({ error: result.error });
  auditLog(req, 'leave.request', { type: 'leave', id: result.request.id, label: `${result.request.staffName} ${startDate}` }, { type, dates });
  res.json({ ok: true, request: result.request });
}));

router.post('/api/leave/requests/:id/cancel', requireStaff, asyncRoute((req, res) => {
  const result = atomicModify(() => {
    const leaveData = loadLeave();
    const request = leaveData.requests.find(r => r.id === req.params.id);
    if (!request) return { error: '申請が見つかりません', status: 404 };
    if (request.staffId !== req.session.staffId)
      return { error: '自分の申請のみ取消できます', status: 403 };
    if (request.status !== 'pending' && request.status !== 'approved')
      return { error: 'この申請は取消できません', status: 400 };

    request.status = 'cancelled';
    request.cancelledAt = getNowJST().toISOString();
    saveLeave(leaveData);
    return { ok: true, request };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  auditLog(req, 'leave.cancel', { type: 'leave', id: result.request.id, label: `${result.request.staffName} ${result.request.dates[0]}` });
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

router.post('/api/admin/leave/requests/:id/approve', requireAdmin, asyncRoute((req, res) => {
  const result = atomicModify(() => {
    const leaveData = loadLeave();
    const request = leaveData.requests.find(r => r.id === req.params.id);
    if (!request) return { error: '申請が見つかりません', status: 404 };
    if (request.status !== 'pending')
      return { error: '承認待ちの申請のみ承認できます', status: 400 };

    const staffData = loadStaff();
    const staff = staffData.staff.find(s => s.id === request.staffId);
    if (staff) {
      const balance = calcLeaveBalance(staff);
      const requestDays = (request.type === 'half_am' || request.type === 'half_pm')
        ? request.dates.length * 0.5 : request.dates.length;

      // お祝い休暇の残日数を申請作成時と同じロジックで再計算
      const hire = staff.hire_date ? new Date(staff.hire_date) : null;
      const expiryMonths = staff.celebration_expiry_months || 6;
      let celebrationRemaining = 0;
      if (hire) {
        const celebrationExpiry = new Date(hire);
        celebrationExpiry.setMonth(celebrationExpiry.getMonth() + expiryMonths);
        const celebDays = staff.celebration_days || 3;
        const celebAdj = staff.celebration_used_adj || 0;
        let celebUsed = celebAdj;
        for (const r of leaveData.requests.filter(r => r.staffId === staff.id && r.status === 'approved' && r.id !== request.id)) {
          if (celebUsed >= celebDays) break;
          for (const d of r.dates) {
            if (celebUsed >= celebDays) break;
            if (new Date(d) < celebrationExpiry)
              celebUsed += (r.type === 'half_am' || r.type === 'half_pm') ? 0.5 : 1;
          }
        }
        celebUsed = Math.round(Math.min(celebUsed, celebDays) * 10) / 10;
        celebrationRemaining = Math.max(0, celebDays - celebUsed);
      }

      if (balance + celebrationRemaining < requestDays)
        return { error: '残日数が不足しています', status: 400 };
    }

    request.status = 'approved';
    request.adminComment = req.body.comment || null;
    request.reviewedAt = getNowJST().toISOString();
    saveLeave(leaveData);
    return { ok: true, request };
  });

  if (result.error) return res.status(result.status).json({ error: result.error });
  auditLog(req, 'leave.approve', { type: 'leave', id: result.request.id, label: `${result.request.staffName} ${(result.request.dates || [])[0]}` });

  try {
    const request = result.request;
    const dates    = request.dates || [];
    const dateStr  = dates.length === 0 ? '(日付不明)'
      : dates.length === 1 ? dates[0]
      : `${dates[0]}〜${dates[dates.length - 1]}`;
    const typeLabel = request.type === 'full' ? '全日' : request.type === 'half_am' ? '午前半休' : request.type === 'half_pm' ? '午後半休' : 'お祝い休暇';
    createStaffNotice(request.staffId,
      '✅ 有給申請が承認されました',
      `${dateStr}（${typeLabel}）の有給申請が承認されました。${request.adminComment ? '\nコメント: ' + request.adminComment : ''}`
    );
  } catch (e) {
    console.error('[leave.approve] 通知の作成に失敗:', e.message);
  }

  res.json({ ok: true });
}));

router.post('/api/admin/leave/requests/:id/reject', requireAdmin, asyncRoute((req, res) => {
  const result = atomicModify(() => {
    const leaveData = loadLeave();
    const request = leaveData.requests.find(r => r.id === req.params.id);
    if (!request) return { error: '申請が見つかりません', status: 404 };
    if (request.status !== 'pending')
      return { error: '承認待ちの申請のみ却下できます', status: 400 };

    request.status = 'rejected';
    request.adminComment = req.body.comment || null;
    request.reviewedAt = getNowJST().toISOString();
    saveLeave(leaveData);
    return { ok: true, request };
  });

  if (result.error) return res.status(result.status).json({ error: result.error });
  auditLog(req, 'leave.reject', { type: 'leave', id: result.request.id, label: `${result.request.staffName} ${(result.request.dates || [])[0]}` });

  try {
    const request = result.request;
    const dates    = request.dates || [];
    const dateStr  = dates.length === 0 ? '(日付不明)'
      : dates.length === 1 ? dates[0]
      : `${dates[0]}〜${dates[dates.length - 1]}`;
    const typeLabel = request.type === 'full' ? '全日' : request.type === 'half_am' ? '午前半休' : '午後半休';
    createStaffNotice(request.staffId,
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
        celebration_days: s.celebration_days || 3,
        celebration_used_adj: s.celebration_used_adj || 0,
      };
    });
  res.json({ summary });
});

router.post('/api/admin/staff/:id/leave-balance', requireAdmin, asyncRoute((req, res) => {
  const { granted, carried_over, manual_adjustment, grant_date, celebration_days, celebration_used_adj } = req.body;
  // バリデーション先行
  if (granted !== undefined) {
    const v = validateNum(granted, { min: 0, max: 365 });
    if (!v.valid) return res.status(400).json({ error: '付与日数が不正です（0〜365）' });
  }
  if (carried_over !== undefined) {
    const v = validateNum(carried_over, { min: 0, max: 365 });
    if (!v.valid) return res.status(400).json({ error: '繰越日数が不正です（0〜365）' });
  }
  if (manual_adjustment !== undefined) {
    const v = validateNum(manual_adjustment, { min: -365, max: 365 });
    if (!v.valid) return res.status(400).json({ error: '手動調整値が不正です（-365〜365）' });
  }
  if (grant_date !== undefined) {
    if (grant_date !== null && grant_date !== '' && !isValidDate(grant_date))
      return res.status(400).json({ error: '付与日の形式が不正です' });
  }
  if (celebration_days !== undefined) {
    const v = validateNum(celebration_days, { min: 0, max: 30 });
    if (!v.valid) return res.status(400).json({ error: 'お祝い休暇日数が不正です（0〜30）' });
  }
  if (celebration_used_adj !== undefined) {
    const v = validateNum(celebration_used_adj, { min: 0, max: 30 });
    if (!v.valid) return res.status(400).json({ error: 'お祝い休暇使用済み調整値が不正です（0〜30）' });
  }

  const result = atomicModify(() => {
    const staffData = loadStaff();
    const staff = staffData.staff.find(s => s.id === req.params.id);
    if (!staff) return { error: 'スタッフが見つかりません', status: 404 };

    if (granted !== undefined) staff.leave_granted = validateNum(granted, { min: 0, max: 365 }).value;
    if (carried_over !== undefined) staff.leave_carried_over = validateNum(carried_over, { min: 0, max: 365 }).value;
    if (manual_adjustment !== undefined) staff.leave_manual_adjustment = validateNum(manual_adjustment, { min: -365, max: 365 }).value;
    if (grant_date !== undefined) staff.leave_grant_date = grant_date || null;
    if (celebration_days !== undefined) staff.celebration_days = validateNum(celebration_days, { min: 0, max: 30 }).value;
    if (celebration_used_adj !== undefined) staff.celebration_used_adj = validateNum(celebration_used_adj, { min: 0, max: 30 }).value;

    saveStaff(staffData);
    return { ok: true, balance: calcLeaveBalance(staff) };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  auditLog(req, 'leave.balance_update', { type: 'leave', id: req.params.id, label: req.params.id }, { granted, carried_over, manual_adjustment, grant_date, celebration_days, celebration_used_adj });
  res.json({ ok: true, balance: result.balance });
}));

router.post('/api/admin/staff/:id/hire-date', requireAdmin, asyncRoute((req, res) => {
  const { hire_date, auto_apply } = req.body;
  if (!hire_date) return res.status(400).json({ error: '入社日は必須です' });
  if (!isValidDate(hire_date)) return res.status(400).json({ error: '入社日の形式が不正です' });

  const result = atomicModify(() => {
    const staffData = loadStaff();
    const staff = staffData.staff.find(s => s.id === req.params.id);
    if (!staff) return { error: 'スタッフが見つかりません', status: 404 };

    staff.hire_date = hire_date;
    if (auto_apply) {
      const autoGrant = calcLeaveGrantDays(hire_date);
      staff.leave_granted = autoGrant;
      staff.leave_grant_date = getTodayJST();
    }
    saveStaff(staffData);
    return { ok: true };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  auditLog(req, 'staff.hire_date_update', { type: 'staff', id: req.params.id, label: req.params.id }, { hire_date, auto_apply });
  res.json({ ok: true, auto_grant_days: calcLeaveGrantDays(hire_date) });
}));

module.exports = router;
