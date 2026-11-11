/** Production defaults are explicit; local development keeps localhost. */
export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === "production" ? "https://api.rescene.xyz" : "http://localhost:8000");

export const WEB_BASE =
  process.env.NEXT_PUBLIC_WEB_URL ??
  (process.env.NODE_ENV === "production" ? "https://app.rescene.xyz" : "");
