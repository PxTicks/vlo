import { vi } from "vitest";

export interface MockResponseOptions {
  status?: number;
  headers?: HeadersInit;
  json?: unknown;
  text?: string;
  blob?: Blob;
}

export function createMockResponse({
  status = 200,
  headers,
  json,
  text,
  blob,
}: MockResponseOptions = {}): Response {
  const responseHeaders = new Headers(headers);
  const bodyText =
    text ?? (json === undefined ? "" : JSON.stringify(json));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: responseHeaders,
    json: vi.fn(async () => json ?? JSON.parse(bodyText)),
    text: vi.fn(async () => bodyText),
    blob: vi.fn(async () => blob ?? new Blob([bodyText])),
  } as unknown as Response;
}

export function stubFetch(
  ...responses: Array<Response | Promise<Response>>
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const response of responses) {
    fetchMock.mockImplementationOnce(async () => response);
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
