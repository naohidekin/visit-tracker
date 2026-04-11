# visit-tracker 修繕パイプライン — 全体フロー

修繕の全体フロー・Phase間の依存・承認フロー・エラー時の動作を定義する。
各STEPの詳細は REMEDIATION.md、品質基準は REMEDIATION-SKILL.md を参照。

---

## 全体フロー

```
Phase 1: 止血     →  🔴承認1  →  Phase 2: 構造改善  →  🔴承認2  →  Phase 3: データ層  →  🔴承認3  →  Phase 4: 強化
(STEP 1-2)                       (STEP 3-5)                        (STEP 6-8)                         (STEP 9-12)
Week 1                           Week 2〜4                          Phase 2完了後                       Month 2〜3
```

---

## 各STEP内の処理フロー

```
STEP開始
  → 対象ファイルを読み込む
  → 変更を実施する
  → npm test を実行する
  → npm run security-check を実行する
  → git diff で変更範囲を確認する
  → git commit する
  → STEP完了
```

---

## Phase間の依存関係

| Phase | 前提条件 |
|-------|---------|
| Phase 2 | Phase 1完了が必須（テストなしで分割は危険） |
| Phase 3 | Phase 2完了が必須（分割後の方がCCのコンテキスト管理が楽） |
| Phase 4 STEP 9,11,12 | Phase 3と並行可能 |
| Phase 4 STEP 10 | オーナーのセッション管理方針決定待ち |

---

## エラー時の振る舞い

| 状況 | 対応 |
|------|------|
| npm test 失敗 | そのSTEP内で修正する。3回失敗したらオーナーに報告して停止 |
| security-check 失敗 | 該当箇所を修正してからcommit |
| 分割後の動作不整合 | git revert してやり直す |
| マイグレーション失敗 | ローカルDBで再試行（本番データに触れない） |
| 想定外のファイル変更 | git diff で確認し、意図しない変更は revert |

---

## 承認ポイントの運用

承認ポイントではCCは作業を停止し、オーナーに以下を報告する:
1. 実施したSTEPの概要
2. npm test の結果
3. 変更ファイル一覧
4. 次のPhaseで行う作業の概要

オーナーが承認するまで次のPhaseに進まない。
