---
title: "既読化時のサイドバー未読数更新の点滅を、楽観更新で滑らかにする"
status: DONE
created: 2026-07-29T23:47:00+09:00
---

# 既読化時のサイドバー未読数更新の点滅を、楽観更新で滑らかにする

## 背景・前提条件 (Context)

### 期待される挙動 vs 実際の挙動
- **期待**: 記事を既読にすると、左サイドバー（`SourceManager`）の該当ソースの未読数バッジと、ヘッダーの総未読数バッジが**即座に -1** され、リストの他の要素は再描画されない。
- **実際**: 既読化のたびにサイドバーのソース一覧**全体**が 3 つのスケルトン（`SourceSkeleton`）に置き換わって点滅し、復元後に数字が変わる。フッターの「N 件のフィードを購読中」も一瞬消える。ヘッダーの総未読数もサーバ往復後まで更新されない。

### 根本原因
1. `App.tsx` の `handleMarkAsRead` は PATCH 成功後に `await sources.reload()`（`/api/sources` の全件 refetch）を呼ぶ。記事リストは optimistic update 済みだが、未読数は意図的にサーバ再計算任せ（コード内のコメント「UnreadCount の減算は sources.reload() 後に再計算されるためここでは行わない」を参照）。
2. `useSources` が **`isLoading: query.isFetching`** を返すため、初回ロードと背景 refetch の区別がつかない。
3. `SourceManager` は `isLoading` のとき実リストの代わりにスケルトンを描画する（`isLoading ? <SourceSkeleton/>×3 : ...`）。フッターも `!isLoading && sources.length > 0` で消える。

### 再現手順
1. `npm run dev`（またはプロジェクト既定の起動方法。`package.json` の scripts を参照）でアプリを起動する。
2. 未読記事がある状態で、記事カードの「既読にする」ボタンを押す（またはキーボードショートカット `m`）。
3. 左サイドバーのソース一覧全体がスケルトンに置き換わって点滅するのが見える。

### 環境情報
- 言語/ランタイム: TypeScript + React（Vite）、データフェッチは `@tanstack/react-query`
- 主要ファイル: `src/client/App.tsx`, `src/client/hooks/useSources.ts`, `src/client/components/SourceManager.tsx`, `src/client/articleState.ts`, `src/client/hooks/useKeyboardShortcuts.ts`

### 関連ファイル / コード

- `src/client/hooks/useSources.ts`（`isLoading` の意味が諸悪の根源）
```ts
export function useSources(): UseSourcesResult {
  const query = useQuery({
    queryFn: fetchSources,
    queryKey: SOURCES_QUERY_KEY,
  });
  // ...
  return {
    isLoading: query.isFetching, // ← 背景 refetch でも true になる
    reload,
    sources: query.data ?? [],
    status,
  };
}
```

- `src/client/App.tsx`（`handleMarkAsRead` と総未読数の派生）
```tsx
const handleMarkAsRead = useCallback(
  async (articleId: string) => {
    const previousArticles = articles;
    // Optimistic UI: 即座に既読化 / 未読のみモードでは削除。
    // UnreadCount の減算は sources.reload() 後に再計算されるためここでは行わない。
    setArticles((current) => applyReadStateChange(current, articleId, true, showUnreadOnly));
    setReadStateStatus({ kind: 'loading', message: '既読にしています...' });
    try {
      const response = await fetch(`/api/articles/${articleId}`, {
        body: JSON.stringify({ isRead: true }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      });
      if (!response.ok) throw new Error('既読状態の更新に失敗しました。');
      await sources.reload();
      setReadStateStatus({ kind: 'success', message: '既読にしました。' });
    } catch (error) {
      setArticles(previousArticles); // 巻き戻し
      setReadStateStatus({ kind: 'error', message: normalizeError(error, '既読状態の更新に失敗しました。') });
    }
  },
  [articles, setArticles, showUnreadOnly, sources],
);

const totalUnreadCount = useMemo(
  () => sources.sources.reduce((sum, source) => sum + source.unreadCount, 0),
  [sources.sources],
);
```

- `src/client/components/SourceManager.tsx`（スケルトン分岐）
```tsx
{isLoading ? (
  <>
    <SourceSkeleton />
    <SourceSkeleton />
    <SourceSkeleton />
  </>
) : sources.length === 0 ? ( /* Empty */ ) : (
  sources.map((source) => ( /* 実リスト。source.unreadCount > 0 で Badge 表示 */ ))
)}
```

- `src/client/main.tsx` / `src/client/queryClient.ts`: `QueryClient` は `makeQueryClient()` で生成され `QueryClientProvider` 経由で提供済み。`App` 内から `useQueryClient()` でアクセスできる。
- `SOURCES_QUERY_KEY` は `useSources.ts` 内で `['sources'] as const`（非 export。楽観更新側から参照するので export が必要になる可能性あり）。
- `Source` 型は `src/shared/types.ts`（`siteUrl`, `displayTitle`, `unreadCount: number` 等）。記事の `Article` には `siteUrl` がある（`src/client/types.ts` / `src/shared/types.ts` を確認のこと）。

### 試したが駄目だったこと
- なし（仕様策定のみ実施済み。設計決定は下記「決定事項」参照）。

## 決定事項（Grilling セッション 2026-07-29 の合意。ADR 0007 参照）

用語は `CONTEXT.md` の **Unread Count（未読数）** / **Total Unread Count（総未読数）** に従う。

1. **更新モデル（Q1=C）**: 既読クリックと同時に、react-query キャッシュ（`['sources']`）上の該当 Source の `unreadCount` を楽観的に -1。PATCH 成功後はサイレントに refetch してサーバ真値と reconcile。失敗時は記事リストとキャッシュの両方をロールバック。
2. **スケルトン範囲（Q2=B）**: `useSources` の `isLoading` を「データが一度も無い初回ロード」（`query.isPending` 相当）の意味に変更し、**あらゆる**背景 refetch（既読化・同期ボタン・購読追加/削除時の `refreshAll`）で `SourceManager` がスケルトンに置き換わらないようにする。副作用として、購読削除済みソースは refetch 完了までリストに残るが、これは許容する。
3. **Reconcile（Q3=C）**: PATCH 成功後の `sources.reload()`（サイレント化済み）は残す。加えて react-query 既定の `refetchOnWindowFocus` も活かす（無効化しない）。
4. **安全策（Q4、3 点とも採用）**:
   - **ロールバック**: 楽観更新前に `['sources']` キャッシュをスナップショットし、PATCH 失敗時は `setQueryData` で復元（既存の `setArticles(previousArticles)` と同パターン）。
   - **二重減算ガード**: `handleMarkAsRead` 入口で、対象記事が既に既読、または in-flight（`Set<articleId>` の ref で管理）なら早期 return し、PATCH 自体をスキップする。背景: `useKeyboardShortcuts` の `m` 連打で、再レンダー前の古いクロージャから同一 `articleId` が二重発火し得る（サーバ PATCH は冪等だが楽観減算が二重に効く）。
   - **0 クランプ**: 減算は `Math.max(0, unreadCount - 1)`。
5. **演出（Q5=A）**: カウント変化・バッジ消滅にアニメーションは**付けない**。数字は即座に切り替わり、0 のバッジは即消える（既存の `source.unreadCount > 0` 分岐のまま）。framer-motion 等の依存追加は禁止。
6. **ヘッダー総未読数**: `totalUnreadCount` は `sources.sources` からの `useMemo` 派生なので、`['sources']` キャッシュを更新すれば自動的に追従する。個別の実装は不要（テストで検証はする）。

## 解決すべきゴール (Goal)
- [ ] `useSources` の `isLoading` が初回ロード時のみ true になり、背景 refetch では false になる
- [ ] `SourceManager` が refetch 中でも実リストを描画し続け、スケルトン・フッターがちらつかない
- [ ] 既読化クリック/`m` キーで、該当 Source の未読数バッジとヘッダー総未読数が即座に -1 される
- [ ] PATCH 失敗時に記事リスト・未読数キャッシュの両方がロールバックされる
- [ ] 同一記事の二重発火（`m` 連打）で未読数が二重に減らない
- [ ] `unreadCount` が 0 のソースで負のバッジが出ない
- [ ] `App.tsx` の「UnreadCount の減算は sources.reload() 後に再計算する」趣旨の古いコメントを、新方針（楽観減算）の説明に更新する
- [ ] 既存のテストを壊さないこと。下記テストを追加・更新すること

### テスト要件
- `useSources.test.ts`: 初回（データ未取得）は `isLoading: true`。データ取得後の refetch では `isLoading: false` のまま旧データを返す。
- `SourceManager.test.tsx`: `isLoading=false` かつ refetch 中を模した状況でも実リストが描画される（最低限、既存のスケルトン分岐テストを新セマンティクスに合わせて更新）。
- `App.test.tsx`:
  - 既読化で該当 Source のバッジとヘッダー総未読数が即 -1（PATCH モックの解決を待たずにアサーション）
  - PATCH 失敗（`fetch` を reject / 非 200）でカウントが元に戻る
  - 同一 `articleId` の連続呼び出しで減算が 1 回分のみ
  - `unreadCount: 0` のソースを既読化しても 0 のまま（負にならない）

### 完了条件（検証方法）
- `npm test`（または `vitest`。`package.json` の test script に従う）が緑
- lint（oxlint / `npm run lint` 相当）が緑
- 手動確認: `npm run dev` 等で起動し、既読化時にサイドバーが点滅せずバッジだけ即座に減る。`m` 連打でも数字が余分に減らない

## 補足
- 設計の経緯・却下した代替案は `docs/adr/0007-optimistic-unread-count.md` を参照。
- 用語（Unread Count / Total Unread Count）は `CONTEXT.md` を参照。
- 購読追加/削除（`useSubscriptions`）は楽観更新を持たず `refreshAll → sources.reload()` 頼みだが、Q2=B によりこれらのパスの点滅も同時に解消される。`useSubscriptions` 自体の楽観更新は本 Issue のスコープ外。

## 解決記録
- 2026-07-29: 実装完了。`useSources` の `isLoading` を `query.isPending` に変更し、楽観更新ヘルパー（`decrementUnreadCount` / `restoreSources`、0 クランプ付き）を追加。`App.handleMarkAsRead` に in-flight ガード（`Set<articleId>` ref）と楽観減算・ロールバックを実装し、旧方針のコメントを ADR 0007 参照に更新。テスト 5 件追加（背景 refetch 中の stale data 保持、PATCH 未解決での即時減算、失敗時ロールバック、二重発火ガード、0 クランプ）。全 221 テスト緑、`tsc --noEmit` クリーン、oxlint 退出码 0。
- 2026-07-29: 仕様との差異: Q3 は「react-query 既定の `refetchOnWindowFocus` を活かす」としていたが、`src/client/queryClient.ts` で `refetchOnWindowFocus: false` が明示設定済みだったため、全クエリへの影響を避けて変更せず。reconcile は PATCH 成功後のサイレント refetch と同期ボタンで担保される。
