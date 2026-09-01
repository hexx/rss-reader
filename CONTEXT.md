# RSS Reader

RSS フィードから記事を集め、日本語の要約を添えて配信・同期するリーダー。

## Language

**Source（購読ソース）**:
ユーザーが購読する RSS フィードの登録単位。記事の取得元。
_Avoid_: feed, provider, channel, 購読サイト（ログ文言として使われていたが Source と同一概念。律速の単位である取得枠とも別物）

**Source URL（Source の URL）**:
Source を一意に識別する URL。登録時に自動検出した RSS/Atom フィードの URL で、`subscriptions.site_url` として保存される。記事は取り込み時にこの値を `articles.site_url` として複製して持つ。サイトのトップページ URL とは限らない。
_Avoid_: サイト URL（トップページの URL と誤解される）

**Article URL（記事 URL）**:
記事そのもののページの URL。フィード item のリンク先を絶対化したもので、`articles.url`。第三者配信では Source URL とホストが異なることがある。
_Avoid_: site URL（Source URL と混同）, link（フィード要素名であり概念名ではない）

**AI Provider**:
要約を生成する OpenAI 互換エンドポイント。`AI_BASE_URL` で指し示す接続先のこと。RSS の Source とは全く別の概念。
_Avoid_: model, endpoint（模型本体と混同しやすい）

**AI Model（AIモデル）**:
AI Provider 上で要約生成に使う具体的なモデル。`AI_MODEL` で指定し、現在の標準設定は `gpt-5.6-luna` とする。
_Avoid_: AI Provider（接続先とモデル本体を混同しやすい）

**AI API Key（AI APIキー）**:
AI Provider への認証に使う秘匿値。アプリでは `AI_API_KEY` で渡し、プロバイダ固有の環境変数名には寄せない。
_Avoid_: OPENAI_API_KEY（接続先が OpenAI でも、アプリ内の設定名は共通の AI API Key とする）

**Article Summary（記事要約）**:
記事のタイトルと本文から生成する、全体要点の日本語要約（表示用 HTML スニペット）。本文が欠損（Content Gap）している記事では生成せず、`summary` を NULL のまま残す（本文が回復した際に生成する）。

**Bookmark（ブックマークコメント）**:
ある記事に対する、はてなブックマーク上の個々のユーザーの反応（コメント・ユーザー名・ブックマーク日時の組）。コメントが空（タグのみ等）のブックマークも含む概念。表示上はコメント非空のものだけ並ぶ。
_Avoid_: comment（要約と混同しやすい）, reaction

**Bookmark Timestamp（ブックマーク日時）**:
ユーザーがその記事をブックマークした日時（分精度）。はてな本体の「新着順」の根拠となる時系列キー。記事の取得時刻や要約の生成時刻とは無関係。
_Avoid_: createdAt（DB上の実装名であり、取得時刻と誤読しやすい）

**Hatena Summary（反応要約）**:
はてなブックマークのコメント群から生成する、世間の反応・意見の日本語要約（表示用 HTML スニペット）。コメント0件では生成しない。
_Avoid_: Reaction Summary

**Fallback（取得退避）**:
相手が直接の取得を拒否したときに、同一の対象を取得のしかたを替えて取り直すこと。1 段目は User-Agent の差し替え、2 段目が Jina Fallback。再試行（同じしかたでやり直す）とも Backfill（取りこぼしを巡回して埋める）とも違う。
_Avoid_: 再取得（Two-Pass Sync・Backfill と混同）, リトライ, プロキシ（仕組みの呼び方であって概念の名前ではない）

**Jina Fallback（Jina 退避）**:
Fallback の 2 段目。ブラウザ UA での取り直しでも取得できなかった本文を、Jina Reader 経由で取得すること。退避対象は「相手が応答を拒否した」（403/451）場合と「応答が完結しなかった」（タイムアウト・リダイレクトループ・ボディ超過）場合（ADR-0012・ADR-0013）。相手が Cloudflare 由来かどうかは条件に入れない（拒否の結果だけで判定する）。
_Avoid_: プロキシ取得, スクレイピング回避, Cloudflare 対策（原因の推定を条件に見せかける呼び方）

**Content Gap（本文欠損）**:
保存済み記事の本文が、要約生成に耐える品質を満たしていない状態。欠損（本文が空）・疑い（本文が短い等、正常本文でない疑い）・正常の 3 値で分類し、疑いは断定ではない。通信の成否とは別の、抽出品質の概念。
_Avoid_: 取得失敗（通信層の失敗と混同）, 空本文（3 値のうち欠損 1 値だけを指す語であり、全体概念ではない）

**Issue（課題プロンプト）**:
issue-logger スキルが `issues/issue-yyyyMMddHHmm.md` に生成する、後続の AI エージェントがそのまま実行できるプロンプト形式の課題ファイル。GitHub の Issue とは全く別の概念。フロントマターは `title` / `status` / `created` の 3 字段のみで、状態遷移の根拠は本文末尾の「## 解決記録」に記す（ADR 0005）。
_Avoid_: ticket, task, GitHub Issue

**Unread Count（未読数）**:
ある Source に属する未読記事の数。権威はサーバが持ち、クライアント側の表示は一時的にずれ得る楽観的な値。
_Avoid_: badge count, unread

**Total Unread Count（総未読数）**:
全 Source の Unread Count の合計。ヘッダーに表示される派生値であり、独立して保持しない。
_Avoid_: total, grand total

**Fetch Bucket（取得枠）**:
律速の間隔とクールダウンを共有する外部取得の単位。既定では登録可能ドメイン 1 個が 1 枠で、運用者群に属するドメインは群として 1 枠に束ねる。
_Avoid_: ホスト名単位, rate limiter（相手の機構と混同）, Source 単位（Source と取得枠は 1:1 ではない）

**Operator Group（運用者群）**:
別ドメインにまたがっても、同一の相手が同一の制限を課していると扱うホストの集まり。1 群が 1 取得枠になる（はてな群など）。
_Avoid_: はてな系（下の Bookmark Host と混同される）, サブドメイングループ

**Domain Filter（調査対象ドメイン）**:
Content Gap の調査で記事を絞り込むための緩いドメイン指定。ホスト一致に前方一致を組み合わせ、`example.com` 指定で `www.example.com` をも含む。律速の単位である Operator Group とは範囲も役割も別。
_Avoid_: ドメイン（単独ではあいまい）, Operator Group（律速の単位と混同）

**Bookmark Host（ブックマーク掲載元）**:
はてなブックマーク由来の Source の表示名を紛れ解消するために使う判定で、`b.hatena.ne.jp` のみを指す。律速のための運用者群よりも狭い、別概念。
_Avoid_: はてな系, isHatenaSource（範囲の違う 2 意味で使われていた旧名）

**Backfill（はてブ補完）**:
すでに保存済みの記事に対し、はてなブックマークのコメントとその要約を取りこぼし分だけ埋める進行。1 回の同期あたり定量をカーソルで巡回して行う。
_Avoid_: 再取得, 復旧, バックフィル（動詞的に「RSS 取得をやり直す」意味と混用されている）

**Backfill Cursor（補完カーソル）**:
ある Source のフィード掲載順に対し、次の Backfill をどの位置から始めるかを示す進行位置。末尾に達したら先頭に戻す。
_Avoid_: 次回取得時刻（クールダウンと混同）, offset（API のページングと混同）

**Throttle（律速）**:
相手が受け付けられる範囲に収まるよう、外部取得の間隔と本数をこちらから抑える振る舞い。相手から受ける制限（429 など）とは区別する。
_Avoid_: レート制限（相手の行為と混同しやすい）, throttle（動詞的に使われると「制限された」意味と混線する）

**Transient Sync Failure（一時同期障害）**:
相手の都合で今回の取得ができなかったが、将来は成功する見込みの同期失敗。同期全体を止めず、後続の同期で自動的に回復する。AI 生成エラー（同期全体を停止する）とは区別する。
_Avoid_: 同期失敗（AI エラーと混用している呼び名）, soft error

**Cooldown（クールダウン）**:
一時同期障害を受けた対象が、回復見込み時刻に達するまで自ら取得を試みない状態。
_Avoid_: 停止, 除外, ブロック（相手から受ける拒否と混同）

**Two-Pass Sync（二段同期）**:
1 回の同期進行において、律速で後回しになった対象を末尾にまとめて一度だけ再試行する進行方式。
_Avoid_: リトライキュー, 再試行（run 内再試行と次 run への持ち越しを混同しやすい）

**Carry-over（次回同期持ち越し）**:
枠が空かない等の理由でフィードを取得できなかった Source を、次の同期 run に譲ること。枠の空きは予約しないため次回可能時刻を持たず、次の cron run で再試行する。持ち越された Source の新着遅延は Freshness Budget の「律速時」に分類する。
_Avoid_: リトライ, 再試行（Two-Pass Sync の run 内再試行と混同）, スキップ（Cooldown による見送りと混同）

**Freshness Budget（許容取り込み遅延）**:
**新着記事**が公開されてから要約付きで表示されるまでに許容する遅延の合意。通常は現行カデンサ ±10 分、律速時は最大 90 分（枠が空かず Carry-over された場合を「律速時」に含む）。既存記事への Backfill の遅れは対象外。
_Avoid_: 鮮度（数値なしでは合意にならない語）

**Completeness Window（補完完走ウィンドウ）**:
全 Source の掲載中記事が Backfill を 1 周するまでの許容時間（24 時間以内）。新着の鮮度ではなく「取りこぼしが埋まる速さ」の約束であり、Freshness Budget とは対象が別。
_Avoid_: 鮮度, Freshness Budget（対象の違う_budget と混同）

**Issue Status（課題ステータス）**:
Issue の生命周期を表す 4 値。`TODO`=未着手で有効な要求、`IN_PROGRESS`=作業中、`DONE`=要求が満たされた（別 Issue 経由での達成を含む）、`WONTFIX`=対応しないと確定（価値喪失または前提の陳腐化による。要求は未達）。達成済みだが別 Issue で実現したものは DONE とし、SUPERSEDED のような 5 値目は設けない。
_Avoid_: SUPERSEDED, DUPLICATE（語彙を増やさず 4 値で表現する）
