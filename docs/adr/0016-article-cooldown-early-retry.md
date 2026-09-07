# 新着記事が取得枠のクールダウンに当たった場合は空保存＋次フル同期で早期再試行する

2026-09-07 の Workers Logs で、`gigazine.net` 枠のクールダウン中に新着記事の本文取得が `EgressUnavailableError(cooldown)` で失敗し、warn「本文の取得に失敗したため、本文なしで処理を継続します。」が出た。原因は恒久欠損ではなく一時障害（当該枠で直前に `markThrottled` が起きていた）なのに、現行は他原因の欠損と同じ扱いだった:

- `ingestNewArticle` は一律 warn＋空保存（`content=''`・`summary NULL`・`content_backfill_at=now`）し、本文補完（ADR-0014）の 24h 間隔待ちになる。
- クールダウン（30〜90分）に対して 24h 待ちは過剰で、Freshness Budget（律速時最大90分）とも不整合。
- はてブ側のクールダウン時が info 扱いなのに対し、本文側だけ warn で非対称（`sync-egress-politeness.md` §7 と不整合）。
- `fetchArticleContent` の Jina Fallback は 403/451・`DirectFetchError` のみ対象で、クールダウン中は退避しない（by design）。

## 決定

- **新着取り込みでクールダウン（`EgressUnavailableError` の `reason==='cooldown'`）に当たった記事は、空保存は維持するが早期再試行可能にする**（Q4=C）。保存せず次 run 持ち越し（記事版 Carry-over）は、hotentry のように回転の速いフィードで掲載落ち→恒久ロストになるため採らない。記事の存在・はてブ・未読は失わない。
- **識別は `content_backfill_at` を NULL のまま残す**（Q7=A）。枠に触れていないので「試行していない」の意味付けで、新カラムは設けない（YAGNI）。既存の補完抽出（`NULL OR < now-24h`）で次フル同期にそのまま拾われる。`content_backfill_failures` は 0 のまま（ADR-0015「枠待ちは失敗数に数えない」と整合）。
- **再試行は次フル同期（`0 */3`、最大3h後）のみ**（Q8=A）。取り込み専用 cron（15,45）では補完しない（ingest 軽量維持）。Freshness 律速時90分は超えるが、ADR-0014 の「Backfill は Freshness 対象外」に本件の例外規定として明記して許容する。予算 `contentBackfillBudgetPerRun=6` は共有のまま（観察後に調整）。
- **同一 run 内の二重取得を防ぐため、補完対象から今 run で作られた行を除外する**（`content_backfill_at IS NULL AND created_at < run 開始時刻`）。ADR-0014 の「取り込み時も試行として記録する」はクールダウン起因に限って外すが、除外条件で同一 run の再取得は起きない。次 run では `created_at` が過去になるため拾われる。
- **本文補完（パス3）でクールダウンに当たった場合も失敗数に数えず、試行時刻を進めない**。現行の「試行を先に記録（`content_backfill_at=now`）してから取得」は、クールダウン打ち切り時に 24h 待ちを作ってしまうため、クールダウン時は NULL に戻す（または進めない）。
- **クールダウン起因の本文見送りは warn ではなく info**（Q6=B）。はてブ側・Give-up（ADR-0015）の info と対称にする。`bucket`・`nextRetryAt`・`articleUrl`・`siteUrl`・`title` を残し、run サマリに `contentCooldownDeferred` 件数を追加する。
- **クールダウン中の Jina 退避はしない**（Q5=A、現行維持）。Jina 経由でも origin への負荷は残るため、Q3 の礼儀（ADR-0009）を Jina 経由で迂回することになる。`jina-fallback.md` §2「429・5xx は退避しない」と同列に再掲する。
- 対象は全 Fetch Bucket 共通（Q2）。`gigazine.net` は初発例。礼儀値（間隔・クールダウン段階）は変えない（Q3）。

## Considered Options

- **保存せず次 run 持ち越し**: 行を作らない分クリーンだが、フィード落ちで拾えなくなる。フィード掲載順に依存しない試行時刻方式（ADR-0014）の利点を捨てるため不採用。
- **原因列の新設（`content_backfill_reason` 等）**: 観測性は上がるがマイグレ＋分岐が増える。NULL/時刻だけで次フル同期の扱いが同じになるため YAGNI。必要になったら足す。
- **取り込み専用 cron でも小予算で補完**: 90分に近づくが ingest run が重くなる。頻度が上がったら昇格する余地として残す。
- **クールダウン中も Jina へ**: 回復は速いが礼儀の迂回になる。原因別（429 起因 vs タイムアウト起因）で分けると bucket に原因保持が必要で複雑化するため見送り。
- **warn 維持**: 「次に何もできない失敗」のみ warn に絞る方針（§7）に反するため不採用。

## Consequences

- クールダウン起因の欠損は最大3hで回復する（現行最大24hから短縮）。恒久欠損（natalie・削除済み等）の 24h 間隔・Give-up 5 回は変わらない。
- `content_backfill_at IS NULL` が「真の未試行」と「クールダウン見送り」の両方を含むようになる。両方とも次フル同期で即対象なので運用上の区別は不要。区別が必要になったら原因列を足す。
- パス3 でクールダウン打ち切りが起きた run は、試行時刻を進めないため次フル同期で同じ記事を再試行する（最大3hポーリング）。枠が回復すれば1回で抜ける。
- ログは `sync-egress-politeness.md` §7・`jina-fallback.md` §6 に反映し、run サマリで効果測定できる。
- マイグレーションなし。変更は `src/workflows/sync.ts` の3分岐（ingest 保存時・ingest ログ・パス3 打ち切り時）＋サマリ計数。
