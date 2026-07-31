'use strict';
/**
 * 回帰テスト: 有給・お祝い休暇の整合性チェック（読み取り専用）
 * 実行: node test-leave-audit.js
 * 「付与日数(有給)にお祝い休暇分が二重に入っている」検出と、アプリ申請の使用内訳を検証。
 */
const os=require('os'),path=require('path'),fs=require('fs'),assert=require('assert');
const TEST_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'leaveaudit-'));
process.env.DATA_DIR=TEST_DIR;process.env.SESSION_SECRET='s';process.env.NODE_ENV='test';
process.env.SPREADSHEET_ID='dummy';delete process.env.GOOGLE_CREDENTIALS;

const request=require('supertest');
const bcrypt=require('bcryptjs');
const {getDb}=require('./lib/db');
const {ensureDataDir,saveLeave}=require('./lib/data');

let passed=0,failed=0;
async function test(name,fn){try{await fn();console.log(`  ✅ ${name}`);passed++;}catch(e){console.error(`  ❌ ${name}\n     ${e.message}`);failed++;}}

(async()=>{
  await ensureDataDir();
  const db=getDb();
  const put=(s)=>db.prepare('INSERT OR REPLACE INTO staff (id,data) VALUES (?,?)').run(s.id,JSON.stringify(s));
  put({id:'boss',name:'管理者',type:'office',is_admin:true,archived:false,password_hash:bcrypt.hashSync('Admin12345',4)});
  // 二重: 有給付与5 == お祝い5、入社<6ヶ月(自動0)
  put({id:'s_dbl',name:'二重太郎',type:'nurse',kaigo_col:'C',iryo_col:'D',archived:false,hire_date:'2026-04-01',
    leave_granted:5,leave_carried_over:0,leave_manual_adjustment:0,oncall_leave_granted:0,celebration_days:5,celebration_used_adj:0});
  // 正常: 有給10(自動10と一致)、お祝い3
  put({id:'s_ok',name:'正常花子',type:'nurse',kaigo_col:'E',iryo_col:'F',archived:false,hire_date:'2026-01-05',
    leave_granted:10,leave_carried_over:0,leave_manual_adjustment:0,oncall_leave_granted:0,celebration_days:3,celebration_used_adj:3});
  // 二重太郎はアプリで通常有給1日を使用済み（承認済み）
  saveLeave({requests:[
    {id:'r1',staffId:'s_dbl',staffName:'二重太郎',type:'full',dates:['2026-08-01'],status:'approved'},
  ]});

  const {app}=require('./server.js');
  const a=request.agent(app);
  await a.post('/api/admin/login').send({staffId:'boss',password:'Admin12345'});

  const body=(await a.get('/api/admin/leave-audit')).body;
  const dbl=body.rows.find(r=>r.id==='s_dbl');
  const ok=body.rows.find(r=>r.id==='s_ok');

  console.log('\n📌 有給・お祝い休暇 整合性チェック');

  await test('付与＝お祝いの二重を検出する', () => {
    assert.ok(dbl.double_suspect,'二重太郎は二重疑い');
    assert.strictEqual(dbl.auto_grant,0,'入社<6ヶ月は自動計算0');
    assert.strictEqual(dbl.leave_granted,5);
    assert.strictEqual(dbl.celebration_days,5);
  });

  await test('アプリ申請の使用内訳（通常/お祝い）を集計する', () => {
    assert.strictEqual(dbl.app_regular_used,1,'通常有給1日使用');
    assert.strictEqual(dbl.app_celebration_used,0);
  });

  await test('推奨付与＝使用分を下回らない（マイナス防止）', () => {
    assert.strictEqual(dbl.suggested_granted,1,'自動0だが使用1があるため推奨は1');
    assert.ok(dbl.would_go_negative_if_auto,'0にすると残がマイナスになる警告');
  });

  await test('自動計算と一致する正常スタッフは二重疑いにならない', () => {
    assert.ok(!ok.double_suspect,'正常花子はOK');
    assert.strictEqual(ok.auto_grant,10);
  });

  await test('summary の二重件数が正しい', () => {
    assert.strictEqual(body.summary.doubleSuspects,1);
  });

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`結果: ${passed} passed, ${failed} failed`);
  if(failed>0){console.error('❌ テスト失敗');process.exit(1);}
  console.log('✨ All tests passed!');
  process.exit(0);
})().catch(e=>{console.error('テスト実行エラー:',e);process.exit(1);});
