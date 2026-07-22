# RSS Reader

RSS フィードから記事を集め、日本語の要約を添えて配信・同期するリーダー。

## Language

**Source（購読ソース）**:
ユーザーが購読する RSS フィードの登録単位。記事の取得元。
_Avoid_: feed, provider, channel

**AI Provider**:
要約を生成する OpenAI 互換エンドポイント。`AI_BASE_URL` で指し示す接続先のこと。RSS の Source とは全く別の概念。
_Avoid_: model, endpoint（模型本体と混同しやすい）

**Article Summary（記事要約）**:
記事のタイトルと本文から生成する、全体要点の日本語要約（表示用 HTML スニペット）。

**Bookmark（ブックマークコメント）**:
ある記事に対する、はてなブックマーク上の個々のユーザーの反応（コメント・ユーザー名・ブックマーク日時の組）。コメントが空（タグのみ等）のブックマークも含む概念。表示上はコメント非空のものだけ並ぶ。
_Avoid_: comment（要約と混同しやすい）, reaction

**Bookmark Timestamp（ブックマーク日時）**:
ユーザーがその記事をブックマークした日時（分精度）。はてな本体の「新着順」の根拠となる時系列キー。記事の取得時刻や要約の生成時刻とは無関係。
_Avoid_: createdAt（DB上の実装名であり、取得時刻と誤読しやすい）

**Hatena Summary（反応要約）**:
はてなブックマークのコメント群から生成する、世間の反応・意見の日本語要約（表示用 HTML スニペット）。コメント0件では生成しない。
_Avoid_: Reaction Summary

**Issue（課題プロンプト）**:
issue-logger スキルが `issues/issue-yyyyMMddHHmm.md` に生成する、後続の AI エージェントがそのまま実行できるプロンプト形式の課題ファイル。YAML フロントマターの `status`（TODO / IN_PROGRESS / DONE / WONTFIX）で生命周期を管理する。GitHub の Issue とは全く別の概念。
_Avoid_: ticket, task, GitHub Issue
