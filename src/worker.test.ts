import { describe, expect, it } from 'vitest';

import { app } from './worker.js';

describe('worker scaffold', () => {
  it('responds to health checks', async () => {
    const response = await app.request('/health');

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('ok');
  });
});
