import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const dist = new URL("../apps/miniapp/dist/", import.meta.url);
// The WeChat module wrapper has a local fetch binding independent of globalThis.
const context = createContext({ wx: {}, fetch: undefined, setTimeout, clearTimeout });
Object.defineProperty(context, "fetch", { get: () => undefined, set: () => {} });
runInContext(`
  let evalAttempts = 0;
  Function = new Proxy(Function, {
    construct() { evalAttempts++; return {}; },
  });
`, context);
for (const file of ["runtime.js", "vendors.js", "taro.js", "common.js"]) {
  runInContext(readFileSync(new URL(file, dist), "utf8"), context, { filename: file, displayErrors: false });
}

await runInContext(`
  wx.webpackJsonp.push([["rescene-login-test"], {}, require => {
    const entries = Object.entries(require.m);
    const taro = entries.find(([, factory]) => String(factory).includes('"initNativeApi"') && String(factory).includes('.exports["default"]'));
    const runtime = entries.find(([, factory]) => String(factory).includes("navigator:function()") && String(factory).includes("requestAnimationFrame:function()"));
    const entry = entries.find(([, factory]) => String(factory).includes('"rescene-session-expired"') && String(factory).includes('"/v1/auth/login"'));
    const uploader = entries.find(([, factory]) => String(factory).includes("createOffscreenCanvas") && String(factory).includes("readFileSync"));
    if (!taro || !runtime || !entry || !uploader) throw new Error("Cannot locate built Taro, login or upload modules");
    require.m[runtime[0]] = module => { module.exports = { navigator: { userAgent: "WeChat" } }; };
    require.m[taro[0]] = module => {
      module.exports = {
        getStorageSync: () => "",
        getFileSystemManager: () => ({ readFileSync: path => new Uint8Array(path === "bad" ? [1, 2, 3] : [255, 216, 255]).buffer }),
        createOffscreenCanvas: ({ width, height }) => ({
          createImage: () => ({ set src(_) { this.onload(); } }),
          getContext: () => ({
            drawImage() {},
            getImageData: () => ({ data: new Uint8Array(width * height * 4).fill(255) }),
          }),
        }),
        request: async ({url, header}) => {
          if (url.endsWith("/v1/auth/login")) return { statusCode: 200, data: { access_token: "fixture-token", token_type: "bearer" } };
          if (header.Authorization !== "Bearer fixture-token") throw new Error("Missing login token");
          if (url.endsWith("/v1/auth/me")) return { statusCode: 200, data: { id: "user", email: "test@example.org", is_admin: false } };
          if (url.endsWith("/v1/projects")) return { statusCode: 200, data: [{ id: "project", name: "Fixture", owner_id: "user", effective_role: "member" }] };
          if (url.endsWith("/project?view=summary")) return { statusCode: 200, data: { id: "project", name: "Fixture", owner_id: "user", effective_role: "member", asset_count: 1, job_count: 0, has_active_jobs: false, cover: null, latest_job: null } };
          if (url.endsWith("/project/assets?cursor=")) return { statusCode: 200, data: { items: [{ id: "a1", filename: "reference.jpg", size: 150, status: "READY" }], next_cursor: null } };
          if (url.endsWith("/project/jobs?cursor=")) return { statusCode: 200, data: { items: [], next_cursor: null } };
          throw new Error("Unexpected request");
        },
      };
    };
    const client = Object.values(require(entry[0])).find(value => typeof value?.login === "function");
    globalThis.loginResult = (async () => {
      const login = await client.login("test@example.org", "fixture-password");
      const user = await client.getMe();
      const [project] = await client.listProjects();
      const workspace = await client.getWorkspace(project.id);
      const inspect = Object.values(require(uploader[0])).find(value => typeof value === "function" && String(value).includes("createOffscreenCanvas"));
      if (!inspect) throw new Error("Cannot locate compiled media inspection");
      const files = [{ path: "one", name: "one.jpg", size: 12 }, { path: "copy", name: "copy.jpg", size: 12 }];
      const warnings = await inspect(files);
      let rejected = false;
      try { await inspect([{path: "bad", name: "bad.jpg", size: 12}]); } catch { rejected = true; }
      return [login.access_token, user.id, project.effective_role, workspace.asset_count, workspace.assets[0].id, warnings.length, rejected];
    })();
  }]);
  loginResult;
`, context, { displayErrors: false }).then(result => assert.deepEqual([...result], ["fixture-token", "user", "member", 1, "a1", 3, true]));
assert.equal(runInContext("evalAttempts", context), 0);
console.log("Built miniapp validates login, paged workspace, and media preflight using native API fixtures");
