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
- 本番反映: `wrangler deploy`
- テスト: `npm run test`
- ビルド: `npm run build`

## AI プロバイダの設定

要約生成には **OpenAI 互換（OpenAI-compatible）な任意のエンドポイント**を使います。
裏側では `@ai-sdk/openai-compatible` の `createOpenAICompatible` を利用しており、
特定のベンダーに依存しません。次の 3 つの環境変数で指定します。

| 変数 | 説明 | 例 |
| --- | --- | --- |
| `AI_BASE_URL` | OpenAI 互換エンドポイントのベース URL | `https://api.openai.com/v1` |
| `AI_API_KEY` | API キー（秘匿値） | `sk-...` |
| `AI_MODEL` | 利用するモデル名（未設定時は `gpt-4o-mini`） | `gpt-4o-mini` |

### ローカル開発

`.env`（または `.dev.vars`）に値を書きます。デフォルトの `.env.example` は
ローカルの [Ollama](https://ollama.com/)（`http://localhost:11434/v1`）向けです。

```ini
AI_BASE_URL=http://localhost:11434/v1
AI_API_KEY=replace-me
AI_MODEL=llama3.2
```

### 本番（Cloudflare Workers）

`.env` はローカル専用であり本番には反映されません。本番では以下のように設定します。

- **API キー（秘匿値）**: `wrangler secret` で設定します。wrangler.toml には書きません。

  ```bash
  npx wrangler secret put AI_API_KEY
  ```

- **公開値（ベース URL・モデル名）**: `wrangler.toml` の `[vars]` に記載します。

  ```toml
  [vars]
  AI_BASE_URL = "https://api.openai.com/v1"
  AI_MODEL = "gpt-4o-mini"
  ```

設定後 `npx wrangler deploy` で反映されます。

### プロバイダ選択ガイド

`AI_BASE_URL` に次のような OpenAI 互換エンドポイントを指定できます。

- **OpenAI 本家**: `https://api.openai.com/v1`
- **各社の OpenAI 互換ゲートウェイ**: OpenRouter / Azure OpenAI / LiteLLM など。
  Anthropic 等を OpenAI 互換でプロキシするゲートウェイを経由すれば、
  Anthropic モデルも `AI_BASE_URL` にそのまま指定できます。
- **ローカルの Ollama**: `http://localhost:11434/v1`（`AI_API_KEY` は任意）
- **ローカルの LM Studio / vLLM 等**: 同様に OpenAI 互換ポートを指定

> **注意**: Anthropic の公式 API は OpenAI 互換ではありません。
> そのまま `AI_BASE_URL` に `https://api.anthropic.com` を指定しても動きません。
> Anthropic を直接使う場合は、(1) OpenAI 互換ゲートウェイでプロキシするか、
> (2) `@ai-sdk/anthropic` などを追加して別プロバイダとして実装する必要があります。
