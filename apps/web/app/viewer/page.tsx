"use client";

import { ResceneApiError, ResceneClient } from "@rescene/api-client";
import { Viewer } from "@rescene/viewer";
import { BrandMark } from "@rescene/workbench";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { API_BASE as API } from "../env";
import { messageOf, pickScene } from "../scene";
const TOKEN_KEY = "rescene-token";

type Phase = "loading" | "ready" | "login" | "error";
type BridgeResponse = { type?: string; requestId?: string; src?: string; error?: string };

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
  }
}

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function ViewerPage() {
  const [reconstructionId, setReconstructionId] = useState("");
  const [initialSrc] = useState(() =>
    typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("src") ?? "",
  );
  const [native, setNative] = useState(false);
  const [src, setSrc] = useState("");
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [renewal, setRenewal] = useState(0);
  const pendingRequest = useRef<string | null>(null);
  const sceneRef = useRef(false);

  const loadBrowser = useCallback(async (id: string) => {
    const token = window.localStorage.getItem(TOKEN_KEY) ?? "";
    if (!token) {
      setBusy(false);
      setPhase("login");
      return;
    }
    setPhase("loading");
    setBusy(true);
    setError("");
    try {
      const client = new ResceneClient(API, token);
      const manifest = await client.getManifest(id);
      const scene = pickScene(manifest.artifacts);
      if (!scene) throw new Error("该重建没有可查看的场景产物（SPZ/PLY）。");
      setSrc(scene);
      setPhase("ready");
    } catch (reason) {
      if (reason instanceof ResceneApiError && reason.status === 401) {
        window.localStorage.removeItem(TOKEN_KEY);
        setError("登录已过期，请重新登录。");
        setPhase("login");
      } else {
        setError(messageOf(reason));
        setPhase("error");
      }
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("reconstruction") ?? "";
    setReconstructionId(id);
    const bridge = typeof window.ReactNativeWebView?.postMessage === "function";
    setNative(bridge);
    if (initialSrc) {
      // An initial URL can render immediately; renewal happens on retry.
      sceneRef.current = true;
      setSrc(initialSrc);
      setPhase("ready");
      return;
    }
    if (bridge && id) return;
    if (id) {
      void loadBrowser(id);
      return;
    }
    setError("缺少场景参数。请从工作台重新打开 Viewer 链接。");
    setPhase("error");
  }, [initialSrc, loadBrowser]);

  // Native hosts own authentication: the web layer asks for a fresh manifest URL
  // through the frozen JSON bridge and never receives a bearer token.
  useEffect(() => {
    if (!native || !reconstructionId) return;
    if (renewal === 0 && sceneRef.current) return;
    const onMessage = (event: MessageEvent) => {
      // Injected native responses have no source; anything from an embedding
      // window is untrusted and must not be able to spoof a manifest URL.
      if (event.source !== null && event.source !== window) return;
      if (typeof event.data !== "string") return;
      let payload: BridgeResponse;
      try {
        payload = JSON.parse(event.data) as BridgeResponse;
      } catch {
        return;
      }
      if (payload.type !== "RESCENE_MANIFEST_RESPONSE") return;
      if (!payload.requestId || payload.requestId !== pendingRequest.current) return;
      pendingRequest.current = null;
      if (payload.src) {
        setSrc(payload.src);
        setError("");
        setPhase("ready");
      } else {
        setSrc("");
        setError(payload.error || "无法获取场景下载地址。");
        setPhase("error");
      }
    };
    window.addEventListener("message", onMessage);
    const requestId = newRequestId();
    pendingRequest.current = requestId;
    setPhase("loading");
    setError("");
    const timer = window.setTimeout(() => {
      if (pendingRequest.current !== requestId) return;
      setError("原生客户端未返回场景地址，请重试。");
      setPhase("error");
    }, 20000);
    try {
      window.ReactNativeWebView?.postMessage(
        JSON.stringify({ type: "RESCENE_MANIFEST_REQUEST", reconstructionId, requestId }),
      );
    } catch {
      pendingRequest.current = null;
      setError("无法与原生客户端通信，请重新打开应用。");
      setPhase("error");
    }
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
    };
  }, [native, reconstructionId, renewal]);

  const retry = useCallback(() => {
    setRenewal((value) => value + 1);
    if (native) return; // the bridge effect re-requests the manifest
    if (reconstructionId) {
      void loadBrowser(reconstructionId);
      return;
    }
    // A legacy `?src=` URL has no renewable identity by design.
    setError("此链接不含重建标识，无法刷新签名地址，请从工作台重新打开 Viewer。");
    setPhase("error");
  }, [native, reconstructionId, loadBrowser]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const client = new ResceneClient(API);
      const result = await client.login(email, password);
      window.localStorage.setItem(TOKEN_KEY, result.access_token);
      setPassword("");
      await loadBrowser(reconstructionId);
    } catch (reason) {
      setError(messageOf(reason));
      setPhase("login");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shared-scene">
      <header className="shared-brand">
        <span className="mark"><BrandMark size={20} /></span>
        <strong>ReScene</strong>
      </header>
      {phase === "ready" && src ? (
        <Viewer key={`${src}:${renewal}`} src={src} reconstructionId={reconstructionId} onRetry={retry} />
      ) : (
        <section className="empty" aria-live="polite">
          {phase === "login" ? (
            <>
              <h2>使用 ReScene 账号查看</h2>
              <p>该场景属于私有重建，请使用邮箱和密码登录。</p>
              <form onSubmit={signIn}>
                <label>
                  邮箱
                  <input
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </label>
                <label>
                  密码
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
                {error ? <p className="error" role="alert">{error}</p> : null}
                <button type="submit" disabled={busy}>{busy ? "正在登录…" : "登录并查看"}</button>
              </form>
            </>
          ) : phase === "error" ? (
            <>
              <h2>场景加载失败</h2>
              <p className="error" role="alert">{error || "请稍后重试。"}</p>
              <button type="button" disabled={busy} onClick={retry}>重新获取场景</button>
              {reconstructionId && !native ? (
                <button type="button" onClick={() => { window.localStorage.removeItem(TOKEN_KEY); setError(""); setPhase("login"); }}>
                  重新登录
                </button>
              ) : null}
            </>
          ) : (
            <h2 role="status">正在加载场景…</h2>
          )}
        </section>
      )}
    </main>
  );
}
