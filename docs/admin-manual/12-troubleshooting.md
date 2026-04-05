# 12. トラブルシューティング・FAQ

[< 目次に戻る](./00-index.md)

---

## よくある質問

### ログインできない

| 原因 | 対処 |
|------|------|
| パスワードの入力ミス | 大文字・小文字、全角・半角を確認してください |
| セッション切れ | ブラウザのキャッシュ・Cookieをクリアして再度ログインしてください |
| パスワード不明 | システム管理者（開発担当者）に問い合わせてください |

---

### スタッフがログインできない

1. 管理画面のスタッフ一覧で、対象スタッフが **アーカイブ状態でない** ことを確認します
2. 「**PW**」ボタンでパスワードをリセットし、初期パスワードを伝えます
3. スタッフにパスワード変更画面（`/change-password`）で新しいパスワードを設定してもらいます

---

### Excel集計で結果がおかしい

| 症状 | 対処 |
|------|------|
| スタッフが表示されない | 管理画面に登録されているスタッフ名と、Excelファイル内の名前が一致しているか確認してください |
| 数値がずれている | iBowのエクスポート形式が変わっていないか確認してください |
| アップロードエラー | ファイル形式（.xlsx）を確認してください |

---

### Googleスプレッドシートのエラー

| 症状 | 対処 |
|------|------|
| データが取得できない | Google認証情報（GOOGLE_CREDENTIALS）が有効か確認してください |
| 列がずれている | 管理画面の「メンテナンス機能」で列位置の修正を実行してください |
| 翌年シートが作れない | データベース内のスプレッドシート登録情報を確認してください |

---

### 有給休暇の日数が合わない

1. 入社日が正しく設定されているか確認します
2. 手動調整の履歴を確認します
3. 必要に応じて「残日数管理」タブから手動で調整します

---

## 環境設定一覧

本システムの動作に必要な環境変数の一覧です。

| 環境変数 | 用途 |
|---------|------|
| `SESSION_SECRET` | セッション暗号化キー |
| `GOOGLE_CREDENTIALS` | Google API認証情報（JSON） |
| `SPREADSHEET_ID` | 当年のGoogleスプレッドシートID |
| `PORT` | サーバーポート番号（デフォルト: 3000） |

---

## データベース

システムのすべてのデータは SQLite データベース（`visit-tracker.db`）に格納されています。
デフォルトの保存先は `DATA_DIR` 環境変数で指定されたディレクトリ（本番: `/data`）です。

### 格納データ一覧

| テーブル | 内容 |
|---------|------|
| `staff` | スタッフ情報・認証情報 |
| `notices` / `notice_read_status` | お知らせデータ・既読状態 |
| `leave_requests` | 有給休暇申請データ |
| `oncall_records` | オンコール記録 |
| `schedules` | 未確定の予定データ |
| `attendance` / `reminders_sent` | 出勤確定・リマインダー送信履歴 |
| `standby_records` / `custom_holidays` / `rainy_days` | 待機記録 |
| `spreadsheet_registry` | 年度別スプレッドシートID |
| `excel_results` | Excel集計結果の履歴 |
| `reset_tokens` | パスワードリセットトークン |
| `webauthn_credentials` | 生体認証/セキュリティキー |
| `audit_log` | 操作ログ（改ざん検知チェーン付き） |
| `settings` | アプリ設定（インセンティブデフォルト等） |

---

## バックアップと復元

### バックアップ手順

データベースファイルをコピーするだけでバックアップできます。

**Render.com（本番環境）の場合:**

```bash
# SSH接続後、/data ディレクトリでバックアップ
cp /data/visit-tracker.db /data/backup/visit-tracker-$(date +%Y%m%d).db
```

**ローカル環境の場合:**

```bash
cp visit-tracker.db visit-tracker-backup-$(date +%Y%m%d).db
```

> **重要**: バックアップ時は `.db-wal` と `.db-shm` ファイルも一緒にコピーしてください。
> これらはWAL（先行書き込みログ）モードの一時ファイルで、未反映のデータが含まれている場合があります。

**安全なバックアップ（WALをフラッシュしてから取得）:**

```bash
# SQLite の checkpoint を実行して WAL を本体に統合
sqlite3 /data/visit-tracker.db "PRAGMA wal_checkpoint(TRUNCATE);"
# その後 .db ファイルのみコピーすればOK
cp /data/visit-tracker.db /data/backup/visit-tracker-$(date +%Y%m%d).db
```

### 復元手順

1. アプリケーションを停止します
2. バックアップファイルを元の場所にコピーします
3. `.db-wal` / `.db-shm` ファイルが残っている場合は削除します
4. アプリケーションを再起動します

```bash
# 1. アプリ停止後
# 2. 復元
cp /data/backup/visit-tracker-20260404.db /data/visit-tracker.db
# 3. WALファイルのクリア
rm -f /data/visit-tracker.db-wal /data/visit-tracker.db-shm
# 4. アプリ再起動
```

### 定期バックアップの推奨

- **日次**: 業務終了後にデータベースファイルをバックアップ
- **週次**: バックアップを外部ストレージ（Google Drive等）にもコピー
- **保持期間**: 直近30日分を推奨

### 整合性チェック

データベースの整合性を確認するには:

```bash
sqlite3 /data/visit-tracker.db "PRAGMA integrity_check;"
# → "ok" と表示されれば正常
```

監査ログのハッシュチェーン検証は管理画面の監査ログセクションから実行できます。

---

## 監査ログの別保管

システムはすべての操作を監査ログに記録し、SQLite とは**別の追記専用 NDJSON ファイル**の両方に書き込みます。

| 保管先 | パス | 用途 |
|--------|------|------|
| SQLite テーブル | `visit-tracker.db` 内 `audit_log` | 管理画面での検索・表示 |
| NDJSON ファイル | `/data/audit-log.ndjson` | 別保管・外部バックアップ用 |

NDJSON ファイルは**追記のみ**（既存行を書き換えない）のため、SQLite が破損・削除されても独立して残ります。

### NDJSON ファイルの保存先変更

環境変数 `AUDIT_LOG_NDJSON_PATH` で変更できます（Render.com では別ボリュームや外部ストレージを指定可能）:

```
AUDIT_LOG_NDJSON_PATH=/mnt/audit/audit-log.ndjson
```

### 監査ログのバックアップ

```bash
# NDJSON ファイルを日付付きでバックアップ（主要な保管先）
cp /data/audit-log.ndjson /data/backup/audit-log-$(date +%Y%m%d).ndjson

# 週次: 外部ストレージへコピー（Google Drive CLI 等）
```

### 監査ログの復旧・照合

SQLite が失われた場合でも NDJSON から復旧できます:

```bash
# NDJSON を SQLite に再インポート（各行を audit_log テーブルへ）
node -e "
const fs  = require('fs');
const { getDb } = require('./lib/db');
const db  = getDb();
const ins = db.prepare('INSERT OR IGNORE INTO audit_log (id, timestamp, prev_hash, data) VALUES (?, ?, ?, ?)');
const lines = fs.readFileSync('/data/audit-log.ndjson', 'utf8').trim().split('\n');
db.transaction(() => {
  for (const line of lines) {
    if (!line) continue;
    const e = JSON.parse(line);
    ins.run(e.id, e.timestamp, e.prevHash ?? '0', line);
  }
})();
console.log('復旧完了:', lines.length, '件');
"
```

### ハッシュチェーン検証

管理画面の監査ログセクションからハッシュチェーンの整合性を確認できます。
NDJSON から復旧した場合も同様に検証してください。
