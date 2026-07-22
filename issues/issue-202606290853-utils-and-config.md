---
title: "ユーティリティと設定の品質改善（logger・drizzle.config・hatena.ts・.env.example 他）"
status: TODO
created: 2026-06-29T08:53:00+09:00
---

# 課題解決プロンプト: ユーティリティと設定の品質改善

## 1. 役割定義 (Persona)
あなたは高度なソフトウェアエンジニアおよびコード品質向上のエキスパートです。以下のコンテキストとゴールを基に、細かいが積み重なると保守性を損なう問題群を修正してください。

## 2. 背景・前提条件 (Context)
- **現状発生している問題**:
  1. **`src/utils/logger.ts`**: `logger` が単なる `console` のラッパーで、実質的に何の価値もない間接層。テストでモックするためだけに存在している。構造化ログやレベル制御の仕組みを入れるか、テスト側を `vi.spyOn(console, ...)` に改修して `logger` ごと削除すべき。
  2. **`src/client/utils/hatena.ts`**: はてなブックマークのエントリURL生成で正規表現置換が雑。
     ```typescript
     url.replace(/^https:\/\//, 's/').replace(/^http:\/\//, '')
     ```
     クエリパラメータ等に `https://` が含まれるケースを考慮していない。`new URL()` でパースしてからプロトコルを置換すべき。
  3. **`drizzle.config.ts`**: `dbCredentials.url` のフォールバックが相対パス `'./data/rss-reader.sqlite'`。これはローカル開発用だが、誤って本番相当の設定と混同されるリスクがある。コメントでの明示か、環境ごとの設定ファイル分割が必要。
  4. **`.env.example`**: 実際のデフォルト値（`http://localhost:11434/v1`）がプレースホルダとして入っている。本番環境やCIでうっかりこの値が使われると事故る。`your-open-code-go-url` のようなプレースホルダ的値にすべき。
  5. **`src/services/ai.ts`**: `generateArticleSummary` が `content` が空文字でもAI APIコールを発行する。空の場合は早期リターンしてAPIコストを節約すべき。
  6. **`src/client/index.css`**: `.skip-link` のスタイルが `!important` 連打で冗長。Tailwindの `sr-only` ユーティリティで簡潔に書ける。
  7. **`src/client/App.tsx`**: ソート順切り替え時に毎回APIを再fetchしている。「古い順/新しい順」はクライアント側でソートすれば十分なケース。

- **関連ファイル/コード**:
  - `src/utils/logger.ts`
  - `src/client/utils/hatena.ts`
  - `drizzle.config.ts`
  - `.env.example`
  - `src/services/ai.ts`
  - `src/client/index.css`
  - `src/client/App.tsx`

## 3. 解決すべきゴール (Goal & Objective)
- [ ] `logger` に構造化ログ（JSON出力）とログレベル制御を導入するか、削除して `console` 直接利用 + テスト側で `vi.spyOn` に統一する
- [ ] `hatena.ts` のURL変換を `new URL()` ベースの安全な実装に変更する
- [ ] `drizzle.config.ts` に「この設定はローカル開発用」であることを明示するコメントを追加する
- [ ] `.env.example` のプレースホルダ値を現実的なものに変更する
- [x] ~~`generateArticleSummary` で `content` が空文字の場合は早期リターンし、APIコールをスキップする~~（陳腐化: 空本文でもタイトルから要約を生成する設計を採用。システムプロンプトに明記済み）
- [ ] `.skip-link` のスタイルを Tailwind のユーティリティクラスで簡潔に書き直す
- [x] ~~ソート順変更時のAPI再fetchをクライアント側ソートに変更し、不要なネットワークリクエストを削減する~~（陳腐化: サーバー側ソート + ページネーション設計（sortOrder パラメータ）を採用したため、ソート時の再fetchは仕様）
- [ ] 既存のテストを壊さないこと

## 4. 期待する成果物 (Output Format)
- 修正が完了した各ファイルのコード
- 各修正の理由とアプローチの簡潔な解説
- 全テスト（`npm run test`）のパス確認

## 5. 実行開始の合図
このプロンプトを理解したら、「タスクを開始します」と宣言し、直ちに `src/utils/logger.ts` の解析から始めてください。

## 解決記録
- 2026-07-22: 監査。大半の項目は未達のため TODO 維持。ただし「ai.ts 空コンテンツ早期リターン」と「ソート時クライアント側ソート化」の 2 項目は、その後の設計判断（タイトルからの要約生成、サーバー側ソート + ページネーション）により陳腐化したため達成済みとして本文から除外した。残要求: logger、hatena.ts の URL 変換、drizzle.config.ts コメント、.env.example プレースホルダ、skip-link の 5 項目。
