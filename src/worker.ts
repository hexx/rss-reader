import { Hono } from 'hono';

import type { Bindings } from './env.js';

const app = new Hono<{ Bindings: Bindings }>();

app.get('/health', (c) => c.text('ok'));

app.get('*', async (c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.notFound();
  }

  const assets = c.env.ASSETS;
  if (assets) {
    return assets.fetch(c.req.raw);
  }

  return c.text('Cloudflare Worker scaffold is not fully wired yet.', 503);
});

export default {
  fetch: app.fetch,
  scheduled: async () => {
    // Stage 1 only wires the deployment surface.
  },
};

export { app };
