# 仕様：本番反映（Production Deploy）

決定の根拠は [ADR-0019](../adr/0019-production-deploys-via-workers-builds.md)（本番反映は Cloudflare Workers Builds に一本化）、[ADR-0020](../adr/0020-additive-only-migrations-in-deploy.md)（マイグレーションはデプロイ手順に組み込み、追加のみ）。用語は [`CONTEXT.md`](../../CONTEXT.md) が権威。

## 1. 権威の所在

| 何を決めるか | 権威 |
|---|---|
| デプロイ手順の中身（マイグレーション適用 → デプロイ） | リポジトリ（`package.json` の `deploy`、`scripts/deploy-guard.mjs`） |
| いつ・どのブランチでビルドするか、build / deploy command、watch paths、API トークン | Cloudflare ダッシュボード（Workers & Pages → rss-reader → Settings → Build） |
| 本番に出てよいか（テストの合否） | GitHub Actions CI ＋ main の ruleset（必須ステータスチェック） |

ダッシュボードの設定は**リポジトリからは見えない**。§3 がその写しであり、変更したら必ずここも更新する（乖離に気づく唯一の手掛かり）。

## 2. 不変条件

- **本番で動いている成果物は main 先頭のコミットからビルドしたものである。** 成果物に影響する差分が main に入れば必ず本番反映が走る。
- 巻き戻しは **`git revert` → main へマージ**が正。`wrangler rollback` は止血の例外で、使ったら必ず revert で追いつかせる。
- D1 は巻き戻せない。追加のみ規約（ADR-0020）により、旧コードは新スキーマで動く。

## 3. Workers Builds の設定値（写し）

| 設定 | 値 |
|---|---|
| Git アカウント / リポジトリ | GitHub `hexx` / `hexx/rss-reader` |
| production branch | `main` |
| Build command | `npm run build` |
| Deploy command | `npm run deploy` |
| Non-production branch builds | **無効**（preview trigger を作らない。version URL は Access 保護外で本番 D1 を共有するため。ADR-0019） |
| Root directory | 未設定（リポジトリ直下） |
| API token | カスタムトークン（下記権限） |
| Build variables / secrets | なし（Node 24 が Workers Builds の既定で、`engines: >=24` と一致する） |
| Path excludes | `docs/**` `issues/**` `*.md` `.github/**` |

API トークンの権限（user トークンのみ対応。アカウント所有トークンは不可）:

- Account: **Account Settings: Read** / **Workers Scripts: Edit** / **Workers KV Storage: Edit** / **Workers R2 Storage: Edit** / **D1: Edit**（自動生成トークンには D1 が無いため、これがカスタムにする理由）
- Zone: **Workers Routes: Edit**（対象ゾーン全体）
- User: **User Details: Read** / **Memberships: Read**

## 4. リポジトリ側

```json
"build": "npm run build:client && tsc -p tsconfig.json",
"deploy": "node scripts/deploy-guard.mjs && wrangler d1 migrations apply rss-reader --remote && wrangler deploy"
```

- `scripts/deploy-guard.mjs`: `WORKERS_CI=1`（Workers Builds が注入）が無く、かつ `ALLOW_LOCAL_DEPLOY=1` も無ければ中止する。ローカルからの本番反映を明示的な操作に閉じるため。
- `wrangler.toml`: `account_id` / `database_id` は実値をコミットする（いずれも秘匿値ではない）。プレースホルダのままだと Workers Builds 側で解決できない（`wrangler d1 migrations apply --remote` は `database_id` の明示が必須）。
- `wrangler` は `devDependencies` に固定され、Workers Builds はそのバージョンを使う。
- 追加のみ規約（ADR-0020）: `drizzle/*.sql` に `DROP` / リネームを含めない。含める必要がある場合は二段目の Issue を立てる。

## 5. GitHub 側（main の ruleset）

必須ステータスチェック（CI のジョブ名がチェック名になる）:

| context | strict |
|---|---|
| `Lint` | `false` |
| `Build` | `false` |
| `Unit Tests` | `false` |

`strict_required_status_checks_policy: false` にするのは、Renovate の automerge が「base の更新待ち」で止まらないようにするため。

UI: Settings → Rules → `main` → 「Require status checks to pass」で 3 つを選択。

API（ruleset id は `gh api repos/hexx/rss-reader/rulesets` で確認）:

```bash
gh api repos/hexx/rss-reader/rulesets/17347074 --method PUT --input - <<'JSON'
{
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "required_status_checks",
      "parameters": {
        "do_not_enforce_on_create": false,
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "Lint" },
          { "context": "Build" },
          { "context": "Unit Tests" }
        ]
      }
    }
  ]
}
JSON
```

> **2026-09-18 の修正**: 既存の ruleset「main」は `conditions.ref_name.include` が空で、**main にどのルールも適用されていなかった**（`gh api repos/hexx/rss-reader/rules/branches/main` が `[]` を返す状態）。上記のとおり `~DEFAULT_BRANCH` を設定したため、必須チェックに加えて `deletion` / `non_fast_forward`（main の削除・force push 禁止）もこの時点から有効になっている。有効性は `gh api repos/hexx/rss-reader/rules/branches/main` で確認できる。

## 6. 初回セットアップの順序

1. `wrangler.toml` の実値をコミットする（確認: `npx wrangler whoami` / `npx wrangler d1 list`）。
2. main の ruleset に必須ステータスチェックを追加する（§5）。
3. Cloudflare ダッシュボード: Workers & Pages → rss-reader → Settings → Build で Git を接続し、§3 の値を設定する（preview trigger は作らない）。
4. 次の main マージ（またはダッシュボードからの手動ビルド）を初回の本番反映とし、§8 のとおりログを確認する。

## 7. 通常のフロー / ロールバック / 緊急時

- **通常**: PR → CI 緑 → main マージ → Workers Builds が `npm run build` → `npm run deploy`（= マイグレーション適用 → デプロイ）。
- **ロールバック**: `git revert <commit>` → PR → main マージ。revert も成果物に影響するため自動で本番反映される。
- **止血（例外）**: ダッシュボードで旧バージョンを promote、または `wrangler rollback`。**使ったら必ず revert で追いつかせる。**
- **緊急のローカル反映**（Workers Builds が使えないとき）:

  ```bash
  npm run build && ALLOW_LOCAL_DEPLOY=1 npm run deploy
  ```

  ローカルの `wrangler.toml` に実値が入っている必要がある。実行後は「本番 = main 先頭」が崩れるため、revert 相当の追いつきを行う。

## 8. 検証

ローカル（本番には触れない）:

```bash
npm run deploy                                          # ガードにより中止されること（WORKERS_CI が無い）
npx wrangler d1 migrations apply rss-reader --local      # 2 回実行し、2 回目が no-op であること（冪等）
```

初回の本番反映では、ビルドログに「適用なし」で素通りしたこと（未適用のマイグレーションが 0 であること）を確認する:

```bash
npx wrangler d1 migrations list rss-reader --remote   # 未適用が空であること
```

**本番で未適用のマイグレーションを意図的に作って検証しない**（再発防止したい事故そのものを作ることになるため）。順序と冪等性の検証はローカルで行う。

## 9. 採用しないもの

- プレビュー配備（非本番ブランチのビルド）。有効化するならプレビュー専用の Worker と D1 を分ける設計から始める（ADR-0019）。
- CI での本番 D1 乖離検知、破壊的 DDL の機械検出（ADR-0020）。
- Renovate の automerge の絞り込み・実行時間帯の制限（必須ステータスチェックのみをゲートとする。ADR-0019）。
