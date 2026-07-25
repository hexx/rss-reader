# Cloudflare Access 保護下では PWA マニフェストに `crossorigin="use-credentials"` を付ける

アプリ全体が Cloudflare Access 保護下にあると、`<link rel="manifest">` の取得がデフォルトで認証情報（`CF_Authorization` クッキー）を送らない（credentialless）ため、Access が `manifest.json` をログイン画面へ 302 リダイレクトし、CORS でブロックされる。ログイン済みでも発生する。`index.html` のマニフェストリンクに `crossorigin="use-credentials"` を付与し、fetch にクッキーを同梱させることで解消する。詳細と検証手順は `issues/issue-202607251727-manifest-cors-cloudflare-access.md` を参照。

## Considered Options

- **（採用）マニフェストリンクに `crossorigin="use-credentials"`**: リポジトリ内で完結する1行のコード修正。ログイン済みユーザーのエラーを直接解消する。
- **（不採用）Cloudflare Access の Bypass ポリシーで `manifest.json` 等を公開**: ログイン前でも取得できるが、アセットを公開するセキュリティ姿勢の変更を伴い、リポジトリ外（ダッシュボード）作業になる。ログインしなければ使えないアプリでは「ログイン前のインストール可能性」に実質価値が無いため見送り。
- **（不可）Worker 側で CORS ヘッダを付与**: Access が Worker より前（エッジ）でリダイレクトするため Worker は当該リクエストを受信せず、効果がない。

## Consequences

- `crossorigin="use-credentials"` は same-origin には通常不要に見えるが、**削除すると本問題が再発する**。将来の整理で誤って消さないこと。
- 解消対象はログイン済みの場合のみ。Access セッション切れ時は引き続きエラーが出得るが、これはトップレベルナビゲーションがログイン画面へ遷移する正常動作の一部として許容する。
- `<link rel="icon">` / `apple-touch-icon` はデフォルトで認証情報付き取得のため対象外（触らない）。
