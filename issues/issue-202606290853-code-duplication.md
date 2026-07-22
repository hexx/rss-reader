---
title: "コード重複の解消（サニタイザ・normalizeError・スキーマDDL・tsconfig）"
status: DONE
created: 2026-06-29T08:53:00+09:00
---

# 課題解決プロンプト: コード重複の解消

## 1. 役割定義 (Persona)
あなたは高度なソフトウェアエンジニアおよび保守性向上のエキスパートです。以下のコンテキストとゴールを基に、コード重複を解消し、単一の真実の源（Single Source of Truth）を確立してください。

## 2. 背景・前提条件 (Context)
- **現状発生している問題**:
  1. **サニタイザの二重実装**: `src/utils/sanitizeHtml.ts`（サーバー側、cheerio利用）と `src/client/utils/sanitizeClientHtml.ts`（クライアント側、DOMParser利用）で、許可タグリスト `ALLOWED_TAGS`、`REMOVE_CONTENT_TAGS`、URL検証パターン `SAFE_URL_PATTERN` が**全く同じ内容で重複定義**されている。変更時に両方を同期して更新しなければならない。
  2. **`normalizeError` の二重定義**: `src/client/utils/status.ts` と `src/client/components/SourceManager.tsx` に同一の関数が定義されている。
  3. **テスト用スキーマDDLのベタ書き**: `src/test-utils/sqljs-db.ts` に CREATE TABLE 文がハードコードされており、`src/db/schema.ts` の Drizzle 定義と**二重管理**されている。スキーマ変更時に同期漏れが発生するリスクがある。
  4. **tsconfigの重複**: `tsconfig.json` と `tsconfig.client.json` で多くの設定項目が重複している。`tsconfig.base.json` に抽出して `extends` で継承すべき。

- **再現手順**: 各ファイルを目視確認すれば重複は明らか

- **関連ファイル/コード**:
  - `src/utils/sanitizeHtml.ts`
  - `src/client/utils/sanitizeClientHtml.ts`
  - `src/client/utils/status.ts`
  - `src/client/components/SourceManager.tsx`
  - `src/test-utils/sqljs-db.ts`
  - `src/db/schema.ts`
  - `tsconfig.json`
  - `tsconfig.client.json`

## 3. 解決すべきゴール (Goal & Objective)
- [ ] `ALLOWED_TAGS`、`REMOVE_CONTENT_TAGS`、`SAFE_URL_PATTERN` を共有モジュール（例: `src/shared/sanitize-constants.ts`）に抽出し、両方のサニタイザから import する
- [ ] `normalizeError` の定義を `src/client/utils/status.ts` に一本化し、`SourceManager.tsx` からは import で利用する
- [ ] テスト用スキーマDDLを Drizzle のスキーマ定義から動的に生成するか、少なくとも Drizzle のマイグレーションSQLファイルから読み込む方式に変更する
- [ ] `tsconfig.base.json` を作成し、`tsconfig.json` と `tsconfig.client.json` に `extends` させる
- [ ] 既存の全テストがパスすること

## 4. 期待する成果物 (Output Format)
- 新規作成または修正された各ファイルのコード
- 修正理由とアプローチの簡潔な解説
- 全テスト（`npm run test`）のパス確認

## 5. 実行開始の合図
このプロンプトを理解したら、「タスクを開始します」と宣言し、直ちに関連ファイルの解析から始めてください。
