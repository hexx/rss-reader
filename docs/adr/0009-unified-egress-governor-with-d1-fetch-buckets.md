# 外部取得を単一の律速層に統合し、取得枠単位の間隔・クールダウンを D1 で管理する

定期同期ではてな群（`*.hatenablog.com` / `*.hatenadiary.jp`）の RSS 取得が `429 Too Many Requests` を返し、その Source の同期が 0 件で終わる（＝新着が次の tick まで丸ごと取りこぼされる）状態が頻発していた。429 は相手側の判断であり、Cloudflare Workers の共有エグレス IP 宛に出ている可能性が高いため「1件も受けない」は約束できない。そこで目標を **影響ゼロ（429 は想定内の一時同期障害として自己回復させる）** に置き換え、全外部取得を単一の律速層に統合する。

## 決定内容

- **律速の対象は全 egress**：フィード取得（`fetchRssOrFallback`）、記事本文取得（`fetchArticleContent`）、はてブ jsonlite 取得を 1 つの律速層に集約する。`src/services/hatena.ts` が持つ専用リミッター（1〜3 秒＋ジッター、429/503 バックオフ、`Retry-After` 解析）は**律速層へ移設して廃止**する（二重実装・挙動の非対称を解消）。
- **律速の単位は Fetch Bucket（取得枠）**：既定は登録可能ドメイン（eTLD+1）。同一の相手が同一の quota を課していると扱う **Operator Group** をコード内設定の手動マップで束ね、1 群 = 1 枠とする。はてな群 = `hatena.ne.jp`（`b.hatena.ne.jp` を含む）＋ `*.hatenablog.com` ＋ `*.hatenadiary.jp`。未知の相手は eTLD+1 既定に任せ、必要になってから群に追加する。
- **jsonlite ははてな群バケットに入れたまま**にする（分離しない）。律速の単位は「相手がどう数えるか」に一致させる。1 run の総量は ADR-0010 で絞る。
- **状態は D1 に永続化**する。`fetch_buckets`（1 行 = 1 取得枠: `bucket`, `next_allowed_at`, `cooldown_until`, `consecutive_throttles`）に置き、isolate メモリを権威にしない（cron 実行は別 isolate で走るため、メモリ保持は run 内しか効かない）。Workers KV / Durable Object は追加しない。
- **クールダウン**：30 分 → 60 分 → 90 分（cap）。成功時に `consecutive_throttles` をリセット。`Retry-After` は**尊重し、90 分を超えて要求された場合は cap 元以上の指示に従う**（その旨の warn を 1 本立てる）。相手の明示的な指示を無視して叩き返すのは礼儀の自己矛盾であり、429 を再発させる。
- **予約は CAS**：枠の予約は `UPDATE fetch_buckets SET next_allowed_at = ? WHERE bucket = ? AND cooldown_until <= now AND next_allowed_at <= now` の成否（`RETURNING`）で行い、外れた実行は待機せず後回しにする。
- **礼儀の間隔とクールダウンは別列に持つ**（`next_allowed_at` / `cooldown_until`）。`force` はこのうち **クールダウンだけを無視**し、間隔は守る（`docs/specs/sync-egress-politeness.md` §6）。**ADR-0002 の「排他ロックは導入しない」方針は維持**する（同期全体を止めるロックではなく、枠の予約だけをアトミックにする）。
- **数値既定値はコード内定数を 1 モジュールに集約**（`wrangler.toml` の `[vars]` には出さない）。調整が必要になった値だけを個別に env へ昇格させる。

### 数値既定値

| 項目 | 値 |
| --- | --- |
| 既定の枠内最小間隔 | 1 秒 ＋ジッター（1〜2 秒） |
| はてな群の枠内最小間隔 | 3 秒 ＋ジッター（3〜6 秒） |
| クールダウン段階 | 30 分 → 60 分 → 90 分（cap） |
| `Retry-After` | 秒数・HTTP date とも尊重。90 分超の要求もそのまま従い warn を 1 本 |
| フィード取得 / 本文取得のタイムアウト | 従来どおり（15 秒 / 10 秒） |

### 明示的な非対象（WONTFIX）

- **専用エグレス IP**（Cloudflare Workers は Enterprise 限定）／**取得を外部プロキシ経由にする**／**同期自体を Workers 外の cron に移す** — 運用コストが大きく、今回の目標（影響ゼロ）に比して過剰。
- **cron 間隔の変更**（`15,45` ＋ `0 */3` を据え置き）— 全 Source の鮮度を恒久的に落とし、ADR-0002 の意図を毀損する。
- **条件付き GET（ETag / Last-Modified）による総量削減** — 429 を返している相手の RSS は `cache-control: private` かつ ETag / Last-Modified 欠落が実測で確認済み（zenn 等は Last-Modified あり）。効く相手が限られるため今回では行わない。
- **429 の完全排除**（相手の判断のため保証不能）。

## Considered Options

- **目標を「429 を 1 件も受けない」に置く**: 共有 IP 起因の可能性が高く制御外を仕様化することになるため不採用。
- **Workers KV に枠状態を置く**: 安価だが結果整合で、同一分に古い値を読み得る。cron 主体で読み書き回数が少ないため D1 で足りる。
- **Durable Object で枠を持つ**: 単一ライターで正確だが、新規バインディング・課金・同期処理の依存を増やす。CAS 予約で十分近似できるため不採用。
- **isolate メモリのみ（`hatena.ts` の現状方式）**: cron 実行をまたげないため、取りこぼし（次 tick まで復旧しない）を解決できない。
- **jsonlite を別枠にする**: 相手の quota を自分で食い合うが、実態（同一上流）と単位がズレるため不採用。総量削減で対応する。
- **フィード取得だけ律速する**: 記事本文取得が同じホストを数秒後に叩くため次 tick の RSS 429 を誘発する（本件の一因）。部分適用では抑止にならない。

## Consequences

- はてブ補完の待機列が同じ枠を共有するため、**ADR-0010 の定量＋カーソルが前提として必要**になる（無いと jsonlite 列の後ろに RSS 取得が埋もれる）。
- 1 run の wall 時間が伸びる（通常同期で ＋十数秒、フル同期の jsonlite 待機は 60 件 × 平均 4.5 秒 ≒ 4.5 分）。cron の wall 上限 15 分（ADR-0002）内に収まる計算。
- 429 は warn ログに残るが、`nextRetryAt` を伴い「次回必ず回復する」ことが読んで分かる行になる。
- テストは fake timer と sleep/random の DI を律速層側に集約する（`_setSleepForTest` 等および `src/test-utils/hatena-rate-limiter.ts` は律速層へ移設・退役）。
