/**
 * 任意のエラーをログ用メッセージに正規化する。
 *
 * drizzle はクエリ失敗を `DrizzleQueryError`（message に SQL 文 + params ダンプ、
 * 実際の DB エラーは `cause`）で包む。ダンプをログに流すと記事全文が混入して
 * 本質的なエラー文が埋もれるため、cause チェーンを辿って最も根本のメッセージを
 * 採用する（docs/specs/ingest-failure.md §4）。
 */
export function toErrorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  let cause: unknown = error instanceof Error ? error.cause : undefined;
  // cause チェーンが自己参照・相互参照している場合に無限ループしないよう、
  // 訪問済みの cause を記録して停止する
  const visited = new Set<unknown>();
  while (cause !== undefined && cause !== null && !visited.has(cause)) {
    visited.add(cause);
    const inspected = inspectCause(cause);
    // 空メッセージで上書きすると有用な情報を失うため、残す
    if (inspected.message !== '') {
      message = inspected.message;
    }
    cause = inspected.next;
  }
  return message.length > maxLogMessageLength
    ? `${message.slice(0, maxLogMessageLength)}…`
    : message;
}

/**
 * cause の実体（Error または cause と同じ形を持つオブジェクト）から、
 * メッセージと次の cause を取り出す。`Error.cause` は `unknown` として型付けされ、
 * 実際にも `{ message, cause }` 形のプレーンオブジェクトが入ることがあるため、
 * どちらも安全に読む。
 */
function inspectCause(cause: unknown): { message: string; next: unknown } {
  if (cause instanceof Error) {
    return { message: cause.message, next: cause.cause };
  }
  if (typeof cause === 'object' && cause !== null) {
    const record = cause as { message?: unknown; cause?: unknown };
    return {
      message: typeof record.message === 'string' ? record.message : '',
      next: record.cause,
    };
  }
  return { message: String(cause), next: undefined };
}

/** ログ 1 行に載せるメッセージの上限。巨大メッセージの混入を抑える保険。 */
const maxLogMessageLength = 500;
