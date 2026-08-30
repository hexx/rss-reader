import type { D1Database } from '@cloudflare/workers-types';

export interface RuntimeEnv {
  AI_API?: string;
  AI_API_KEY?: string;
  AI_BASE_URL?: string;
  AI_MODEL?: string;
  AI_REASONING_EFFORT?: string;
  /** Jina Fallback（ADR-0012）で使う Jina Reader の API キー。任意（未設定ならキーなし）。 */
  JINA_API_KEY?: string;
}

export interface Bindings extends RuntimeEnv {
  ASSETS?: {
    fetch(request: Request): Promise<Response>;
  };
  DB?: D1Database;
}
