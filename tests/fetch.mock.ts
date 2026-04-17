declare let global: typeof globalThis;

export function mockFetch({
  json = null,
  ok,
  status = 200,
  headers = {},
}: {
  ok?: boolean;
  json?: unknown;
  status?: number;
  headers?: Record<string, string>;
}) {
  const resolvedOk = ok ?? status < 400;
  global.fetch = jest.fn(async () => ({
    json: async () => json,
    ok: resolvedOk,
    status,
    headers: {
      get: (name: string): string | null => headers[name.toLowerCase()] ?? headers[name] ?? null,
    },
  })) as unknown as typeof fetch;
}
