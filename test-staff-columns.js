'use strict';
/**
 * 回帰テスト: スタッフ列割り当ての整合性（列ずれ防止）
 * 実行: node test-staff-columns.js
 *
 * 背景（バグ）:
 *   スタッフをアーカイブしてもシート列は解放されないのに、列番号の計算は
 *   「アーカイブ済みを除いた人数」を使っていた。そのためアーカイブ→リハビリ追加で
 *   新列が既存リハビリ職の列に衝突し、列挿入で既存データが右にずれる一方、
 *   そのスタッフの列番号メタ情報は更新されず、記録済みの訪問件数が消える／
 *   別人の値が表示される列ずれが発生していた（リハビリ職のみ）。
 *   さらに役員(admin)がリハビリ人数に数えられる不具合もあった。
 *
 * 不変条件: どんなアーカイブ/追加操作の後でも、各スタッフの col メタ情報は
 *   自分の記録セルを指し続ける（＝記録した値がそのまま読める）。列の共有も起きない。
 */
const os=require('os'),path=require('path'),fs=require('fs'),assert=require('assert');
const TEST_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'visit-cols-'));
process.env.DATA_DIR=TEST_DIR;process.env.SESSION_SECRET='s';process.env.NODE_ENV='test';
process.env.SPREADSHEET_ID='dummy';delete process.env.GOOGLE_CREDENTIALS;

const {MONTHS}=require('./lib/constants');
const store=new Map();
const colIdx=(c)=>{let n=0;for(const ch of c)n=n*26+(ch.charCodeAt(0)-64);return n-1;};
const idxCol=(i)=>{let s='',n=i+1;while(n>0){s=String.fromCharCode(64+((n-1)%26+1))+s;n=Math.floor((n-1)/26);}return s;};
function parseRange(r){const b=r.indexOf('!');const t=r.slice(0,b),a=r.slice(b+1);const m=a.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);return{title:t,c1:m[1],r1:+m[2],c2:m[3]||m[1],r2:m[4]?+m[4]:+m[2]};}
function readRange(r){const{title,c1,r1,c2,r2}=parseRange(r);const ci1=colIdx(c1),ci2=colIdx(c2);const out=[];for(let R=r1;R<=r2;R++){const a=[];for(let ci=ci1;ci<=ci2;ci++){const k=`${title}!${idxCol(ci)}${R}`;a.push(store.has(k)?store.get(k):'');}while(a.length&&(a[a.length-1]===''||a[a.length-1]==null))a.pop();out.push(a);}while(out.length&&out[out.length-1].length===0)out.pop();return out;}
function writeRange(r,v){const{title,c1,r1}=parseRange(r);const ci1=colIdx(c1);for(let i=0;i<v.length;i++)for(let j=0;j<(v[i]||[]).length;j++){const k=`${title}!${idxCol(ci1+j)}${r1+i}`;const val=v[i][j];if(val===''||val==null)store.delete(k);else store.set(k,String(val));}}
function shiftCols(title,startIndex,delta){ // delta>0 insert, delta<0 delete
  const keys=[...store.keys()].filter(k=>k.startsWith(title+'!'));
  const items=keys.map(k=>{const m=k.slice(title.length+1).match(/^([A-Z]+)(\d+)$/);return{k,ci:colIdx(m[1]),row:m[2],val:store.get(k)};});
  if(delta>0){
    for(const it of items) if(it.ci>=startIndex){store.delete(it.k);}
    for(const it of items.filter(i=>i.ci>=startIndex).sort((a,b)=>b.ci-a.ci)) store.set(`${title}!${idxCol(it.ci+delta)}${it.row}`,it.val);
  }else{
    const d=-delta;
    for(const it of items){if(it.ci>=startIndex&&it.ci<startIndex+d)store.delete(it.k);}
    for(const it of items.filter(i=>i.ci>=startIndex+d).sort((a,b)=>a.ci-b.ci)){store.delete(it.k);store.set(`${title}!${idxCol(it.ci-d)}${it.row}`,it.val);}
  }
}
const sheetsMeta=MONTHS.map((title,i)=>({properties:{title,sheetId:i}}));
const titleOf=(sid)=>MONTHS[sid];
const fakeApi={spreadsheets:{
  get:async()=>({data:{sheets:sheetsMeta}}),
  batchUpdate:async({requestBody})=>{for(const req of (requestBody.requests||[])){if(req.insertDimension){const{range}=req.insertDimension;if(range.dimension==='COLUMNS')shiftCols(titleOf(range.sheetId),range.startIndex,range.endIndex-range.startIndex);}else if(req.deleteDimension){const{range}=req.deleteDimension;if(range.dimension==='COLUMNS')shiftCols(titleOf(range.sheetId),range.startIndex,-(range.endIndex-range.startIndex));}}return{data:{}};},
  values:{get:async({range})=>({data:{values:readRange(range)}}),update:async({range,requestBody})=>{writeRange(range,requestBody.values);return{data:{}};},batchUpdate:async({requestBody})=>{for(const d of requestBody.data)writeRange(d.range,d.values);return{data:{}};},batchGet:async({ranges})=>({data:{valueRanges:ranges.map(r=>({values:readRange(r)}))}})}
}};
const fakeSheets={getAuth:()=>({}),getSheets:async()=>fakeApi,sheetsRetry:async(fn)=>fn(),buildSheetHeaderRow:()=>['日付','曜日'],createSpreadsheetForYear:async()=>'dummy',hasRecordForDate:async()=>false,getAllStaffRecordStatus:async()=>({missing:[],entered:[],onLeave:[]}),getValues:async(s,r)=>readRange(r),updateValues:async(s,r,v)=>{writeRange(r,v);},batchUpdateValues:async(s,d)=>{for(const x of d)writeRange(x.range,x.values);},batchGetValues:async(s,rs)=>rs.map(r=>({values:readRange(r)}))};
const sp=require.resolve('./lib/sheets.js');
require.cache[sp]={id:sp,filename:sp,loaded:true,exports:fakeSheets};

const request=require('supertest');
const bcrypt=require('bcryptjs');
const {getDb}=require('./lib/db');
const {ensureDataDir,loadStaff}=require('./lib/data');

let passed=0,failed=0;
async function test(name,fn){try{await fn();console.log(`  ✅ ${name}`);passed++;}catch(e){console.error(`  ❌ ${name}\n     ${e.message}`);failed++;}}
async function adminLogin(app){const a=request.agent(app);const res=await a.post('/api/admin/login').send({staffId:'boss',password:'pass1234'});const c=(res.headers['set-cookie']||[]).find(x=>x.startsWith('csrf_token='));return{a,csrf:c?.split(';')[0]?.split('=').slice(1).join('=')??''};}

let app;
function reset(staffRows){
  store.clear();
  const db=getDb();
  db.prepare('DELETE FROM staff').run();
  const boss={id:'boss',name:'管理者',type:'office',is_admin:true,archived:false,hire_date:'2024-04-01',seq:1,password_hash:bcrypt.hashSync('pass1234',4)};
  db.prepare('INSERT OR REPLACE INTO staff (id,data) VALUES (?,?)').run('boss',JSON.stringify(boss));
  staffRows.forEach((s,i)=>{const row={hire_date:'2024-04-01',archived:false,seq:i+2,password_hash:bcrypt.hashSync('pass1234',4),...s};db.prepare('INSERT OR REPLACE INTO staff (id,data) VALUES (?,?)').run(s.id,JSON.stringify(row));});
}
const cell=(col)=>{const k=`7月!${col}25`;return store.has(k)?store.get(k):null;};
function colOf(id){return loadStaff().staff.find(s=>s.id===id)?.col;}
function assertNoSharedCols(){const cols=loadStaff().staff.filter(s=>s.col).map(s=>s.col);assert.strictEqual(new Set(cols).size,cols.length,`列の共有が発生: ${JSON.stringify(cols)}`);}

(async()=>{
  await ensureDataDir();
  ({app}=require('./server.js'));

  console.log('\n📌 スタッフ列割り当ての整合性テスト');

  await test('アーカイブ→リハビリ追加で既存リハビリ職の記録が消えない（列ずれ防止）', async () => {
    reset([
      {id:'pt_a',name:'PT-A',type:'PT',col:'C'},
      {id:'pt_b',name:'PT-B',type:'PT',col:'D'},
      {id:'pt_c',name:'PT-C',type:'PT',col:'E'},
    ]);
    writeRange('7月!C25',[[11]]); writeRange('7月!D25',[[22]]); writeRange('7月!E25',[[33]]);
    const {a,csrf}=await adminLogin(app);
    await a.patch('/api/admin/staff/pt_a/archive').set('x-csrf-token',csrf).send({});
    const r=await a.post('/api/admin/staff').set('x-csrf-token',csrf).send({name:'PT-D',type:'PT',loginId:'pt_d',initialPw:'pass1234'});
    assert.strictEqual(r.status,200,`追加は成功: ${JSON.stringify(r.body)}`);
    // 既存スタッフの col が自分のデータを指し続ける
    assert.strictEqual(cell(colOf('pt_c')),'33','PT-C の記録33が読める');
    assert.strictEqual(cell(colOf('pt_b')),'22','PT-B の記録22が読める');
    assert.strictEqual(cell(colOf('pt_a')),'11','アーカイブPT-Aの記録11も保持');
    assertNoSharedCols();
    // 新スタッフは空いている右端の列
    assert.ok(colIdx(colOf('pt_d'))>colIdx(colOf('pt_c')),'PT-D は最右の新しい列');
  });

  await test('役員(admin)はリハビリ人数に数えられない（列が飛ばない）', async () => {
    reset([
      {id:'exec',name:'役員',type:'admin'},          // 列を持たない
      {id:'pt_a',name:'PT-A',type:'PT',col:'C'},
      {id:'pt_b',name:'PT-B',type:'PT',col:'D'},
    ]);
    writeRange('7月!C25',[[10]]); writeRange('7月!D25',[[20]]);
    const {a,csrf}=await adminLogin(app);
    const r=await a.post('/api/admin/staff').set('x-csrf-token',csrf).send({name:'PT-C',type:'PT',loginId:'pt_c',initialPw:'pass1234'});
    assert.strictEqual(r.status,200);
    assert.strictEqual(colOf('pt_c'),'E','新リハビリは D の次=E（役員で1つ飛ばない）');
    assert.strictEqual(cell(colOf('pt_a')),'10'); assert.strictEqual(cell(colOf('pt_b')),'20');
    assertNoSharedCols();
  });

  await test('アーカイブ看護師がいても看護師/リハビリ追加で列がずれない', async () => {
    reset([
      {id:'ns_a',name:'看A',type:'nurse',kaigo_col:'C',iryo_col:'D'},
      {id:'ns_b',name:'看B',type:'nurse',kaigo_col:'E',iryo_col:'F'},
      {id:'pt_x',name:'PT-X',type:'PT',col:'G'},
    ]);
    writeRange('7月!C25',[[1]]); writeRange('7月!D25',[[2]]); // 看A
    writeRange('7月!E25',[[3]]); writeRange('7月!F25',[[4]]); // 看B
    writeRange('7月!G25',[[99]]);                              // PT-X
    const {a,csrf}=await adminLogin(app);
    await a.patch('/api/admin/staff/ns_a/archive').set('x-csrf-token',csrf).send({});
    const r=await a.post('/api/admin/staff').set('x-csrf-token',csrf).send({name:'看C',type:'nurse',loginId:'ns_c',initialPw:'pass1234'});
    assert.strictEqual(r.status,200,`看護師追加成功: ${JSON.stringify(r.body)}`);
    const ns=(id)=>loadStaff().staff.find(s=>s.id===id);
    // 既存の看護師B と PT-X の記録が、更新後の col で正しく読める
    assert.strictEqual(cell(ns('ns_b').kaigo_col),'3','看B介護3');
    assert.strictEqual(cell(ns('ns_b').iryo_col),'4','看B医療4');
    assert.strictEqual(cell(colOf('pt_x')),'99','PT-X の99が読める（列ずれ無し）');
    assert.strictEqual(cell(ns('ns_a').iryo_col),'2','アーカイブ看Aの記録も保持');
    // col 共有が無いこと（看護師の kaigo/iryo と PT の col すべて）
    const all=loadStaff().staff.flatMap(s=>s.type==='nurse'?[s.kaigo_col,s.iryo_col].filter(Boolean):(s.col?[s.col]:[]));
    assert.strictEqual(new Set(all).size,all.length,`列共有が発生: ${JSON.stringify(all)}`);
  });

  await test('列ずれ調査ツール(column-audit)が既存の列ずれを検出する', async () => {
    reset([
      {id:'pt_a',name:'田中',type:'PT',col:'E'},   // データは別列(G)に取り残されている想定
      {id:'pt_b',name:'佐藤',type:'PT',col:'E'},   // 同じ列Eを指す（重複＝異常）
      {id:'pt_c',name:'鈴木',type:'PT',col:'F'},
    ]);
    writeRange('7月!E4',[['佐藤']]); // 見出し行(row4)
    writeRange('7月!F4',[['鈴木']]);
    writeRange('7月!G4',[['田中']]);
    const {a}=await adminLogin(app);
    const r=await a.get('/api/admin/column-audit');
    assert.strictEqual(r.status,200);
    assert.ok(r.body.summary.likelyDesynced,'列ずれを検出する');
    assert.strictEqual(r.body.summary.duplicateColumnAssignments,1,'重複列(E)を1件検出');
    assert.ok(r.body.suspects.some(s=>s.id==='pt_a'),'田中(pt_a)の見出し不一致を検出');
    assert.ok(!r.body.suspects.some(s=>s.id==='pt_c'),'鈴木(pt_c)は正常と判定');
  });

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`結果: ${passed} passed, ${failed} failed`);
  if(failed>0){console.error('❌ テスト失敗');process.exit(1);}
  console.log('✨ All tests passed!');
  process.exit(0);
})().catch(e=>{console.error('テスト実行エラー:',e);process.exit(1);});
