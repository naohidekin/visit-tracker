'use strict';
/**
 * 回帰テスト: 訪問件数の読み取り正本化（段階4）
 * 実行: node test-visit-read.js
 * GET /api/record・/api/monthly-stats・/api/monthly-detail（通常/締め）が
 * SQLite(visit_records)から正しく集計して返すことを検証する。
 */
const os=require('os'),path=require('path'),fs=require('fs'),assert=require('assert');
const TEST_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'visitread-'));
process.env.DATA_DIR=TEST_DIR;process.env.SESSION_SECRET='s';process.env.NODE_ENV='test';
process.env.SPREADSHEET_ID='dummy';delete process.env.GOOGLE_CREDENTIALS;

// Sheets はfake（読み取りはSQLiteなので呼ばれない。念のため用意）
const fakeSheets={getAuth:()=>({}),getSheets:async()=>({}),sheetsRetry:async(fn)=>fn(),buildSheetHeaderRow:()=>[],createSpreadsheetForYear:async()=>'dummy',hasRecordForDate:async()=>false,getAllStaffRecordStatus:async()=>({missing:[],entered:[],onLeave:[]}),getValues:async()=>[],updateValues:async()=>{},batchUpdateValues:async()=>{},batchGetValues:async()=>[]};
const sp=require.resolve('./lib/sheets.js');
require.cache[sp]={id:sp,filename:sp,loaded:true,exports:fakeSheets};

const request=require('supertest');
const bcrypt=require('bcryptjs');
const {getDb}=require('./lib/db');
const {ensureDataDir,upsertVisitRecord,getRecordStatusForDate}=require('./lib/data');

let passed=0,failed=0;
async function test(name,fn){try{await fn();console.log(`  ✅ ${name}`);passed++;}catch(e){console.error(`  ❌ ${name}\n     ${e.message}`);failed++;}}

(async()=>{
  await ensureDataDir();
  const db=getDb();
  const put=(s)=>db.prepare('INSERT OR REPLACE INTO staff (id,data) VALUES (?,?)').run(s.id,JSON.stringify(s));
  put({id:'n1',name:'看護A',type:'nurse',kaigo_col:'C',iryo_col:'D',archived:false,hire_date:'2024-04-01',password_hash:bcrypt.hashSync('nurse123',4)});
  put({id:'p1',name:'リハA',type:'PT',col:'E',archived:false,hire_date:'2024-04-01',password_hash:bcrypt.hashSync('rehab123',4)});
  put({id:'boss',name:'管理者',type:'office',is_admin:true,archived:false,password_hash:bcrypt.hashSync('Admin12345',4)});

  // SQLiteに既知データを投入（8月・9月）
  upsertVisitRecord('n1','2026-08-01',{kaigo:3,iryo:4});
  upsertVisitRecord('n1','2026-08-02',{kaigo:2,iryo:1});
  upsertVisitRecord('n1','2026-08-20',{kaigo:1,iryo:1}); // 締め期間テスト用
  upsertVisitRecord('n1','2026-09-10',{kaigo:2,iryo:2}); // 締め期間テスト用
  upsertVisitRecord('p1','2026-08-01',{value:7});
  upsertVisitRecord('p1','2026-08-03',{value:5});

  const {app}=require('./server.js');
  async function login(id,pw){const a=request.agent(app);await a.post('/api/login').send({loginId:id,password:pw});return a;}
  const nurse=await login('n1','nurse123');
  const pt=await login('p1','rehab123');
  const admin=request.agent(app);
  await admin.post('/api/admin/login').send({staffId:'boss',password:'Admin12345'});

  console.log('\n📌 訪問件数の読み取り（SQLite正本）');

  await test('GET /api/record: 看護師の既存値を返す', async () => {
    const r=(await nurse.get('/api/record?date=2026-08-01')).body;
    assert.strictEqual(r.kaigo,3); assert.strictEqual(r.iryo,4);
  });
  await test('GET /api/record: 記録なしはnull', async () => {
    const r=(await nurse.get('/api/record?date=2026-08-15')).body;
    assert.strictEqual(r.kaigo,null); assert.strictEqual(r.iryo,null);
  });
  await test('GET /api/record: PTの既存値を返す', async () => {
    const r=(await pt.get('/api/record?date=2026-08-01')).body;
    assert.strictEqual(r.value,7);
  });

  await test('monthly-stats: 看護師の月合計と稼働日数', async () => {
    const r=(await nurse.get('/api/monthly-stats?year=2026&month=8')).body;
    assert.strictEqual(r.total_kaigo,6,'介護 3+2+1=6'); // 8/1,8/2,8/20
    assert.strictEqual(r.total_iryo,6,'医療 4+1+1=6');
    assert.strictEqual(r.total,12);
    assert.strictEqual(r.working_days,3);
  });
  await test('monthly-stats: PTの月合計', async () => {
    const r=(await pt.get('/api/monthly-stats?year=2026&month=8')).body;
    assert.strictEqual(r.total_units,12,'7+5=12'); assert.strictEqual(r.working_days,2);
  });

  await test('monthly-detail: 看護師の日別と合計', async () => {
    const r=(await nurse.get('/api/monthly-detail?year=2026&month=8')).body;
    assert.strictEqual(r.type,'nurse');
    const d1=r.days.find(d=>d.day===1), d2=r.days.find(d=>d.day===2), d15=r.days.find(d=>d.day===15);
    assert.strictEqual(d1.kaigo,3); assert.strictEqual(d1.iryo,4); assert.strictEqual(d1.total,7);
    assert.strictEqual(d2.total,3);
    assert.strictEqual(d15.kaigo,null,'記録なしはnull');
    assert.strictEqual(r.stats.total_kaigo,6); assert.strictEqual(r.stats.total_iryo,6);
  });

  await test('monthly-detail 締め: 前月16日〜当月15日を集計', async () => {
    // month=9 → 締め期間 8/16〜9/15。該当: 8/20(1,1) と 9/10(2,2)
    const r=(await nurse.get('/api/monthly-detail?year=2026&month=9&mode=billing')).body;
    assert.strictEqual(r.mode,'billing');
    assert.strictEqual(r.stats.total_kaigo,3,'8/20の1 + 9/10の2 = 3');
    assert.strictEqual(r.stats.total_iryo,3);
    assert.strictEqual(r.stats.working_days,2);
    const a20=r.days.find(d=>d.date==='2026-08-20'), s10=r.days.find(d=>d.date==='2026-09-10');
    assert.strictEqual(a20.total,2); assert.strictEqual(s10.total,4);
  });

  console.log('\n📌 管理者用 月次明細（SQLite正本）');

  await test('admin monthly-detail: 看護師の月合計をSQLiteから集計', async () => {
    const r=(await admin.get('/api/admin/monthly-detail?staffId=n1&year=2026&month=8')).body;
    assert.strictEqual(r.type,'nurse');
    assert.strictEqual(r.stats.total_kaigo,6,'介護 3+2+1=6');
    assert.strictEqual(r.stats.total_iryo,6,'医療 4+1+1=6');
    assert.strictEqual(r.stats.working_days,3);
    const d1=r.days.find(d=>d.day===1);
    assert.strictEqual(d1.kaigo,3); assert.strictEqual(d1.iryo,4); assert.strictEqual(d1.total,7);
  });
  await test('admin monthly-detail: PTの月合計をSQLiteから集計', async () => {
    const r=(await admin.get('/api/admin/monthly-detail?staffId=p1&year=2026&month=8')).body;
    assert.strictEqual(r.staffType,'PT');
    assert.strictEqual(r.stats.total_units,12,'7+5=12');
    assert.strictEqual(r.stats.working_days,2);
  });

  console.log('\n📌 入力状況判定（getRecordStatusForDate, SQLite正本）');

  await test('getRecordStatusForDate: 記録ありは entered', async () => {
    const s=getRecordStatusForDate('2026-08-01', ()=>false);
    assert.deepStrictEqual(s.entered.map(x=>x.id).sort(),['n1','p1']);
    assert.strictEqual(s.missing.length,0);
    assert.strictEqual(s.onLeave.length,0);
  });
  await test('getRecordStatusForDate: 記録なしは missing', async () => {
    const s=getRecordStatusForDate('2026-08-15', ()=>false);
    assert.deepStrictEqual(s.missing.map(x=>x.id).sort(),['n1','p1']);
    assert.strictEqual(s.entered.length,0);
  });
  await test('getRecordStatusForDate: 有給者は onLeave（entered/missingに出さない）', async () => {
    const s=getRecordStatusForDate('2026-08-01', (id,d)=>id==='n1'&&d==='2026-08-01');
    assert.deepStrictEqual(s.onLeave.map(x=>x.id),['n1']);
    assert.deepStrictEqual(s.entered.map(x=>x.id),['p1']);
    assert.strictEqual(s.missing.length,0);
  });

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`結果: ${passed} passed, ${failed} failed`);
  if(failed>0){console.error('❌ テスト失敗');process.exit(1);}
  console.log('✨ All tests passed!');
  process.exit(0);
})().catch(e=>{console.error('テスト実行エラー:',e);process.exit(1);});
