declare let global: typeof globalThis;

export function mockFetch({
  json = null,
  ok = true,
  status = 200,
}: {
  ok?: boolean;
  json?: unknown;
  status?: number;
}) {
  global.fetch = jest.fn(async () => ({
    json: async () => json,
    ok,
    status,
  })) as unknown as typeof fetch;
}
