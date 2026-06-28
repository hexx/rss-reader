/**
 * クライアント側は src/shared/types.ts の共有型を re-export して使う。
 *
 * 既存コードの `import type { Article, Source, Bookmark } from '../types.js'`
 * を変更せずに共有型へルーティングする。
 */
export type {
  Article,
  ArticleReadStateResponse,
  ArticleSortDirection,
  Bookmark,
  Source,
  SubscriptionMutationResponse,
  SyncAcceptedResponse,
} from '../shared/types.js';
