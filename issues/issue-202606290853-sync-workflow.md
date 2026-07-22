---
title: "同期ワークフローの処理上限二重管理と環境依存の解消"
status: DONE
created: 2026-06-29T08:53:00+09:00
---

# 課題解決プロンプト: 同期ワークフローの処理上限二重管理と環境依存の解消

## 1. 役割定義 (Persona)
あなたは高度なソフトウェアエンジニアおよびワークフロー設計のエキスパートです。以下のコンテキストとゴールを基に、正確かつ効率的なリファクタリングを行ってください。

## 2. 背景・前提条件 (Context)
- **現状発生している問題**:
  1. 手動同期とCron同期の処理上限が `syncSite` と `syncAllSubscriptions` の2箇所で**二重管理**されている。
     - `syncSite` 内: `isCron ? 10 : 2`
     - `syncAllSubscriptions` 内: `!isCron && totalProcessedCount >= 2`
     将来上限値を変えたときに片方だけ変えてしまう事故が起きる。
  2. `syncSite` 関数が第3引数 `env` に `process.env` をデフォルト値として受け取っている。Cloudflare Workers では `process.env` は使えず、ローカル開発と本番で `env` の渡し方が変わることを型で強制できない。テストコードでも `undefined` を渡して `process.env` にフォールバックさせている箇所があり危うい。
  3. `syncAllSubscriptions` も同様に `env: RuntimeEnv = process.env` となっている。

- **再現手順**:
  1. `src/workflows/sync.ts` を見れば二重管理が一目瞭然
  2. テストコードで `await syncSite(siteUrl, false, undefined, false)` のように `undefined` を渡している

- **関連ファイル/コード**:
  - `src/workflows/sync.ts`
  - `src/workflows/sync.test.ts`
  - `src/worker.ts`（`syncAllSubscriptions` の呼び出し元）

## 3. 解決すべきゴール (Goal & Objective)
- [ ] 処理上限の管理を1箇所に集約し、定数または設定オブジェクトとして一元管理する
- [ ] `syncSite` / `syncAllSubscriptions` の `env` パラメータを必須化し、`process.env` のデフォルト値を削除する
- [ ] すべての呼び出し元（テスト含む）で明示的に `env` を渡すよう修正する
- [ ] 既存のテストを壊さないこと（テストの修正は可）

## 4. 期待する成果物 (Output Format)
- 修正が完了した `src/workflows/sync.ts` のコード
- `src/workflows/sync.test.ts` の修正（`undefined` を渡していた箇所の修正）
- 必要に応じて `src/worker.ts` の呼び出し箇所修正
- 修正理由とアプローチの簡潔な解説

## 5. 実行開始の合図
このプロンプトを理解したら、「タスクを開始します」と宣言し、直ちに `src/workflows/sync.ts` の解析から始めてください。
