import { describe, expect, it, vi } from 'vitest';

const { drizzleMock } = vi.hoisted(() => ({
  drizzleMock: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: drizzleMock,
}));

import { getDb } from './index.js';

describe('database env adapter', () => {
  it('forwards the D1 binding to drizzle', () => {
    const client = { tag: 'db-client' };
    const d1 = {} as never;
    drizzleMock.mockReturnValue(client);

    expect(getDb({ DB: d1 } as never)).toBe(client);
    expect(drizzleMock).toHaveBeenCalledWith(d1, expect.objectContaining({ schema: expect.any(Object) }));
  });
});
