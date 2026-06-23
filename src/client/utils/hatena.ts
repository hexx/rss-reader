/**
 * はてなブックマークのエントリーページURLを生成する
 * @param url 元の記事URL
 * @returns はてなブックマークのエントリーページURL
 */
export function getHatenaEntryUrl(url: string): string {
  return `https://b.hatena.ne.jp/entry/${url.replace(/^https:\/\//, 's/').replace(/^http:\/\//, '')}`;
}
