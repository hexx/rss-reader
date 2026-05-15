import type { D1Database, VectorizeIndex } from '@cloudflare/workers-types';

export interface RuntimeEnv {
  DATABASE_URL?: string;
  OPENCODE_GO_API_KEY?: string;
  OPENCODE_GO_BASE_URL?: string;
  OPENCODE_GO_MODEL?: string;
  VECTOR_DB_PATH?: string;
  VECTOR_DIMENSION?: string;
}

export interface Bindings extends RuntimeEnv {
  ADMIN_PASSWORD?: string;
  ADMIN_USERNAME?: string;
  ASSETS?: {
    fetch(request: Request): Promise<Response>;
  };
  CRON_TIMEZONE?: string;
  DB?: D1Database;
  LOG_DIR?: string;
  LOG_LEVEL?: string;
  VECTORIZE_INDEX?: VectorizeIndex;
}
