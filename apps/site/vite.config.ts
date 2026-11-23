import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { paletteCssVariables, resolvePalette, type Palette } from "../../packages/design-tokens/src/index";
import { DEMO_MODEL_PATH, loadDemoModel } from "./demo-assets";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * The workspace package ships TypeScript sources and is externalised from the
 * config bundle, so the palette is read from the same module by path.
 */
function paletteBlock(selector: string, palette: Palette, dark: boolean): string {
  const declarations = Object.entries(paletteCssVariables(palette))
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
  return `${selector}{color-scheme:${dark ? "dark" : "light"};${declarations}}`;
}

const PALETTE_TOKEN = "@rescene-site-palette;";

/**
 * Replaces `@rescene-site-palette;` with the ultramarine palette for the system,
 * light and dark cases, so the first paint never depends on JavaScript.
 */
function sitePalette(): Plugin {
  const light = paletteBlock(':root[data-site-theme="system"],:root[data-site-theme="light"]', resolvePalette("ultramarine", false), false);
  const systemDark = paletteBlock(':root[data-site-theme="system"]', resolvePalette("ultramarine", true), true);
  const dark = paletteBlock(':root[data-site-theme="dark"]', resolvePalette("ultramarine", true), true);
  const generated = `${light}@media (prefers-color-scheme: dark){${systemDark}}${dark}`;
  return {
    name: "rescene-site-palette",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith(".css") || !code.includes(PALETTE_TOKEN)) return null;
      return { code: code.replaceAll(PALETTE_TOKEN, generated), map: null };
    },
  };
}

/** Fails the build instead of shipping a missing or substituted demo scene. */
function demoModel(): Plugin {
  let pending: Promise<Buffer> | undefined;
  const load = () => (pending ??= loadDemoModel());
  return {
    name: "rescene-site-demo-model",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== DEMO_MODEL_PATH) return next();
        void load().then(
          (bytes) => {
            response.statusCode = 200;
            response.setHeader("Content-Type", "application/octet-stream");
            response.setHeader("Content-Length", String(bytes.length));
            response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            response.end(bytes);
          },
          (error: unknown) => {
            response.statusCode = 503;
            response.setHeader("Content-Type", "text/plain; charset=utf-8");
            response.end(`演示模型不可用：${error instanceof Error ? error.message : String(error)}`);
          },
        );
      });
    },
    async buildStart() {
      const bytes = await load();
      this.emitFile({ type: "asset", fileName: DEMO_MODEL_PATH.slice(1), source: bytes });
    },
  };
}

/** Ships the project and font licences beside the built site, outside `/assets/`. */
function licenseNotices(): Plugin {
  return {
    name: "rescene-site-licenses",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "LICENSE.txt",
        source: readFileSync(new URL("../../LICENSE", import.meta.url)),
      });
      this.emitFile({
        type: "asset",
        fileName: "Inter-LICENSE.txt",
        source: readFileSync(new URL("../../packages/design-tokens/assets/Inter-LICENSE.txt", import.meta.url)),
      });
    },
  };
}

export default defineConfig({
  base: "/",
  publicDir: "public",
  build: {
    assetsInlineLimit: 0,
    // /demo/ is one intentional lazy chunk (WebGL viewer engine); the homepage
    // never loads it, so its size is expected rather than a bundling mistake.
    chunkSizeWarningLimit: 4200,
    rollupOptions: {
      input: {
        main: `${root}index.html`,
        demo: `${root}demo/index.html`,
      },
    },
  },
  esbuild: { jsx: "automatic" },
  plugins: [sitePalette(), demoModel(), licenseNotices(), {
    name: "rescene-site-html",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const version = readFileSync(fileURLToPath(new URL("../../VERSION", import.meta.url)), "utf8").trim();
        if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
          throw new Error("VERSION must contain a valid semantic version");
        }
        return html
          .replaceAll("%RESCENE_VERSION%", version)
          .replaceAll("%RESCENE_DEMO_MODEL%", DEMO_MODEL_PATH);
      },
    },
  }],
});
