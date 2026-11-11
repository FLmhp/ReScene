import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  publicDir: "public",
  build: { assetsInlineLimit: 0 },
  plugins: [{
    name: "rescene-version",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const version = readFileSync(fileURLToPath(new URL("../../VERSION", import.meta.url)), "utf8").trim();
        if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
          throw new Error("VERSION must contain a valid semantic version");
        }
        return html.replaceAll("%RESCENE_VERSION%", version);
      },
    },
  }],
});
