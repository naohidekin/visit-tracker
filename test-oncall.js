'use strict';
/**
 * 回帰テスト: オンコール締期間の表示整合性
 * 実行: node test-oncall.js
 *
 * 背景（バグ）: オンコール画面の月セレクタが「当月カレンダー月」を初期表示していたため、
 *   毎月16日以降に入力した当番（当月16日〜翌月15日の締期間＝翌月ラベル側）が、
 *   初期表示の締期間に出てこず「登録したのに反映されない」ように見えていた。
 *   → 16日以降は翌月ラベルを初期表示にする（frontendDefaultMonth 相当）。
 */
const os=require('os'),path=require('path'),fs=require('fs'),assert=require('assert');
const TEST_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'visit-oncall-'));
process.env.DATA_DIR=TEST_DIR;process.env.SESSION_SECRET='oncall-test';process.env.NODE_ENV='test';
process.env.SPREADSHEET_ID='dummy';delete process.env.GOOGLE_CREDENTIALS;

const request=require('supertest');
const bcrypt=require('bcryptjs');
const {getDb}=require('./lib/db');
const {ensureDataDir}=require('./lib/data');

let passed=0,failed=0;
async function test(name,fn){try{await fn();console.log(`  ✅ ${name}`);passed++;}catch(e){console.error(`  ❌ ${name}\n     ${e.message}`);failed++;}}

// フロント（oncall.html）の初期表示月ロジックと同じもの
function frontendDefaultMonth(todayStr){
  const [y,m,d]=todayStr.split('-').map(Number);
  const base=d>=16?1:0;
  const dt=new Date(y,(m-1)+base,1);
  return dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0');
}

(async()=>{
  await ensureDataDir();
  getDb().prepare('INSERT OR REPLACE INTO staff (id,data) VALUES (?,?)').run('t_nurse',JSON.stringify({
    id:'t_nurse',name:'テスト看護師',type:'nurse',kaigo_col:'C',iryo_col:'D',
    password_hash:bcrypt.hashSync('nurse123',4),is_admin:false,archived:false,hire_date:'2024-04-01',oncall_eligible:true,
  }));
  getDb().prepare('INSERT OR REPLACE INTO staff (id,data) VALUES (?,?)').run('boss',JSON.stringify({
    id:'boss',name:'管理者',type:'office',is_admin:true,archived:false,password_hash:bcrypt.hashSync('Admin12345',4),
  }));
  const {app}=require('./server.js');
  const a=request.agent(app);
  const login=await a.post('/api/login').send({loginId:'t_nurse',password:'nurse123'});
  const csrf=(login.headers['set-cookie']||[]).find(x=>x.startsWith('csrf_token='))?.split(';')[0]?.split('=').slice(1).join('=')??'';
  const post=(body)=>a.post('/api/oncall/records').set('x-csrf-token',csrf).send(body);
  const recs=async(month)=>(await a.get('/api/oncall/records?month='+month)).body.records||[];

  console.log('\n📌 オンコール締期間の表示');

  await test('16日以降の当番は「翌月ラベルの締期間」に入る（当月ラベルには出ない）', async () => {
    await post({date:'2026-07-20',count:0,totalHours:8,transportCount:1});
    const inAug=(await recs('2026-08')).some(r=>r.date==='2026-07-20'); // 8月（締期間）=7/16〜8/15
    const inJul=(await recs('2026-07')).some(r=>r.date==='2026-07-20'); // 7月（締期間）=6/16〜7/15
    assert.ok(inAug,'7/20 は「8月（締期間）」に表示される');
    assert.ok(!inJul,'7/20 は「7月（締期間）」には表示されない');
    const sum=(await a.get('/api/oncall/monthly-summary?month=2026-08')).body.summary;
    assert.strictEqual(sum.totalMinutes,480,'8月締期間の合計は8時間');
  });

  await test('15日以前の当番は「当月ラベルの締期間」に入る', async () => {
    await post({date:'2026-07-10',count:0,totalHours:5,transportCount:0});
    const inJul=(await recs('2026-07')).some(r=>r.date==='2026-07-10');
    assert.ok(inJul,'7/10 は「7月（締期間）」に表示される');
  });

  await test('初期表示月ロジック: 16日以降は翌月ラベルを初期表示にする', async () => {
    assert.strictEqual(frontendDefaultMonth('2026-07-27'),'2026-08','7/27 の初期表示は 8月（締期間）');
    assert.strictEqual(frontendDefaultMonth('2026-07-16'),'2026-08','7/16 の初期表示は 8月（締期間）');
    assert.strictEqual(frontendDefaultMonth('2026-07-15'),'2026-07','7/15 の初期表示は 7月（締期間）');
    assert.strictEqual(frontendDefaultMonth('2026-12-20'),'2027-01','年跨ぎ: 12/20 の初期表示は 翌年1月');
    // 初期表示月が、その日入力した当番を必ず含むこと
    assert.ok((await recs(frontendDefaultMonth('2026-07-20'))).some(r=>r.date==='2026-07-20'),'初期表示月に当日の当番が含まれる');
  });

  await test('管理者向け: オンコール有給の累計実績（15時間=1日）を集計する', async () => {
    // これまでに 7/20=8h + 7/10=5h を登録済み（計13h）。あと3hで計16h=1日付与。
    await post({date:'2026-07-12',count:0,totalHours:3,transportCount:0});
    const admin=request.agent(app);
    await admin.post('/api/admin/login').send({staffId:'boss',password:'Admin12345'});
    const rows=(await admin.get('/api/admin/oncall/leave-ledger')).body.rows;
    const row=rows.find(r=>r.staffId==='t_nurse');
    assert.ok(row,'対象スタッフが実績に出る');
    assert.strictEqual(row.totalHours,16,'累計16時間');
    assert.strictEqual(row.grantedDays,1,'16h → 15hで1日付与');
    assert.strictEqual(row.validDays,1,'期限内なので有効1日');
    assert.strictEqual(row.expiredDays,0,'期限切れなし');
    assert.strictEqual(row.hoursToNext,14,'次の1日まであと14時間（30h-16h）');
  });

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`結果: ${passed} passed, ${failed} failed`);
  if(failed>0){console.error('❌ テスト失敗');process.exit(1);}
  console.log('✨ All tests passed!');
  process.exit(0);
})().catch(e=>{console.error('テスト実行エラー:',e);process.exit(1);});
