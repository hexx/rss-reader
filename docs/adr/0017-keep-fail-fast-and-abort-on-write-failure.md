# 継続型 AI 障害でも fail-fast を維持し、記事保存の失敗も同期中断の対象にする

2026-09-07、OpenAI のクレジット残高がゼロになり、30 分ごとの cron run がすべて `AiGenerationError` で停止し続けた（運用対応は課金で解消）。この「継続型障害」の扱いを再検討した（[issue-202609080602-ai-fail-fast-continuous-failure.md](../../issues/issue-202609080602-ai-fail-fast-continuous-failure.md)）。縮退運転（要約なしで保存し続ける）を含む 3 案を比較した結果、**ADR-0008 の記事要約 fail-fast は維持**し、代わりに **D1 への保存失敗を同期中断（Sync Abort）に格上げ**した。

判断の根拠になった事実:

- **要約の回収経路が存在しない**。Content Backfill（ADR-0014）の対象抽出は `content IS NULL OR content = ''` のみで、「本文はあるが要約が NULL」の記事を後から要約化するパスは無い。よって縮退保存した瞬間に**記事要約は恒久欠損**になる（Hatena Summary は `hatena_summary IS NULL` が補完巡回の対象になっていて非対称）。fail-fast の存在意義は「要約を回収する手段が無い」ことに負荷されていた。
- **恒久障害と一時障害を安全に分類できない**。pi-ai は HTTP ステータスを構造化して返さず、`stopReason: 'error'` と `errorMessage` 文字列だけを返す。`insufficient_quota` を判別するには substring マッチに頼ることになり、誤分類の帰結は「要約なし記事の大量保存」＝ ADR-0008 が最も避けたかった分岐そのもの。
- **逆に、止まるべきでない時に緑で完了した障害が実在する**。同じ 2026-09-07 の新着停止障害（[ingest-failure.md §7](../specs/ingest-failure.md)）は D1 マイグレーション未適用による**全 INSERT 失敗**で、現行コードは保存失敗を記事単位で warn して継続するため、run は `同期が完了しました。` で完了し、本文取得と AI 生成のコストを払いつつ 1 件も保存できなかった（同 spec F9「AI コストを払って死ぬ」）。

## 決定

- **Article Summary（記事要約）生成失敗の fail-fast を維持する**。縮退運転（要約なしで保存し続ける）は採らない（R1-Q1=a）。
- **障害の恒久/一時で挙動を分けない**。分類語彙を新たに作らず、`AiGenerationError` は原因を問わず中断させる（R1-Q1=c 却下。恒久障害だけを縮退させる案は、誤分類の帰結が縮退案そのものより悪くなる）。
- **Article Summary（記事要約）の生成失敗のみを同期中断の対象に狭める**。Hatena Summary（はてブ要約）の生成失敗は warn として記事を保存し、未生成ぶんは既存のはてブ補完（Backfill）で回収する（R4-Q4=b）。理由は上記 1 番目の事実どおり、**Hatena Summary には NULL を拾う回収経路が既にあり、Article Summary にはない**から。縮退してよいのは「後から回収できるものだけ」という基準の一貫した適用であり、障害種別による分類は増やさない。
- **記事保存の失敗も Sync Abort の対象にする**。`UNIQUE constraint failed: articles.url`（ADR-0002 が受容した同時実行競合）だけが唯一の継続例外で、従来どおり info でスキップ（R2-Q1=i）。**対象は同期中のすべての D1 書き込み**（`articles` INSERT、`hatena_bookmarks` upsert、バックフィルの UPDATE、`subscriptions.backfill_cursor`、取得枠 `fetch_buckets` の予約・markThrottled）に広げる（R3-Q2=ii）。記事単位の例外リストや失敗追跡状態は持たない（R2-Q2=a、毒記事は受容）。実装上は取得失敗と同じ catch に混ざるため、書き込み箇所をラッパーで包んで**書き込み失敗を例外として区別する**（新しい例外クラスは要るが、新しい障害分類語彙は作らない）。
- **404/410 の記事は現状維持**（R3-Q1=a）: 空本文で行を作り、はてブが取れていれば同じ run で保存する（「404 でもはてブだけ取得」は現行の期待挙動として明記する）。次フル同期で ADR-0015 の即 Give-up に達するまでの 1 巡回分の再取得は許容し、Give-up 記事の一覧非表示（R3-Q1=d）は採らない。
- **run 開始前の AI 疎通確認（probe）は入れない**。設定不備は `validateAiConfiguration` が外部取得前に止めており、疎通不良は最初の生成失敗で止まる。probe は quota 系を実際に生成を試みる前に検出できない（R2-Q3=a）。
- **Content Backfill 内の Article Summary 生成失敗も中断する**（R3-Q4=a）。巡回がそこで死ぬが、要約なし保存の裏口を開かないことを優先する。
- **検知は Pull 型のログ 1 行**。`sync.ts` がカウンタと発生場所を持つ `同期を中断しました。` を **error** レベルで出し、cron ハンドラの catch は最終受け皿として残す（R2-Q4=a・R2-Q5=i）。フィールドは `trigger`（cron / api）、`mode`（full / ingest-only）、`reason`（`ai-generation` / `write` / `unknown`）、`stage`（`feed-fetch` / `ingest` / `bookmark-backfill` / `content-backfill`）、`error`（cause 実文）、`articleUrl` / `siteUrl`、進行カウンタ。設定不備（`AiConfigurationError`）は載せない（R3-Q3=y: cron catch 側の 1 行に任せる）。中断時は `同期が完了しました。` を出さない（両者排他、R4-Q2）。**warn は「相手都合の見送り」、error は「こちらが止めた」**に役割を分け、検知の起点を `level: error` 1 クエリに絞る（R5-Q1=a）。状態テーブル・UI 表示・外部アラートは作らない。
- **`POST /api/sync` の応答契約（202）は変えないが、ログは cron と同じ `toErrorMessage` 経由に統一する**（R4-Q3）。未修正だった API 経路を [ingest-failure.md §4](../specs/ingest-failure.md) の原則に寄せる。
- **UI の同期ボタンは完了を保証しない文言にする**（R4-Q1=b）。`同期を開始しました。完了後に再読み込みします。` は、run が数秒後に中断しても成功に見えるため、同期の開始と切り離す。
- **同期モードを切り替える運用スイッチを持たない**（環境変数・API パラメータいずれも）（R1-Q5）。

## Consequences

- AI 障害中・D1 保存不能中は**新着記事が一切増えない**。Freshness Budget（通常 ±10 分）はこの期間満たせない。これを用語側の射程外として明記し、設計上の期待挙動とする。本文が空で Article Summary を試みない記事（404 記事など）は、はてブがなく Hatena Summary も試みない場合に限り中断せず保存される。
- 障害中は取り込みが進まないため、**D1 ストレージの増大も止まる**。縮退運転と記事保持ポリシー（500MB 超の長期課題）のトレードオフは本決定では発生しない。
- 「その記事だけが原因で恒久的に保存できない」ケース（毒記事）が実在すれば、全 Source の新着取り込みが停止する。中断ログの `articleUrl` で人間が特定して対処する前提で受容する。データ起因の INSERT 失敗は [ingest-failure.md §2 F1/F2](../specs/ingest-failure.md) で否定済み。危害が実在したら記事単位の例外スキップを新設して改定する。
- 「保存失敗は次の同期で自己回復する」という旧合意は、**run を止めないという意味では廃止**。未保存記事は次の cron で再取り込み対象になるという自己回復の性質自体は残る。
- **障害時の AI コストは、D1 書き込みの失敗箇所まで進むぶんだけ残る**。同期中の全 D1 書き込みが中断対象になったため、D1 全体の書き込み不能はパス1先頭の取得枠予約（`INSERT INTO fetch_buckets`）で検知され、**AI 呼び出し 0 本・外部取得 0 本**で止まる。一方 `articles` 表固有の失敗（マイグレーション未適用など）は、INSERT が要約生成より後ろにあるため **run あたり高々 2 本**（Article Summary 1 ＋ 必要なら Hatena Summary 1）の無駄が残る。これは 30 分 cron で 48 run/日 = 96 本/日以下に有界であり、**この残りは許容する**（R6-Q1=a）。canary 書き込みでゼロにする案、順序を反転（write-then-summarize）して要約補完を新設する案は、代价が上回るとして却下した。
- Hatena Summary の生成失敗は run を止めないため、**「run は緑で完了したがはてブ要約が付いていない」期間が発生し得る**。回収は次回以降のフル同期（`0 */3`）に譲るので、この期間は最大で巡回待ちぶん遅れる。失敗 warn は乱発せず run 内で 1 本だけ出し、件数は完了サマリ `hatenaSummaryFailed` に出す（R5-Q1=a）。
- 本決定は ADR-0008 の**Hatena Summary を含めた fail-fast の射程を変更する**（記事要約の fail-fast と 202 応答契約は維持）。