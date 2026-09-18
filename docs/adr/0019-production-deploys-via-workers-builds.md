# 本番反映は Cloudflare Workers Builds に一本化する

これまで本番反映は運用者の手元からの `npm run deploy`（`build:client && wrangler deploy`）だけで行われ、実行主体はリポジトリのどこにも記録されていなかった（`issues/issue-202609080602-d1-migrations-in-deploy-flow.md` の「デプロイの実行主体: UNKNOWN」、`docs/specs/ingest-failure.md` §7）。GitHub Actions CI は lint/build/test のみでデプロイせず、GitHub の deployment / environment も 0 件。`wrangler.toml` の `account_id` / `database_id` はプレースホルダで実値は運用者の手元にしか無く、「どのコミットが本番で動いているか」をリポジトリから知る手段が無かった。そこで main へのマージを本番反映の唯一のトリガーとする。

## 決定

- **本番反映は Cloudflare Workers Builds の production trigger（production branch = `main`）だけで行う**。main にマージされた時点で自動的に本番反映される（継続的デプロイ）。
- **不変条件: 本番で動いている成果物は main 先頭のコミットからビルドしたものである**。成果物に影響する差分が main に入れば必ず反映が走る。この不変条件を守るため、障害時の巻き戻しは `git revert` → main へのマージを正とする（`wrangler rollback` は止血が必要なときの例外で、使ったら必ず revert で追いつかせる）。
- **プレビュー配備（非本番ブランチのビルド）は作らない**。既定の preview trigger は `wrangler versions upload` で version URL を作るが、このアプリは Cloudflare Access が唯一の認証でアプリ内認証を持たず（ADR-0006）、binding は本番 D1 を共有する。プレビュー URL は Access 保護外に出るため、「認証なしで本番 DB を書き換え、AI 課金を起こせる URL」を増やすことになる。
- **lint / build / test は GitHub Actions CI（`.github/workflows/ci.yml`）に残し、main の ruleset に必須ステータスチェック（`Lint` / `Build` / `Unit Tests`）を追加する**。Workers Builds のビルドコマンドは成果物の生成（`npm run build`）とデプロイ手順の実行に限る。
- **ビルド設定の権威は Cloudflare ダッシュボード**（リポジトリからは見えない）。設定値は `docs/specs/deploy.md` §3 に写して乖離に気づけるようにする。デプロイ手順の実体はリポジトリ側の `npm run deploy` に置き、ダッシュボードの deploy command はそれを呼ぶだけにする。
- **成果物に影響しない差分（`docs/**` `issues/**` `*.md` `.github/**`）ではビルドしない**（watch paths）。`public/**` `drizzle/**` `wrangler.toml` は除外しない。
- `account_id` / `database_id` の実値をリポジトリにコミットする（いずれも秘匿値ではない）。

## Considered Options

- **GitHub Actions + `cloudflare/wrangler-action`**: 既存 CI と一体で書け、ゲートとデプロイを 1 ファイルに収められるが、Cloudflare の API トークンを GitHub Secrets に置く必要があり、デプロイ経路が 2 つのツールに跨る。
- **手元からのデプロイを続ける**: 「デプロイの実行主体が不明」という現在の問題が解消せず、実行には実値入りの `wrangler.toml` が必要で再現できない。
- **プレビュー配備を有効化**: PR ごとの確認ができるが、Access 保護外・本番 D1 共有という性質上、事故の作り込みになる。環境を分けるなら別 Worker + 別 D1 の新設が必要で、独立した設計課題。
- **Renovate の automerge を絞る／実行時間帯を限定する**: 必須チェックがゲートになるため現状維持（patch + minor automerge）を選ぶ。深夜帯の本番反映は許容し、原因不明の障害時は直近にデプロイが無かったかをダッシュボードのビルド履歴で確認する。

## Consequences

- main の ruleset に必須ステータスチェックを入れるまで、テストが赤いままのマージが本番に出る（手順は `docs/specs/deploy.md` §5 に記録）。
- 本番反映の設定がダッシュボードに存在するようになるため、リポジトリを読むだけでは経路が分からない。この非対称を `docs/specs/deploy.md` が埋める。デプロイの失敗と再実行はダッシュボードのビルド履歴を見る。
- ローカルからの本番反映は `ALLOW_LOCAL_DEPLOY=1` の明示が要るようになる（`scripts/deploy-guard.mjs`）。経路を 1 本にする代わりに、抜け道は意図的な操作に閉じる。
