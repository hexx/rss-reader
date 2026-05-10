# RSS Reader

AI 要約、はてなブックマーク連携、RAG 検索、Web ダッシュボード、Cron 自動同期を備えた RSS リーダーです。

## プロジェクト概要

- RSS フィードや HTML から記事を取得します。
- 各記事に対してはてなブックマークコメントを集めます。
- OpenCode Go 互換の AI で日本語要約を生成します。
- 要約と本文をベクトル化して LanceDB に保存し、横断検索できます。
- Web ダッシュボードと Cron ジョブで定期同期を自動化できます。

## 前提条件

- Node.js 22 以上
- SQLite 3
- OpenCode Go 互換 API のベース URL と API キー

## セットアップ

1. リポジトリをクローンして依存関係をインストールします。

```bash
npm install
```

2. `.env.example` を `.env` にコピーして、必要な値を設定します。

```bash
cp .env.example .env
```

3. データベースを初期化します。

```bash
DATABASE_URL=./sqlite.db npx drizzle-kit push --config drizzle.config.ts --force
```

## 使い方（CLI 編）

サイトの購読追加:

```bash
npm run cli -- subscribe https://example.com/
```

手動同期:

```bash
npm run cli -- sync
```

検索:

```bash
npm run cli -- search AI RSS
```

## 使い方（Web・自動化編）

Web ダッシュボードと Cron を同時起動します。

```bash
npm run start:all
```

ブラウザで以下を開きます。

```text
http://localhost:3000
```

個別起動も可能です。

```bash
npm run serve
npm run cron
```

## トラブルシューティング

- 実行ログは `logs/app.log` に出力されます。
- エラー詳細は `logs/error.log` を確認します。
- 画面や CLI で問題が出る場合は、まず `tail -f logs/error.log` を見てください。

## 環境変数

詳細は `.env.example` を参照してください。
