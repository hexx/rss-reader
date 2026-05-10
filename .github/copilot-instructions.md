# Project Overview
このプロジェクトは、記事の全文取得、はてなブックマークのコメント取得、AIによる要約とRAGベースの横断的検索機能を備えた「理想のRSSリーダー」アプリケーションです。

# Tech Stack
- **Language**: TypeScript (Node.js環境)
- **Database (Relational)**: SQLite
- **ORM**: Drizzle ORM (記事のメタデータ、要約情報の保存)
- **Vector Database**: LanceDB (RAG構築、横断的検索用)
- **AI/LLM**: OpenCode Go
  - Vercel AI SDKの `@ai-sdk/openai-compatible` プロバイダーを使用して接続すること。
  - プロンプトおよび生成される要約はすべて「日本語」で行うこと。
  - テキスト生成（要約）は OpenCode Go、Embedding（ベクトル化）は OpenAI の `text-embedding-3-small` を `@ai-sdk/openai` で使用すること。

# Core Features & Requirements
1. **RSS & Web Scraping**:
   - RSSフィードから記事を取得し、元URLから記事の全文をスクレイピングする。
   - RSSを提供していないWebサイトの場合は、WebサイトのHTMLから記事のリンクと内容を抽出し、動的にRSS（または同等のデータ構造）を生成する。
2. **Hatena Bookmark Integration**:
   - 各記事のURLに対して、はてなブックマークのAPIやフィードを利用してコメントを取得する。
3. **AI Summarization**:
   - 取得した記事本文と、付随するはてなブックマークのコメントをセットにして、AI（OpenCode Go）を用いて日本語で要約する。
4. **RAG & Search**:
   - 記事データと要約データをLanceDBにエンベディングして保存し、自然言語による横断的な検索（RAG）を実装する。

# Coding Guidelines & Constraints
- **DoS Prevention (CRITICAL)**:
  - 外部サイト（Webサイト、RSSフィード、はてなブックマーク等）から情報を取得・スクレイピングする際は、必ずリクエスト間に適切な間隔（例: 1〜3秒のランダムなスリープ）を設けること。DoS攻撃とみなされるような連続リクエストは絶対に記述しないこと。
- **TypeScript**:
  - 厳格な型定義（`strict: true`）を使用すること。
- **Database Operations**:
  - データベース操作はすべてDrizzle ORMを介して行うこと。
- **AI Integration**:
  - `@ai-sdk/openai-compatible` のセットアップ時は、環境変数からBase URLとAPI Keyを読み込むように構成すること。
