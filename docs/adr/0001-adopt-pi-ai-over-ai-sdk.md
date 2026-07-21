# LLM 層に ai-sdk ではなく pi-ai を採用する

要約生成の LLM 層を Vercel AI SDK（`ai` / `@ai-sdk/openai-compatible`）から `@earendil-works/pi-ai` に置き換える。動機は機能拡張ではなく **pi エコシステムへの統一**である。任意の OpenAI 互換エンドポイント（`AI_BASE_URL`）という本アプリの前提は維持する。

## 決定内容

- pi-ai の `createProvider()` + `Models` コレクションを使う（pi 標準の抽象に乗せる）。API は `openai-completions`、非ストリーミング（`models.complete`）。
- 接続先は常に `AI_BASE_URL` で明示する（必須）。`AI_API_KEY` も必須を維持し、README 側をコードに合わせる。`AI_MODEL` の既定は `gpt-4o-mini`。
- モデルのメタデータは **固定の既定値**（`reasoning: false` / `cost: 0` / `input: ['text']` 等）を使う。`compat` は明示せず pi-ai の `baseUrl` 自動検出に任せる。
- 認証は `AI_API_KEY` をリクエストごとに明示渡しする（`process.env` に依存しない。Workers バインディング対応）。
- pi-ai は API エラー時に throw せず `stopReason: 'error'` のメッセージを返すため、本アプリ側で throw に変換して ai-sdk 時代の reject 挙動を再現する。

## Considered Options

- **ai-sdk を維持**: 普及度は高いが、エコシステム統一の目的を満たさない。
- **pi-ai の API 直接呼び出し（`Models` を使わない）**: コードは最少だが pi らしい抽象に乗らず、統一の旨味が薄い。
- **`AI_BASE_URL` を省略可にしてカタログの正規 URL へフォールバック**: Ollama 等はカタログに載らず主要ケースで結局必須になる上、書き忘れ時に意図しないエンドポイントへ静かに接続するリスクがあるため不採用。接続先は明示を徹底する。
- **`AI_PROVIDER` + 静的組み込みカタログから実メタデータを借用**: 採用を見送り。`providers/all` 経由の import は未使用プロバイダの SDK まで dynamic import でインラインされバンドルが約 900K（minify 後）に膨張した。データ専用 import（`.models.js`）でも約 524K。本アプリは reasoning 非使用・コスト表示なしでメタデータの実利が薄く、固定既定値（約 148K 相当）で十分と判断（YAGNI）。
  - 主な利用想定である **opencode-go 経由の deepseek-v4-flash**（`AI_BASE_URL=https://opencode.ai/zen/go/v1`）は、URL の `opencode.ai` を pi-ai が自動検出して `supportsStore: false` / `supportsDeveloperRole: false` を正しく設定するため、固定既定値（`reasoning: false`）でも単発・reasoning 無しの要約リクエストは正しく動作する。
