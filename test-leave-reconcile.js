'use strict';
/**
 * 回帰テスト: お祝い休暇の付け替え修正（二重付与の解消）
 * 実行: node test-leave-reconcile.js
 * 通常有給として記録された取得分を お祝い休暇へ付け替え、付与を正しく揃える処理を検証。
 */
const os=require('os'),path=require('path'),fs=require('fs'),assert=require('assert');
const TEST_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'leaverec-'));
process.env.DATA_DIR=TEST_DIR;process.env.SESSION_SECRET='s';process.env.NODE_ENV='test';
process.env.SPREADSHEET_ID='dummy';delete process.env.GOOGLE_CREDENTIALS;

const request=require('supertest');
const bcrypt=require('bcryptjs');
const {getDb}=require('./lib/db');
const {ensureDataDir,saveLeave,loadStaff,loadLeave}=require('./lib/data');
const {calcLeaveGrantDays,calcLeaveBalance}=require('./lib/leave-calc');

// JST基準で N日前後の日付文字列を返す
function daysFromNow(delta){const d=new Date(Date.now()+9*3600*1000);d.setDate(d.getDate()+delta);return d.toISOString().slice(0,10);}

let passed=0,failed=0;
async function test(name,fn){try{await fn();console.log(`  ✅ ${name}`);passed++;}catch(e){console.error(`  ❌ ${name}\n     ${e.message}`);failed++;}}

(async()=>{
  await ensureDataDir();
  const db=getDb();
  const put=(s)=>db.prepare('INSERT OR REPLACE INTO staff (id,data) VALUES (?,?)').run(s.id,JSON.stringify(s));
  put({id:'boss',name:'管理者',type:'office',is_admin:true,archived:false,password_hash:bcrypt.hashSync('Admin12345',4)});

  const hireYoung=daysFromNow(-60); // 入社2ヶ月前 → 自動付与0、お祝い期間内
  // ① 付与を既に0にした結果、残がマイナス（通常有給3日使用）
  put({id:'s_zeroed',name:'ゼロ太郎',type:'nurse',kaigo_col:'C',iryo_col:'D',archived:false,hire_date:hireYoung,
    leave_granted:0,leave_carried_over:0,leave_manual_adjustment:0,oncall_leave_granted:0,celebration_days:0,celebration_used_adj:0});
  // ② まだ二重のまま（付与3＝お祝い3、通常有給1日使用）
  put({id:'s_double',name:'二重花子',type:'nurse',kaigo_col:'E',iryo_col:'F',archived:false,hire_date:hireYoung,
    leave_granted:3,leave_carried_over:0,leave_manual_adjustment:0,oncall_leave_granted:0,celebration_days:3,celebration_used_adj:0});
  // ③ 二重だが取得実績なし（付与3＝お祝い3、通常有給の使用0）→ 水増し付与を0に戻すだけ
  put({id:'s_phantom',name:'水増子',type:'PT',col:'H',archived:false,hire_date:hireYoung,
    leave_granted:3,leave_carried_over:0,leave_manual_adjustment:0,oncall_leave_granted:0,celebration_days:3,celebration_used_adj:0});
  // ④ お祝い付与が標準より多い(5)スタッフ → 付替時に勝手に3へ下げない（現行値を維持）
  put({id:'s_celeb5',name:'祝五郎',type:'PT',col:'I',archived:false,hire_date:hireYoung,
    leave_granted:0,leave_carried_over:0,leave_manual_adjustment:0,oncall_leave_granted:0,celebration_days:5,celebration_used_adj:0});
  // ④ 正常（勤続長め・お祝い期限切れ・付与＝自動計算）
  const hireOld=daysFromNow(-900);
  const okGrant=calcLeaveGrantDays(hireOld,daysFromNow(0));
  put({id:'s_ok',name:'正常次郎',type:'PT',col:'G',archived:false,hire_date:hireOld,
    leave_granted:okGrant,leave_carried_over:0,leave_manual_adjustment:0,oncall_leave_granted:0,celebration_days:3,celebration_used_adj:0});

  saveLeave({requests:[
    {id:'z1',staffId:'s_zeroed',staffName:'ゼロ太郎',type:'full',dates:[daysFromNow(-20)],status:'approved'},
    {id:'z2',staffId:'s_zeroed',staffName:'ゼロ太郎',type:'full',dates:[daysFromNow(-19)],status:'approved'},
    {id:'z3',staffId:'s_zeroed',staffName:'ゼロ太郎',type:'full',dates:[daysFromNow(-18)],status:'approved'},
    {id:'d1',staffId:'s_double',staffName:'二重花子',type:'full',dates:[daysFromNow(-15)],status:'approved'},
    {id:'c1',staffId:'s_celeb5',staffName:'祝五郎',type:'full',dates:[daysFromNow(-12)],status:'approved'},
    {id:'o1',staffId:'s_ok',staffName:'正常次郎',type:'full',dates:[daysFromNow(-25)],status:'approved'},
  ]});

  const {app}=require('./server.js');
  const a=request.agent(app);
  const loginRes=await a.post('/api/admin/login').send({staffId:'boss',password:'Admin12345'});
  const csrfRaw=(loginRes.headers['set-cookie']||[]).find(c=>c.startsWith('csrf_token='));
  const csrf=csrfRaw?.split(';')[0]?.split('=').slice(1).join('=')??'';

  console.log('\n📌 お祝い休暇の付け替え修正');

  const prev=(await a.get('/api/admin/leave-reconcile')).body;
  const zeroed=prev.rows.find(r=>r.id==='s_zeroed');
  const dbl=prev.rows.find(r=>r.id==='s_double');
  const phantom=prev.rows.find(r=>r.id==='s_phantom');

  await test('マイナス残（付与0・通常有給3使用）を対象にする', () => {
    assert.ok(zeroed,'ゼロ太郎が対象');
    assert.strictEqual(zeroed.before.balance,-3,'修正前は-3日');
    assert.strictEqual(zeroed.reclassify_days,3,'3日を付け替え');
    assert.strictEqual(zeroed.after.granted,0,'付与は自動計算0');
    assert.strictEqual(zeroed.after.celebration_days,3,'お祝いは標準3');
    assert.strictEqual(zeroed.after.balance,0,'修正後の残は0');
  });

  await test('二重のまま（付与3＞自動0）も対象にする', () => {
    assert.ok(dbl,'二重花子が対象');
    assert.strictEqual(dbl.reclassify_days,1);
    assert.strictEqual(dbl.after.granted,0);
    assert.strictEqual(dbl.after.balance,0);
  });

  await test('二重だが取得実績なし（水増し付与）も対象にする', () => {
    assert.ok(phantom,'水増子が対象');
    assert.strictEqual(phantom.reclassify_days,0,'付け替え日数は0');
    assert.strictEqual(phantom.before.granted,3);
    assert.strictEqual(phantom.after.granted,0,'水増し付与を0に戻す');
    assert.strictEqual(phantom.after.celebration_days,3);
    assert.strictEqual(phantom.after.balance,0);
  });

  await test('お祝い付与が標準より多い場合は下げず現行値を維持する', () => {
    const c5=prev.rows.find(r=>r.id==='s_celeb5');
    assert.ok(c5,'祝五郎が対象');
    assert.strictEqual(c5.before.celebration_days,5);
    assert.strictEqual(c5.after.celebration_days,5,'5のまま（3に下げない）');
    assert.strictEqual(c5.reclassify_days,1);
    assert.strictEqual(c5.after.granted,0);
    assert.strictEqual(c5.after.balance,0);
  });

  await test('正常スタッフ（お祝い期限切れ・付与＝自動）は対象外', () => {
    assert.ok(!prev.rows.find(r=>r.id==='s_ok'),'正常次郎は対象外');
    assert.strictEqual(prev.summary.eligible,4);
  });

  await test('適用: 付け替え後にDBが正しく更新される', async () => {
    const res=await a.post('/api/admin/leave-reconcile/apply').set('x-csrf-token',csrf).send({staffId:'s_zeroed'});
    assert.strictEqual(res.status,200);
    assert.ok(res.body.success);
    const staff=loadStaff().staff.find(s=>s.id==='s_zeroed');
    assert.strictEqual(staff.leave_granted,0,'付与0');
    assert.strictEqual(staff.celebration_days,3,'お祝い3');
    const reqs=loadLeave().requests.filter(r=>r.staffId==='s_zeroed');
    const portion=reqs.reduce((sum,r)=>sum+(r.celebration_days||0),0);
    assert.strictEqual(portion,3,'3日分がお祝い部分消費として記録');
    assert.strictEqual(calcLeaveBalance(staff,reqs),0,'有給残は0（マイナス解消）');
  });

  await test('冪等: 適用後は対象外になる', async () => {
    const again=(await a.get('/api/admin/leave-reconcile')).body;
    assert.ok(!again.rows.find(r=>r.id==='s_zeroed'),'再適用は不要');
    assert.strictEqual(again.summary.eligible,3,'残るのは二重花子・水増子・祝五郎');
    // 二重に適用しようとしても対象外エラー
    const res=await a.post('/api/admin/leave-reconcile/apply').set('x-csrf-token',csrf).send({staffId:'s_zeroed'});
    assert.strictEqual(res.status,400,'対象外は400');
  });

  await test('サマリにお祝い休暇の使用日数・残が出る（モーダル表示用）', async () => {
    const sum=(await a.get('/api/admin/leave/summary')).body.summary;
    const z=sum.find(x=>x.id==='s_zeroed');
    assert.strictEqual(z.celebration_used,3,'付替後はお祝い使用3日として集計される');
    assert.strictEqual(z.celebration_remaining,0,'残0（付与3−使用3）');
    const c5=sum.find(x=>x.id==='s_celeb5');
    assert.strictEqual(c5.celebration_used,0,'未付替は0（まだ通常有給として記録）');
    assert.strictEqual(c5.celebration_remaining,5,'残5（付与5−使用0）');
  });

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`結果: ${passed} passed, ${failed} failed`);
  if(failed>0){console.error('❌ テスト失敗');process.exit(1);}
  console.log('✨ All tests passed!');
  process.exit(0);
})().catch(e=>{console.error('テスト実行エラー:',e);process.exit(1);});
