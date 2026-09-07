---
title: "デプロイフローに D1 マイグレーション適用（または乖離検知）を組み込む"
status: TODO
created: 2026-09-08T06:02:57+09:00
---

# デプロイフローに D1 マイグレーション適用（または乖離検知）を組み込む

## 背景・前提条件 (Context)

2026-09-06 に #394（ADR-0015 Give-up 機能）をデプロイした際、コードは `articles` テーブルの新列
（`content_backfill_failures`・`content_backfill_gave_up_at`）を参照するようになったが、それらを
追加する D1 マイグレーション `0007_curvy_wolf_cub.sql` を本番に適用していなかった。その結果、
2026-09-07 03:45 JST 以降、**すべての新着記事 INSERT が決定的に失敗**し、約1日にわたり新着が
一切増えない状態が続いた（詳細は `docs/specs/ingest-failure.md` §7 解決記録）。

### 期待される挙動 vs 実際の挙動

- **期待**: スキーマ変更を含むコードが本番へデプロイされるとき、対応するマイグレーションが本番 D1 にも適用されている。または、乖離があればデプロイ/CI が失敗して検知できる。
- **実際**: コードだけが先行デプロイされ、マイグレーションは未適用。以後すべての INSERT が `SQLITE_ERROR` で失敗し続け、原因の判明までにログの観測性修正（PR #396）を要した。

### エラーログ / スタックトレース

本番 Workers Logs（2026-09-07 03:45 JST 頃以降、いろいろな articleUrl で同文が反復。逐語）:

```json
{
  "level": "warn",
  "message": "記事の同期に失敗しました。",
  "articleUrl": "https://www.yomiuri.co.jp/politics/20260907-GYT1T00258/",
  "error": "table articles has no column named content_backfill_failures: SQLITE_ERROR",
  "siteUrl": "https://b.hatena.ne.jp/hotentry.rss",
  "title": "海外ワインをトンネルや海底保存し「潜在能力を引き出した」か…総務省、ふるさと納税巡り返礼品の実態調査",
  "event": { "cron": "15,45 * * * *", "scheduledTime": 1788813908 }
}
```

### 再現手順

1. マイグレーション未適用の本番 D1 を用意する（今回の事故の再現なら、`drizzle/meta/_journal.json` の `0007` 相当を未適用にした状態）。
2. 新着記事を取り込む（`POST /api/sync` または cron を待つ）。
3. INSERT が次のエラーで失敗することを確認する:
   `table articles has no column named content_backfill_failures: SQLITE_ERROR`
4. 適用状況の確認コマンド（デプロイ可能な wrangler 認証がある環境で）:

```bash
npx wrangler d1 migrations list rss-reader --remote   # 未適用マイグレーションの一覧
npx wrangler d1 execute rss-reader --remote --command "PRAGMA table_info(articles)"  # 実スキーマ確認
```

### 環境情報

- 実行環境: Cloudflare Workers + D1（wrangler 4.91.0、`wrangler.toml` の `migrations_dir = "drizzle"`）
- デプロイ方法: `npm run deploy`（= `npm run build:client && wrangler deploy`）。デプロイの実行主体（手元か CI か）: UNKNOWN
- CI: `.github/workflows/ci.yml`（lint / build / test のみ。デプロイ・マイグレーションは含まれない）
- 手動修正の実施状況: `npx wrangler d1 migrations apply rss-reader --remote` を 2026-09-08 06:02 JST 時点で実行済みかどうかは **UNKNOWN**（未実施なら本番は INSERT 失敗が継続中。まず最優先で確認・実行すること）

### 関連ファイル / コード

- `package.json`

```json
"deploy": "npm run build:client && wrangler deploy"
```

- `wrangler.toml`

```toml
[[d1_databases]]
binding = "DB"
database_name = "rss-reader"
migrations_dir = "drizzle"
```

- `drizzle/0007_curvy_wolf_cub.sql`（本事故で未適用だったマイグレーション）

```sql
ALTER TABLE `articles` ADD `content_backfill_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `articles` ADD `content_backfill_gave_up_at` integer;
```

### 試したが駄目だったこと

- なし（今回初めての構造的対処）。

## 解決すべきゴール (Goal)

- [ ] 方式の決定: (a) `npm run deploy` に `npx wrangler d1 migrations apply rss-reader --remote` を組み込む、(b) CI に「drizzle ジャーナルと本番 `d1_migrations` の差分検知」ステップを追加する、(c) 両方 —— のうちどれを採るか決定し、実装する
- [ ] 採用した方式を `docs/specs/` または README のデプロイ手順に文書化する
- [ ] 既存テスト（`npm test`）を壊さないこと

### 完了条件（検証方法）

- `npm run deploy` 相当の実行時にマイグレーション適用が行われる（または乖離時に CI/デプロイが失敗する）ことを、`npx wrangler d1 migrations list rss-reader --remote` の出力で確認できる
- ローカル環境で「未適用マイグレーションがある状態 → デプロイ/CI が検知する」動作を一度再現して提示できる

## 補足（任意）

- 原因調査の全経緯は `docs/specs/ingest-failure.md`（解決記録 §7）を参照。観測性の修正は PR #396 で済み、本 issue は再発防止のプロセス整備がスコープ。
- `wrangler d1 migrations apply` は適用台帳（`d1_migrations`）を見て未適用分だけ当てるため、冪等に再実行できる。
