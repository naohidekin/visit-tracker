'use strict';
// 有給休暇管理ルート（スタッフ向け・管理者向け）

const express = require('express');
const router = express.Router();

const { loadStaff, saveStaff, loadLeave, saveLeave, loadNotices, saveNotices, loadAttendance, saveAttendance, atomicModify } = require('../lib/data');
const { requireStaff, requireAdmin } = require('../lib/auth-middleware');
const { asyncRoute, isValidDate, validateNum, getTodayJST, getNowJST, toDateStr } = require('../lib/helpers');
const { auditLog } = require('../lib/audit');
const { calcLeaveBalance, calcLeaveGrantDays, calcNextGrant, calcPendingGrant, formatTenureLabel, calcCelebrationRemaining, calcValidOncallLeave } = require('../lib/leave-calc');

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

// 日付配列 → 通知用の期間表記（"YYYY-MM-DD" or "開始〜終了"）
function formatLeaveDateRange(dates) {
  const d = dates || [];
  if (d.length === 0) return '(日付不明)';
  if (d.length === 1) return d[0];
  return `${d[0]}〜${d[d.length - 1]}`;
}

// 申請 → 種別の日本語ラベル（履歴画面と同じ表記に統一）
function leaveTypeLabel(request) {
  const ot = request.originalType || request.type;
  const isHalf = (ot === 'half_am' || ot === 'half_pm');
  const base = ot === 'half_am' ? '午前半休' : ot === 'half_pm' ? '午後半休' : request.type === 'celebration' ? 'お祝い休暇' : '全日';
  return (request.type === 'celebration' && isHalf) ? base + '（お祝い）' : base;
}

// 申請取消の共通処理（本人取消・管理者取消）。
// 取消時、出勤自動確定cronが書いた「有給」勤怠レコード（source:'auto'）も掃除する
// （同日を含む他の承認済み申請が残っている場合は消さない。手動レコードは触らない）。
function cancelLeaveRequest(requestId, { allowedStatuses, cancelledBy, requireStaffId = null }) {
  return atomicModify(() => {
    const leaveData = loadLeave();
    const request = leaveData.requests.find(r => r.id === requestId);
    if (!request) return { error: '申請が見つかりません', status: 404 };
    if (requireStaffId && request.staffId !== requireStaffId)
      return { error: '自分の申請のみ取消できます', status: 403 };
    if (!allowedStatuses.includes(request.status))
      return { error: allowedStatuses.includes('pending') ? 'この申請は取消できません' : '承認済みの申請のみ取消できます', status: 400 };

    const wasApproved = request.status === 'approved';
    request.status = 'cancelled';
    request.cancelledAt = getNowJST().toISOString();
    request.cancelledBy = cancelledBy;
    saveLeave(leaveData);

    // 承認済みだった場合のみ、自動確定済みの「有給」勤怠レコードを掃除
    if (wasApproved) {
      const attendanceData = loadAttendance();
      let changed = false;
      for (const d of request.dates || []) {
        const rec = attendanceData.records[d] && attendanceData.records[d][request.staffId];
        if (rec && rec.source === 'auto' && rec.status === 'leave') {
          const stillOnLeave = leaveData.requests.some(r =>
            r.id !== request.id && r.staffId === request.staffId && r.status === 'approved' && (r.dates || []).includes(d));
          if (!stillOnLeave) {
            delete attendanceData.records[d][request.staffId];
            changed = true;
          }
        }
      }
      if (changed) saveAttendance(attendanceData);
    }

    return { ok: true, request };
  });
}

// ─── API: 有給休暇（スタッフ向け） ─────────────────────────────
// 有給残の内訳（本人の有給画面と同じ表示データ）を計算して返す。
// 本人用 /api/leave/balance と管理者用 leave-balance-view で共通利用し、両画面の数値を必ず一致させる。
function buildLeaveBalanceView(staff) {
  const leaveData = loadLeave();
  const approved = leaveData.requests.filter(r =>
    r.staffId === staff.id && r.status === 'approved'
  );
  let usedDays = 0;
  for (const r of approved) {
    if (r.type === 'celebration') continue; // お祝い休暇は有給使用済から除外
    const perDate = (r.type === 'half_am' || r.type === 'half_pm') ? 0.5 : 1;
    const totalDays = r.dates.length * perDate;
    const celebPortion = r.celebration_days || 0; // 部分消費分は有給使用済から除外
    usedDays += totalDays - celebPortion;
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
  const balance     = calcLeaveBalance(staff, approved);
  const autoGrantDays = calcLeaveGrantDays(staff.hire_date);

  const nextGrant = calcNextGrant(staff.hire_date, undefined, staff.celebration_expiry_months || 6);

  // お祝い休暇の使用日数を計算（手動調整 + celebration申請 + 部分消費のある通常申請）
  const celebrationDays = staff.celebration_days || 3;
  const celebrationAdj = staff.celebration_used_adj || 0;
  let celebrationUsed = celebrationAdj;
  for (const r of approved) {
    if (celebrationUsed >= celebrationDays) break;
    if (r.type === 'celebration') {
      const ot = r.originalType || r.type;
      const perDate = (ot === 'half_am' || ot === 'half_pm') ? 0.5 : 1;
      for (const d of r.dates) {
        if (celebrationUsed >= celebrationDays) break;
        celebrationUsed += perDate;
      }
    } else if (r.celebration_days) {
      // 部分消費: 通常申請のうちお祝い休暇から消費した分
      celebrationUsed = Math.min(celebrationDays, celebrationUsed + r.celebration_days);
    }
  }
  celebrationUsed = Math.round(Math.min(celebrationUsed, celebrationDays) * 10) / 10;

  return {
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
  };
}

router.get('/api/leave/balance', requireStaff, (req, res) => {
  const staff = loadStaff().staff.find(s => s.id === req.session.staffId);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });
  res.json(buildLeaveBalanceView(staff));
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
  // 2か月前まで遡って申請可能
  const twoMonthsAgo = new Date(today + 'T00:00:00+09:00');
  twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
  const twoMonthsAgoStr = new Date(twoMonthsAgo.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (start < twoMonthsAgoStr) return res.status(400).json({ error: '2か月以上前の日付は指定できません' });

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

    const requestDays = (type === 'half_am' || type === 'half_pm') ? dates.length * 0.5 : dates.length;

    // お祝い休暇の有効期限・残日数を先に計算（自動変換・部分消費判定でも使用）
    let celebInfo = null;
    if (staff.hire_date) {
      const hire = new Date(staff.hire_date);
      const expiryMonths = staff.celebration_expiry_months || 6;
      const celebrationExpiry = new Date(hire);
      celebrationExpiry.setMonth(celebrationExpiry.getMonth() + expiryMonths);
      const now = new Date(getTodayJST());
      const celebrationDays = staff.celebration_days || 3;
      const celebrationAdj = staff.celebration_used_adj || 0;
      let celebrationUsed = celebrationAdj;
      // 承認済みの消化数: type='celebration' + 部分消費のある通常申請
      for (const r of leaveData.requests.filter(lr => lr.staffId === staff.id && lr.status === 'approved')) {
        if (celebrationUsed >= celebrationDays) break;
        if (r.type === 'celebration') {
          const ot = r.originalType || r.type;
          const per = (ot === 'half_am' || ot === 'half_pm') ? 0.5 : 1;
          for (const d of r.dates) {
            if (celebrationUsed >= celebrationDays) break;
            celebrationUsed += per;
          }
        } else if (r.celebration_days) {
          celebrationUsed = Math.min(celebrationDays, celebrationUsed + r.celebration_days);
        }
      }
      celebrationUsed = Math.round(Math.min(celebrationUsed, celebrationDays) * 10) / 10;
      // 保留中の消化数: type='celebration' + 部分消費のある通常申請
      let celebrationPending = 0;
      for (const r of leaveData.requests) {
        if (r.staffId !== staff.id || r.status !== 'pending') continue;
        if (r.type === 'celebration') {
          const ot = r.originalType || r.type;
          const per = (ot === 'half_am' || ot === 'half_pm') ? 0.5 : 1;
          for (const d of r.dates) celebrationPending += per;
        } else if (r.celebration_days) {
          celebrationPending += r.celebration_days;
        }
      }
      celebrationPending = Math.round(celebrationPending * 10) / 10;
      celebInfo = {
        expiry: celebrationExpiry,
        expiryStr: celebrationExpiry.toISOString().slice(0, 10),
        expiryMonths,
        active: now < celebrationExpiry,
        remaining: Math.max(0, celebrationDays - celebrationUsed - celebrationPending),
      };
    }

    // お祝い休暇優先消費:
    //   残高 >= リクエスト日数 → 完全自動変換（celebration タイプ）
    //   残高 > 0 かつ < リクエスト日数 → 残高を全消費し、不足分を有給から補う（部分消費）
    let effectiveType = type;
    let celebrationDaysApplied = 0; // 部分消費時にお祝い休暇から消費する日数

    if (type !== 'celebration' && celebInfo && celebInfo.active && celebInfo.remaining > 0) {
      if (celebInfo.remaining >= requestDays) {
        effectiveType = 'celebration'; // 完全自動変換
      } else {
        celebrationDaysApplied = celebInfo.remaining; // 残高全部消費、不足分は有給へ
      }
    }

    if (effectiveType === 'celebration') {
      if (!celebInfo || !celebInfo.active)
        return { error: `お祝い休暇の有効期限（入職から${celebInfo ? celebInfo.expiryMonths : 6}ヶ月）が過ぎています`, status: 400 };
      if (!staff.hire_date)
        return { error: 'お祝い休暇は入職日が設定されている場合のみ利用できます', status: 400 };
      for (const d of dates) {
        if (new Date(d) >= celebInfo.expiry)
          return { error: `${d} はお祝い休暇の有効期限（${celebInfo.expiryStr}）を超えています`, status: 400 };
      }
      if (celebInfo.remaining < requestDays)
        return { error: 'お祝い休暇の残日数が不足しています', status: 400 };
    } else {
      // 有給残高のみで検証（お祝い部分を差し引いた分が有給で賄えるか）
      const balance = calcLeaveBalance(staff);
      const paidNeeded = requestDays - celebrationDaysApplied;
      const pendingDays = leaveData.requests
        .filter(r => r.staffId === staff.id && r.status === 'pending' && r.type !== 'celebration')
        .reduce((sum, r) => {
          const per = (r.type === 'half_am' || r.type === 'half_pm') ? 0.5 : 1;
          const total = r.dates.length * per;
          const celebPortion = r.celebration_days || 0;
          return sum + Math.max(0, total - celebPortion);
        }, 0);
      if (balance - pendingDays < paidNeeded)
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
      if (effectiveType === 'full' || effectiveType === 'celebration')
        return { error: `${dd} は既に半日休暇が申請済みのため、全日申請できません`, status: 400 };
      if (ex.has(effectiveType))
        return { error: `${dd} は既に同じ区分（${effectiveType === 'half_am' ? '午前' : '午後'}）で申請済みです`, status: 400 };
    }

    const request = {
      id: `${staff.id}-${start}-${Date.now()}`,
      staffId: staff.id,
      staffName: staff.name,
      type: effectiveType,
      dates,
      reason: reason || '',
      status: 'pending',
      adminComment: null,
      createdAt: getNowJST().toISOString(),
      reviewedAt: null,
      cancelledAt: null,
      ...(celebrationDaysApplied > 0 ? { celebration_days: celebrationDaysApplied } : {}),
      ...(effectiveType !== type ? { originalType: type } : {}),
    };
    leaveData.requests.push(request);
    saveLeave(leaveData);
    return { ok: true, request };
  });

  if (result.error) return res.status(result.status).json({ error: result.error });
  auditLog(req, 'leave.request', { type: 'leave', id: result.request.id, label: `${result.request.staffName} ${startDate}` }, { type: result.request.type, dates });
  res.json({ ok: true, request: result.request });
}));

router.post('/api/leave/requests/:id/cancel', requireStaff, asyncRoute((req, res) => {
  const result = cancelLeaveRequest(req.params.id, {
    allowedStatuses: ['pending', 'approved'],
    cancelledBy: 'staff',
    requireStaffId: req.session.staffId,
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
      const ot = request.originalType || request.type;
      const requestDays = (ot === 'half_am' || ot === 'half_pm')
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
          const rot = r.originalType || r.type;
          const perDay = (rot === 'half_am' || rot === 'half_pm') ? 0.5 : 1;
          for (const d of r.dates) {
            if (celebUsed >= celebDays) break;
            if (new Date(d) < celebrationExpiry)
              celebUsed += perDay;
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
    createStaffNotice(request.staffId,
      '✅ 有給申請が承認されました',
      `${formatLeaveDateRange(request.dates)}（${leaveTypeLabel(request)}）の有給申請が承認されました。${request.adminComment ? '\nコメント: ' + request.adminComment : ''}`
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
    createStaffNotice(request.staffId,
      '❌ 有給申請が却下されました',
      `${formatLeaveDateRange(request.dates)}（${leaveTypeLabel(request)}）の有給申請が却下されました。${request.adminComment ? '\nコメント: ' + request.adminComment : ''}`
    );
  } catch (e) {
    console.error('[leave.reject] 通知の作成に失敗:', e.message);
  }

  res.json({ ok: true });
}));

// 管理者による承認済み申請の取消（取消で有給残・勤怠へ反映。承認待ちは「却下」を使う）
router.post('/api/admin/leave/requests/:id/cancel', requireAdmin, asyncRoute((req, res) => {
  const result = cancelLeaveRequest(req.params.id, {
    allowedStatuses: ['approved'],
    cancelledBy: 'admin',
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  auditLog(req, 'leave.admin_cancel', { type: 'leave', id: result.request.id, label: `${result.request.staffName} ${(result.request.dates || [])[0]}` });

  try {
    const request = result.request;
    createStaffNotice(request.staffId,
      '有給申請が取り消されました',
      `${formatLeaveDateRange(request.dates)}（${leaveTypeLabel(request)}）の有給申請が管理者により取り消されました。\nご不明な点は管理者にご確認ください。`
    );
  } catch (e) {
    console.error('[leave.admin_cancel] 通知の作成に失敗:', e.message);
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
      // 有給の「使用」は本人画面(calcLeaveBalance)と同基準：
      // お祝い休暇での取得は除外し、通常申請のうちお祝いで賄った分(celebration_days)も差し引く
      let usedDays = 0;
      for (const r of approved) {
        if (r.type === 'celebration') continue;
        const per = (r.type === 'half_am' || r.type === 'half_pm') ? 0.5 : 1;
        usedDays += r.dates.length * per - (r.celebration_days || 0);
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
      // 残日数は本人画面と同じ calcLeaveBalance で算出
      // （お祝い休暇での取得・期限切れOCを正しく除外し、両画面で一致させる）
      const balance      = calcLeaveBalance(s, approved);
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
        pending_grant: calcPendingGrant(s),
        grant_history: (s.leave_grant_history || []).slice()
          .sort((a, b) => (b.grantedAt || '').localeCompare(a.grantedAt || ''))
          .map(h => ({ ...h, label: formatTenureLabel(h.months) })),
      };
    });
  res.json({ summary });
});

// 有給付与の時期が到来している職員のアラート一覧（管理者ダッシュボード用）
// 入社日から半年→その後1年ごと（付与規定テーブル）の付与基準日を過ぎているのに
// 付与日数へ未反映のスタッフを返す。付与日数を更新すると自動的に一覧から消える。
router.get('/api/admin/leave/grant-alerts', requireAdmin, (_req, res) => {
  const staffData = loadStaff();
  const alerts = [];
  for (const s of staffData.staff) {
    if (s.archived) continue;
    const pending = calcPendingGrant(s);
    if (pending) {
      alerts.push({
        id: s.id,
        name: s.name,
        grant_days: pending.grant_days,
        current_granted: pending.granted,
        reached_date: pending.reached_date,
        tenure_label: pending.tenure_label,
      });
    }
  }
  alerts.sort((a, b) => (a.reached_date || '').localeCompare(b.reached_date || ''));
  res.json({ count: alerts.length, alerts });
});

// 管理者向け: 対象職員の有給内訳（本人の有給画面と同じ表示データ）
router.get('/api/admin/staff/:id/leave-balance-view', requireAdmin, (req, res) => {
  const staff = loadStaff().staff.find(s => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: 'スタッフが見つかりません' });
  res.json(buildLeaveBalanceView(staff));
});

router.post('/api/admin/staff/:id/leave-balance', requireAdmin, asyncRoute((req, res) => {
  const { granted, carried_over, manual_adjustment, grant_date, celebration_days, celebration_used_adj, record_grant } = req.body;
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

    // 付与を記録する場合は、更新“前”の状態で対象マイルストーンを確定
    let grantToRecord = null;
    if (record_grant) {
      const pending = calcPendingGrant(staff);
      if (pending) {
        const already = (staff.leave_grant_history || []).some(h => h.months === pending.reached_months);
        if (!already) {
          grantToRecord = {
            months: pending.reached_months,
            days: pending.grant_days,
            label: pending.tenure_label,
            reachedDate: pending.reached_date,
          };
        }
      }
    }

    if (granted !== undefined) staff.leave_granted = validateNum(granted, { min: 0, max: 365 }).value;
    if (carried_over !== undefined) staff.leave_carried_over = validateNum(carried_over, { min: 0, max: 365 }).value;
    if (manual_adjustment !== undefined) staff.leave_manual_adjustment = validateNum(manual_adjustment, { min: -365, max: 365 }).value;
    if (grant_date !== undefined) staff.leave_grant_date = grant_date || null;
    if (celebration_days !== undefined) staff.celebration_days = validateNum(celebration_days, { min: 0, max: 30 }).value;
    if (celebration_used_adj !== undefined) staff.celebration_used_adj = validateNum(celebration_used_adj, { min: 0, max: 30 }).value;

    // 付与履歴に記録。二度付け防止＋「実際に保存された付与日数が規定日数に達している」場合のみ。
    // （反映後に付与日数を手で下げた場合などは記録・通知しない）
    if (grantToRecord && (staff.leave_granted || 0) >= grantToRecord.days) {
      if (!Array.isArray(staff.leave_grant_history)) staff.leave_grant_history = [];
      staff.leave_grant_history.push({
        grantedAt: grantToRecord.reachedDate,   // 付与の効力発生日（＝規定上の基準日）
        months: grantToRecord.months,
        days: grantToRecord.days,
      });
      // 付与日は「クリック日」ではなく付与規定上の基準日（繰越期限の起点になる）
      staff.leave_grant_date = grantToRecord.reachedDate;
    } else {
      grantToRecord = null;  // 記録・通知の対象外
    }

    saveStaff(staffData);
    return {
      ok: true,
      balance: calcLeaveBalance(staff),
      staffName: staff.name,
      grantRecorded: grantToRecord,
    };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });

  // 付与を記録した場合は本人へ個別お知らせを送信
  if (result.grantRecorded) {
    createStaffNotice(
      req.params.id,
      '有給休暇が付与されました',
      `勤続${result.grantRecorded.label}に伴い、有給休暇 ${result.grantRecorded.days}日 が付与されました。\n` +
      `現在の有給残日数は ${result.balance}日 です。\n` +
      `詳しくは「有給休暇」画面でご確認ください。`
    );
    auditLog(req, 'leave.grant_recorded', { type: 'leave', id: req.params.id, label: result.staffName },
      { months: result.grantRecorded.months, days: result.grantRecorded.days });
  }

  auditLog(req, 'leave.balance_update', { type: 'leave', id: req.params.id, label: req.params.id }, { granted, carried_over, manual_adjustment, grant_date, celebration_days, celebration_used_adj });
  res.json({ ok: true, balance: result.balance, grant_recorded: !!result.grantRecorded });
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
