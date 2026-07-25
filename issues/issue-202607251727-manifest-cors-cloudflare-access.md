---
title: "Cloudflare Access 保護下で manifest.json 取得が CORS ブロックされる問題の修正"
status: TODO
created: 2026-07-25T17:27:00+09:00
---

# Cloudflare Access 保護下で manifest.json 取得が CORS ブロックされる問題の修正

## 背景・前提条件 (Context)

### 期待される挙動 vs 実際の挙動
- **期待**: ログイン済みユーザーがアプリを開いたとき、`/manifest.json` が 200 で取得でき、PWA マニフェスト（アプリ名・アイコン・`start_url` 等）が正常に読み込まれる。ブラウザの Console に CORS エラーが出ない。
- **実際**: ログイン済みでも `/manifest.json` の取得が Cloudflare Access によって `cloudflareaccess.com` のログイン画面へ 302 リダイレクトされ、そのリダイレクト先が CORS 応答でないためブラウザにブロックされ、Console にエラーが出る。PWA のインストール可能性も損なわれる。アプリ本体の機能（記事閲覧等）は無傷。

### 根本原因
1. 本アプリは `https://rss-reader.hogeika.workers.dev` 全体が **Cloudflare Access（Zero Trust）** 保護下にある。
2. `<link rel="manifest">` によるマニフェスト取得は、ブラウザが**デフォルトで認証情報（`CF_Authorization` クッキー）を送らない**（credentialless 扱い）。
3. クッキーが無いため Cloudflare Access は `manifest.json` を返さず、`cloudflareaccess.com` のログイン画面へ **302 リダイレクト**する。
4. マニフェスト取得は CORS モードのサブリソース fetch。リダイレクト先の別オリジンに `Access-Control-Allow-Origin` ヘッダが無いため **CORS でブロック**される。

ページ本体（トップレベルナビゲーション）はクッキーを送るため Access を通過できるが、マニフェスト fetch は送らないため、**ログイン済みでもこのエラーだけが発生する**。

### エラーログ / スタックトレース
（ユーザー報告より逐語引用）
```
Access to manifest at 'https://still-bonus-fb1d.cloudflareaccess.com/cdn-cgi/access/login/rss-read...MVT9fP4V9aQMm-e9aDTZOCDy3ooT3Pw7_xbPyoBULpgQ&redirect_url=%2Fmanifest.json' (redirected from 'https://rss-reader.hogeika.workers.dev/manifest.json') from origin 'https://rss-reader.hogeika.workers.dev' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.
GET https://still-bonus-fb1d.cloudflareaccess.com/cdn-cgi/access/login/rss-read...MVT9fP4V9aQMm-e9aDTZOCDy3ooT3Pw7_xbPyoBULpgQ&redirect_url=%2Fmanifest.json net::ERR_FAILED 200 (OK)
Access to manifest at 'https://still-bonus-fb1d.cloudflareaccess.com/cdn-cgi/access/login/rss-read...wt1UFRk3q62gUgT1zoboRcmLo8sIZyz7Thje3g9rTk3w&redirect_url=%2Fmanifest.json' (redirected from 'https://rss-reader.hogeika.workers.dev/manifest.json') from origin 'https://rss-reader.hogeika.workers.dev' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.
GET https://still-bonus-fb1d.cloudflareaccess.com/cdn-cgi/access/login/rss-read...wt1UFRk3q62gUgT1zoboRcmLo8sIZyz7Thje3g9rTk3w&redirect_url=%2Fmanifest.json net::ERR_FAILED 200 (OK)
```

### 再現手順
ローカル（`wrangler dev`）には Cloudflare Access が無いため再現不可。**本番の Access 保護環境でのみ再現する。**
1. `npx wrangler deploy` で本番に反映する。
2. ブラウザで `https://rss-reader.hogeika.workers.dev/` を開き、Cloudflare Access でログインする。
3. アプリが表示された状態で DevTools の Console を開く。
4. ハードリロードする。
5. Console に上記 `Access to manifest ... blocked by CORS policy` エラーが表示される。Network で `manifest.json` が `cloudflareaccess.com` へ 302 していることを確認できる。

### 環境情報
- デプロイ先: Cloudflare Workers（`rss-reader`）、D1 バインディング、静的アセットは `./dist-client`（`wrangler.toml` の `assets`）
- 認証: Cloudflare Access（Zero Trust）。Access の設定（ポリシー等）はリポジトリ外（Cloudflare ダッシュボード）にあり、コード管理されていない
- ランタイム: Node.js 24 以上、ビルド `npm run build`（`vite build` が `index.html` を `dist-client/index.html` へ出力）
- 検証ブラウザ: 任意（Chromium 系で確認。Firefox/Safari も同種の挙動）

### 関連ファイル / コード
- `index.html`（修正対象。Vite のソース。ビルドで `dist-client/index.html` になる）
```html
    <link rel="manifest" href="/manifest.json" />
    <link rel="icon" type="image/png" href="/icon-192.png" sizes="192x192" />
    <link rel="icon" type="image/x-icon" href="/favicon.ico" />
    <link rel="apple-touch-icon" href="/icon-192.png" />
```
- `public/manifest.json`（マニフェスト本体。変更なし）
- `public/sw.js`（`/manifest.json` を Cache-First でキャッシュ。**変更なし**。詳細は「補足」）

### 試したが駄目だったこと
- 直接的なコード修正はまだ未実施。ただし設計検討（grilling）により、以下は**採用しない**と確定済み:
  - **Worker 側で CORS ヘッダを付与する**: 無意味。Cloudflare Access が Worker より前（エッジ）でリダイレクトするため、Worker は当該リクエストをそもそも受信しない。
  - **Cloudflare Access の Bypass ポリシーで `manifest.json` を公開する**: 有効ではあるが、アセットを公開するセキュリティ姿勢の変更を伴い、かつリポジトリ外（ダッシュボード）作業になる。ログインしなければ使えないアプリでは「ログイン前のインストール可能性」に実質価値が無いため不採用。

## 解決すべきゴール (Goal)
- [ ] `index.html` のマニフェストリンクを `<link rel="manifest" href="/manifest.json" crossorigin="use-credentials" />` に変更する（`crossorigin="use-credentials"` を付与する）。これによりマニフェスト fetch に same-origin の `CF_Authorization` クッキーが同梱され、ログイン済みなら Access がリダイレクトせず `manifest.json` を返すようになる。
- [ ] 変更は **マニフェストリンクの1箇所のみ**とすること。`<link rel="icon">` / `<link rel="apple-touch-icon">` には `crossorigin` を付けない（これらはデフォルトで認証情報付き no-cors 取得のため Access を通過でき、実際エラーも出ていない。CORS モード化すると SW のキャッシュパーティションが分かれる等の副作用リスクだけが増す）。
- [ ] `public/sw.js` は**変更しない**（`CACHE_NAME` のバージョニングも不要。戦略も中身も変わらないため）。
- [ ] 既存のテスト・ビルドを壊さないこと（`npm run build` / `npm run test` / `npm run lint` が通ること）。

### 完了条件（検証方法）
ログイン済みユーザーで以下を満たすこと:
- [ ] `npx wrangler deploy` で本番反映後、Cloudflare Access でログインしてアプリを開き、ハードリロードする。
- [ ] DevTools Console に `Access to manifest ... blocked by CORS policy` エラーが出ない。
- [ ] DevTools Network で `manifest.json` が **200** で実際の JSON を返す（`cloudflareaccess.com` への 302 になっていない）。
- [ ] DevTools Application → Manifest に「理想のRSSリーダー」の名前・アイコンが正常に表示される。
- [ ] （副次効果）PWA のインストール可能性が回復する。

## 補足（任意）
- **スコープ注記（重要）**: 本修正は「ログイン済みユーザー」のエラーを解消する。**Access セッション切れの際は引き続きエラーが出得る**が、その場合はトップレベルナビゲーション自体がログイン画面へリダイレクトされる「認証切れの正常動作」なので、本修正のスコープ外（許容）とする。
- **`sw.js` との相互作用（無変更で問題ない根拠）**:
  - SW 非アクティブ時（初回ロード）: マニフェスト fetch は直接ネットワークへ。`crossorigin="use-credentials"` によりクッキー同梱済みなので Access が素通し → OK。
  - SW アクティブ時: Cache-First でキャッシュから返る。install 時の `cache.addAll` はログイン済み（=アプリが読めている）状態で走るため、キャッシュに入るのは本物の `manifest.json`。same-origin 応答なので CORS 要求にもそのまま使える → OK。
- **なぜこの属性を消してはいけないか**: `crossorigin="use-credentials"` は same-origin には通常不要に見えるが、Cloudflare Access 保護下ではマニフェスト fetch にクッキーを同梱させる唯一の手段であり、削除すると本問題が再発する。決定の経緯は `docs/adr/0006-manifest-credentials-behind-cloudflare-access.md` を参照。
- 同種の問題は他プロジェクト（mealie / LibreChat / outline 等）でも Cloudflare Access 固有の事象として報告・修正されている。
