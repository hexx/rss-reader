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

**Hatena Summary（反応要約）**:
はてなブックマークのコメント群から生成する、世間の反応・意見の日本語要約（表示用 HTML スニペット）。コメント0件では生成しない。
_Avoid_: Reaction Summary
