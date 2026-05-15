declare module 'express-basic-auth' {
  import type { RequestHandler } from 'express';

  export interface BasicAuthOptions {
    challenge?: boolean;
    realm?: string;
    users: Record<string, string>;
  }

  export default function basicAuth(options: BasicAuthOptions): RequestHandler;
}
