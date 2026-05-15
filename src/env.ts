import type { D1Database, VectorizeIndex } from '@cloudflare/workers-types';

export interface Bindings {
  ADMIN_PASSWORD?: string;
  ADMIN_USERNAME?: string;
  ASSETS?: {
    fetch(request: Request): Promise<Response>;
  };
  CRON_TIMEZONE?: string;
  DATABASE_URL?: string;
  DB?: D1Database;
  LOG_DIR?: string;
  LOG_LEVEL?: string;
  OPENCODE_GO_API_KEY?: string;
  OPENCODE_GO_BASE_URL?: string;
  OPENCODE_GO_MODEL?: string;
  VECTOR_DB_PATH?: string;
  VECTOR_DIMENSION?: string;
  VECTORIZE_INDEX?: VectorizeIndex;
}
