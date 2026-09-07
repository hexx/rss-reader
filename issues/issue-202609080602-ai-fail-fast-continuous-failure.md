---
title: "AI 継続障害（クレジット切れ等）で同期全体が 30 分ごとに止まり続ける問題の再検討"
status: TODO
created: 2026-09-08T06:02:57+09:00
---

# AI 継続障害（クレジット切れ等）で同期全体が 30 分ごとに止まり続ける問題の再検討

## 背景・前提条件 (Context)

ADR-0008（`docs/adr/0008-configurable-ai-api-and-fail-fast-sync.md`）により、AI 生成エラーは
同期全体を fail-fast で停止する設計。2026-09-07 に OpenAI のクレジット残高がゼロになり、
30 分ごとの cron run がすべて `AiGenerationError` で停止し続けた（運用対応として OpenAI への
課金で解消）。**新着取り込み・はてブ補完・本文補完が一切進まなくなる**ため、継続型障害の扱いを
再検討する。なお ADR-0008 の判断自体は正当な理由に基づくため、本 issue は「改定」か「維持＋監視
強化」かを決めて記録することがゴール。

### 期待される挙動 vs 実際の挙動

- **期待**: AI Provider の継続的な障害（クレジット切れ・quota 超過・障害等）でも、①同じ原因で run が止まり続けていることが 1 見で分かり、②復旧までの影響範囲（要約なし保存等）が制御されている
- **実際**: クレジット切れの間、30 分ごとの cron が毎回最初の新着記事の要約生成で中断。且つ旧コードでは Workers Logs に `{"name": "AiGenerationError"}` しか残らず原因が分からなかった（観測性は PR #396 で改善済み・デプロイ済み）

### エラーログ / スタックトレース

本番 Workers Logs（2026-09-07 20:15 UTC 頃。旧コードでの出力。逐語）:

```json
{
  "level": "error",
  "message": "定期同期に失敗しました。",
  "error": {
    "name": "AiGenerationError"
  },
  "event": { "cron": "15,45 * * * *", "scheduledTime": 1788812108 },
  "$metadata": { "account": "f9992c5557a4b6f6a85c6f4220d19f07", "service": "rss-reader" }
}
```

※ `message` / `cause` が欠けているのは、当時の cron catch が生の Error を渡していたため（PR #396 で `toErrorMessage` 経由に修正済み）。デプロイ済みの現コードでは cause チェーンを辿った実メッセージ（例: `429 insufficient_quota`）が記録される。

### 再現手順

1. OpenAI 互換エンドポイント（`AI_BASE_URL`、既定 `https://api.openai.com/v1`）をクレジット切れ/不正キー状態にする（またはモックで 429 を返す）
2. `POST /api/sync` または cron を実行する
3. 同期 run 全体が `AiGenerationError` で中断し、以後 30 分ごとに同じ失敗が繰り返されることを確認する

### 環境情報

- 実行環境: Cloudflare Workers（cron: `15,45 * * * *` 取り込み専用 / `0 */3 * * *` フル同期）
- 言語/ランタイム: TypeScript / Node.js 24 互換（Workers `nodejs_compat`）
- AI: OpenAI 互換エンドポイント、モデル `gpt-5.6-luna`、リクエストタイムアウト 60 秒
- 起動方法: `npm run dev`（ローカル）/ `npm run deploy`（本番）

### 関連ファイル / コード

- `src/services/ai.ts`

```ts
export class AiError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = new.target.name;
    this.cause = cause;
  }
}
export class AiGenerationError extends AiError {}

// completeText 内: pi-ai は API エラー時も throw せず stopReason: 'error' を返す
if (result.stopReason === 'error' || result.stopReason === 'aborted') {
  throw new Error(result.errorMessage ?? `AI request failed: ${result.stopReason}`);
}
```

- `src/workflows/sync.ts`

```ts
async function runAi<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toAiError(error);
  }
}
// ingestNewArticle の catch 冒頭:
if (isAiError(error)) {
  throw error;   // ← ここで同期 run 全体が停止する（ADR-0008）
}
```

- ADR: `docs/adr/0008-configurable-ai-api-and-fail-fast-sync.md`

### 試したが駄目だったこと

- OpenAI への課金（運用対応。根本の設計問題は未解決）

## 解決すべきゴール (Goal)

- [ ] 継続型 AI 障害（insufficient_quota 等の恒久的・半恒久的失敗）の扱いを決定する: (a) fail-fast を維持し検知手段を足す、(b) 障害種別で挙動を変える（例: quota 系は要約なし保存で継続）、など
- [ ] 決定を ADR-0008 の追記または改定 ADR として記録する（判断の理由と替代案を含む）
- [ ] 「同じ原因で run が止まり続けている」ことが Workers Logs / 通知から 1 回で分かる仕組みを用意する（連続 N 回失敗での通知、またはログの fingerprint 設計。通知先: UNKNOWN — ユーザーに確認すること）

### 完了条件（検証方法）

- 決定した方針が ADR に記録されていること
- `npm test` が緑であること
- モック AI（常時エラー）に対して cron 相当の同期を 2 回以上実行し、決定した挙動（停止継続+検知 / 縮退運転）がログから確認できること

## 補足（任意）

- 関連: `docs/specs/ingest-failure.md` §8 未決事項、PR #396（ログ観測性の修正）。
- 障害の実体は OpenAI クレジット切れ（2026-09-07、ユーザー確認）。`AI_API_KEY` の quota 系エラーは 429 で返るため、`AiGenerationError` の cause から判別可能なはず（要実装確認）。
