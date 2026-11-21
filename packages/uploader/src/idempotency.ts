/**
 * Creates the client-side retry key shared by browsers, Android and the Mini Program.
 *
 * `crypto.randomUUID` exists in browsers, the Tauri webview and recent Expo
 * runtimes; the fallbacks keep a stable 32-character key elsewhere.
 */
export function newIdempotencyKey(): string {
  const api = globalThis.crypto as { randomUUID?: () => string; getRandomValues?: (values: Uint8Array) => Uint8Array } | undefined;
  if (typeof api?.randomUUID === "function") return api.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof api?.getRandomValues === "function") api.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}
