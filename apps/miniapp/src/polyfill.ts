/**
 * WeChat has no `fetch`; adapt Taro.request to the subset the shared API client
 * reads. `body` stays undefined on purpose so the client skips SSE and polls.
 */
import Taro from "@tarojs/taro";
import { z } from "zod";

// WeChat can stub Function without throwing. Disable Zod's eval probe before schemas are created.
z.config({ jitless: true });

type RequestInitLike = {
  method?: string;
  headers?: unknown;
  body?: string;
};

function headerRecord(headers: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers || typeof headers !== "object") return result;
  for (const [key, value] of Object.entries(headers)) result[key] = String(value);
  return result;
}

function headerValue(headers: Record<string, string>, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return "";
}

function normalizePayload(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

// WeChat's per-module global bindings do not reliably share globalThis.fetch.
export const miniappFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = (init ?? {}) as RequestInitLike;
  const method = (request.method ?? "GET").toUpperCase() as
    | "GET"
    | "POST"
    | "PUT"
    | "PATCH"
    | "DELETE";
  const header = headerRecord(request.headers);
  const response = await Taro.request({
    url: String(input),
    method,
    header,
    data: request.body,
  });
  const payload = normalizePayload(response.data);
  const text = typeof response.data === "string" ? response.data : (JSON.stringify(response.data) ?? "");
  const responseHeaders = response.header ?? {};
  // Adapter boundary: the client only reads ok/status/headers.get/json/text.
  return {
    ok: response.statusCode >= 200 && response.statusCode < 300,
    status: response.statusCode,
    headers: { get: (name: string) => headerValue(responseHeaders, name) || null },
    json: async () => payload,
    text: async () => text,
  } as unknown as Response;
};
