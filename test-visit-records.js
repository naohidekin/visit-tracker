'use strict';
/**
 * 回帰テスト: 訪問件数の二重書き込み（SQLite正本化・段階1）
 * 実行: node test-visit-records.js
 * POST /api/record（本人）と POST /api/admin/record（管理）が、Google Sheets と同時に
 * SQLite の visit_records へ保存することを検証する。既存挙動（シート保存）は壊さない。
 */
const os=require('os'),path=require('path'),fs=require('fs'),assert=require('assert');
const TEST_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'visitrec-'));
process.env.DATA_DIR=TEST_DIR;process.env.SESSION_SECRET='s';process.env.NODE_ENV='test';
process.env.SPREADSHEET_ID='dummy';delete process.env.GOOGLE_CREDENTIALS;

// Sheetsはfakeで受けるだけ（書き込みno-op）。SQLite側の記録を検証する。
const fakeSheets={
  getAuth:()=>({}), getSheets:async()=>({}), sheetsRetry:async(fn)=>fn(),
  buildSheetHeaderRow:()=>['日付','曜日'], createSpreadsheetForYear:async()=>'dummy',
  hasRecordForDate:async()=>false, getAllStaffRecordStatus:async()=>({missing:[],entered:[],onLeave:[]}),
  getValues:async()=>[], updateValues:async()=>{}, batchUpdateValues:async()=>{},
  batchGetValues:async()=>[],
};
const sp=require.resolve('./lib/sheets.js');
require.cache[sp]={id:sp,filename:sp,loaded:true,exports:fakeSheets};

const request=require('supertest');
const bcrypt=require('bcryptjs');
const {getDb}=require('./lib/db');
const {ensureDataDir,getVisitRecord}=require('./lib/data');
const {getTodayJST}=require('./lib/helpers');

let passed=0,failed=0;
async function test(name,fn){try{await fn();console.log(`  ✅ ${name}`);passed++;}catch(e){console.error(`  ❌ ${name}\n     ${e.message}`);failed++;}}

(async()=>{
  await ensureDataDir();
  const db=getDb();
  const put=(s)=>db.prepare('INSERT OR REPLACE INTO staff (id,data) VALUES (?,?)').run(s.id,JSON.stringify(s));
  put({id:'n1',name:'看護A',type:'nurse',kaigo_col:'C',iryo_col:'D',archived:false,hire_date:'2024-04-01',password_hash:bcrypt.hashSync('nurse123',4)});
  put({id:'p1',name:'リハA',type:'PT',col:'E',archived:false,hire_date:'2024-04-01',password_hash:bcrypt.hashSync('rehab123',4)});
  put({id:'boss',name:'管理者',type:'office',is_admin:true,archived:false,password_hash:bcrypt.hashSync('Admin12345',4)});

  const {app}=require('./server.js');
  const today=getTodayJST(); // 常に編集可能期間内かつ未来日でない

  async function login(endpoint,body){
    const a=request.agent(app);
    const r=await a.post(endpoint).send(body);
    const c=(r.headers['set-cookie']||[]).find(x=>x.startsWith('csrf_token='));
    return {a,csrf:c?.split(';')[0]?.split('=').slice(1).join('=')??''};
  }

  console.log('\n📌 訪問件数の二重書き込み（SQLite）');

  await test('看護師の入力が SQLite に保存される（kaigo/iryo）', async () => {
    const {a,csrf}=await login('/api/login',{loginId:'n1',password:'nurse123'});
    const r=await a.post('/api/record').set('x-csrf-token',csrf).send({date:today,kaigo:3,iryo:4});
    assert.strictEqual(r.status,200,JSON.stringify(r.body));
    const rec=getVisitRecord('n1',today);
    assert.ok(rec,'SQLiteに記録がある');
    assert.strictEqual(rec.kaigo,3); assert.strictEqual(rec.iryo,4); assert.strictEqual(rec.value,null);
  });

  await test('リハビリ職の入力が SQLite に保存される（value）', async () => {
    const {a,csrf}=await login('/api/login',{loginId:'p1',password:'rehab123'});
    const r=await a.post('/api/record').set('x-csrf-token',csrf).send({date:today,value:7});
    assert.strictEqual(r.status,200,JSON.stringify(r.body));
    const rec=getVisitRecord('p1',today);
    assert.ok(rec); assert.strictEqual(rec.value,7); assert.strictEqual(rec.kaigo,null); assert.strictEqual(rec.iryo,null);
  });

  await test('空入力は NULL として保存される', async () => {
    const {a,csrf}=await login('/api/login',{loginId:'p1',password:'rehab123'});
    const r=await a.post('/api/record').set('x-csrf-token',csrf).send({date:today,value:''});
    assert.strictEqual(r.status,200,JSON.stringify(r.body));
    assert.strictEqual(getVisitRecord('p1',today).value,null,'空はNULL');
  });

  await test('管理者の記録編集も SQLite に反映される', async () => {
    const {a,csrf}=await login('/api/admin/login',{staffId:'boss',password:'Admin12345'});
    const r=await a.post('/api/admin/record').set('x-csrf-token',csrf).send({staffId:'n1',date:today,kaigo:5,iryo:6});
    assert.strictEqual(r.status,200,JSON.stringify(r.body));
    const rec=getVisitRecord('n1',today);
    assert.strictEqual(rec.kaigo,5); assert.strictEqual(rec.iryo,6);
  });

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`結果: ${passed} passed, ${failed} failed`);
  if(failed>0){console.error('❌ テスト失敗');process.exit(1);}
  console.log('✨ All tests passed!');
  process.exit(0);
})().catch(e=>{console.error('テスト実行エラー:',e);process.exit(1);});
