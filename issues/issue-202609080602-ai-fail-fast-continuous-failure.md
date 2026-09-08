---
title: "AI 継続障害（クレジット切れ等）で同期全体が 30 分ごとに止まり続ける問題の再検討"
status: IN_PROGRESS
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

## grilling セッションでの決定（2026-09-08。R=ラウンド番号）

| 決定 | 内容 |
| --- | --- |
| 根方針 | **fail-fast 維持＋縮退運転却下**（R1-Q1=a）。恒久/一時の分類で挙動を変えない（R1-Q1=c 却下） |
| 保存失敗 | **同期中の全 D1 書き込み失敗を同期中断（Sync Abort）に格上げ**。例外は `UNIQUE(url)` 競合のみ（R2-Q1=i、R3-Q2=ii）。毒記事は受容（R2-Q2=a） |
| AI probe | run 開始前の疎通確認は入れない（R2-Q3=a）。Content Backfill 内の要約生成失敗も中断（R3-Q4=a） |
| Hatena Summary | **生成失敗は warn 継続**（R4-Q4=b）。NULL は補完巡回が拾うため恒久欠損にならない — 「縮退してよいのは回収できるものだけ」 |
| 404/410 | 現状維持（R3-Q1=a）。空本文で行を作り、はてブは同じ run で保存。Give-up 記事の非表示化は採らない |
| 検知 | Pull 型のログ 1 行 `同期を中断しました。`（R2-Q4=a・R2-Q5=i）。状態テーブル・UI 表示・外部アラート・N 回カウントは作らない。設定不備は cron catch 側に任せる（R3-Q3=y） |
| API / UI | `POST /api/sync` は 202 据え置きで `toErrorMessage` 経由に統一（R4-Q3）。UI の同期ボタン文言は完了を保証しない（R4-Q1=b） |
| 用語 | `Sync Abort（同期中断）` を新設。`Ingest Failure` / `Transient Sync Failure` / `Freshness Budget` / `Hatena Summary` の定義を改訂（R3-Q6、R3-Q5=x） |
| 記録 | ADR-0017 を新規（ADR-0008 は中核維持・Hatena Summary の射程のみ変更し相互リンク）。運用スイッチは持たない（R1-Q5） |

## 解決すべきゴール (Goal)

- [x] 継続型 AI 障害の扱いを決定する → **ADR-0017**（fail-fast 維持＋縮退却下＋保存失敗の中断化）
- [x] 決定を ADR に記録する（理由と替代案を含む）→ `docs/adr/0017-keep-fail-fast-and-abort-on-write-failure.md`
- [x] Article Summary 生成失敗、および同期中の D1 書き込み失敗で run が中断することをテストで担保する
- [x] `UNIQUE(url)` 競合は従来どおり info スキップで中断しないことを担保する
- [x] Hatena Summary 生成失敗は warn 継続で、未生成ぶんが次回フル同期の補完で回収されることを担保する
- [x] `同期を中断しました。` が `trigger` / `mode` / `reason` / `stage` / `articleUrl` / `siteUrl` / カウンタを載した **error** レベル 1 行で出ることを担保する
- [x] `同期が完了しました。` に `hatenaSummaryFailed` 集計が増えること（warn は初回のみ）
- [x] `POST /api/sync` の catch が `toErrorMessage` 経由になっていること
- [x] UI の同期ボタン文言が完了を保証しないこと
- [ ] 本番デプロイ後の観察: AI 障害時・D1 保存不能時に `同期を中断しました。` が cron ごとの 1 行だけ出ること（認証環境が必要なので未実施）

### 完了条件（検証方法・2026-09-08 更新）

- [x] `npm test` / `npx oxlint` / `npm run build` が緑であること — **2026-09-08 確認（24 files / 342 tests 緑、oxlint エラー 0、tsc + vite ビルド成功）**
- [x] モック AI（常時エラー）で cron 相当の同期を 2 回実行し、毎回 `同期を中断しました。`（`reason: "ai-generation"`）が 1 行ずつ出ることを確認 — **テスト化済み（`sync.test.ts`「AI 常時エラーで cron 相当の同期を 2 回実行すると…」）**
- [x] モック D1 書き込み失敗（`Exceeded maximum DB size.` 等）で run が中断し `同期が完了しました。` が出ないことをテストで確認 — **`sync.test.ts`（ingest・枠予約の両経路）および `egress.test.ts`（SyncWriteError 化）**
- [x] `docs/specs/ingest-failure.md` §5（失敗記事の追跡）と §8（本 issue）を ADR-0017 解決済みとして更新すること

### 実装計画（1 PR・R5-Q3=a）

1. `SyncWriteError`＋`runWrite` ラッパーで、同期中の全 D1 書き込みを中断対象にする → **完了（`src/db/writeError.ts` 新設。`sync.ts` の全書き込みと `egress.ts` の枠予約・障害記録を包む）**
2. Article Summary 失敗＝中断／Hatena Summary 失敗＝warn 継続（初回 warn ＋ `hatenaSummaryFailed` 集計）の住み分け → **完了**
3. `runSync` をラップして `同期を中断しました。`（error）を出力。`同期が完了しました。` は中断時に出さない → **完了（`performSync` に分離）**
4. `POST /api/sync` の catch を `toErrorMessage` 経由に、UI 側は開始を保証する文言に変更 → **完了**

## 補足（任意）

- 関連: `docs/specs/ingest-failure.md` §8 未決事項、PR #396（ログ観測性の修正）。
- 障害の実体は OpenAI クレジット切れ（2026-09-07、ユーザー確認）。`AI_API_KEY` の quota 系エラーは 429 で返るため、`AiGenerationError` の cause から判別可能なはず（要実装確認）→ **判別しない**ことを決めた（ADR-0017。pi-ai は HTTP ステータスを構造化で返さず `errorMessage` 文字列のみ）。cause の実文はログに出るので原因特定は可能。
- 当初ゴールの「連続 N 回失敗での通知」は、R1-Q2 の回答（同じ原因で止まり続けてもよい）により不要。**止まるべき時に止まらないこと**（保存不能の緑完了）が実害として残り、検知は Pull 型ログ 1 行に縮約した。
- 本番の購読 Source 数・1 run あたりの新着件数は未取得（ローカル `sqlite.db` は購読 0・記事 0）。ADR-0017 の決定はいずれも実数に依存しない。

## 解決記録

- **2026-09-08（grilling・仕様確定）**: R1〜R6 の 6 ラウンドで決定し、**ADR-0017**（`docs/adr/0017-keep-fail-fast-and-abort-on-write-failure.md`）に記録。中心の発見は「**fail-fast の荷重は『要約を回収する手段が無い』ことに乗っていた**」という一点で、これにより縮退運転は恒久欠損の製造機になると判明（Hatena Summary だけ回収経路が存在するため、そこだけ縮退を認める）。ADR-0008 は中核を維持し、Hatena Summary の射程のみ変更。
- **2026-09-08（実装）**: ADR-0017 を実装した。
  - `src/db/writeError.ts` 新設（`SyncWriteError` / `isSyncWriteError` / `runWrite`）。分類語彙は増やさず、書き込み失敗だけを例外で区別する。
  - `src/workflows/sync.ts`: `BackfillState` → `RunState`（進行位置 `progress` と `hatenaSummaryFailed` 集計を持つ）。`runSync` を `performSync` に分離し、`同期を中断しました。`（error）を 1 行出力。同期中の全 D1 書き込みを `runWrite` で包み、`tryFetchFeed` では枠の書き込み失敗を `failed`（Source 個別 warn）に降格させず再送出。`ingestNewArticle` の catch は **AI → UNIQUE 競合 → 書き込み失敗 → その他 warn** の順で判定する。
  - `src/services/egress.ts`: D1 枠ストアの全書き込み（`ensureRow` / `reserve` / `applyThrottle` / `markOk` / `spaceOut`）を `runWrite` で包んだ。**D1 が書けない状態はパス1先頭（`INSERT INTO fetch_buckets`）で検知され、外部取得も AI 呼び出しも 0 本**で止まる。
  - `src/worker.ts`: cron / `POST /api/sync` に `trigger` を渡し、API 側の catch を `toErrorMessage` 経由に統一（PR #396 で取りこぼした経路）。
  - `src/client/hooks/useSync.ts`: 「同期を開始しました。完了後に再読み込みします。」→「同期をサーバーに送信しました。少ししてから一覧が更新されます。」（run が数秒後に中断しても成功に見えないため）。
  - docs: `CONTEXT.md` に `Sync Abort`、ADR-0008 相互リンク、`ingest-failure.md` §4/§5/§8 と `sync-egress-politeness.md` §7（ログ仕様）を改訂。
  - テスト: 新規 5 本（保存不能の中断＋ログ / AI 常時エラー 2 run / はてブ要約の warn 継続と集計 / 枠予約失敗で AI を呼ばない / egress の SyncWriteError 化）と既存 4 本の期待値更新。**24 files / 342 tests 緑、`npx oxlint` exit 0、`npm run build` 成功**。
- **2026-09-08（ADR-0016 の潜在バグ発見・修正）**: 保存失敗を中断に格上げしたことで、**同一 run 内の本文補完が取りたての行を再取得している**ことが露見した（テストが落ちるまで黙って失敗していた）。原因は `articles.created_at` の既定式が julianday を integer に切り捨てるため、run 開始直後の INSERT の `created_at` が `runStartedAtMs` より数 ms 古くなること。ADR-0016 の除外条件（`created_at < run 開始時刻`）が壊れていた。抽出を 1 秒余白（`sameRunCreatedGraceMs`）に変更し、回帰テスト（`fetchArticleContent` が 1 回しか呼ばれないこと）で固定。ADR-0016 に「実装上の補足」として追記済み。
- **未実施（引き継ぎ）**: 本番デプロイ後の観察。`npm run deploy` 後、次の cron で `同期が完了しました。` に `hatenaSummaryFailed: 0` が出ることを 1 回確認し、以後は AI を意図的に失敗させた run で `同期を中断しました。`（`reason: "ai-generation"`）が cron 1 回につき 1 行出ることを確認する。本決定はマイグレーションを要さない（`fetch_buckets` 以外にスキーマ変更なし）。
