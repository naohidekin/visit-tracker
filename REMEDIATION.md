# visit-tracker 修繕パイプライン — 司令塔

このファイルはCCが修繕作業を実行する際の指示書。
進め方・順序・承認ポイント・禁止動作を定義する。
品質基準は REMEDIATION-SKILL.md、全体フローは REMEDIATION-PIPELINE.md を参照。

---

## Phase 1: 止血（Week 1）

### STEP 1 — 回帰テスト4本追加

対象: test-regression.js（新規作成）
テストフレームワーク: Node.js assert + supertest（既存と同じ）

追加するテスト:
1. アーカイブ済みスタッフが操作できないこと
2. CSRFトークンなしのPOSTが403を返すこと
3. 締め後（修正可能期間外）に記録を修正できないこと
4. 管理者以外がadmin系APIにアクセスできないこと

完了条件: `npm test` で既存テスト含め全通過

### STEP 2 — 入力検証 + CSRF整理

対象ファイル:
- routes/record.js — monthパラメータに 1-12 の範囲チェック追加
- server.js:103-113 — 手動cookieパースのエッジケース処理改善（新規ライブラリ追加不可）
- server.js:114-120 — CSRF除外パス一覧にコメントで理由を付記
- test-regression.js — CSRF検証テスト追加

完了条件: `npm test` 全通過 + `npm run security-check` 通過

### 🔴 承認ポイント1

オーナーが確認する項目:
- [ ] npm test 全通過
- [ ] CSRF除外パス一覧が妥当か
- [ ] 変更差分が想定内か

---

## Phase 2: 構造改善（Week 2〜4）

### STEP 3 — routes/admin.js 分割

routes/admin.js（2,012行）を以下10ファイルに分割:

| ファイル | 内容 |
|---------|------|
| admin-auth.js | login/logout/check/WebAuthn/me |
| admin-staff.js | CRUD/archive/権限/パスワード |
| admin-incentive.js | インセンティブ設定 |
| admin-billing.js | 月次詳細/インセンティブ集計 |
| admin-record.js | 管理者による記録編集 |
| admin-standby.js | 待機/雨天管理 |
| admin-audit.js | 監査ログ閲覧/検証 |
| admin-attendance.js | 月次出勤集計 |
| admin-excel.js | Excel取込/分析 |
| admin-sheets.js | スプレッドシート管理 |

admin.js は集約ファイル（router.use でマウント、~50行）として残す。
export/requireパターンは既存の record.js, auth.js に合わせる。

完了条件: npm test 全通過、全エンドポイントが同じパスで応答

### STEP 4 — public/admin.html インラインJS外部化

admin.html の `<script>` ブロック（~3,200行）を機能別の外部JSファイルに分離:
- public/js/admin-staff.js
- public/js/admin-leave.js
- public/js/admin-oncall.js
- public/js/admin-notice.js
- 等

admin.html には `<script src="...">` タグのみ残す。

完了条件: 管理画面の全タブが動作すること

### STEP 5 — CSP unsafe-inline 除去

- server.js の helmet 設定から `'unsafe-inline'` を削除
- nonce方式を導入: リクエストごとにnonceを生成し `<script nonce="...">` で許可
- 全HTMLファイルのインラインstyleも外部CSSに移行

完了条件: helmet設定に `unsafe-inline` が存在しないこと

### 🔴 承認ポイント2

オーナーが確認する項目:
- [ ] npm test 全通過
- [ ] 管理画面の全タブを実際に操作して動作確認
- [ ] CSPヘッダーに unsafe-inline が含まれていないこと

---

## Phase 3: データ層改善

### STEP 6 — DELETE→INSERT を UPSERT化（11箇所）

lib/data.js の以下11関数を個別UPDATE/INSERT OR REPLACE方式に変更:

高優先: saveAttendance, saveLeave, saveOncall
中優先: saveStaff, saveSchedules, saveNotices, saveStandby
低優先: saveExcelResults, saveResetTokens, saveWebAuthnData, saveRegistry

全関数でトランザクション内実行を維持する（原子性保証）。

完了条件: npm test 全通過 + 既存データが正しく読み書きできること

### STEP 7 — staff テーブル主要列の正規化

lib/db.js のスキーマに列を追加:
- is_admin (INTEGER DEFAULT 0)
- archived (INTEGER DEFAULT 0)
- type (TEXT)
- hire_date (TEXT)

マイグレーション: 既存JSON（data列）から上記4列にデータをコピー。
data列は当面残す（段階移行）。

完了条件: 列データとJSONデータが一致するテストが通過

### STEP 8 — インデックス作成

lib/db.js に CREATE INDEX IF NOT EXISTS を追加:
- notice_read_status(staff_id)
- attendance(staff_id)
- reminders_sent(staff_id)
- reset_tokens(staff_id)
- webauthn_credentials(staff_id)
- standby_records(staff_id)

完了条件: DBの初期化が正常に完了すること

### 🔴 承認ポイント3

オーナーが確認する項目:
- [ ] npm test 全通過
- [ ] マイグレーション前後のデータ一致
- [ ] 管理画面でスタッフ操作が正常

---

## Phase 4: 強化（Month 2〜3）

### STEP 9 — テスト拡充
権限境界、WebAuthn、例外系のテストを追加。

### STEP 10 — セッション管理見直し
オーナーが方針（cookie-session維持 or サーバ側ストア移行）を決定後に実施。

### STEP 11 — 外部連携の堅牢化
- lib/sheets.js: AbortController + タイムアウト（30秒）追加
- lib/mail.js: リトライ（最大3回、指数バックオフ）追加

### STEP 12 — UX/アクセシビリティ修正
- alert() → toast変換（admin.html 4箇所, change-password.html 3箇所）
- maximum-scale=1.0 除去（全14 HTMLファイル）

---

## 禁止動作

1. 既存のビジネスロジック（計算式・判定条件）を変更しない
2. 新機能を追加しない
3. テーブルのデータを直接DELETE/UPDATEしない（マイグレーションスクリプト経由）
4. lib/sheets.js の構造を変更しない（タイムアウト追加は許可）
5. 外部ライブラリの新規追加はオーナー承認なしに行わない
6. 承認ポイントを飛ばして次のPhaseに進まない
7. 本番環境に直接影響する操作をしない
8. 自動確定の訂正フローをCCが勝手に設計しない（スコープ外）
9. standby_records のPK構造を変更しない（1日1名は仕様確認済み）
