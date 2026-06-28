/**
 * ステータスの種類。
 *
 * 文字列のインクルード判定（例: status.includes('失敗')）ではなく
 * discriminated union で扱うことで、表示側の判定漏れと
 * 国際化時の事故を防ぐ。
 */
export type StatusKind = 'loading' | 'success' | 'error';

export type Status = {
  kind: StatusKind;
  message: string;
};

export function statusOf(kind: StatusKind, message: string): Status {
  return { kind, message };
}

export function errorStatus(message: string): Status {
  return { kind: 'error', message };
}

export function successStatus(message: string): Status {
  return { kind: 'success', message };
}

export function loadingStatus(message: string): Status {
  return { kind: 'loading', message };
}

/** 任意のエラーオブジェクトをメッセージ文字列に正規化する。 */
export function normalizeError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
