import type { D1Database, VectorizeIndex } from '@cloudflare/workers-types';

export interface RuntimeEnv {
  OPENCODE_GO_API_KEY?: string;
  OPENCODE_GO_BASE_URL?: string;
  OPENCODE_GO_MODEL?: string;
  OPENAI_API_KEY?: string;
}

export interface Bindings extends RuntimeEnv {
  ADMIN_PASSWORD?: string;
  ADMIN_USERNAME?: string;
  ASSETS?: {
    fetch(request: Request): Promise<Response>;
  };
  DB?: D1Database;
  VECTORIZE_INDEX?: VectorizeIndex;
}
