---
description: Renovateの導入（初期設定ファイル作成）、既存のRenovate PRの確認、CI結果の検証、および条件を満たしたPRの自動マージを自動化するスキル
metadata:
    github-path: skills/renovate
    github-ref: refs/heads/main
    github-repo: https://github.com/hexx/skills
    github-tree-sha: 4bf0014fab5e7b09fcd7de615b7d4b97fa225581
name: renovate
platform: universal
---
# Renovate Automation Skill

あなたはリポジトリの依存関係更新を自動化・管理する専門エージェントです。
以下の指示に従い、「Renovateのセットアップ」または「既存PRの検証とマージ」を正確に実行してください。

## 1. 動作モードの判定
ユーザーの要求に応じて、実行するタスクを切り替えてください。
* リポジトリのルートディレクトリに `renovate.json` や `renovate.json5` がない場合 ➡️ **【タスクA: Renovateの導入】** を実行
* すでに導入済みで、PRの確認を求められた場合 ➡️ **【タスクB: PRの確認とマージ】** を実行

---

## 【タスクA: Renovateの導入】
リポジトリにRenovateの初期設定を組み込みます。

1. **設定ファイルの生成**
   リポジトリのルート直下に `renovate.json` を以下の標準的な設定で新規作成してください。
   ```json
   {
     "$schema": "[https://docs.renovatebot.com/renovate-schema.json](https://docs.renovatebot.com/renovate-schema.json)",
     "extends": [
       "config:recommended"
     ],
     "timezone": "Asia/Tokyo",
     "automergeType": "pr",
     "platformAutomerge": true,
     "packageRules": [
       {
         "matchUpdateTypes": ["minor", "patch"],
         "automerge": true
       }
     ]
   }

```

2. **変更のコミットとプッシュ**
以下のコマンドを実行し、変更を提案してください。
```bash
git checkout -b configure-renovate
git add renovate.json
git commit -m "chore: configure Renovate"
git push -u origin configure-renovate
gh pr create --title "chore: configure Renovate" --body "Add initial renovate.json configuration."

```



---

## 【タスクB: PRの確認とマージ】

GitHub CLI (`gh`) を使用して、現在オープンになっているRenovateのプルリクエストを巡回し、安全にマージします。

### ステップ 1: Renovate PRの一覧取得

以下のコマンドを実行して、Renovateが作成したオープン状態のPRを検索してください。

```bash
gh pr list --author "app/renovate" --state open --json number,title,headRefName

```

*対象のPRが1つもない場合は、「現在確認が必要なRenovate PRはありません」とユーザーに報告して終了してください。*

### ステップ 2: 各PRの検証 (ループ実行)

見つかったPRごとに、以下の手順を順番に実行してください。

1. **CIステータスの確認**
PRのテストが通過しているかチェックします。
```bash
gh pr checks <PR番号>

```


* ❌ **CIが失敗（Failure/Error）している場合**: マージを中断し、「CIが失敗しているため手動確認が必要です」とユーザーに報告して次のPRへ進んでください。
* ⏳ **CIが実行中の場合**: 「CIの完了を待機中、または保留します」としてスキップしてください。
* ✅ **すべてのCIが成功（Success）している場合**: 次のステップへ進みます。


2. **変更内容（Diff）の厳格な確認**
意図しない変更が含まれていないか確認します。
```bash
gh pr diff <PR番号>

```


* **判定基準**: 変更内容が依存関係の定義ファイル（`package.json`, `yarn.lock`, `package-lock.json`, `go.mod` など）のバージョン更新のみであることを確認してください。もしソースコードのロジック変更などが含まれていると判断した場合は警告を出し、マージをスキップしてください。



### ステップ 3: 自動マージの実行

ステップ2の条件をすべてクリアし、マージ可能（Mergeable）な状態であれば、以下のコマンドを用いてSquashマージを実行してください。

```bash
gh pr merge <PR番号> --squash --delete-branch

```

マージが完了したら、ユーザーに対象のPRタイトルとマージ完了の旨を報告してください。
