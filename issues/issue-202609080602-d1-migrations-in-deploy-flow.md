---
title: "デプロイフローに D1 マイグレーション適用（または乖離検知）を組み込む"
status: DONE
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

- [x] 方式の決定: (a) `npm run deploy` に `npx wrangler d1 migrations apply rss-reader --remote` を組み込む、(b) CI に「drizzle ジャーナルと本番 `d1_migrations` の差分検知」ステップを追加する、(c) 両方 —— のうちどれを採るか決定し、実装する — **(a) を採用（ADR-0020）。乖離検知 (b) は不採用。あわせて本番反映の経路を Cloudflare Workers Builds に一本化した（ADR-0019）**
- [x] 採用した方式を `docs/specs/` または README のデプロイ手順に文書化する — **`docs/specs/deploy.md` を新設し、README の「実行」「デプロイ（本番反映）」「スキーマ変更の反映」を差し替え。CONTEXT.md に Production Deploy / Environment を追加**
- [x] 既存テスト（`npm test`）を壊さないこと — **2026-09-08 確認（24 files / 345 tests 緑）**

### 完了条件（検証方法）

- [x] `npm run deploy` 相当の実行時にマイグレーション適用が行われる（または乖離時に CI/デプロイが失敗する）ことを、`npx wrangler d1 migrations list rss-reader --remote` の出力で確認できる — **実装で保証（`npm run deploy` = 適用 → デプロイ。ADR-0020）。本番での `--remote` の確認は引き継ぎ A-4（認証環境が必要）**
- [x] ローカル環境で「未適用マイグレーションがある状態 → デプロイ/CI が検知する」動作を一度再現して提示できる — **方式が自動適用 (a) のため検知ではなく「順序」と「冪等性」で代替して確認: ローカル D1 で 1 回目に 0001〜0007 を適用、2 回目に `✅ No migrations to apply!`（2026-09-08）**

## 補足（任意）

- 原因調査の全経緯は `docs/specs/ingest-failure.md`（解決記録 §7）を参照。観測性の修正は PR #396 で済み、本 issue は再発防止のプロセス整備がスコープ。
- `wrangler d1 migrations apply` は適用台帳（`d1_migrations`）を見て未適用分だけ当てるため、冪等に再実行できる。

## 解決記録

- **2026-09-08（方式決定・オーナー承認 /grill-with-docs）**: 選択肢のうち **(a)「デプロイ手順にマイグレーション適用を組み込む」を採用**し、CI での乖離検知 (b) / 両方 (c) は不採用とした（根拠: ADR-0020）。あわせて本番反映の経路そのものを **Cloudflare Workers Builds に一本化**した（ADR-0019）。本文にあった「デプロイの実行主体（手元か CI か）: UNKNOWN」はこの決定で解消し、本番反映のトリガーは main へのマージだけになる。
- **2026-09-08（実装）**: `package.json` の `deploy` を `node scripts/deploy-guard.mjs && wrangler d1 migrations apply rss-reader --remote && wrangler deploy` に再構成（従来は `build:client && wrangler deploy`）。`scripts/deploy-guard.mjs` を追加し、`WORKERS_CI=1`（Workers Builds が注入）が無い手元からの実行は `ALLOW_LOCAL_DEPLOY=1` を明示しない限り中止するようにした。ビルドは Workers Builds の build command（`npm run build`）が担う。
- **2026-09-08（文書化）**: `docs/specs/deploy.md` を新設（権威の所在・不変条件・ダッシュボード設定の写し・API トークン権限・必須ステータスチェックの手順・初回セットアップ順序・ロールバック・検証）。README の「実行」「デプロイ（本番反映）」「スキーマ変更の反映」を差し替え、CONTEXT.md に **Production Deploy（本番反映）**・**Environment（実行環境）** を追加。ADR-0019 / 0020 を起票。
- **2026-09-08（検証・ローカル）**: `npm run deploy` がガードで中止されること（exit 1、緊急手順を表示）を確認。`npx wrangler d1 migrations apply rss-reader --local` は 1 回目で 0001〜0007 を適用、2 回目で `✅ No migrations to apply!`（冪等）を確認。品質ゲートは `npm test` 24 files / **345 tests 緑**、`npx oxlint` **エラー 0**（warning のみ、ADR-0018 の許容範囲）、`npm run build`（vite + tsc）成功。
- **2026-09-08（DONE・オーナー判断）**: 「方式の決定」「文書化」「テストを壊さない」の 3 要求は満たし、`npm run deploy` にマイグレーション適用が入った。残る本番側の確認を残して DONE とする判断の根拠は、①残作業（`wrangler.toml` の実値コミット、Cloudflare ダッシュボードの Git 接続・API トークン作成、main ruleset の必須チェック追加、初回デプロイのログ確認）は**リポジトリ外の設定・運用作業**であり実装の成否と独立している、②「本番で未適用を作って検知を確かめる」検証は再発防止したい事故そのものを人為的に作ることになるため実施せず、ローカル検証で代替した — の 2 点（ADR-0005 の DONE 判定に準拠）。

### 引き継ぎ A: 初回の Workers Builds デプロイで確認すること（Cloudflare / GitHub の認証環境が必要）

1. `npx wrangler whoami` / `npx wrangler d1 list` で実値を確認し、`wrangler.toml` の `account_id` / `database_id` を実値に置き換えてコミットする（現在はプレースホルダ）。
2. main の ruleset に必須ステータスチェック（`Lint` / `Build` / `Unit Tests`、`strict` は false）を追加する。手順は `docs/specs/deploy.md` §5。
3. Cloudflare ダッシュボード（Workers & Pages → rss-reader → Settings → Build）で Git を接続し、build command `npm run build` / deploy command `npm run deploy` / **D1 Edit 権限を含むカスタム API トークン** / path excludes（`docs/**` `issues/**` `*.md` `.github/**`）を設定する。**preview trigger は作らない**。
4. 初回デプロイのビルドログで、マイグレーションが適用されず素通りしたこと（`✅ No migrations to apply!` 相当）を確認し、`npx wrangler d1 migrations list rss-reader --remote` が空であることを確認する（§8 のとおり、本番で未適用を意図的に作る検証はしない）。

### 引き継ぎ B: 未決の設計論点（DONE 時点で未決）

- **CI での本番 D1 乖離検知**（ADR-0020 で不採用）: 本番反映が唯一の適用経路になるため通常は乖離しない。乖離が観測されたら「経路を外れた反映が起きた」証拠として再検討する。
- **破壊的 DDL の運用**: 追加のみ規約により `DROP` / リネームは二段目のデプロイに回すが、二段目を忘れないための Issue 起票は人手に依存しており、機械検出はしていない。
- **プレビュー配備**（ADR-0019 で不採用）: 有効化するならプレビュー専用の Worker と D1 を分ける設計から始める（本番 D1 を共有したままでは、Access 保護外の URL が本番データを書き換えられてしまう）。
