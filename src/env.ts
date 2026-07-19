import type { D1Database } from '@cloudflare/workers-types';

export interface RuntimeEnv {
  AI_API_KEY?: string;
  AI_BASE_URL?: string;
  AI_MODEL?: string;
}

export interface Bindings extends RuntimeEnv {
  ASSETS?: {
    fetch(request: Request): Promise<Response>;
  };
  DB?: D1Database;
}
