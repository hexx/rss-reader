/**
 * サーバーとクライアントで共有する API 契約の型定義。
 *
 * サーバー側のレスポンス生成（src/worker.ts）と、
 * クライアント側の API 呼び出し（src/client/**）の両方から
 * 参照される単一の真実の源として機能する。
 */

/** はてなブックマークの 1 エントリ。 */
export interface Bookmark {
  comment: string;
  createdAt: string;
  id: string;
  user: string;
}

/** API から返却される記事の構造。 */
export interface Article {
  bookmarks: Bookmark[];
  content: string;
  createdAt: string;
  hatenaSummary: string;
  id: string;
  isRead: boolean;
  publishedAt: string;
  siteUrl: string;
  summary: string;
  title: string;
  url: string;
}

/** 購読ソース 1 件の API レスポンス。 */
export interface Source {
  articleCount: number;
  displayTitle: string;
  id: string;
  siteUrl: string;
  title: string;
  unreadCount: number;
}

/** 購読追加・削除のレスポンス（成功時）。 */
export interface SubscriptionMutationResponse {
  /** 入力 URL がそのままフィード URL として登録された場合は true。auto-discovery された場合は false。 */
  alreadyAFeed?: boolean;
  /** 検出されたフィードの種類。 */
  feedType?: 'rss' | 'atom';
  id?: string;
  siteUrl: string;
  title?: string;
}

/** 記事既読状態の更新レスポンス。 */
export interface ArticleReadStateResponse {
  id: string;
  isRead: boolean;
}

/** 同期開始 API のレスポンス。 */
export interface SyncAcceptedResponse {
  status: 'accepted';
}

/** ソート方向。 */
export type ArticleSortDirection = 'asc' | 'desc';
