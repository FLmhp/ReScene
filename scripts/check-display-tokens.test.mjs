import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../packages/design-tokens/src/tokens.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const tokens = {};
runInNewContext(`(function(exports){${compiled}\n})(exports)`, { exports: tokens });
const ratio = (a, b) => {
  const luminance = color => {
    const c = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255).map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
    return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
  };
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

test("generated palettes preserve contrast and endpoints", () => {
  for (const color of ["#9E3150", "#B3483D", "#915A35", "#28536B", "#000000", "#FFFFFF", "#FFFF00", "#0000FF", "#808080"]) {
    for (const dark of [false, true]) {
      const palette = tokens.deriveMonochromePalette(color, dark);
      const backgrounds = ["bg", "bgDeep", "bgSoft", "panel", "panelAlt", "surface", "surfaceStrong"];
      for (const foreground of ["fg", "muted", "accent", "accentStrong", "accentAlt"]) {
        for (const background of backgrounds) assert.ok(ratio(palette[foreground], palette[background]) >= 4.5, `${color} ${dark} ${foreground}/${background}`);
      }
      for (const accent of ["accent", "accentStrong", "accentAlt"]) assert.ok(ratio(palette[accent], palette.onAccent) >= 4.5);
    }
  }
  const palette = tokens.deriveMonochromePalette("#28536B", false);
  assert.equal(palette.bgSoft, "#FBFCFC");
  assert.equal(palette.bgDeep, "#DFE5E9");
  assert.equal(tokens.resolvePalette("jade", false).bg, "#F1F5F4");
  assert.equal(tokens.resolvePalette("ultramarine", true).accent, "#AEC0FF");
  assert.equal(tokens.resolvePalette("ink", false).fg, "#22262D");
});

test("defaults are system plus ultramarine and every colourway name is four characters", () => {
  assert.equal(tokens.themePreference(null), "system");
  assert.equal(tokens.themePreference("sepia"), "system");
  assert.equal(tokens.displayPreferences(null).colorway, "ultramarine");
  assert.equal(tokens.displayPreferences({ colorway: "unknown" }).colorway, "ultramarine");
  assert.equal(tokens.displayPreferences({}, "legacy").colorway, "ultramarine");
  assert.equal(tokens.colorwayPreference("ink"), "ink");
  for (const option of tokens.COLORWAY_OPTIONS) {
    assert.equal([...option.label].length, 4, `${option.value} label must be four characters`);
  }
  const samples = tokens.COLORWAY_OPTIONS.filter(option => option.value !== "custom").map(option => tokens.colorwayPrimary(option.value));
  assert.equal(new Set(samples).size, samples.length, "each colourway previews a distinct primary");
  assert.equal(tokens.colorwayPrimary("custom", "#aa405c"), "#AA405C");
  assert.equal(tokens.colorwayPrimary("custom", "bad"), tokens.DEFAULT_PRIMARY);
  assert.equal(tokens.colorwayPrimary("jade"), "#00665D");
});

test("display storage values are independently normalized", () => {
  for (const input of ["##112233", "red", "#abcd", "#112233url()", null]) assert.equal(tokens.normalizePrimary(input), null);
  assert.equal(tokens.normalizePrimary(" aa405c "), "#AA405C");
  assert.equal(tokens.displayPreferences("invalid", "ultramarine").colorway, "ultramarine");
  const display = tokens.displayPreferences({ colorway: "custom", primary: "bad", fontSize: "large", surface: "solid" });
  assert.equal(display.primary, "#28536B");
  assert.equal(display.colorway, "custom");
  assert.equal(display.fontSize, "large");
  assert.equal(display.surface, "solid");
});

test("workbench boots with OS appearance even with a credential, stored colors, and a URL override", () => {
  const bootstrap = readFileSync(new URL("../apps/web/public/theme-init.js", import.meta.url), "utf8");
  assert.equal(bootstrap, readFileSync(new URL("../apps/desktop/public/theme-init.js", import.meta.url), "utf8"));
  const root = { dataset: {}, style: { setProperty() {} } };
  let listener;
  let storageReads = 0;
  const storage = { "rescene-token": "expired-credential", "rescene-theme": "light", "rescene-colorway": "ink" };
  runInNewContext(bootstrap, {
    document: { documentElement: root },
    location: { pathname: "/", search: "?theme=light" },
    URLSearchParams,
    localStorage: { getItem(key) { storageReads++; return storage[key] ?? null; } },
    matchMedia: () => ({ matches: true, addEventListener(_event, fn) { listener = fn; } }),
  });
  assert.equal(storageReads, 0);
  assert.equal(root.dataset.themePreference, "system");
  assert.equal(root.dataset.theme, "dark");
  assert.equal(root.dataset.colorway, "ultramarine");
  listener({ matches: false });
  assert.equal(root.dataset.theme, "light");
  assert.equal(root.dataset.colorway, "ultramarine");
});

test("standalone viewer and share still honor their independent appearance parameters", () => {
  const bootstrap = readFileSync(new URL("../apps/web/public/theme-init.js", import.meta.url), "utf8");
  const run = (pathname, search, storage) => {
    const root = { dataset: {}, style: { setProperty() {} } };
    let listener;
    runInNewContext(bootstrap, {
      document: { documentElement: root }, location: { pathname, search }, URLSearchParams,
      localStorage: { getItem(key) { if (storage === null) throw Error("blocked"); return storage[key] ?? null; } },
      matchMedia: () => ({ matches: false, addEventListener(_event, fn) { listener = fn; } }),
    });
    return { root, change: matches => listener({ matches }) };
  };
  const viewer = run("/viewer", "?theme=dark", { "rescene-theme": "light", "rescene-colorway": "ink" });
  viewer.change(false);
  assert.equal(viewer.root.dataset.theme, "dark");
  assert.equal(viewer.root.dataset.colorway, "ink");
  const share = run("/share/example", "", null);
  share.root.dataset.colorway = "custom";
  share.root.dataset.primary = "#AA405C";
  share.change(true);
  assert.equal(share.root.dataset.theme, "dark");
  assert.equal(share.root.dataset.primary, "#AA405C");
  assert.equal(share.root.dataset.colorway, "custom");
});
