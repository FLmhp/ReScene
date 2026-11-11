"use client";

import { ResceneClient } from "@rescene/api-client";
import { Viewer } from "@rescene/viewer";
import { BrandMark } from "@rescene/workbench";
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
        <span className="mark"><BrandMark size={20} /></span>
        <strong>ReScene</strong>
      </header>
      {url ? (
        <Viewer
          key={`${url}:${renewal}`}
          src={url}
          onRetry={() => void load()}
        />
      ) : (
        <div className="empty">
          <h2>{error || "正在加载场景…"}</h2>
          {error ? <button type="button" disabled={loading} onClick={() => void load()}>重新获取场景</button> : null}
        </div>
      )}
    </main>
  );
}
