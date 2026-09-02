# 仕様：拒否された本文の Jina Fallback

決定の根拠は [ADR-0012](../adr/0012-jina-fallback-for-blocked-article-content.md)。既存の律速・退避の前提は [sync-egress-politeness.md](./sync-egress-politeness.md)・[ADR-0009](../adr/0009-unified-egress-governor-with-d1-fetch-buckets.md)・[ADR-0011](../adr/0011-honest-reader-user-agent.md)。用語は [`CONTEXT.md`](../../CONTEXT.md) が権威（Fallback（取得退避） / Jina Fallback（Jina 退避） / Transient Sync Failure / Cooldown）。

## 1. 目標と非目標

**目標**
- リーダ UA・ブラウザ UA の両方で 403/451 を受けた記事本文を、Jina Reader（`r.jina.ai`）経由で取得し、空本文による要約品質の黙っての恒久劣化を防ぐ。
- Jina への依存が律速の礼儀を壊さないこと。Jina へのリクエストは既存の律速層・取得枠・クールダウン機構に統合される。

**非目標**
- 退避の原因特定（Cloudflare 由来か共有エグレス IP 由来か等）。判定は拒否の結果（ステータス）のみで行う。
- 退避事実の永続化、発火頻度の run 集計、markdown 記法の除去（必要になれば `x-respond-with: text` が逃げ道）。
- フィード取得・フィード自動検出・はてブ jsonlite への適用（記事本文取得のみが対象）。
- 429・5xx の退避。相手の明示的な律速要求・不調は既存の律速・クールダウンの領域（sync-egress-politeness.md）に残す。タイムアウト・ボディ超過・リダイレクトループは ADR-0013 により退避対象に含める。

## 2. 退避チェーン（記事本文取得のみ）

```
1. リーダ UA で取得（ADR-0011）
2. 403/451 → ブラウザ UA で 1 回退避（ADR-0011、変更なし）
3. 403/451 → Jina Fallback（新設・最終段）
```

- トリガーは **403/451 と、応答が完結しない失敗（タイムアウト・リダイレクトループ・ボディ超過）**（ADR-0013）。429・5xx では退避しない（相手の律速要求・不調に従う）。
- 退避の事実（どの段階で取れたか）は Source にも取得枠にも保存しない。記事ごとに毎回 1 → 2 → 3 を試す。
- Jina Fallback の成否にかかわらず、記事は既存の `ingestNewArticle` パスで保存される（Jina も失敗 → 本文なしで保存 + 既存 warn）。

## 3. Jina リクエストの契約

- エンドポイント: `https://r.jina.ai/<記事URL>`（prefix 方式）。
- ヘッダー: UA は ADR-0011 のリーダ UA をそのまま使う。`JINA_API_KEY` が設定されている場合は `Authorization: Bearer <key>` を添付、未設定なら添付しない（キーなしの無料枠で動作）。その他の Jina 固有ヘッダーは使わない（取得エンジンは既定の auto に任せる）。
- 応答: 既定の markdown を受け取り、既存の `normalizeText` 相当の正規化（空白圧縮）を経て**そのまま本文**とする。cheerio による本文抽出（`extractArticleContent`）は経ない。先頭の `Title:` / `URL Source:` メタ行は特別扱いしない。
- 形式の逃げ道: markdown 記法が要約品質に問題を起こす場合は `x-respond-with: text` に切り替えられる（初期実装では使わない）。
- 適用する既存の防御（直接取得と共通）:
  - 記事 URL の `ensureSafePageUrl`（内部アドレス・非 http(s) の拒否）
  - 非HTML拡張子の除外（退避の対象にそもそもならない）
  - タイムアウト 15 秒 / ボディ上限 2 MB（`FETCH_TIMEOUT_MS` / `DEFAULT_MAX_HTML_BYTES` の流用）
- 退避に固有の追加防御:
  - 認証情報（userinfo）付きの URL は第三者（Jina）に渡すと漏出になるため**退避しない**。
  - Jina の `Authorization` ヘッダーは**クロスオリジンのリダイレクト先へは送らない**（同一オリジンの追随では維持）。

## 4. 律速との統合

- Jina へのリクエストは `bucketKeyOf` の既存ロジックで **`jina.ai` 枠**（eTLD+1）に割り当たる。専用の Operator Group は不要。
- `jina.ai` 枠専用の枠内最小間隔を新設する（はてな群の `hatenaMinimumDelayMs` と同じパターン）: **3 秒 + ジッター 1 秒（3〜4 秒）**。キーなし無料枠の約 20 RPM 以下に収まる。**キーの有無で間隔は変えない**。
- 枠の確保は記事本文と同じ `wait` モード。枠が他実行に占有されている場合は既存の上限（`maximumSlotWaitMs` = 60 秒）まで待ち、空かなければ `EgressUnavailableError` → 既存の「本文なしで保存」パスへ。**クールダウン中は待たずに即座に弾かれる**（既存 `acquireEgressSlot` の挙動のまま）。
- Jina が 429 / タイムアウト / ボディ超過を返した場合は既存機構のまま **`jina.ai` 枠にクールダウン**（30→60→90 分、`Retry-After` 服従）。`Transient Sync Failure` として次回同期で自己回復する。

## 5. 数値既定値（コード内定数、env 化しない）

| 項目 | 値 |
| --- | --- |
| Jina Fallback の発火条件 | 直接取得の失敗のうち 403/451・タイムアウト・リダイレクトループ・ボディ超過（記事本文のみ。ADR-0013） |
| `jina.ai` 枠の枠内最小間隔 | 3 秒 + ジッター（3〜4 秒） |
| Jina リクエストのタイムアウト / サイズ上限 | **45 秒（専用値。描画完了 networkidle 待ちのため。2026-09-02 実測で 15 秒では間に合わない）** / 2 MB（本文取得と共通の定数） |
| `JINA_API_KEY` | 任意。未設定ならキーなし |

## 6. ログ仕様

| 事象 | レベル | 必須フィールド |
| --- | --- | --- |
| Jina Fallback の発火（Jina 取得の開始） | info | `articleUrl`, `bucket`（`jina.ai`） |
| Jina を含む本文取得の失敗（本文なしで保存） | warn | 既存の行に委ねる（`articleUrl`, `error`, `siteUrl`, `title`）— **二重出ししない** |

- Jina の 429 等で `jina.ai` 枠にクールダウンが入る場合の warn は既存の律速ログ（`nextRetryAt` 付き）の慣行に従う。

## 7. 受入条件（テスト観測点）

1. リーダ UA で 403、ブラウザ UA でも 403 の記事だけ `r.jina.ai` へ退避する。ブラウザ UA で成功した記事は Jina を呼ばない。
2. 429 / タイムアウトでは退避しない（既存の律速・クールダウンのパスのまま）。
3. Jina の markdown 応答が cheerio を経ず、正規化されてそのまま本文として保存される。
4. `jina.ai` 枠が 3〜4 秒間隔で律速される（既定枠の 1〜2 秒より広い）。
5. Jina が 429 を返すと `jina.ai` 枠にクールダウンが設定され、クールダウン中の退避は待たずに本文なしで保存になる（枠が占有されている場合のみ 60 秒まで待つ）。
6. `JINA_API_KEY` 設定時は Bearer ヘッダーを添付し、未設定時は添付しない。
7. 内部アドレス宛・非HTML拡張子の記事 URL は退避しない。

## 8. リスク

- **外部依存の追加**: Jina の可用性・レート制限・応答形式の変更が本文品質に直結する。応答形式の既定変更に気づけるよう、受入条件 3 のテストが形式を固定する。
- **第三者への URL 送信**: 拒否された記事 URL が Jina に送られる。対象は購読先の公開記事 URL であり機密性は低いが、非公開ページの URL がフィード経由で流れた場合は Jina 側に渡る。
- **同期所要時間**: 退避が頻発すると記事あたり最大 +60 秒（枠待ち上限）の伸びがあり得る。Jina 枠のクールダウン中は待たずに本文なし保存へ流れるため、待機が積み重なるのは占有時のみ。
