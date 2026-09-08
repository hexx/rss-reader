/**
 * 同期中の D1 書き込み失敗を表すエラー（ADR-0017）。
 *
 * 相手の都合による取得失敗（Transient Sync Failure）は run を止めないが、
 * **保存できない障害は即座に run を止める**（Sync Abort）。書き込みは取得と
 * 同じ catch に混ざるため、書き込み箇所を `runWrite` で包んで例外を区別する。
 */
export class SyncWriteError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = new.target.name;
    this.cause = cause;
  }
}

export function isSyncWriteError(error: unknown): error is SyncWriteError {
  return error instanceof SyncWriteError;
}

/**
 * D1 への書き込みを実行し、失敗を `SyncWriteError` に正規化する（ADR-0017）。
 *
 * drizzle はクエリ失敗を SQL+params ダンプ入りのエラーで包むが、ここでは原因を
 * 判定しない（**恒久/一時の分類語彙は作らない**）。生エラーは `cause` に保つので、
 * ログ側は `toErrorMessage` で最下層の実文（`UNIQUE constraint failed: ...` 等）を出す。
 */
export async function runWrite<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isSyncWriteError(error)) {
      throw error;
    }
    throw new SyncWriteError('同期中の D1 書き込みに失敗しました。', error);
  }
}
