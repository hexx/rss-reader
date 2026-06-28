# RSS Reader

Cloudflare Workers と D1 を使う RSS リーダーです。

## プロジェクト概要

- RSS フィードや HTML から記事を取得します。
- 各記事に対してはてなブックマークコメントを集めます。
- OpenCode Go 互換の AI で日本語要約を生成します。
- Cloudflare Workers で同期と配信を行います。

## 前提条件

- Node.js 24 以上
- OpenCode Go 互換 API のベース URL と API キー
- Cloudflare の D1 / Workers バインディング

## セットアップ

1. リポジトリをクローンして依存関係をインストールします。

```bash
npm install
```

2. `.env.example` を `.env` にコピーして、必要な値を設定します。

```bash
cp .env.example .env
```

3. `wrangler.toml` で Cloudflare の bindings を設定します。

## 実行

- ローカル確認: `wrangler dev`
- 本番反映: `wrangler deploy`
- テスト: `npm run test`
- ビルド: `npm run build`

## 環境変数

詳細は `.env.example` を参照してください。
