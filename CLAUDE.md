# CLAUDE.md - visit-tracker プロジェクトガイド

このファイルはAIコーディングアシスタント向けのプロジェクトコンテキストです。

## プロジェクト概要

**にこっと訪問看護ステーション** の訪問単位数入力・管理システム。
訪問看護スタッフが日々の訪問件数を入力し、Google Sheetsに記録する業務用Webアプリ。

## 技術スタック

- **バックエンド**: Node.js 18+ / Express.js 4.x（ルート分割済み: server.js + routes/ + lib/）
- **フロントエンド**: vanilla HTML/CSS/JS（ビルドステップなし）、PWA対応
- **データストア**: SQLite（better-sqlite3, WALモード）+ Google Sheets API（訪問記録の外部連携）
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
├── server.js                  ← Express エントリポイント（cron, 静的配信）
├── lib/                       ← バックエンドモジュール
│   ├── db.js                  ← SQLite初期化・スキーマ・JSON移行
│   ├── data.js                ← データ永続化API（SQLiteバックエンド）
│   ├── audit.js               ← 監査ログ（SHA-256チェーン, SQLite）
│   ├── helpers.js             ← バリデーション、日付ユーティリティ、ファイルロック
│   ├── constants.js           ← パス・設定定数
│   ├── auth-middleware.js     ← 認証ミドルウェア
│   ├── webauthn.js            ← WebAuthn/FIDO2資格情報管理
│   ├── leave-calc.js          ← 有給計算ロジック
│   ├── sheets.js              ← Google Sheets API連携
│   ├── mail.js                ← メール送信
│   └── startup.js             ← 起動時初期化
├── routes/                    ← APIルート
│   ├── auth.js, record.js, leave.js, oncall.js
│   ├── schedules.js, notices.js, admin.js
├── test-leave.js              ← 有給計算のユニットテスト
├── visit-tracker.db           ← SQLiteデータベース（WALモード）
├── public/                    ← フロントエンド（静的ファイル）
│   ├── index.html             ← メイン入力画面（PWA）
│   ├── login.html, admin.html, leave.html, oncall.html
│   ├── notices.html, history.html, manual.html, admin-manual.html
│   ├── change-password.html, forgot-password.html, reset-password.html
│   ├── sw.js, manifest.json
│   └── vendor/                ← ローカル配信ライブラリ
└── docs/admin-manual/         ← 管理者マニュアル（Markdown）
```

## 環境変数（.env）

| 変数名 | 必須 | 説明 |
|--------|------|------|
| `SPREADSHEET_ID` | はい | Google SheetsのID |
| `SESSION_SECRET` | はい | セッション署名用ランダム文字列（本番は必須） |
| `GOOGLE_CREDENTIALS` | はい | Google サービスアカウントのJSON（1行） |
| `PORT` | いいえ | ポート番号（デフォルト: 3000） |
| `APP_BASE_URL` | いいえ | アプリのベースURL |
| `DATA_DIR` | いいえ | SQLite DB とJSON補助ファイルの保存先（デフォルト: プロジェクトルート） |
| `INITIAL_ADMIN_STAFF_IDS` | いいえ | 起動時に自動で管理者権限を付与するスタッフIDをカンマ区切りで指定（例: `ubukata01,sato02`）。毎起動で idempotent に union 追加。既存の管理者は剥奪しない |
| `INITIAL_ADMIN_STAFF_ID` | いいえ | 後方互換用の単数版。`INITIAL_ADMIN_STAFF_IDS` と併用した場合はマージされる |

## アーキテクチャの重要ポイント

### server.js の構成
- エントリポイント: Express初期化、静的配信、cron定時タスク
- APIルートは `routes/` に分割（auth, record, leave, oncall, schedules, notices, admin）
- 共通ロジックは `lib/` に集約（data, db, audit, helpers, sheets等）

### データ永続化
- **SQLite** (`visit-tracker.db`): 全アプリデータの正本（WALモード、better-sqlite3）
  - スタッフ、有給、オンコール、お知らせ、出勤確定、待機、WebAuthn、監査ログ等
  - 初回起動時にJSONファイルから自動移行
- **Google Sheets**: 訪問記録の外部連携先（年度ごとスプレッドシート、月別シート）
- **監査ログ**: SHA-256ハッシュチェーンで改ざん検知（SQLiteテーブル内）

### 認証フロー
- スタッフ: ID/パスワード → cookie-session（7日間）
- 管理者: 管理者権限スタッフのID/パスワード → 管理者セッション
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
- **データ書き込み保護**: SQLiteトランザクション + write-file-atomic による原子的書き込み
- **ブルートフォース対策**: ログインAPI に IP単位の試行回数制限
- **セッション管理**: スタッフアーカイブ時に既存セッションを即時無効化
- **外部依存排除**: Chart.js / WebAuthn 等を vendor/ にローカル配信
- **機密データ分離**: staff.json 等のデータファイルを .gitignore で管理外に。本番は DATA_DIR=/data で分離
- **再発防止**: `npm run security-check` で禁止パターン（inline handler, 外部CDN, eval等）を自動検出

## リリースノート（スタッフ向けお知らせ）

スタッフ向け画面（index.html, history.html, leave.html, oncall.html 等）の表示・操作に影響する変更をコミットする際は、`release-notes.json` にエントリを追加すること。内部リファクタやバグ修正でユーザー体験に変化がない場合は不要。

追加するエントリの形式:
```json
{
  "id": "vX.Y.Z",
  "date": "YYYY-MM-DD",
  "title": "変更タイトル（簡潔に）",
  "body": "変更の概要。スタッフが理解できる平易な日本語で記述。\\n複数行可。"
}
```

コミット前にエントリの内容をユーザーに確認してもらうこと。

## 既知の課題・TODO

- Sheets APIのレート制限対応
