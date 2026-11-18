import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const dist = new URL("../apps/miniapp/dist/", import.meta.url);
// The WeChat module wrapper has a local fetch binding independent of globalThis.
const context = createContext({ wx: {}, fetch: undefined });
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
    if (!taro || !runtime || !entry) throw new Error("Cannot locate built Taro or API modules");
    require.m[runtime[0]] = module => { module.exports = { navigator: { userAgent: "WeChat" } }; };
    require.m[taro[0]] = module => {
      module.exports = {
        getStorageSync: () => "",
        request: async ({url, header}) => {
          if (url.endsWith("/v1/auth/login")) return { statusCode: 200, data: { access_token: "fixture-token", token_type: "bearer" } };
          if (header.Authorization !== "Bearer fixture-token") throw new Error("Missing login token");
          if (url.endsWith("/v1/auth/me")) return { statusCode: 200, data: { id: "user", email: "test@example.org", is_admin: false } };
          if (url.endsWith("/v1/projects")) return { statusCode: 200, data: [{ id: "project", name: "Fixture", owner_id: "user", effective_role: "member" }] };
          throw new Error("Unexpected request");
        },
      };
    };
    const client = Object.values(require(entry[0])).find(value => typeof value?.login === "function");
    globalThis.loginResult = (async () => {
      const login = await client.login("test@example.org", "fixture-password");
      const user = await client.getMe();
      const [project] = await client.listProjects();
      return [login.access_token, user.id, project.effective_role];
    })();
  }]);
  loginResult;
`, context, { displayErrors: false }).then(result => assert.deepEqual([...result], ["fixture-token", "user", "member"]));
assert.equal(runInContext("evalAttempts", context), 0);
console.log("Built miniapp login validates the response without dynamic code generation");
