/**
 * はてなブックマークのエントリーページURLを生成する
 * @param url 元の記事URL
 * @returns はてなブックマークのエントリーページURL
 */
export function getHatenaEntryUrl(url: string): string {
  // フィード由来の URL はスキームが大文字（HTTPS:// 等）の場合もあるため、
  // 大文字小文字を区別せずにスキームを除去する。
  return `https://b.hatena.ne.jp/entry/${url.replace(/^https:\/\//i, 's/').replace(/^http:\/\//i, '')}`;
}
