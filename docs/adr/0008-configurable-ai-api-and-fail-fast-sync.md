# AI API方式を設定可能にし、AIエラー時は同期全体を停止する

AI要約の標準接続先をOpenAIのGPT-5.6 Lunaへ変更する一方、既存のOpenAI互換エンドポイント対応を維持するため、`AI_API` で `openai-completions` / `openai-responses` を切り替えられるようにする。標準設定はResponses APIとし、未設定時は既存環境との互換性のためCompletions APIを使う。

記事要約またはHatena Summaryの生成に失敗した場合は、記事単位で握りつぶさず、現在実行中の購読同期全体を停止する。同期は記事単位で逐次保存しているため、停止前にコミットされたデータは残し、失敗した新規記事は保存しない。これにより、AI障害中に要約のない記事を大量に取り込むことを防ぎ、次回同期で未処理分を再試行できる。

## 決定内容

- 認証変数はプロバイダ固有の `OPENAI_API_KEY` ではなく、既存の `AI_API_KEY` を継続使用する。
- `AI_MODEL` の既定値は `gpt-5.6-luna` とする。
- `AI_API` の既定値は `openai-completions` とし、標準設定ファイルでは `openai-responses` を明示する。
- `AI_REASONING_EFFORT` は `off` / `low` / `medium` / `high` / `xhigh` / `max` を受け付け、既定値は `medium` とする。GPT-5.6 Lunaでは `minimal` を受け付けない。
- 不正なAI設定は外部取得前に検証し、AI生成エラーは全購読同期へ伝播させる。
- `/api/sync` の非同期 `202 Accepted` と、Cloudflare Worker側でのログ記録は変更しない。

## Consequences

- OpenAI本家のResponses APIを標準として利用できる。
- 既存のOpenAI互換サービスは、対応するAPI方式を設定すれば引き続き利用できる。
- AIエラー時は同期済みデータと未処理データが混在し得るが、全体ロールバックのためにネットワーク処理を長時間トランザクションへ包む必要はない。
- 既存記事の一括再要約は行わず、新着記事と未生成Hatena Summaryのバックフィルだけが新設定を利用する。
