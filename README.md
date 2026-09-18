# RSS Reader

Cloudflare Workers と D1 を使う RSS リーダーです。

## プロジェクト概要

- RSS フィードや HTML から記事を取得します。
- 各記事に対してはてなブックマークコメントを集めます。
- OpenAI 互換 API で日本語要約を生成します。
- Cloudflare Workers で同期と配信を行います。

## 前提条件

- Node.js 24 以上
- OpenAI 互換 API のベース URL と API キー（OpenAI 本家、各社ゲートウェイ、ローカルの Ollama 等）
- Cloudflare の D1 / Workers バインディング

## セットアップ

1. リポジトリをクローンして依存関係をインストールします。

```bash
npm install
```

2. `.env.example` を `.env` にコピーして、AI プロバイダの値を設定します。

```bash
cp .env.example .env
```

3. `wrangler.toml` で Cloudflare の bindings を設定します。

## 実行

- ローカル確認: `wrangler dev`
- 本番反映: main へマージする（Cloudflare Workers Builds が自動で反映する。手元からは実行しない）
- テスト: `npm run test`
- ビルド: `npm run build`

## デプロイ（本番反映）

本番反映は **Cloudflare Workers Builds**（production branch = `main`）だけが行います。
main にマージすると、ビルド（`npm run build`）→ デプロイ（`npm run deploy`）の順に走り、
`npm run deploy` の中で D1 マイグレーションの適用（未適用分のみ）と `wrangler deploy` が行われます。

- 障害時は `git revert` して main にマージします（revert も自動で反映されます）
- 止血のためにダッシュボードで旧バージョンへ戻した場合は、必ず revert で追いつかせてください
- 手元から反映する必要があるときだけ `npm run build && ALLOW_LOCAL_DEPLOY=1 npm run deploy`
- 設定値と手順の詳細は [docs/specs/deploy.md](./docs/specs/deploy.md)、判断の根拠は ADR-0019 / 0020

## 同期の律速（外部取得のマナー）

定期同期は購読先とはてなブックマーク API を多数叩くため、外部取得はすべて
**律速層**（`src/services/egress.ts`）を通します。取得枠（同一登録ドメイン、または
はてな群のような同一運用者の集まり）ごとに最小間隔を守り、429/503 を受けると
D1 の `fetch_buckets` にクールダウン（30分 → 60分 → 90分、`Retry-After` は尊重）を
記録して自己回復します。設計詳細は [docs/specs/sync-egress-politeness.md](./docs/specs/sync-egress-politeness.md)、
判断根拠は ADR-0009 / 0010 / 0011 を参照してください。

`POST /api/sync?force=true` はクールダウン中の特例再試行で、運用上手動のリカバリ専用です
（UI からは呼びません。枠内の最小間隔は引き続き守ります）。

## スキーマ変更の反映

D1 のテーブルは drizzle のマイグレーションで管理します（`drizzle/` 配下）。
スキーマを変えたら `npm run db:generate` で生成し、そのまま main にマージしてください。
本番への適用はデプロイ手順（`npm run deploy`）に組み込まれているため、人手での適用は不要です。

```bash
npx wrangler d1 migrations apply rss-reader --local   # 開発環境の確認
npx wrangler d1 migrations list rss-reader --remote   # 本番の適用状況（読み取りのみ）
```

**マイグレーションは追加のみ（後方互換）**という規約があります（ADR-0020）。適用はコードの反映より
先に走るため、旧コードが新スキーマで動く時間帯が必ず生じるためです。`DROP` やリネームが必要な場合は、
「追加してコードから使う」→「次のデプロイで旧列を消す」の二段構えにし、二段目は Issue 化してください。

## AI プロバイダの設定

要約生成には **OpenAI 互換（OpenAI-compatible）な任意のエンドポイント**を使います。
裏側では [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai) の
`openai-completions` / `openai-responses` APIを設定で切り替えます。特定のベンダーには依存しません。

| 変数 | 説明 | 例 |
| --- | --- | --- |
| `AI_BASE_URL` | OpenAI 互換エンドポイントのベース URL | `https://api.openai.com/v1` |
| `AI_API_KEY` | API キー（秘匿値）。キー不要なローカルサーバでもダミー値が必要 | `sk-...` |
| `AI_MODEL` | 利用するモデル名（未設定時は `gpt-5.6-luna`） | `gpt-5.6-luna` |
| `AI_API` | API方式（未設定時は `openai-completions`） | `openai-responses` |
| `AI_REASONING_EFFORT` | 推論レベル（未設定時は `medium`） | `medium` |

### ローカル開発

`.env`（または `.dev.vars`）に値を書きます。デフォルトの `.env.example` は
OpenAI 本家の GPT-5.6 Luna（`https://api.openai.com/v1`）向けです。

```ini
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=replace-me
AI_MODEL=gpt-5.6-luna
AI_API=openai-responses
AI_REASONING_EFFORT=medium
```

`AI_API` は `openai-completions` または `openai-responses` を指定できます。
`AI_REASONING_EFFORT` は `off` / `low` / `medium` / `high` / `xhigh` / `max` を指定できます。
GPT-5.6 Lunaでは `minimal` はサポートされません。

ローカルの [Ollama](https://ollama.com/) を使う場合は、`.env.example` 内のコメント行
（`http://localhost:11434/v1` + `llama3.2`）に従って書き換えてください。

### 本番（Cloudflare Workers）

`.env` はローカル専用であり本番には反映されません。本番では以下のように設定します。

- **API キー（秘匿値）**: `wrangler secret` で設定します。wrangler.toml には書きません。

  ```bash
  npx wrangler secret put AI_API_KEY
  ```

- **公開値（ベース URL・モデル名・API方式・推論レベル）**: `wrangler.toml` の `[vars]` に記載します。

  ```toml
  [vars]
  AI_BASE_URL = "https://api.openai.com/v1"
  AI_MODEL = "gpt-5.6-luna"
  AI_API = "openai-responses"
  AI_REASONING_EFFORT = "medium"
  ```

設定後、次の本番反映（main へのマージ）で反映されます。

### プロバイダ選択ガイド

`AI_BASE_URL` に次のような OpenAI 互換エンドポイントを指定できます。

- **OpenAI 本家**: `https://api.openai.com/v1`
- **各社の OpenAI 互換ゲートウェイ**: OpenRouter / Azure OpenAI / LiteLLM など。
  Anthropic 等を OpenAI 互換でプロキシするゲートウェイを経由すれば、
  Anthropic モデルも `AI_BASE_URL` にそのまま指定できます。
- **DeepSeek 公式 API**: `https://api.deepseek.com` に
  `AI_MODEL=deepseek-v4-flash-vision-exp` のような指定。API キーは
  [platform.deepseek.com](https://platform.deepseek.com) で発行します。`api.deepseek.com`
  経路は pi-ai が自動で互換設定（`store` フィールドを送らない等）を判別します。
- **ローカルの Ollama**: `http://localhost:11434/v1`（`AI_API_KEY` は必須ですが、
  キー不要なサーバでは `replace-me` などのダミー値で構いません）
- **ローカルの LM Studio / vLLM 等**: 同様に OpenAI 互換ポートを指定

> **注意**: Anthropic の公式 API は OpenAI 互換ではありません。
> そのまま `AI_BASE_URL` に `https://api.anthropic.com` を指定しても動きません。
> Anthropic を直接使う場合は、OpenAI 互換ゲートウェイでプロキシしてください。
