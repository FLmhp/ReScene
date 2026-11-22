import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

const dist = new URL("../apps/miniapp/dist/", import.meta.url);
const app = JSON.parse(readFileSync(new URL("app.json", dist), "utf8"));
assert.equal(app.entryPagePath, "pages/index/index");
assert.equal(app.pages[0], app.entryPagePath);
assert.ok(app.pages.includes("pages/focus/index"), "The library focus route must stay registered beside the login entry");
assert.equal(app.lazyCodeLoading, undefined);
// The WeChat module wrapper has a local fetch binding independent of globalThis.
const context = createContext({ wx: {}, fetch: undefined, setTimeout, clearTimeout, URLSearchParams });
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

// The production page concatenates private modules, so exercise its exact shared reader
// in isolation while retaining the built client and Taro request fixtures below.
const readerSource = readFileSync(new URL("../apps/miniapp/src/pages/project/job-logs.ts", import.meta.url), "utf8");
const readerJs = ts.transpileModule(readerSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
runInContext(`globalThis.readerModule = { exports: {} }; (function(module, exports) { ${readerJs}\n})(readerModule, readerModule.exports);`, context);

await runInContext(`
  wx.webpackJsonp.push([["rescene-login-test"], {}, require => {
    const entries = Object.entries(require.m);
    const taro = entries.find(([, factory]) => String(factory).includes('"initNativeApi"') && String(factory).includes('.exports["default"]'));
    const runtime = entries.find(([, factory]) => String(factory).includes("navigator:function()") && String(factory).includes("requestAnimationFrame:function()"));
    const entry = entries.find(([, factory]) => String(factory).includes('"rescene-session-expired"') && String(factory).includes('"rescene-token"'));
    const uploader = entries.find(([, factory]) => String(factory).includes("createOffscreenCanvas") && String(factory).includes("readFileSync"));
    const navigation = entries.find(([, factory]) => String(factory).includes("reLaunch") && String(factory).includes('"/pages/index/index"'));
    const queue = entries.find(([, factory]) => String(factory).includes('"rescene-queue"') && String(factory).includes("getStorageInfoSync"));
    if (!taro || !runtime || !entry || !uploader || !navigation || !queue) throw new Error("Cannot locate built Taro, login, navigation, queue or upload modules");
    let homeUrl;
    let oldIdentityStarted;
    let finishOldIdentity;
    const oldIdentityPending = new Promise(resolve => { oldIdentityStarted = resolve; });
    const oldIdentityResponse = new Promise(resolve => { finishOldIdentity = resolve; });
    const legacy = JSON.stringify([{ kind: "project", id: "old", name: "Legacy fixture", createdAt: 1 }]);
    const createdDrafts = [];
    const logRequests = [];
    const logReplies = [];
    const storage = new Map([["rescene-queue", legacy]]);
    const mediaFiles = new Map([["wxfile://tmp/kept.jpg", 12]]);
    const copiedMedia = [];
    const accessChecks = [];
    const readFiles = [];
    const mediaFs = {
      readFileSync: path => { readFiles.push(path); return new Uint8Array(path === "bad" ? [1, 2, 3] : [255, 216, 255]).buffer; },
      accessSync: path => { accessChecks.push(path); if (!mediaFiles.has(path)) throw new Error("file missing"); },
      mkdirSync: () => {},
      copyFileSync: (src, dest) => { mediaFiles.set(dest, mediaFiles.get(src)); copiedMedia.push([src, dest]); },
      statSync: path => { if (!mediaFiles.has(path)) throw new Error("file missing"); return { size: mediaFiles.get(path) }; },
      unlinkSync: path => { mediaFiles.delete(path); },
    };
    let storageUnavailable = true;
    require.m[runtime[0]] = module => { module.exports = { navigator: { userAgent: "WeChat" }, URLSearchParams }; };
    require.m[taro[0]] = module => {
      module.exports = {
        env: { USER_DATA_PATH: "wxfile://usr" },
        getStorageSync: key => {
          if (storageUnavailable) {
            storageUnavailable = false;
            throw new Error("Storage unavailable at startup");
          }
          return storage.get(key);
        },
        setStorageSync: (key, value) => { storage.set(key, value); },
        removeStorageSync: key => { storage.delete(key); },
        reLaunch: async ({url}) => { homeUrl = url; },
        getFileSystemManager: () => mediaFs,
        createOffscreenCanvas: ({ width, height }) => ({
          createImage: () => ({ set src(_) { this.onload(); } }),
          getContext: () => ({
            drawImage() {},
            getImageData: () => ({ data: new Uint8Array(width * height * 4).fill(255) }),
          }),
        }),
        request: async ({url, header, method, data}) => {
          if (url.endsWith("/v1/auth/login")) {
            const email = JSON.parse(data).email;
            return { statusCode: 200, data: { access_token: email === "stale@example.org" ? "fixture-old-token" : "fixture-token", token_type: "bearer" } };
          }
          if (header.Authorization === "Bearer fixture-old-token" && url.endsWith("/v1/auth/me")) {
            oldIdentityStarted();
            await oldIdentityResponse;
            return { statusCode: 200, data: { id: "old-user", email: "stale@example.org", is_admin: false } };
          }
          if (header.Authorization !== "Bearer fixture-token") throw new Error("Missing login token");
          if (url.endsWith("/v1/auth/me")) return { statusCode: 200, data: { id: "user", email: "test@example.org", is_admin: false } };
          if (url.includes("/v1/jobs/") && url.includes("/logs?")) {
            logRequests.push(url);
            if (!logReplies.length) throw new Error("Unexpected log request");
            const reply = await logReplies.shift();
            if (reply instanceof Error) throw reply;
            return { statusCode: 200, data: { items: reply } };
          }
          if (url.endsWith("/v1/projects") && method === "POST") {
            const { name } = JSON.parse(data);
            createdDrafts.push(name);
            return { statusCode: 201, data: { id: "replayed", name, owner_id: "user", effective_role: "owner" } };
          }
          if (url.endsWith("/v1/projects")) return { statusCode: 200, data: [{ id: "project", name: "Fixture", owner_id: "user", effective_role: "member" }] };
          if (url.endsWith("/project?view=summary")) return { statusCode: 200, data: { id: "project", name: "Fixture", owner_id: "user", effective_role: "member", asset_count: 1, job_count: 0, has_active_jobs: false, cover: null, latest_job: null } };
          if (url.endsWith("/project/assets?cursor=")) return { statusCode: 200, data: { items: [{ id: "a1", filename: "reference.jpg", size: 150, status: "READY" }], next_cursor: null } };
          if (url.endsWith("/project/jobs?cursor=")) return { statusCode: 200, data: { items: [], next_cursor: null } };
          throw new Error("Unexpected request");
        },
      };
    };
    const api = Object.values(require(entry[0]));
    const client = api.find(value => typeof value?.login === "function");
    const authenticate = api.find(value => typeof value === "function" && value.length === 3);
    const currentOwner = api.find(value => typeof value === "function" && String(value).includes(".owner()"));
    const replay = Object.values(require(queue[0])).find(value => typeof value === "function" && String(value).includes(".replay("));
    if (!client || !authenticate || !currentOwner || !replay) throw new Error("Cannot locate compiled auth or queue API");
    globalThis.loginResult = (async () => {
      const openHome = Object.values(require(navigation[0])).find(value => typeof value === "function" && String(value).includes("reLaunch"));
      await openHome();
      if (homeUrl !== "/pages/index/index") throw new Error("Stale entry did not return to the login route");
      const staleLogin = authenticate("login", "stale@example.org", "fixture-password");
      await oldIdentityPending;
      const user = await authenticate("login", "test@example.org", "fixture-password");
      finishOldIdentity();
      if (await staleLogin !== null) throw new Error("Late identity response replaced the newer account");
      const credential = JSON.parse(storage.get("rescene-token"));
      if (credential.token !== "fixture-token" || credential.owner !== user.id) throw new Error("Verified account was not bound to its credential");
      if (storage.get("rescene-queue") !== legacy) throw new Error("Unowned legacy queue changed");
      storage.set("rescene-queue-old-user", legacy);
      storage.set("rescene-queue-user", JSON.stringify([{ kind: "project", id: "mine", name: "Current account draft", createdAt: 2 }]));
      const replayed = await replay(currentOwner(), () => {});
      if (replayed.created !== 1 || createdDrafts.join() !== "Current account draft") throw new Error("Replay did not isolate the current account");
      if (storage.get("rescene-queue-old-user") !== legacy || storage.get("rescene-queue-user") !== "[]") throw new Error("Replay did not persist the current account's completion");
      const [project] = await client.listProjects();
      const workspace = await client.getWorkspace(project.id);
      const inspect = Object.values(require(uploader[0])).find(value => typeof value === "function" && String(value).includes("createOffscreenCanvas"));
      if (!inspect) throw new Error("Cannot locate compiled media inspection");
      const files = [{ path: "one", name: "one.jpg", size: 12 }, { path: "copy", name: "copy.jpg", size: 12 }];
      const warnings = await inspect(files);
      let rejected = false;
      try { await inspect([{path: "bad", name: "bad.jpg", size: 12}]); } catch (error) { rejected = error.message.includes("bad.jpg") && error.message.includes("内容与扩展名不符"); }

      storage.set("rescene-queue-user", JSON.stringify([{ kind: "upload", id: "kept", projectId: "project", uri: "wxfile://tmp/kept.jpg", name: "kept.jpg", mimeType: "image/jpeg", size: 12, createdAt: 4 }]));
      await replay(currentOwner(), () => {});
      const adopted = JSON.parse(storage.get("rescene-queue-user")).find(entry => entry.id === "kept");
      const migrated = Boolean(adopted?.managed) && adopted.uri.includes("/rescene-media/")
        && copiedMedia.some(([, dest]) => dest === adopted.uri);

      storage.set("rescene-queue-user", JSON.stringify([{ kind: "upload", id: "lost", projectId: "project", uri: "wxfile://tmp/lost.jpg", name: "lost.jpg", mimeType: "image/jpeg", size: 12, createdAt: 5 }]));
      await replay(currentOwner(), () => {});
      const keptLost = JSON.parse(storage.get("rescene-queue-user")).some(entry => entry.id === "lost");
      const checkedMissing = accessChecks.includes("wxfile://tmp/lost.jpg") && !readFiles.includes("wxfile://tmp/lost.jpg");
      const log = id => ({ id, level: "info", message: "fixture " + id, created_at: "2026-01-01T00:00:00Z" });
      let shown = [];
      let failures = 0;
      let lastFailure;
      const reader = readerModule.exports.createJobLogReader((id, options) => client.listJobLogs(id, options), rows => { shown = rows; }, error => { failures++; lastFailure = error; });
      const check = (condition, text) => { if (!condition) throw new Error(text); };
      reader.context("one", "", true);
      logReplies.push([], [log(1), log(1)], [log(1), log(2)]);
      await reader.poll();
      await reader.poll();
      check(shown.map(row => row.id).join() === "1", "Empty first page did not acquire and deduplicate the first log: " + lastFailure);
      check(!logRequests[0].includes("after_id=") && !logRequests[1].includes("after_id="), "Empty cursor sent after_id");
      await reader.poll();
      check(logRequests[2].includes("after_id=1") && shown.map(row => row.id).join() === "1,2", "Incremental cursor or deduplication failed");
      logReplies.push(new Error("offline"), [log(3)]);
      await reader.poll();
      check(failures === 1 && shown.length === 2, "Failure discarded logs");
      await reader.poll();
      check(shown.map(row => row.id).join() === "1,2,3", "Failure prevented retry");
      reader.context("one", "warning", true);
      logReplies.push([], [log(4)]);
      await reader.poll();
      await reader.poll();
      check(shown.map(row => row.id).join() === "4" && logRequests.at(-1).includes("level=warning") && !logRequests.at(-1).includes("after_id="), "Empty filtered page did not recover");
      let finishOld;
      logReplies.push(new Promise(resolve => { finishOld = resolve; }));
      const old = reader.poll();
      const inFlightCount = logRequests.length;
      await reader.poll();
      check(logRequests.length === inFlightCount, "Concurrent request was not bounded");
      reader.context("two", "warning", true);
      logReplies.push([log(5)]);
      await reader.poll();
      finishOld([log(99)]);
      await old;
      check(shown.map(row => row.id).join() === "5", "Stale task response was applied");
      let finishLevel;
      logReplies.push(new Promise(resolve => { finishLevel = resolve; }));
      const oldLevel = reader.poll();
      reader.context("two", "error", true);
      logReplies.push([log(5)]);
      await reader.poll();
      finishLevel([log(97)]);
      await oldLevel;
      check(shown.map(row => row.id).join() === "5", "Stale level response was applied");
      let finishHidden;
      logReplies.push(new Promise(resolve => { finishHidden = resolve; }));
      const hidden = reader.poll();
      const count = logRequests.length;
      reader.context("two", "error", false);
      await reader.poll();
      check(logRequests.length === count, "Hidden page polled");
      finishHidden([log(98)]);
      await hidden;
      check(shown.map(row => row.id).join() === "5", "Hidden page accepted a response");
      reader.context("two", "error", true);
      logReplies.push([log(6)]);
      await reader.poll();
      check(logRequests.at(-1).includes("after_id=5") && shown.map(row => row.id).join() === "5,6", "Re-entry did not refetch the tail");
      return [client.getToken(), user.id, project.effective_role, workspace.asset_count, workspace.assets[0].id, warnings.length, rejected, migrated, checkedMissing, keptLost];
    })();
  }]);
  loginResult;
`, context, { displayErrors: false }).then(result => assert.deepEqual([...result], ["fixture-token", "user", "member", 1, "a1", 3, true, true, true, true]));
assert.equal(runInContext("evalAttempts", context), 0);
console.log("Built miniapp validates startup recovery, account-bound login, managed queue media, paged workspace, and media preflight using native API fixtures");
