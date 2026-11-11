import { ResceneClient } from "@rescene/api-client";
import { createWebUploader } from "@rescene/uploader/web";
import { Viewer, type ViewerProps } from "@rescene/viewer";
import { Workbench, type KeyValueStore } from "@rescene/workbench";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

import "@rescene/design-tokens/web.css";
import "@rescene/viewer/viewer.css";
import "@rescene/workbench/workbench.css";

const API = import.meta.env.VITE_API_URL ?? (import.meta.env.PROD ? "https://api.rescene.xyz" : "http://localhost:8000");
const WEB = import.meta.env.VITE_WEB_URL ?? (import.meta.env.PROD ? "https://app.rescene.xyz" : "http://localhost:3000");

const tokenStore: KeyValueStore = {
  get: (key) => window.localStorage.getItem(key),
  set: (key, value) => window.localStorage.setItem(key, value),
  remove: (key) => window.localStorage.removeItem(key),
};

/**
 * Tauri must show only a size- and SHA-256-verified cache entry. A remote URL is
 * used directly only in browser preview, where the native cache is unavailable.
 */
function DesktopViewer({ src, artifactKind, reconstructionId, sha256, size, onStatus, onRetry }: ViewerProps) {
  const [cached, setCached] = useState<{ identity: string; src: string } | null>(null);
  const [failure, setFailure] = useState<{ identity: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const retryRef = useRef(onRetry);
  retryRef.current = onRetry;

  const native = Boolean(window.__TAURI_INTERNALS__);
  const digest = (sha256 ?? "").toLowerCase();
  const extension = artifactKind === "ply" ? "ply" : "spz";
  const identity = `${reconstructionId ?? ""}:${extension}:${digest}:${size ?? 0}`;
  const identityReady = reconstructionId !== undefined && reconstructionId !== "" && /^[0-9a-f]{64}$/.test(digest)
    && (artifactKind === "spz" || artifactKind === "ply")
    && size !== undefined && Number.isSafeInteger(size) && size > 0;

  useEffect(() => {
    let active = true;
    setCached(null);
    setFailure(null);
    if (!native) {
      if (import.meta.env.DEV) return;
      const message = "桌面缓存桥不可用，无法校验场景。";
      setFailure({ identity, message });
      statusRef.current?.("error", message);
      return;
    }
    if (!identityReady || !reconstructionId || sha256 === undefined || size === undefined) {
      const message = "场景缺少 SHA-256 或大小，无法校验缓存。";
      setFailure({ identity, message });
      statusRef.current?.("error", message);
      return;
    }
    statusRef.current?.("loading", "正在校验场景缓存");
    invoke<string>("cache_artifact", { url: src, reconstructionId, kind: extension, sha256: digest, size })
      .then((path) => {
        if (active) setCached({ identity, src: convertFileSrc(path) });
      })
      .catch((reason: unknown) => {
        if (!active) return;
        const message = `场景缓存失败：${reason instanceof Error ? reason.message : String(reason)}`;
        setFailure({ identity, message });
        statusRef.current?.("error", message);
      });
    return () => {
      active = false;
    };
  }, [attempt, digest, extension, identity, identityReady, native, reconstructionId, sha256, size, src]);

  const retry = useCallback(() => {
    setCached(null);
    setFailure(null);
    setAttempt((value) => value + 1);
    retryRef.current?.();
  }, []);

  if (!native && import.meta.env.DEV) {
    return (
      <Viewer
        src={src}
        artifactKind={artifactKind}
        reconstructionId={reconstructionId}
        sha256={sha256}
        size={size}
        onStatus={onStatus}
        onRetry={onRetry}
      />
    );
  }

  const cachedSrc = cached && cached.identity === identity ? cached.src : "";
  const error = failure && failure.identity === identity ? failure.message : "";
  const failureMessage = error || (!native ? "桌面缓存桥不可用，无法校验场景。" : "");
  if (failureMessage) {
    return (
      <div
        role="alert"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          width: "100%",
          minHeight: 240,
          padding: 24,
          boxSizing: "border-box",
          color: "var(--fg, #e8eef7)",
          background: "var(--bg, #070b12)",
          textAlign: "center",
        }}
      >
        <strong>场景未通过完整性校验</strong>
        <span>{failureMessage}</span>
        {native && <button type="button" onClick={retry}>重试</button>}
      </div>
    );
  }

  if (!cachedSrc) {
    return (
      <div
        role="status"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          minHeight: 240,
          color: "var(--fg, #e8eef7)",
          background: "var(--bg, #070b12)",
        }}
      >
        正在校验场景缓存…
      </div>
    );
  }

  return (
    <Viewer
      src={cachedSrc}
      artifactKind={artifactKind}
      reconstructionId={reconstructionId}
      sha256={sha256}
      size={size}
      onStatus={onStatus}
      onRetry={retry}
    />
  );
}

export function App() {
  const [client] = useState(() => new ResceneClient(API));
  const [uploader] = useState(() => createWebUploader(client));
  return (
    <Workbench
      client={client}
      uploader={uploader}
      viewer={DesktopViewer}
      tokenStore={tokenStore}
      webBaseUrl={WEB}
    />
  );
}
