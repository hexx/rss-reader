---
title: "欠損本文（Content Gap）の Backfill 導入と本文取得失敗の根本原因特定"
status: TODO
created: 2026-09-01T04:58:15+09:00
---

# 欠損本文（Content Gap）の Backfill 導入と本文取得失敗の根本原因特定

## 背景・前提条件 (Context)

### 期待される挙動 vs 実際の挙動
- **期待**: 記事本文は保存時に取得され、取得できなかった場合も後日の補完巡回で回復する（はてブとはてブ要約と同じ対称性）。
- **実際**: 本文は**取り込み時に 1 回だけ**取得され、失敗すると `content = ''` で恒久的に保存される。はてブとはてブ要約は Backfill（ADR-0010）で回復するが、**本文と記事要約は回復しない**。2026-09-01 に「空本文時の要約スキップ」（CONTEXT.md の Article Summary）が適用されたため、`summary IS NULL` の行が「本文が回復したら要約も生成すべき対象」になる。

### 規模（本番 D1 の遡及解析、2026-08-31 時点の実測）

判定は docs/specs/content-gap-audit.md の 3 値（欠損 = content が NULL/空、疑い = 200 文字未満、正常）。

| 記事ドメイン | 欠損 | 疑い | 正常 | 合計 |
| --- | --- | --- | --- | --- |
| yomiuri.co.jp | 209 | 0 | 2 | 211 |
| news.yahoo.co.jp | 128 | 0 | 201 | 329 |
| youtube.com | 90 | 20 | 0 | 110 |
| techno-edge.net | 78 | 0 | 0 | 78 |
| mainichi.jp | 77 | 0 | 120 | 197 |
| natalie.mu | 36 | 0 | 26 | 62 |
| ynjn.jp | 25 | 0 | 0 | 25 |
| nicovideo.jp | 15 | 0 | 0 | 15 |
| pc.watch.impress.co.jp | 14 | 0 | 381 | 395 |
| news.livedoor.com | 11 | 0 | 16 | 27 |
| piyolog.hatenadiary.jp | 9 | 0 | 25 | 34 |

読み: 「疑い」がほぼ存在せず成否が二極化している → 抽出ロジック（セレクタ）ではなく取得段の問題の可能性が高い。youtube.com / nicovideo.jp は動画サイトで静的 HTML に本文が存在しない可能性が高く、Backfill の対象範囲から除外する判断が必要（ADR で記録）。

### 具体例（1 記事の実測、2026-08-31）

- 記事: `https://news.yahoo.co.jp/articles/a8e2cde771a3c3740c9c94de672b039162d54c07`（「包丁キャンセル」AERA DIGITAL、公開 2026-08-31 22:14 JST、取込 23:46 JST・92 分 = Freshness Budget 律速時上限 90 分をわずかに超過）
- D1 の状態: 本文字数 0・要約あり（空本文からタイトルベースの要約が生成されていた。要約はワンオフ SQL で NULL 化済みの想定 — docs/specs/content-gap-audit.md §6）
- 調査時点の実測（サンドボックス IP から。Workers のエグレス IP とは別物である点に注意）:
  - Jina Reader（`r.jina.ai`）経由 → **成功**、本文入り markdown（61.2KB）
  - 直接取得 → リーダ UA / ブラウザ UA とも **200 OK・164KB**（403/451 なし → Jina Fallback は発火しない）
  - cheerio 抽出（`article` セレクタ）→ **本文 1,584 文字**
- ⇒ 「今取り込めば正常」であり、取り込み時点の一時失敗が確定。**再取得すれば回復する**。

### エラーログ / スタックトレース

UNKNOWN — 本件の根本原因特定が本課題のステップ 0 であるため、ログを未取得のまま起票した。検索対象のログ文言は「再現手順」に記載する。

### 再現手順（診断クエリとログ突合）

1. 診断クエリは docs/specs/content-gap-audit.md が権威。主に使うもの:
   - 期間フィルタ付き全体集計: `datetime(created_at / 1000, 'unixepoch', '+09:00') >= '2026-08-31 00:00:00'`
   - 取込枠別（cron run 単位 = 15 分丸め）: `datetime((created_at / 1000) - (created_at / 1000) % 900, 'unixepoch', '+09:00') AS 取込枠`
   - 実行: `npx wrangler d1 execute rss-reader --remote -y --command "<SQL>"`
2. Workers Logs（Cloudflare ダッシュボード）で次を検索:
   - warn「本文の取得に失敗したため、本文なしで処理を継続します。」→ `error` 値の分布
   - info「Jina Fallback で本文を取得します。」→ 発火の有無（403/451 がないと出ない）
3. 未認証環境では `npx wrangler login` を先に実行すること。

### 環境情報
- Cloudflare Workers + D1（`compatibility_date 2024-09-23`、wrangler 4.107.0 で動作確認済み）
- 本番データ: `npx wrangler d1 execute rss-reader --remote`（要 wrangler 認証）
- テスト: `npm test`（vitest）、lint: `npm run lint`（oxlint）

### 関連ファイル / コード

- `src/workflows/sync.ts`（ingestNewArticle — 本文は 1 回だけ取得し、失敗時は空で保存する箇所）:
```ts
    const [contentResult, bookmarksResult] = await Promise.allSettled([
      fetchArticleContent(egress, article.url, { jinaApiKey: env.JINA_API_KEY }),
      fetchHatenaBookmarks(egress, article.url),
    ]);
    ...
    const content = contentResult.status === 'fulfilled' ? contentResult.value : '';
```
- `src/services/scraper.ts`（fetchArticleContent — Jina Fallback の発火条件は 403/451 のみ。ADR-0012 / jina-fallback.md §2。ボディ 2MB 超過・タイムアウトでは退避しない）
- `src/services/egress.ts`（`maximumSlotWaitMs` 60 秒、既定枠内間隔 1〜2 秒、クールダウン 30→60→90 分）
- `docs/specs/content-gap-audit.md`（診断クエリの権威）、`docs/specs/jina-fallback.md`、`docs/specs/sync-egress-politeness.md`、`docs/adr/0009` `0010` `0012`
- 用語の権威: `CONTEXT.md`（Content Gap / Backfill（はてブ補完）/ Backfill Cursor / Freshness Budget / Article Summary）

### 試したが駄目だったこと
- なし（本文の再取得機構は現状存在しない）

## 解決すべきゴール (Goal)

### ステップ 0: 根本原因の特定（設計の前に必須）

- [ ] Workers Logs で warn「本文の取得に失敗したため、本文なしで処理を継続します。」を検索し、`error` 値を原因区分する:
  - `exceeded the size limit` = ボディ 2MB 超過
  - `Fetch timed out` = タイムアウト
  - 429 / クールダウン文言 = 律速
  - `403` / `451` = 拒否（この場合、info「Jina Fallback で本文を取得します。」の有無も確認する）
- [ ] `npx wrangler secret list` で `JINA_API_KEY` の設定有無を確認する（未設定ならキーなし無料枠の IP 単位制限が仮説を補強する）
- [ ] 特定した原因を本ファイル末尾の「## 解決記録」に記録する

### ステップ 1: 設計と ADR

- [ ] 用語案「**本文補完（Content Backfill）**」を ADR で確定し、CONTEXT.md に追加する（既存の Backfill（はてブ補完）との対比: 対象が本文 + 記事要約である点を明記する）
- [ ] 設計論点を ADR で決定する:
  - Backfill Cursor の拡張方法（hatena 用 `subscriptions.backfillCursor` とどう共存するか）
  - 対象範囲（全期間の欠損 or 直近 N 日。恒久欠損サイトの扱い）
  - 1 run の定量（ADR-0010 の 60 件枠との関係）
  - **要約の事後生成**（`summary IS NULL` かつ本文回復後に `generateArticleSummary` を実行）
  - Freshness Budget（許容取り込み遅延）は対象外であることの明記（Backfill は既存記事の回復であり、新着の鮮度ではない）
- [ ] `docs/adr/` に ADR を作成する（ADR-0009/0010 の形式に従う）

### ステップ 2: 実装

- [ ] 本文の Backfill を補完巡回に追加する（上記 ADR の範囲に従う）
- [ ] 回復した記事の `summary IS NULL` を埋める（要約の事後生成）
- [ ] 恒久欠損サイト（動画サイト等、ADR で除外判定したもの）は無限リトライしない

### 完了条件（検証方法）
- `npm test` が緑になること
- `npm run lint`（oxlint）がエラーなしであること
- docs/specs/content-gap-audit.md のクエリで、Backfill 実行後の欠損件数が減少していることを確認できること
- 本課題の「## 解決記録」に根本原因と ADR 番号が記録されていること

## 補足
- 2026-09-01 実施の「空本文時の要約スキップ」により、以後の新着は空本文でも `summary = NULL` で保存される。本課題の Backfill 実装時に `summary IS NULL` を拾えば、過去のスキップ分も一括で回復できる。
- ADR-0012（Jina Fallback）の退避事実は DB に保存されない（jina-fallback.md §2）。遡及では「どの段階で取れたか」を判別できないため、原因特定はログに頼る。
