# 記事取り込み失敗（Ingest Failure）の観測性と原因確定手順

> Status: 解決済み（2026-09-08。原因は D1 マイグレーション未適用。解決記録は §7）
> 関連: [ADR-0002](../adr/0002-split-sync-cadences.md) / [ADR-0003](../adr/0003-bookmark-comment-ordering.md) / [sync-egress-politeness.md](./sync-egress-politeness.md) / CONTEXT.md「Ingest Failure」

## 1. 背景

2026-09-07（JST）頃から、新着記事取り込み（`ingestNewArticle`）の INSERT が
**いろいろな記事 URL で繰り返し失敗**し、warn ログ
`記事の同期に失敗しました。` が多発している。

失敗ログには drizzle の `DrizzleQueryError` の message（SQL 文 + params ダンプ）しか
記録されておらず、**実際の DB エラー（`error.cause`）が捨てられている**ため、
原因をログから断定できなかった。この観測性の欠陥自体が診断を遅らせた。

## 2. 検証済みの事実

| # | 事実 | 根拠 |
| --- | --- | --- |
| F1 | 失敗した行の実データ（content 4,669 bytes など計 約5.9KB）は、本番と同じスキーマのローカル SQLite に**正常に挿入できる** | 再現検証（本番ログの params 全文を同一スキーマへ挿入。検証済み、スクリプトは削除済み） |
| F2 | D1 の行サイズ上限（行 2MB / SQL 文 100KB）は本件インスタンスと無縁 | F1 + [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/) |
| F3 | 2026-09-01 付で **Workers Free プランの日次 row 上限の強制施行**が開始（超過で 0時UTC まで全クエリ失敗・メールアラートあり） | [Changelog 2026-09-01](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/) |
| F4 | Free プランには **DB あたり 500MB の保存上限**があり、到達すると insert が失敗する（日次リセットなし・アラート対象外） | [D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| F5 | 本番 DB のストレージ使用量は **500MB を超えている** | ダッシュボード（ユーザー確認） |
| F6 | INSERT 失敗の開始は 2026-09-07（JST）= 2026-09-06T18:45Z 頃。**以後継続** | Workers Logs（ユーザー確認） |
| F7 | 「日次上限 exceeded」の**メールアラートは届いていない**。ユーザーの認識ではアカウントは Paid | ユーザー確認 |
| F8 | ADR-0002 は「**Workers Paid プランが前提**」と明記している | ADR-0002 Consequences |
| F9 | 失敗した run は本文取得・AI 要約生成まで**成功した末に** INSERT で失敗している（AI コストを払って死ぬ） | 失敗ログの params 解析 |
| F10 | `articles.url` はグローバル UNIQUE。競合時の INSERT 冪等化（ON CONFLICT）は**未実装**（check-then-insert は非原子的） | `src/db/schema.ts` / `src/workflows/sync.ts` |
| F11 | 2026-09-07（JST）以降、**アプリに新着記事は一切増えていない**（= 全書き込みが失敗している） | ユーザー確認 |
| F12 | アカウントは **Workers Paid サブスクあり**（プラットフォームのアカウントプランは Free）。なお 2026-09-05 に「Workers Paid の支払い完了済みなのにダッシュボードは Workers Free 表示」のコミュニティ報告がある | ユーザー確認 / [Community 報告](https://community.cloudflare.com/t/workers-paid-payment-completed-but-subscription-still-shows-free/955672) |
| F13 | D1 が返す保存容量系エラーは 2 種: `Exceeded maximum DB size.`（DB 単位の上限）と `Your account has exceeded D1's maximum account storage limit...`（アカウント合計） | [D1 エラーリスト](https://developers.cloudflare.com/d1/observability/debug-d1/) |

## 3. 仮説の評価（cause 確定待ち）

| 仮説 | 整合する証拠 | 矛盾・懸念 | 状態 |
| --- | --- | --- | --- |
| **H-A: D1 が実効上 Free 判定（500MB/DB 上限）で書き込み拒否** | F4・F5・F6・F11・F12 が整合的に見えた | **❌ 否定（赤鯡）**。cause 確定後、本原因ではないことが判明（§7）。ストレージ 500MB 超は実在するが本件とは無関係の長期課題 | 却下 |
| H-B: Free プラン日次 row 上限（F3） | 全 URL 失敗を説明 | アラート無し（F7）・日次リセットで回復するはずなのに継続（F6）・開始が 9/1 ではなく 9/7 | **却下（§7）** |
| H-C: UNIQUE(url) 競合（同時実行。ADR-0002 が受容済み） | 起こり得る | 頻発・継続を説明できない（競合は記事 1 本あたり高々 1 回） | 一部の warn の説明に降格 |
| H-行サイズ: 行/SQL 文が上限超過 | ユーザーの初期直感（サイズ制限） | F1・F2 で**否定** | 却下 |

判別は「ログ修正 → デプロイ → cause のエラー文確認」で確定する（§4・§6）。結果は §7。

| 仮説（追補） | 状態 |
| --- | --- |
| **H-D: マイグレーション未適用（スキーマ乖離）** — #394（ADR-0015）がコードのみ本番へ出て、D1 マイグレーション 0007（`content_backfill_failures`・`content_backfill_gave_up_at` の追加）が未適用だったため、全 INSERT が `SQLITE_ERROR` で失敗 | **✅ 確定（§8）** |

## 4. 修正仕様（観測性。実装済み）

実装: `src/utils/errors.ts`（新設）・`src/workflows/sync.ts`・`src/worker.ts`。テスト: `src/utils/errors.test.ts`・`src/workflows/sync.test.ts`（2 件追加）。

1. **cause の記録**: エラー正規化ヘルパー（`toErrorMessage`）は `error.cause` を再帰的に辿り、
   最下層のエラーメッセージを優先して返す。`DrizzleQueryError` の SQL+params ダンプは
   ログに流さない（クエリの識別に十分な最小限のみ）。
   - これにより `sync.ts` 内の全 warn（はてブ取得失敗・補完失敗等）も一括で改善される。
2. **競合の格下げ**: `ingestNewArticle` の catch で cause が
   `UNIQUE constraint failed: articles.url` の場合、想定内の同時実行競合（ADR-0002）として
   **warn ではなく info** で 1 行記録する（`記事は同時実行で保存済みのためスキップします。`）。
3. **AI エラーの扱いは現状維持**: `isAiError` による fail-fast（ADR-0008）は変更しない。
   → **2026-09-08 改訂**: ADR-0017 により、Article Summary の失敗は fail-fast のまま、**Hatena Summary の失敗は warn 継続**（NULL は補完巡回が回収する）。
4. **cron ハンドラの最終 catch**（`console.error('定期同期に失敗しました。')`）も同じヘルパー経由にする。

## 5. grilling セッションでの決定（2026-09-07）

| 決定 | 内容 |
| --- | --- |
| Article の一意性 | URL で世界一意（1 行）。`site_url` は最初に発見した Source を記録（Q2） |
| INSERT の冪等化 | **保留**。cause 確定後に再評価（Q3） |
| ログ設計 | §4 のとおり実施（Q4） |
| 同時実行の削減 | しない（ロック導入・cron 設計変更は見送り。ADR-0002 維持）（Q5） |
| 失敗記事の追跡 | しない。Ingest Failure の一時的失敗は次の同期で自己回復（Q6）→ **ADR-0017 で一部改訂**: 自己回復（次 run で再取り込み）は残るが、「run を止めない」は廃止され、保存失敗は同期中断になった |
| 確定手順 | §4 のログ修正を先行実装・デプロイし、cause で原因確定（Q9） |
| 用語 | 「Ingest Failure（記事取り込み失敗）」を CONTEXT.md に追加（Q10） |

## 6. 検証手順（デプロイ後）

1. 次回 cron（30分間隔）のログで、INSERT 失敗時に **cause のエラー文**が記録されていることを確認。
2. エラー文のパターンで判定:
   - `Exceeded maximum DB size.` → **H-A 確定**（DB 単位の保存上限）→ §8 の未決事項へ
   - `maximum account storage limit` → アカウント合計の上限（複数 DB 合計の確認）
   - `daily row read/write limit` 系 → H-B 確定（使用量削減 or プラン確認）
   - `UNIQUE constraint failed: articles.url` → H-C（頻度も確認。多発するなら冪等化を再評価）
3. 補助的な判別症状: **9/7 以降、アプリに新着記事が一切増えていない**なら全書き込み失敗
   （H-A/H-B 系）。一部の記事だけ欠けているなら H-C 系。

## 7. 解決記録（2026-09-08）

PR #396 デプロイ直後の本番ログで cause が取得でき、原因は **H-D（マイグレーション未適用）** と確定した:

```
error: "table articles has no column named content_backfill_failures: SQLITE_ERROR"
```

- **経緯**: ADR-0015（#394、2026-09-06 マージ・デプロイ）のコードは新列 2 本を参照するが、それらを追加するマイグレーション 0007（2026-09-05 21:08 UTC 生成）を本番 D1 に適用していなかった。コードだけ先に行き、スキーマが取り残される「スキーマ乖離」。
- **時間軸の整合**: 失敗開始（2026-09-07 03:45 JST）= #394 デプロイ後最初の新着記事取り込み。以後全 INSERT が決定的に失敗（F11 の「新着ゼロ」もこれで説明）。
- **赤鯡だったもの**: ストレージ 500MB 超（実在するが本件と無関係）、Workers Paid / platform のプラン判定、D1 日次上限（F3 は 9/1 施行の事実だが本件とは無関係）。500MB は偶然 9/6〜7 頃に目に入ったために強く見えた。
- **修正**: 本番 D1 へ `npx wrangler d1 migrations apply rss-reader --remote` を実行（デプロイと同じ wrangler 認証・アカウントで。`migrations apply` は適用台帳を見て未適用分だけ当てるため安全）。
- **検証**: 適用後の cron で info「同期が完了しました。」に `synced > 0` が付き、新着が増えること。以後 INSERT 失敗 warn は出ないはず（出たら H-C の個別競合か新しい問題）。


## 8. 未決事項（2026-09-08 時点）

- **リメディエーション**: H-A は否定。ただしストレージ 500MB 超は実在するため、旧記事の保持ポリシーは別途検討。
- **INSERT 冪等化の再評価**: 本件の大量失敗は H-D が原因であり、H-C（UNIQUE 競合）の証拠は出ていない。現状の info 格下げで十分と考えられるが、競合 info が頻出するようなら再評価する。
- **サブスク状態確認**: 本件との因果が消えたため優先度を下げる（Workers Paid の実効状態は、次回の上限関連事象まで確認しない）。
- **再発防止**: デプロイフローに D1 マイグレーション適用（または適用済み検証）を組み込む → 未着手（issue 化候補）。
- **AI fail-fast の再検討**: 解決済み（2026-09-08）。ADR-0017 で fail-fast 維持（縮退運転は却下）を決定し、代わりに記事保存の失敗を同期中断の対象に追加した。検知は `同期を中断しました。`（error 1 行）で行う。実装: `issues/issue-202609080602-ai-fail-fast-continuous-failure.md`。
