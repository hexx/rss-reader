import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

export const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

// Drizzle: use an in-memory SQLite database and apply schema setup inside each test suite.
// LanceDB: point each suite at a temporary directory and delete it after the test run.
// AI SDK: mock exported functions with vi.mock() and return deterministic responses.
