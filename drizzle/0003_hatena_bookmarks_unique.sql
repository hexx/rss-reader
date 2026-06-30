-- 既存データに重複行があると UNIQUE INDEX 作成が失敗するため、
-- 先に `(article_id, user)` 単位で最も古い行だけを残す。
-- 元コードでは主キー以外の重複を弾いていなかったため、本番 DB には
-- `(article_id, user)` の重複が存在し得る。
DELETE FROM `hatena_bookmarks`
WHERE `rowid` NOT IN (
  SELECT `min_rowid` FROM (
    SELECT MIN(`rowid`) AS `min_rowid`
    FROM `hatena_bookmarks`
    GROUP BY `article_id`, `user`
  ) AS `_keep`
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hatena_bookmarks_article_id_user_unique` ON `hatena_bookmarks` (`article_id`, `user`);
