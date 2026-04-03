# 訪問単位数管理 Webアプリ

訪問看護ステーション向けの訪問単位数入力・管理システムです。

## 機能概要

| 画面 | URL | 説明 |
|------|-----|------|
| ログイン | `/login` | スタッフ個別認証（セッション1週間） |
| 入力画面 | `/` | 訪問時間/単位数の入力＋月次実績表示 |
| PW変更 | `/change-password` | 自分のパスワード変更 |
| 管理者 | `/admin` | スタッフ管理・PW リセット |

---

## ローカル開発

### 前提
- Node.js 18以上がインストール済みであること

### 手順

```bash
cd visit-tracker
npm install
cp .env.example .env   # .envを編集
npm run dev            # http://localhost:3000 で起動
```

---

## Renderへのデプロイ手順

### 1. GitHubリポジトリを作成してプッシュ

```bash
cd visit-tracker
git init
git add .
git commit -m "initial commit"
```

GitHub でリポジトリを新規作成し、以下を実行：

```bash
git remote add origin https://github.com/あなたのユーザー名/visit-tracker.git
git branch -M main
git push -u origin main
```

> **重要**: `.env` はGitにコミットしないこと（`.gitignore` で除外済み）

---

### 2. Google サービスアカウントを設定

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを開く
2. **「APIとサービス」→「ライブラリ」** で **Google Sheets API** を有効化
3. **「IAMと管理」→「サービスアカウント」** で新規サービスアカウントを作成
4. サービスアカウントの **「キー」→「鍵を追加」→「JSON」** でキーファイルをダウンロード
5. 対象スプレッドシートの共有設定で、サービスアカウントのメールアドレスを **「編集者」** として追加

---

### 3. Renderでデプロイ

1. [render.com](https://render.com) にログインし **「New → Web Service」** をクリック
2. GitHubリポジトリを選択して接続
3. 以下の設定を行う：

| 項目 | 設定値 |
|------|--------|
| Environment | `Node` |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | Free以上 |

4. **「Environment Variables」** に以下を追加：

| 環境変数 | 値 |
|----------|----|
| `SPREADSHEET_ID` | `1CwZ-h1ZnJ4tdwQ_B56DOPNt35ffGHUXg` |
| `SESSION_SECRET` | ランダムな長い文字列（例：openssl rand -base64 32 で生成） |
| `GOOGLE_CREDENTIALS` | credentials.json の中身を**1行のJSON文字列**として貼り付け |

**GOOGLE_CREDENTIALS の作り方（macOS/Linux）:**

```bash
cat credentials.json | tr -d '\n' | pbcopy
```

上記でクリップボードにコピーされるので、Renderの環境変数にペーストする。
`private_key` 内の改行は `\n` のまま保持してください。

5. **「Create Web Service」** をクリック → デプロイ完了（数分）

---

## 初期ログイン情報

| 名前 | ID | 初期PW |
|------|----|--------|
| 生方雪絵 | ubukata01 | YU01 |
| 鈴木幸平 | suzuki02 | KS02 |
| 後藤来実 | goto03 | KG03 |
| 鎌田由布 | kamata04 | YK04 |
| 中島大智 | nakashima05 | DN05 |
| 小澤悠那 | ozawa06 | YO06 |
| 大江綾子 | ooe07 | AO07 |

管理者URL: `/admin`  管理者権限を持つスタッフIDでログイン

---

## PWAとしてスマホに追加

1. iPhoneの場合: Safariで開く → 共有ボタン → 「ホーム画面に追加」
2. Androidの場合: Chromeで開く → メニュー → 「ホーム画面に追加」

アプリアイコンは `public/icon-192.png` と `public/icon-512.png` を用意してください（192×192px・512×512px のPNG）。

---

## 注意事項

- **Renderの無料プランはファイルシステムが永続しません。** スタッフ追加・削除や管理者ログイン後に再デプロイするとデータがリセットされます。`staff.json` を変更したらGitにコミットしてから再デプロイしてください。
- スタッフを**削除**してもスプレッドシートの列は削除されません。スプレッドシート側で手動削除してください。
- スタッフを**追加**すると全月シートの4行目に列が自動追加されます。SUM等の集計式は必要に応じて手動で拡張してください。

---

## ファイル構成

```
visit-tracker/
├── server.js           ← Express バックエンド
├── staff.json          ← スタッフ情報（7名の初期データ）
├── package.json
├── .env.example        ← 環境変数テンプレート
├── .gitignore
├── README.md
└── public/
    ├── login.html          ← ログイン画面
    ├── index.html          ← 訪問入力画面（PWA対応）
    ├── change-password.html← PW変更画面
    ├── admin.html          ← 管理者画面
    ├── manifest.json       ← PWAマニフェスト
    └── sw.js               ← Service Worker
```
