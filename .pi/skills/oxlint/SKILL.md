---
description: プロジェクトにoxlintが導入されているか確認・導入し、静的解析を実行してコードの指摘箇所を自動で修正します。
metadata:
    github-path: skills/oxlint
    github-ref: refs/heads/main
    github-repo: https://github.com/hexx/skills
    github-tree-sha: cad3b144ee7fb6b5c65daa4ab02e4b448a8e62d0
name: oxlint
---
# oxlint 自動導入・コード修正スキル

ユーザーから「oxlintでコードを綺麗にして」「oxlintを実行して」などの指示、あるいはJavaScript/TypeScriptプロジェクトのコード品質向上を求められた際、以下のステップを順に実行してください。

## 実行手順

### 1. プロジェクト環境の確認
1. プロジェクトのルートディレクトリにあるファイルを確認し、使用されているパッケージマネージャー（`package.json`、`package-lock.json`、`yarn.lock`、`pnpm-lock.yaml`、`bun.lockb` など）を特定します。
2. `package.json` の `dependencies` または `devDependencies` に `oxlint` が含まれているか、およびローカル環境で `oxlint` コマンドが実行可能か確認します。

### 2. oxlintの導入（未導入の場合）
oxlintが導入されていない場合は、特定したパッケージマネージャーに応じて、以下のいずれかのコマンドを用いて開発用依存関係（devDependencies）としてインストールしてください。

- **npm**: `npm install -D oxlint`
- **yarn**: `yarn add -D oxlint`
- **pnpm**: `pnpm add -D oxlint`
- **bun**: `bun add -d oxlint`

### 3. oxlintの実行
インストールが完了している、または既に導入されていた場合は、以下のコマンドを実行して静的解析（Lint）を行います。
プロジェクト全体をスキャンし、指摘内容（エラーや警告）の出力をキャプチャしてください。

```bash
npx oxlint
```
*(パッケージマネージャーがbunの場合は `bunx oxlint`、pnpmの場合は `pnpm dlx oxlint` を試みてください)*

### 4. 指摘コードの自動修正
1. oxlintの実行結果を解析し、問題が指摘されたファイルを特定します。
2. oxlintの自動修正機能（fix）が利用可能な場合は、まず以下のコマンドを実行して自動修正を試みます。
   ```bash
   npx oxlint --fix
   ```
3. 自動修正コマンドで解決しなかった残りの指摘事項、または手動修正が必要なエラーについては、AIエージェント自身が `editFile` ツールを使用して直接ソースコードを修正します。
4. 修正の際は、不必要なバグを生まないようコードの整合性を保ち、型定義やロジックが破壊されないように細心の注意を払ってください。

### 5. 最終確認
修正が完了したら、再度 `npx oxlint` を実行して、すべての指摘事項がクリアされたことを確認し、ユーザーに結果を報告してください。
