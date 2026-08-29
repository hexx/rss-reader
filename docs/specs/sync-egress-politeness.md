# 仕様：外部取得の律速（同期の 429 を「影響ゼロ」にする）

決定の根拠は [ADR-0009](../adr/0009-unified-egress-governor-with-d1-fetch-buckets.md)（律速層と取得枠）、[ADR-0010](../adr/0010-capped-backfill-with-cursor.md)（補完の定量とカーソル）、[ADR-0011](../adr/0011-honest-reader-user-agent.md)（リーダ UA）。用語は [`CONTEXT.md`](../../CONTEXT.md) が権威。

## 1. 目標と非目標

**目標**
- 429 によって Source の新着が取りこぼされないこと。一時同期障害は同じ run 内または次回同期で自己回復する。
- 新着の許容取り込み遅延（Freshness Budget）は通常 ±10 分、律速時は最大 90 分。
- 補完完走ウィンドウ ≤ 24 時間。
- warn ログは「障害」ではなく「対応済みで、いつ再試行するか」が読める行になる。

**非目標**
- 429 レスポンスを物理的に 0 件にすること（相手の判断であり、Cloudflare 共有エグレス IP 起因の可能性が高い制御外要素）。
- cron 間隔の変更、条件付き GET による総量削減、専用エグレス IP／外部プロキシ／Workers 外実行（ADR-0009 に WONTFIX 記録）。
- 手動同期の完了通知（ポーリング / SSE）。ADR-0002 の「別問題」判断を維持。

## 2. 構成

```
全 egress（フィード取得 / 記事本文 / はてブ jsonlite）
        ↓
   律速層（src/services/egress.ts に集約）
   · 取得枠の予約（CAS） · 間隔とジッター · Retry-After 服従 · クールダウン
        ↓
   D1: fetch_buckets（1 行 = 1 取得枠）
```

- `src/services/hatena.ts` の専用リミッター（`acquireRequestSlot` / `applyRetryAfter` / exponential backoff）と `src/test-utils/hatena-rate-limiter.ts` は**律速層へ移設して退役**。テスト用の DI は `src/test-utils/egress.ts`（仮想時計・メモリ枠）に集約した。
- 取得枠のキー解決: `hatena.ne.jp` / `b.hatena.ne.jp` / `*.hatenablog.com` / `*.hatenadiary.jp` → `hatena`（Operator Group、コード内設定）。それ以外は eTLD+1。`src/worker.ts` の表示用判定 `isHatenaSource()` は範囲が違う別概念なので `isHatenaBookmarkHost()` へ改名する（CONTEXT.md の Bookmark Host 参照）。

## 3. 同期進行（二段同期）

### パス1 — 全 Source のフィード取得（最優先）
1. `subscriptions` を siteUrl 昇順で読む（従来どおり）。
2. Source ごとに取得枠を CAS 予約（`cooldown_until <= now AND next_allowed_at <= now` を取れた実行だけが進む）。取れない Source は**待機せず後回し列**へ。
3. 予約取れた Source のフィードを取得。パースした記事一覧はメモリに保持し、この段階では DB に記事を書かない。
4. 一時同期障害（429 / 503 / タイムアウト / HTML 応答）→ 枠にクールダウンを設定し、後回し列へ。
5. **パス1末尾**：後回し列を 1 周する。枠が開していれば再試行（**待機はしない**）、まだ 429 なら次 run 持ち越し（クールダウン済み）。
6. 最終的に取得できなかった Source は info でスキップ理由と次回取得可能時刻を出して進む（他の Source に影響を波及させない）。

### パス2 — 記事処理（本文・ブックマーク・要約）
- パス1で取得できたフィードの記事一覧を順に処理する。
  - **新着記事**：本文取得（403/451 時はブラウザ UA で 1 回だけ退避再取得）＋ jsonlite 取得 ＋ AI 要約 → 保存。**新着のブックマーク取得は補完上限の対象外**（必ず取得する）。
  - **既存記事**：はてブ補完の対象。**1 run 合計 60 件**まで。巡回は「カーソル起点の Source ラウンドロビン」で、各 Source のカーソルを処理位置まで進め、末尾に達した Source は 0 に折り返す。
  - 補完の途中で**枠がクールダウン中**と分かったら、その Source の巡回を打ち切る（同じ枠は当時空かないため）。カーソルは進んだ分だけ保存するので、次のフル同期から残りを拾える。
- AI 生成エラーは従来どおり同期全体を停止する（ADR-0008）。律速・クールダウンは全体を止めない。
- 排他ロックは導入しない（ADR-0002 維持）。競合は UNIQUE 制約の冪等性（ADR-0003）と CAS 予約で吸収する。

## 4. 数値既定値（コード内定数を 1 モジュールに集約、env 化しない）

| 項目 | 値 |
| --- | --- |
| 既定の枠内最小間隔 | 1 秒 ＋ジッター（1〜2 秒） |
| はてな群の枠内最小間隔 | 3 秒 ＋ジッター（3〜6 秒） |
| クールダウン段階 | 30 分 → 60 分 → 90 分（cap） |
| `Retry-After` | 秒数・HTTP date とも尊重。90 分超も従い warn を 1 本 |
| はてブ補完 | 60 件 / run（カーソルで巡回） |
| Hatena Summary の AI バックフィル | 20 件 / run（従来どおり・別枠） |
| 本文取得の UA 退避 | 403 / 451 のとき 1 回（記事ごと） |
| タイムアウト | フィード 10 秒 / 本文 15 秒 / jsonlite 15 秒（変更なし） |
| User-Agent | `rss-reader/1.0 (+https://github.com/hexx/rss-reader)` |

## 5. データモデル

```sql
-- drizzle/0005_*: ADR-0009 / ADR-0010
CREATE TABLE fetch_buckets (
  bucket TEXT PRIMARY KEY,                   -- 'hatena', 'qiita.com', ...
  consecutive_throttles INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER NOT NULL DEFAULT 0, -- epoch ms（force はここだけ無視）
  next_allowed_at INTEGER NOT NULL DEFAULT 0 -- epoch ms（礼儀の間隔）
);
ALTER TABLE subscriptions ADD backfill_cursor INTEGER NOT NULL DEFAULT 0;
```

- 枠の行は初回利用時に lazily 作成（`INSERT ... ON CONFLICT DO NOTHING` → CAS 予約）。実装は `createD1BucketStore`（本番）/ `createMemoryBucketStore`（テスト）。
- `fetch_buckets` は律速状態だけを持つ。**Source 側に置く進行状態は `backfill_cursor` のみ**（律速状態は取得枠が持つ、という区別を壊さない）。
- 本番反映は既存手順（`npx wrangler d1 migrations apply` → `wrangler deploy`）。

## 6. API

- `POST /api/sync` — クールダウンを**遵守**（クールダウン中の Source はスキップして他の Source を同期）。
- `POST /api/sync?force=true` — **クールダウンだけを無視**して取得する。枠内の最小間隔は遵守（force は礼儀の放棄ではない）。引数は API のみで UI には露出しない。新規 Source はクールダウン履歴が無い＝即取得（購読直後の初回取り込み経路は従来どおり）。
- レスポンスは現状の `202 Accepted` のまま（完了通知は今回対象外）。

## 7. ログ仕様

| 事象 | レベル | 必須フィールド |
| --- | --- | --- |
| `Source 同期を開始します。` / `Source のフィードを取得しました。`（「購読サイト」は使わない） | info | `siteUrl` |
| クールダウン中または枠が空かず、取得を見送る | info | `bucket`, `nextAllowedAt`, `siteUrl` |
| パス1末尾の再試行でも未取得だった Source の持ち越し | info | `carried`, `siteUrls` |
| 一時同期障害（429 / 503 / タイムアウト / HTML 応答） | warn | `siteUrl` or `articleUrl`, `error`, `bucket`, **`nextRetryAt`** |
| クールダウンを理由に見送った記事処理（補完打ち切り・コメントなし保存） | info | `bucket`, `nextRetryAt`（**warn を乱発しない**） |
| run 完了サマリ | info | `elapsedMs`, `skipped`, `sources`, `synced`, `throttled` |

## 8. 受入条件（テスト観測点）

1. はてな群の 4 フィードが**1 取得枠**として間隔（3〜6 秒）を守って取得される（`egress.test.ts` / `hatena.test.ts`）。
2. 429 → パス1末尾で再試行 → 成功し、その Source の新着が同じ run 内に取り込まれる。
3. 429 継続 → クールダウンが D1 に永続化され、次の run では info スキップ（warn 乱発なし）。他 Source の同期は正常完了。
4. 補完 60 件上限とカーソルの折り返し（1 run 60 件、次回はその次から、末尾で 0）。
5. jsonlite の既存制約（1 本刻み・200 でも HTML 応答は障害扱い・不正 JSON の扱い）が移設後も壊れない。
6. 本文取得が 403 を返した記事だけブラウザ UA で再取得され、1 回で済む（保存は成功）。
7. 同一 isolate をまたいだ状態は D1 が権威（メモリ側リミッターに依存したテストにしない）。

## 9. リスク

- **主因の推定は未検証**：「jsonlite ストームが共有 IP の quota を枯らし RSS 429 を誘発している」という仮説は、本番ログ観察での成否判定を受入条件に含めないため今回の実測で確かめない。実装後もはてな系 429 が残る場合は、(1) 同一 IP の他テナント起因（我々の礼儀では解決不能）、(2) 記事本文取得が群を跨いで集中している、(3) 間隔・クールダウンの値が甘い、の順で疑うこと。
- リーダ UA を嫌う相手では 403 退避が毎回発火する（コストは本文 1 回分の再取得）。
- 枠間隔の厳格化はフル同期の所要時間を増やす（60 件 × 平均 4.5 秒 ≒ 4.5 分の待機）。wall 15 分（ADR-0002）内に収まる計算だが、新着バースト時は中断→次回再開に頼る。
