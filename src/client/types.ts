export type Bookmark = {
  comment: string;
  createdAt: string;
  id: string;
  user: string;
};

export type Article = {
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
};

export type Source = {
  articleCount: number;
  displayTitle: string;
  id: string;
  siteUrl: string;
  title: string;
  unreadCount: number;
};
