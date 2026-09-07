---
title: "記事本文の保持ポリシーを決める（D1 ストレージの単調増大対策）"
status: TODO
created: 2026-09-08T06:02:57+09:00
---

# 記事本文の保持ポリシーを決める（D1 ストレージの単調増大対策）

## 背景・前提条件 (Context)

本アプリは取得した記事の本文（スクレイピング結果）を D1 の `articles.content` に
**無期限で保存**する。削除は購読解除時（Source 単位の CASCADE）のみで、既読・古い記事の
クリーンアップは存在しない。2026-09-07 時点で本番 DB のストレージ使用量は **500MB 超**
（ユーザーが Cloudflare ダッシュボードで確認。正確な値・日次増加率は UNKNOWN —
D1 Metrics がダッシュボードで閲覧できなかったため）。

なお 2026-09-07 の新着停止障害（`docs/specs/ingest-failure.md` §7）の原因は
マイグレーション未適用であり、**ストレージ 500MB 超は本障害の原因ではない**（赤鯡だった）。
ただし保存量の単調増大は実在する将来リスクであり、Workers Paid の上限（10GB/DB）到達を
放置すると同じ「全書き込み失敗」が再発する。

### 期待される挙動 vs 実際の挙動

- **期待**: 保存量が上限に達しないよう制御されている。削除・縮小を実施した場合、D1 の空き容量として回収される
- **実際**: 本文が無期限に蓄積される。現在 500MB 超（増加率 UNKNOWN）。削除ポリシー・容量回収の検証は未実施

### エラーログ / スタックトレース

なし（本 issue は将来リスクの設計課題。参考として D1 の上限到達時エラーは公式エラーリストの
`Exceeded maximum DB size.` / `Your account has exceeded D1's maximum account storage limit...`）。

### 再現手順

1. 使用量の確認（デプロイ可能な wrangler 認証がある環境で）:

```bash
npx wrangler d1 info rss-reader --remote
# ダッシュボード: Cloudflare → Storage & Databases → D1 → rss-reader（Metrics が閲覧できない環境あり）
```

2. 件数・平均本文長の把握:

```bash
npx wrangler d1 execute rss-reader --remote --command "SELECT COUNT(*) AS articles, SUM(LENGTH(content)) AS content_bytes, SUM(LENGTH(summary)) AS summary_bytes FROM articles"
```

### 環境情報

- 実行環境: Cloudflare Workers + D1（Workers Paid。D1 上限: 10GB/DB、Free は 500MB/DB）
- 言語/ランタイム: TypeScript / drizzle-orm 0.45.2
- 起動方法: `npm run dev` / `npm run deploy`
- 現在の記事総数: UNKNOWN（おおよそ 1 万件規模。ADR-0002 の記述より）

### 関連ファイル / コード

- `src/db/schema.ts`

```ts
export const articles = sqliteTable('articles', {
  content: text('content'),          // ← スクレイピング本文。無期限保存
  summary: text('summary'),          // AI 要約（表示用 HTML）
  hatenaSummary: text('hatena_summary'),
  // ... created_at / published_at / is_read / content_backfill_* など
});
```

- 削除系の既存実装: `src/worker.ts`（購読解除時に `hatena_bookmarks` → `articles` → `subscriptions` を削除）
- 関連: `docs/adr/0002-split-sync-cadences.md`、`issues/issue-202609010458-content-backfill.md`、`docs/specs/ingest-failure.md` §8

### 試したが駄目だったこと

- なし（本件はまだ調査・設計フェーズ）。

## 解決すべきゴール (Goal)

- [ ] 保存量の実測（記事数・本文バイト総量・ブックマーク数・インデックス込みの DB サイズ）を取り、現在の増加率を試算する
- [ ] 保持ポリシーの方針を決める（例: (a) N ヶ月より古い記事の `content` を NULL 化して summary のみ残す、(b) 既読 + 一定期間経過記事を丸ごと削除、(c) 現状維持 + 到達予測の監視のみ）。未読の扱い・はてブコメントとの整合（`hatena_bookmarks` は FK で CASCADE）に注意
- [ ] D1 での空き容量回収の可否を調査する（SQLite は DELETE してもファイルが縮まない。D1 における VACUUM 相当・Time Travel との相互作用: 要調査、UNKNOWN）
- [ ] 決定した方針を ADR として記録する

### 完了条件（検証方法）

- 実測結果と増加率の試算がこの issue のコメント欄（または解決記録）に記録されていること
- 方針が ADR として確定していること
- 実装する場合は `npm test` が緑であり、削除/縮小処理が既存の一覧 API・未読数・はてブ表示を壊さないこと

## 補足（任意）

- 本障害（2026-09-07）の直接原因ではないため優先度は中。ただし「到達 → 全書き込み失敗」の再発防止として、Workers Paid でも 10GB 到達前に対処できるよう早期の試算を推奨。
- 大きなオブジェクトの分離（R2 への本文退避等）はアーキテクチャ変更になるため、まずはポリシー策定と試算から始めること。
