'use strict';
/**
 * 回帰テスト: 訪問件数の過去データ移行（段階2）＋照合（段階3）
 * 実行: node test-visit-migrate.js
 * 各シートの見出し（氏名）を正として列→スタッフを対応づけ、Sheet→SQLiteへ取り込む。
 * 見出しに一致しない列（退職者の残列など）は取り込まず orphaned として報告する。Sheetは無変更。
 */
const os=require('os'),path=require('path'),fs=require('fs'),assert=require('assert');
const TEST_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'visitmig-'));
process.env.DATA_DIR=TEST_DIR;process.env.SESSION_SECRET='s';process.env.NODE_ENV='test';
process.env.SPREADSHEET_ID='dummy';delete process.env.GOOGLE_CREDENTIALS;

// ── fake Sheets（store をセル単位で保持。getValuesで範囲読み出し） ──
const store=new Map();
const colIdx=(c)=>{let n=0;for(const ch of c)n=n*26+(ch.charCodeAt(0)-64);return n-1;};
const idxCol=(i)=>{let s='',n=i+1;while(n>0){s=String.fromCharCode(64+((n-1)%26+1))+s;n=Math.floor((n-1)/26);}return s;};
function parseRange(r){const b=r.indexOf('!');const t=r.slice(0,b),a=r.slice(b+1);const m=a.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);return{title:t,c1:m[1],r1:+m[2],c2:m[3]||m[1],r2:m[4]?+m[4]:+m[2]};}
function readRange(r){const{title,c1,r1,c2,r2}=parseRange(r);const ci1=colIdx(c1),ci2=colIdx(c2);const out=[];for(let R=r1;R<=r2;R++){const a=[];for(let ci=ci1;ci<=ci2;ci++){const k=`${title}!${idxCol(ci)}${R}`;a.push(store.has(k)?store.get(k):'');}while(a.length&&(a[a.length-1]===''||a[a.length-1]==null))a.pop();out.push(a);}while(out.length&&out[out.length-1].length===0)out.pop();return out;}
function seed(cell,val){store.set(cell,String(val));}
const fakeSheets={getAuth:()=>({}),getSheets:async()=>({}),sheetsRetry:async(fn)=>fn(),buildSheetHeaderRow:()=>['日付','曜日'],createSpreadsheetForYear:async()=>'dummy',hasRecordForDate:async()=>false,getAllStaffRecordStatus:async()=>({missing:[],entered:[],onLeave:[]}),getValues:async(s,r)=>readRange(r),updateValues:async()=>{},batchUpdateValues:async()=>{},batchGetValues:async()=>[]};
const sp=require.resolve('./lib/sheets.js');
require.cache[sp]={id:sp,filename:sp,loaded:true,exports:fakeSheets};

const request=require('supertest');
const bcrypt=require('bcryptjs');
const {getDb}=require('./lib/db');
const {ensureDataDir,getVisitRecord,upsertVisitRecord}=require('./lib/data');

let passed=0,failed=0;
async function test(name,fn){try{await fn();console.log(`  ✅ ${name}`);passed++;}catch(e){console.error(`  ❌ ${name}\n     ${e.message}`);failed++;}}

(async()=>{
  await ensureDataDir();
  const db=getDb();
  const put=(s)=>db.prepare('INSERT OR REPLACE INTO staff (id,data) VALUES (?,?)').run(s.id,JSON.stringify(s));
  put({id:'n1',name:'看甲',type:'nurse',kaigo_col:'C',iryo_col:'D',archived:false,hire_date:'2024-04-01'});
  put({id:'p1',name:'リ乙',type:'PT',col:'E',archived:false,hire_date:'2024-04-01'});
  put({id:'boss',name:'管理者',type:'office',is_admin:true,archived:false,password_hash:bcrypt.hashSync('Admin12345',4)});
  // 年→シートID を登録（当年）
  const YEAR=new Date().getFullYear();
  db.prepare('INSERT OR REPLACE INTO spreadsheet_registry (year, spreadsheet_id) VALUES (?,?)').run(String(YEAR),'testsid');

  // 1月シートの見出し＆データを仕込む（看甲=C/D, リ乙=E, 退職者 廣瀬=G/H は該当スタッフ無し）
  seed('1月!C3','看甲'); seed('1月!C4','介護'); seed('1月!D4','医療');
  seed('1月!E3','リ乙'); // PT（row4は空）
  seed('1月!G3','廣瀬'); seed('1月!G4','介護'); seed('1月!H4','医療'); // 退職者の残列（該当スタッフ無し）
  // データ（5行目=1日）
  seed('1月!C5','3'); seed('1月!D5','4');   // 看甲 1/1: 介護3 医療4
  seed('1月!E5','7');                        // リ乙 1/1: 7
  seed('1月!C6','2'); seed('1月!D6','1');   // 看甲 1/2: 介護2 医療1
  seed('1月!G5','99');                       // 廣瀬(退職)の残データ → 取り込まない

  const {app}=require('./server.js');
  const a=request.agent(app);
  const login=await a.post('/api/admin/login').send({staffId:'boss',password:'Admin12345'});
  const csrf=(login.headers['set-cookie']||[]).find(x=>x.startsWith('csrf_token='))?.split(';')[0]?.split('=').slice(1).join('=')??'';

  console.log('\n📌 訪問件数の過去データ移行＆照合');

  await test('取り込み前: statusでSheet件数を把握（SQLiteは0）', async () => {
    const s=(await a.get('/api/admin/visit-migrate/status')).body;
    const n1=s.rows.find(r=>r.id==='n1');
    assert.strictEqual(n1.sheetCount,2,'看甲はSheetに2件');
    assert.strictEqual(n1.sqliteCount,0,'まだSQLiteは0');
    assert.ok(s.summary.orphanColumns>=1,'廣瀬の残列がorphanとして検出される');
  });

  await test('backfill: 見出しに一致する分だけSQLiteへ取り込む', async () => {
    const r=await a.post('/api/admin/visit-migrate/backfill').set('x-csrf-token',csrf).send({});
    assert.strictEqual(r.status,200,JSON.stringify(r.body));
    assert.strictEqual(r.body.imported,3,'看甲2件+リ乙1件=3件');
    // 看甲 1/1
    const rec=getVisitRecord('n1',`${YEAR}-01-01`);
    assert.ok(rec); assert.strictEqual(rec.kaigo,3); assert.strictEqual(rec.iryo,4);
    // リ乙 1/1
    const prec=getVisitRecord('p1',`${YEAR}-01-01`);
    assert.strictEqual(prec.value,7);
    // 看甲 1/2
    assert.strictEqual(getVisitRecord('n1',`${YEAR}-01-02`).kaigo,2);
  });

  await test('退職者(廣瀬)の残列は取り込まず orphan として報告', async () => {
    const r=await a.post('/api/admin/visit-migrate/backfill').set('x-csrf-token',csrf).send({});
    const orphan=r.body.orphanCols.find(o=>o.where.includes('廣瀬'));
    assert.ok(orphan,'廣瀬列がorphanに出る');
    assert.strictEqual(orphan.count,1,'廣瀬の残データ1件');
    // 廣瀬はSQLiteに入っていない（該当staffが無いので当然）
  });

  await test('取り込み後: statusで照合が一致（covered）', async () => {
    const s=(await a.get('/api/admin/visit-migrate/status')).body;
    const n1=s.rows.find(r=>r.id==='n1');
    assert.strictEqual(n1.sheetCount,2); assert.strictEqual(n1.sqliteCount,2,'2件が取り込まれている');
    assert.ok(s.summary.fullyCovered,'全スタッフでSheet≦SQLite（取りこぼしなし）');
  });

  await test('既存(二重書き込み済み)の正しい値はシートで上書きしない', async () => {
    // 2月の見出しとデータ（看甲 2/1 = 介護5）を仕込む
    seed('2月!C3','看甲'); seed('2月!C4','介護'); seed('2月!D4','医療');
    seed('2月!C5','5');
    // ただしSQLiteには既に「二重書き込み済みの正しい値」= 介護99 が入っているとする
    upsertVisitRecord('n1',`${YEAR}-02-01`,{kaigo:99,iryo:null,value:null});
    const r=await a.post('/api/admin/visit-migrate/backfill').set('x-csrf-token',csrf).send({});
    assert.strictEqual(r.status,200,JSON.stringify(r.body));
    // シートの5では上書きされず、99のまま
    assert.strictEqual(getVisitRecord('n1',`${YEAR}-02-01`).kaigo,99,'既存値99が保護される');
    assert.ok(r.body.skipped>=1,'既存分はskippedとして数える');
  });

  await test('冪等: 再実行しても件数は増えない（既存は保護）', async () => {
    await a.post('/api/admin/visit-migrate/backfill').set('x-csrf-token',csrf).send({});
    const s=(await a.get('/api/admin/visit-migrate/status')).body;
    // n1: 1/1, 1/2（Sheet由来）＋ 2/1（事前投入・保護）= 3件のまま
    assert.strictEqual(s.rows.find(x=>x.id==='n1').sqliteCount,3,'3件のまま');
  });

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`結果: ${passed} passed, ${failed} failed`);
  if(failed>0){console.error('❌ テスト失敗');process.exit(1);}
  console.log('✨ All tests passed!');
  process.exit(0);
})().catch(e=>{console.error('テスト実行エラー:',e);process.exit(1);});
