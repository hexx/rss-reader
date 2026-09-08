# lint 新ルールの error 化にはコード修正で追従する

2026-09-08、Renovate PR（#348 renovate/oxlint-monorepo）が oxlint を 1.78.0 → 1.82.0 に更新したところ、Lint ジョブが失敗した。oxlint 1.79 以降に React Compiler 対応ルール群（`react/set-state-in-effect` など）が correctness カテゴリへ追加され、react プラグイン有効時に error として発火するようになったため。発火は `src/client/hooks/useArticles.ts` の 2 件のみ（①effect 内の同期 setState、②effect deps に含めた ref の余剰）。warnings は従来から許容されている（style/pedantic は warn のまま）。

## 決定

- **依存更新で lint の新ルールが error 化したら、コード修正で追従する**。ルール無効化（`.oxlintrc.json` の変更）もバージョン固定もしない。
- **対応フロー**は「Renovate PR の lint 失敗 → main に先出しで修正 PR をマージ → Renovate が rebase → CI green → automerge 待ち」。修正 PR の CI は旧バージョン（1.78.0）で走るため、新旧両バージョンで lint errors 0 を満たすことを確認してから出す。
- **useArticles.ts は挙動保存の最小再構成で対応**した（全面再設計は採用しない）:
  - effect 内の同期 setState を排除し、ローディング遷移を `refresh` / `loadMore` ハンドラと state 初期値に移動。ローディング文言はレンダー時に offset と showUnreadOnly から導出する（文言の出し分けロジックは不変）。
  - 最新パラメータの参照は `useLatestRef`（ref）+ deps 除外をやめ、React 19.2 の `useEffectEvent` に置き換えた。新ルールと旧ルールが ref の deps 包含について矛盾した要求（extra / missing）をするため、ref 経由の参照自体を廃止するのが唯一のコードのみでの解決だった。
  - リクエスト ID に世代（reloadToken）を織り込み、refresh の強制再取得トリガーを effect 内でも「読む」形にした（新ルールの extra 判定を回避しつつ、requestId の単調性を維持）。
- **warnings は引き続き許容する**。今回、対象ファイル内で読みやすさを損なわない機械的修正（sort-imports / id-length / no-inline-comments 等）のみ一部適用したが、これは部分的な保険的措置であり方針転換ではない。one-var のような複数宣言の結合や日本語コメントの大文字化は、`oxlint --fix` でも可読性を損なうため適用しない。

## Consequences

- 将来の oxlint 更新で新ルールが error 化しても対応方針が定まっており、Renovate の自動マージとリポジトリ慣習（PR 単位 + ADR）に沿って進められる。
- 新旧ルールの矛盾（ref の deps 包含について extra / missing が同時に発火する）に遭遇した場合も、ルール無効化ではなくコード側の構造変更（useEffectEvent 等の React 公式機構）で対応する方針が立っている。
- この対応により、oxlint 1.78.0（現行 CI）と 1.82.0（PR #348）の両方で lint errors 0 を満たす。