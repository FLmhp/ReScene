"use client";

import { ResceneClient } from "@rescene/api-client";
import { Viewer } from "@rescene/viewer";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { API_BASE as API } from "../../env";
import { messageOf, pickScene } from "../../scene";

export default function SharedScene({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [renewal, setRenewal] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const share = await new ResceneClient(API).getPublicShare(token);
      const scene = pickScene(share.artifacts);
      if (!scene) throw new Error("场景产物不可用");
      setUrl(scene);
      setRenewal((value) => value + 1);
    } catch (reason) {
      setUrl("");
      setError(messageOf(reason));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="shared-scene">
      <header className="shared-brand">
        <Link href="/" prefetch={false}>返回工作台</Link>
        <h1>共享场景</h1>
      </header>
      {url ? (
        <Viewer
          key={`${url}:${renewal}`}
          src={url}
          onRetry={() => void load()}
        />
      ) : (
        <section className="empty" aria-live="polite">
          {error ? (
            <>
              <h2>场景加载失败</h2>
              <p className="error" role="alert">{error}</p>
              <button type="button" disabled={loading} onClick={() => void load()}>重新获取场景</button>
            </>
          ) : (
            <h2 role="status">正在加载场景…</h2>
          )}
        </section>
      )}
    </main>
  );
}
