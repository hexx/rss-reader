# 回復不能と判定した記事の本文補完を断念する（Give-up）

Content Backfill（ADR-0014）は 24 時間間隔で無期限に再試行する設計だった。しかし 2026-09-01〜02 の実測（[issues/issue-202609010458-content-backfill.md](../../issues/issue-202609010458-content-backfill.md) 追記 5〜8、Workers Logs の計装）で、**恒久的に回復しない欠損**が存在することが確定した:

- **削除済み記事**（404/410）: 配信ミス以外は回復しない。Workers Logs で繰り返される 404 が観測されている
- **CAPTCHA 型**（natalie）: 誰にも取得不可
- **リダイレクトループ・タイムアウトが恒久的なサイト**: ADR-0013 で Jina に退避するようになったが、Jina でも失敗し続ける場合がある

無限再試行は、①ログのノイズ、②タイムアウト時の `jina.ai` 枠クールダウン連鎖（他サイトへの巻き添え拒否）、③意図しない外部取得の継続を招く。

## 決定

- **404/410（記事が存在しない応答）は即座に断念**する（`content_backfill_failures` を上限値に、`content_backfill_gave_up_at` を記録）。
- **その他の失敗は 5 回連続で断念**する（`CONTENT_BACKFILL_GIVE_UP_THRESHOLD = 5`）。
- 断念した記事（Give-up、`content_backfill_gave_up_at IS NOT NULL`）は**巡回対象から除外**される。
- 断念は warn ではなく **info** で記録する（正常な意思決定であり、障害ではない）。
- **枠待ち（EgressUnavailableError）は失敗回数にカウントしない** — 記事の問題ではなく枠の問題であり、はてブ補完と同じ「譲る」領域。
- 復活は手動で行う: `content_backfill_failures = 0` + `content_backfill_gave_up_at = NULL`（手順は [content-gap-audit.md §7](../specs/content-gap-audit.md)）。

## Considered Options

- **404/410 も 5 回の猶予を置く**: 配信ミスで後日復活するケースを救えるが、その頻度は低く、4 日分の無駄打ちが残る。復活は手動で足りる。
- **試行間隔の指数退避のみ（断念しない）**: 恒久欠損（natalie の CAPTCHA 等）を永遠に抱え続ける。
- **サイト単位の除外リスト（ADR-0014 で検討済み）**: サイト全体が悪いケースには効くが、記事単位の削除（404）には効かない。記事単位の断念で置き換える。
- **UI での再試行ボタン**: 誤判定は稀。SQL 1 行で足りる（YAGNI）。

## Consequences

- 削除済み・恒久欠損記事のログノイズと無駄打ちが消える。
- 断念記事は「本文が空・要約なし」のまま表示される（空本文時要約スキップにより要約汚染はない）。
- 404 でも後日復活する記事は、手動復活まで回収されない。
- マイグレーション: `articles` に `content_backfill_failures`・`content_backfill_gave_up_at` を追加（0007）。
