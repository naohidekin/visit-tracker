# visit-tracker 修繕パイプライン — 品質基準

修繕作業で「どう書くか、どういう品質で出すか」を定義する。
進め方は REMEDIATION.md、全体フローは REMEDIATION-PIPELINE.md を参照。

---

## コード品質

- 既存の命名規則（camelCase）を踏襲する
- 分割時の export/require パターンは既存ルート（record.js, auth.js）に合わせる
- 1ファイル300行以下を目標とする（admin-staff.js のみ600行まで許容）
- 共通ヘルパーの重複コピーは禁止する（lib/helpers.js に集約）
- 不要なコメント・JSDoc・型注釈を追加しない（変更箇所のみ）
- console.log でのデバッグ出力を残さない

---

## テスト基準

- 新規テストは Node.js assert + supertest で書く（既存と同じ）
- 各STEPの完了前に `npm test` が全通過すること
- リファクタリング系STEP（3,4,5）では「振る舞い不変」をテストで証明する
  - 分割前後で同じリクエストに同じレスポンスが返ること
- DB変更系STEP（6,7,8）ではマイグレーション前後のデータ一致を検証する
- テスト用DBは一時ファイルを使う（既存の test-api.js と同じパターン）

---

## セキュリティ基準

- CSP変更後（STEP 5）: helmet設定に `'unsafe-inline'` が存在しないこと
- CSRF変更後（STEP 2）: 全 POST/PATCH/DELETE エンドポイントが CSRF検証を通ること
- UPSERT化（STEP 6）: トランザクション内で実行する（既存と同等の原子性保証）
- 入力検証: 外部入力（req.query, req.body）は型・範囲チェックを通してから DB/API に渡す
- cookieパース改善（STEP 2）: 悪意ある入力（空値、特殊文字、超長文字列）で壊れないこと

---

## マイグレーション基準

- スキーマ変更は lib/db.js の初期化ブロック内で行う（既存パターン踏襲）
- 既存データが失われないことをテストで証明する
- staff列化（STEP 7）: JSON（data列）内のデータと新設列のデータが一致すること
- マイグレーション処理は冪等であること（2回実行しても壊れない）
- ALTER TABLE は SQLite の制約を考慮する（列追加のみ、列変更・削除は不可）

---

## 検証チェックリスト（各STEP共通）

1. `npm test` 全通過
2. `npm run security-check` 通過
3. `git diff` で変更範囲が想定内
4. 新規ファイルがある場合、既存の構造と整合していること
