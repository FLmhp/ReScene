import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { paletteCssVariables, resolvePalette, type Palette } from "../../packages/design-tokens/src/index";

const root = fileURLToPath(new URL(".", import.meta.url));
const DEMO_MODEL_BYTES = 4_982_770;
const DEMO_MODEL_SHA256 = "5e4b4505ea46fd54f9a7a9b4da55a960c7a1029f040decb66b15c75c47afba0a";
const DEMO_MODEL_PATH = `/assets/knock-community-hall-${DEMO_MODEL_SHA256.slice(0, 8)}.spz`;

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
      const file = id.split("?")[0];
      if (!file.endsWith(".css") || !code.includes(PALETTE_TOKEN)) return null;
      return { code: code.replaceAll(PALETTE_TOKEN, generated), map: null };
    },
  };
}

/** Fails the build instead of shipping a missing, stale or substituted demo scene. */
function demoModelCheck(): Plugin {
  return {
    name: "rescene-site-demo-model",
    buildStart() {
      const bytes = readFileSync(new URL(`./public${DEMO_MODEL_PATH}`, import.meta.url));
      if (bytes.length !== DEMO_MODEL_BYTES) {
        throw new Error(`Demo model must be ${DEMO_MODEL_BYTES} bytes, found ${bytes.length}`);
      }
      if (createHash("sha256").update(bytes).digest("hex") !== DEMO_MODEL_SHA256) {
        throw new Error("Demo model SHA-256 differs from the pinned digest");
      }
    },
  };
}

/** Injects a tiny blocking, hashed script before CSS so a saved theme never flashes. */
function themeBootstrap(): Plugin {
  let tag = "";
  return {
    name: "rescene-site-theme-bootstrap",
    apply: "build",
    buildStart() {
      const source = readFileSync(new URL("./src/theme-init.js", import.meta.url), "utf8");
      const digest = createHash("sha256").update(source).digest("hex").slice(0, 10);
      const fileName = `assets/theme-init-${digest}.js`;
      this.emitFile({ type: "asset", fileName, source });
      tag = `<script src="/${fileName}"></script>`;
    },
    transformIndexHtml(html) {
      return html.replace("<!-- rescene-theme-init -->", tag);
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
  plugins: [sitePalette(), demoModelCheck(), themeBootstrap(), licenseNotices(), {
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
