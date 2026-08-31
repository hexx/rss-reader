# 仕様：本文欠損（Content Gap）の遡及調査

用語の権威は [`CONTEXT.md`](../../CONTEXT.md)（**Content Gap（本文欠損）** / **Domain Filter（調査対象ドメイン）**）。関連仕様: [jina-fallback.md](./jina-fallback.md)（本文の退避チェーン）。

本ドキュメントはコード・DB スキーマを変更しない手動の診断手順であり、判定基準と調査クエリの権威である。

## 1. 目的と非目標

**目的**
- 特定サイトの要約が「短い・変な・ナビの内容っぽい」と疑われるとき、D1 に保存済みの本文を遡及解析して Content Gap を URL / ドメイン単位で特定できるようにする。
- 判定は実行時の導出値とし、スキーマ変更・API 実装を伴わない。

**非目標**
- 本文の再取得・修復（調査は報告のみ。対処＝セレクタ調整や再取得は人が続けて行う）。
- 取得経路（Jina Fallback / `<body>` フォールバック）の判別。取得エラー理由の判別。
- 判定結果の永続化・常設監視。

## 2. 判定基準

`articles.content` に対し、次の 3 値に分類する。

| 分類 | 定義 | SQL 条件 |
| --- | --- | --- |
| 欠損 | 本文が空。同期は取得失敗時に空文字で保存するため、「取得できていない」の確定値 | `content IS NULL OR content = ''` |
| 疑い | 本文が短く、正常本文でない疑いがある | `LENGTH(content) < 200` |
| 正常 | 欠損・疑いのいずれでもない | — |

- `LENGTH()` はバイト数ではなく**文字数**（UTF-8 のコードポイント数）を返す。日本語本文に対する閾値 200 文字は「要約生成の入力として明らかに不足」の目安。
- **疑いは断定ではない。** 速報系の短い記事・コラムの見出し only ページなどは誤検知になりうる。「疑い」は目視確認のトリガーとして使う（§4.4）。

## 3. Domain Filter の書き方

- 記事の絞り込みは **`site_url`（所属 Source のドメイン）と `url`（記事 URL）の両方に対する OR 条件**とする。フィードに第三者配信 URL が混ざってホストがずれていても拾えるようにするため。
- 一致の範囲は**ホスト完全一致＋ `www.` 付き**。`example.com` 指定で `https://www.example.com/...` を含み、`blog.example.com` 等のサブドメイン・ポート番号付き・userinfo 付きは含まない。LIKE は ASCII の大小文字を同一視する。
- クエリ冒頭の CTE でドメインを 1 箇所だけ定義し、**書き換え箇所は `VALUES ('…')` の 1 行のみ**とする。

```sql
WITH domain(domain) AS (VALUES ('example.com'))  -- ← このドメインを書き換える
```

## 4. 調査手順

### 4.1 実行方法

```bash
npx wrangler d1 execute rss-reader --remote -y --command "
<以下のクエリを貼り付け>
"
```

- 実行前に `wrangler login` 済みであること。接続先は README の `d1 migrations apply rss-reader --remote` と同じ本番 D1。
- クエリはすべて SELECT のみで、書き込みは発生しない。
- 構文はローカル空 DB（`node:sqlite`）で検証済み。実データでの初回実行は、この手順自体のテストを兼ねる（詰まったら本ドキュメントを修正する）。

### 4.2 ① 全体サマリ — どのドメインが壊れているかの俯瞰

Source（`site_url`）別に分類数を一覧する。欠損＋疑いの多いドメインから疑う。

```bash
npx wrangler d1 execute rss-reader --remote -y --command "
WITH classified AS (
  SELECT
    site_url,
    CASE
      WHEN content IS NULL OR content = '' THEN '欠損'
      WHEN LENGTH(content) < 200 THEN '疑い'
      ELSE '正常'
    END AS 分類
  FROM articles
)
SELECT
  site_url,
  SUM(分類 = '欠損') AS 欠損,
  SUM(分類 = '疑い') AS 疑い,
  SUM(分類 = '正常') AS 正常,
  COUNT(*) AS 合計
FROM classified
GROUP BY site_url
ORDER BY SUM(分類 = '欠損') + SUM(分類 = '疑い') DESC, 合計 DESC;
"
```

### 4.3 ② Domain Filter 絞り込み — 対象ドメインの欠損・疑い一覧

ドメインを書き換えて実行する。欠損を先頭に、本文が短い順に並ぶ。

```bash
npx wrangler d1 execute rss-reader --remote -y --command "
WITH domain(domain) AS (VALUES ('example.com'))
SELECT
  a.url,
  a.title,
  CASE
    WHEN a.content IS NULL OR a.content = '' THEN '欠損'
    ELSE '疑い'
  END AS 分類,
  LENGTH(a.content) AS 本文字数,
  datetime(a.published_at / 1000, 'unixepoch', '+09:00') AS 公開日時
FROM articles a, domain d
WHERE (  a.url LIKE '%://' || d.domain || '/%'
      OR a.url LIKE '%://' || d.domain
      OR a.url LIKE '%://www.' || d.domain || '/%'
      OR a.url LIKE '%://www.' || d.domain
      OR a.site_url LIKE '%://' || d.domain || '/%'
      OR a.site_url LIKE '%://' || d.domain
      OR a.site_url LIKE '%://www.' || d.domain || '/%'
      OR a.site_url LIKE '%://www.' || d.domain )
  AND (a.content IS NULL OR a.content = '' OR LENGTH(a.content) < 200)
ORDER BY (a.content IS NULL OR a.content = '') DESC, LENGTH(a.content);
"
```

#### 記事ドメイン別集計バリアント

②の一覧の前段として、欠損・疑いがどの記事ドメインに集中しているかを見る。**Article URL のホストごと**に分類を全部数える（正常も含め、母数に対する壊れ率を判断できるようにする）。`www.` ありなしは同一グループにまとめる（Domain Filter と同じ同一視）。

```bash
npx wrangler d1 execute rss-reader --remote -y --command "
WITH domain(domain) AS (VALUES ('example.com'))
SELECT
  CASE WHEN substr(host, 1, 4) = 'www.' THEN substr(host, 5) ELSE host END AS 記事ドメイン,
  SUM(content IS NULL OR content = '') AS 欠損,
  SUM(content IS NOT NULL AND content != '' AND LENGTH(content) < 200) AS 疑い,
  SUM(content IS NOT NULL AND content != '' AND LENGTH(content) >= 200) AS 正常,
  COUNT(*) AS 合計
FROM (
  SELECT
    content,
    substr(
      url,
      instr(url, '://') + 3,
      min(
        coalesce(nullif(instr(substr(url, instr(url, '://') + 3), '/'), 0), 999999),
        coalesce(nullif(instr(substr(url, instr(url, '://') + 3), '?'), 0), 999999)
      ) - 1
    ) AS host
  FROM articles
  CROSS JOIN domain d
  WHERE (  url LIKE '%://' || d.domain || '/%'
        OR url LIKE '%://' || d.domain
        OR url LIKE '%://www.' || d.domain || '/%'
        OR url LIKE '%://www.' || d.domain
        OR site_url LIKE '%://' || d.domain || '/%'
        OR site_url LIKE '%://' || d.domain
        OR site_url LIKE '%://www.' || d.domain || '/%'
        OR site_url LIKE '%://www.' || d.domain )
)
GROUP BY 記事ドメイン
ORDER BY 欠損 DESC, 疑い DESC;
"
```

- ホスト抽出は `://` の直後から最初の `/`（または `?`）まで。記事 URL は取り込み時に http(s) に限定されているため、常に抽出できる。
- Source が違っても Article URL のホストが同じなら 1 行にまとまる。例えば Domain Filter に `asahi.com` を指定すると、朝日新聞デジタルの記事と、朝日の記事を配信している Yahoo!ニュースの記事が同じ `asahi.com` 行に合算される。
- サブドメイン（`digital.asahi.com` 等）は `www.` と見なさないため別行になる。
- Domain Filter を使わず全体を俯瞰したいときは、`WITH domain` 行・`CROSS JOIN domain d`・`WHERE` の 8 条件を丸ごと削る。
- 欠損・疑いだけの件数で十分なときは、内側の `SELECT` に `AND (content IS NULL OR content = '' OR LENGTH(content) < 200)` を足し、`正常`・`合計` の列を `対象計` に置き換える。

### 4.4 ③ 記事別詳細 — 本文先頭を目視確認

②で拾った記事の `content` 先頭 200 文字を見て、疑いの中身を判別する。

- **ナビ・フッターの語彙が並ぶ** → `<body>` フォールバックでしか抽出できていない（ボイラープレート）。セレクタ調整の候補。
- **空っぽ・stub 的な断片** → JS 描画前提のページまたは取得時点で本文が無い。
- **短いが正常な本文** → 誤検知。判定基準（閾値）の見直し判断材料。

```bash
npx wrangler d1 execute rss-reader --remote -y --command "
WITH domain(domain) AS (VALUES ('example.com'))
SELECT
  a.url,
  a.title,
  LENGTH(a.content) AS 本文字数,
  substr(a.content, 1, 200) AS 本文先頭
FROM articles a, domain d
WHERE (  a.url LIKE '%://' || d.domain || '/%'
      OR a.url LIKE '%://' || d.domain
      OR a.url LIKE '%://www.' || d.domain || '/%'
      OR a.url LIKE '%://www.' || d.domain
      OR a.site_url LIKE '%://' || d.domain || '/%'
      OR a.site_url LIKE '%://' || d.domain
      OR a.site_url LIKE '%://www.' || d.domain || '/%'
      OR a.site_url LIKE '%://www.' || d.domain )
  AND (a.content IS NULL OR a.content = '' OR LENGTH(a.content) < 200)
ORDER BY LENGTH(a.content);
"
```

## 5. 制限事項

- **取得経路は判定できない。** Jina Fallback・`<body>` フォールバックの事実は DB に保存しない（[jina-fallback.md](./jina-fallback.md) §2「退避の事実は保存しない」と整合）。「ボイラープレート疑い」の判別は §4.4 の目視で補う。
- **取得エラーの理由は判らない。** 403/451・タイムアウト・ボディ超過などの理由はログにしか存在せず、D1 からは「空本文だった」ことしかわからない。§4.4 の目視と、必要なら Worker ログとの突き合わせで原因に近づく。
- **① は `site_url` 別の集計である。** 記事 `url` のホストが Source とずれる記事は、Source 側のドメインに計上される。ホストずれそのものを見たい場合は ② の `url` 条件で拾う。
- **Domain Filter はポート番号付き・userinfo 付き URL を拾えない。** そのような URL が疑わしいときは `LIKE` パターンを個別に足す。
- `content` は抽出済みテキストであり、抽出前の HTML 構造由来の判別は不可能。
- 判定は実行時の導出値で**永続化しない**。フラグ保存・API 化・常設監視に進むときは、判定基準をコードへ移し、その判断（閾値・分類・格納方法）を ADR に記録すること。
