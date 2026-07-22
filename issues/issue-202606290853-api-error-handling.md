---
title: "APIエラーハンドリングと型安全性の改善"
status: DONE
created: 2026-06-29T08:53:00+09:00
---

# 課題解決プロンプト: APIエラーハンドリングと型安全性の改善

## 1. 役割定義 (Persona)
あなたは高度なソフトウェアエンジニアおよびWeb API設計のエキスパートです。以下のコンテキストとゴールを基に、正確かつ効率的な修正を行ってください。

## 2. 背景・前提条件 (Context)
- **現状発生している問題**:
  1. `src/worker.ts` の各APIハンドラ（POST/DELETE `/api/subscriptions`、PATCH `/api/articles/:id`）で、JSONパース失敗時に `catch(() => ({}))` で空オブジェクトにフォールバックしている。全くの無効JSONや巨大すぎるリクエストボディもエラーを返さず後続処理に進んでしまう。
  2. `/api/articles` のクエリパラメータ `unread_only` が未指定時にデフォルト `true` になる。APIのデフォルトとして直感に反する（「全て表示」が自然なデフォルト）。
  3. `/api/sync` の `executionCtx` 不在時のエラーハンドリングが不十分。`void syncTask` は実質的に Promise を捨てているだけで、エラーが完全に握り潰される。
  4. `fetchArticles` 関数の引数型が `ReturnType<typeof getDb>` に依存しており、`getDb` の実装変更で型推論が壊れる。
  5. `formatDate` 関数が不正な日付文字列に対して現在時刻を返す。不正データを現在時刻で上書きしてしまうのはデータの完全性を損なう。

- **再現手順**:
  1. `curl -X POST http://localhost:8787/api/subscriptions -H 'Content-Type: application/json' -d 'invalid json'` → 400 ではなく空オブジェクト扱いで後続処理に進む
  2. `curl http://localhost:8787/api/articles` → `unread_only` 未指定なのに未読記事のみ返る
  3. `executionCtx` なしで `/api/sync` を呼び出す → 同期タスクのエラーがどこにもログ出力されない

- **関連ファイル/コード**: `src/worker.ts`

## 3. 解決すべきゴール (Goal & Objective)
- [ ] JSONパース失敗時に `400 Bad Request` を返すよう修正する
- [ ] `unread_only` のデフォルトを `false` に変更し、クライアント側で明示的に `true` を送る設計にする
- [ ] `executionCtx` 不在時にもエラーログを出力し、最低限のエラーハンドリングを行う（`void syncTask` の代わりに `.catch(console.error)` など）
- [ ] `fetchArticles` の引数型を `DrizzleD1Database` などの明示的な型に変更する
- [ ] `formatDate` 関数で不正な日付の場合は `null` または明示的なエラー値を返し、現在時刻で上書きしない
- [ ] 既存のテストを壊さないこと

## 4. 期待する成果物 (Output Format)
- 修正が完了した `src/worker.ts` のコード
- 修正理由とアプローチの簡潔な解説
- 既存テスト（`src/worker.test.ts`）のパス確認、必要に応じてテスト修正

## 5. 実行開始の合図
このプロンプトを理解したら、「タスクを開始します」と宣言し、直ちに `src/worker.ts` の解析から始めてください。
