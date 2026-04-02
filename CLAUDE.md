# CLAUDE.md - visit-tracker プロジェクトガイド

このファイルはAIコーディングアシスタント向けのプロジェクトコンテキストです。

## プロジェクト概要

**にこっと訪問看護ステーション** の訪問単位数入力・管理システム。
訪問看護スタッフが日々の訪問件数を入力し、Google Sheetsに記録する業務用Webアプリ。

## 技術スタック

- **バックエンド**: Node.js 18+ / Express.js 4.x（`server.js` 単一ファイル、約3,100行）
- **フロントエンド**: vanilla HTML/CSS/JS（ビルドステップなし）、PWA対応
- **データストア**: Google Sheets API（訪問記録）+ JSONファイル（スタッフ・休暇・当番等）
- **認証**: bcryptjs + cookie-session（7日間）+ WebAuthn/FIDO2
- **デプロイ**: Render.com（永続ディスク `/data`）

## コマンド

```bash
npm install          # 依存インストール
npm run dev          # 開発サーバー起動 (localhost:3000, --watch付き)
npm start            # 本番起動
npm test             # テスト実行 (node test-leave.js)
```

## ディレクトリ構成

```
visit-tracker/
├── server.js                  ← Express バックエンド（全APIルート含む）
├── test-leave.js              ← 有給計算のユニットテスト
├── staff.json                 ← スタッフマスタ（ID, 名前, 職種, パスワードハッシュ, 有給残日数）
├── package.json
├── .env.example               ← 環境変数テンプレート
├── render.yaml                ← Renderデプロイ設定
├── scripts/
│   └── protect-sheets.js      ← Sheetsの保護設定スクリプト
├── public/                    ← フロントエンド（静的ファイル）
│   ├── index.html             ← メイン入力画面（PWA）
│   ├── login.html             ← ログイン
│   ├── admin.html             ← 管理者ダッシュボード
│   ├── leave.html             ← 有給管理
│   ├── oncall.html            ← 当番管理
│   ├── notices.html           ← お知らせ
│   ├── history.html           ← 操作履歴
│   ├── manual.html            ← ユーザーマニュアル
│   ├── admin-manual.html      ← 管理者マニュアル
│   ├── change-password.html   ← パスワード変更
│   ├── sw.js                  ← Service Worker
│   └── manifest.json          ← PWAマニフェスト
├── docs/admin-manual/         ← 管理者マニュアル（Markdown 13ファイル）
├── leave-requests.json        ← 有給申請データ
├── notices.json               ← お知らせデータ
├── oncall-records.json        ← 当番記録
├── schedules.json             ← スケジュール
└── audit-log.json             ← 操作ログ（SHA-256チェーン）
```

## 環境変数（.env）

| 変数名 | 必須 | 説明 |
|--------|------|------|
| `SPREADSHEET_ID` | はい | Google SheetsのID |
| `ADMIN_PASSWORD` | はい | 管理者ログインパスワード |
| `SESSION_SECRET` | はい | セッション署名用ランダム文字列（本番は必須） |
| `GOOGLE_CREDENTIALS` | はい | Google サービスアカウントのJSON（1行） |
| `PORT` | いいえ | ポート番号（デフォルト: 3000） |
| `APP_BASE_URL` | いいえ | アプリのベースURL |
| `DATA_DIR` | いいえ | JSONファイルの保存先（デフォルト: プロジェクトルート） |

## アーキテクチャの重要ポイント

### server.js の構成
- すべてのAPIルート、ミドルウェア、ビジネスロジックが `server.js` に集約
- Google Sheets APIのラッパー関数（リトライ付き）
- 認証ミドルウェア（スタッフ用・管理者用の2系統）
- node-cronによる定時タスク（リマインダー通知、トークン清掃）

### データ永続化
- **Google Sheets**: 年度ごとにスプレッドシートを自動作成。月別シート（1月〜12月）に日次の訪問単位数を記録
- **JSONファイル**: `staff.json`, `leave-requests.json`, `oncall-records.json` 等をfsで読み書き
- **監査ログ**: SHA-256ハッシュチェーンで改ざん検知

### 認証フロー
- スタッフ: ID/パスワード → cookie-session（7日間）
- 管理者: 共通パスワード → 別セッション
- WebAuthn: 生体認証/セキュリティキーに対応

### ビジネスルール
- **編集期限**: 前月データは当月16〜20日のみ編集可。21日以降はロック
- **有給付与**: 労働基準法準拠の自動付与テーブル（6ヶ月:10日〜6.5年:20日）
- **インセンティブ**: 職種別デフォルト単価 + 個人別上書き設定
- **スタッフ種別**: `nurse`（看護師、2列: 介護単位+医療単位）と `PT`（リハビリ、1列）

### Google Sheets レイアウト
- ヘッダー行: 4行目（日付, 曜日, スタッフ名）
- データ行: 5行目以降（日次データ）
- 列割り当て: A-B列は予約、C列以降にスタッフ（看護師は2列、PTは1列）

## 主要APIエンドポイント

### 認証
- `POST /api/login` / `POST /api/logout` / `GET /api/me`
- `POST /api/change-password` / `POST /api/forgot-password` / `POST /api/reset-password`
- `POST /api/webauthn/*` (register/login/delete)

### 訪問記録
- `GET /api/record?date=YYYY-MM-DD` - 日次記録取得
- `POST /api/record` - 記録入力（編集期限あり）
- `GET /api/monthly-stats?year=Y&month=M` - 月次統計
- `GET /api/monthly-detail` - 月次詳細（グラフ用）

### 管理者
- `GET/POST/PATCH/DELETE /api/admin/staff` - スタッフCRUD
- `POST /api/admin/record` - 管理者による記録編集
- `POST /api/admin/upload-excel` - Excelインポート
- `GET/POST /api/admin/incentive/*` - インセンティブ設定

### 有給・当番・お知らせ
- `/api/leave` - 有給申請・承認・却下
- `/api/oncall` - 当番記録・月次集計
- `/api/notices` - お知らせ管理
- `/api/schedules` - スケジュール管理

## コーディング規約

- 言語: 日本語（UI、コメント、ログメッセージ）
- フロントエンド: フレームワーク不使用。vanilla JS + fetch API
- バックエンド: Express.jsのルートハンドラとして直接実装
- エラーハンドリング: API は `{ success: false, error: "メッセージ" }` 形式で返す
- 日付フォーマット: `YYYY-MM-DD`（内部）、`M月D日` or `YYYY年M月`（UI表示）
- テスト: `npm test` が通ることを確認してからコミット

## 実装済みセキュリティ対策

- **CSRF対策**: double-submit cookie 方式（setCsrfCookie / verifyCsrf）+ フロント側 apiFetch ラッパー
- **XSS対策**: インラインイベントハンドラ全廃 → addEventListener / イベント委譲。innerHTML内ユーザーデータは esc() でエスケープ
- **セキュリティヘッダー**: helmet（CSP, X-Frame-Options, X-Content-Type-Options 等）
- **データ書き込み保護**: write-file-atomic による原子的書き込み + withFileLock / lockedRoute による排他制御
- **ブルートフォース対策**: ログインAPI に IP単位の試行回数制限
- **セッション管理**: スタッフアーカイブ時に既存セッションを即時無効化
- **外部依存排除**: Chart.js / WebAuthn 等を vendor/ にローカル配信
- **機密データ分離**: staff.json 等のデータファイルを .gitignore で管理外に。本番は DATA_DIR=/data で分離
- **再発防止**: `npm run security-check` で禁止パターン（inline handler, 外部CDN, eval等）を自動検出

## 既知の課題・TODO

- 管理者認証が共有パスワード方式（個別アカウント化・MFA導入を検討）
- JSONファイルベースの設計（複数インスタンス運用時はSQLite移行が必要）
- Sheets APIのレート制限対応
