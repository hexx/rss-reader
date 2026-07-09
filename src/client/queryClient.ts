import { QueryClient } from '@tanstack/react-query';

/** クライアント側で共有する QueryClient のファクトリ。 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 30_000,
      },
    },
  });
}
