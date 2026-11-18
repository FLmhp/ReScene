"use client";

import type { ResceneClient } from "@rescene/api-client";
import { useEffect, useRef, useState } from "react";

export function AssetPreview({ client, id, filename, ready }: { client: ResceneClient; id: string; filename: string; ready: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const image = /\.(jpg|jpeg|png)$/i.test(filename);
  useEffect(() => {
    if (!host.current || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "120px" });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !ready || !image) return;
    let active = true;
    setFailed(false);
    void client.getAssetPreview(id).then((value) => { if (active) setUrl(value.url); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [client, id, ready, image, visible, attempt]);
  return <div className="asset-preview" ref={host}>
    {url && !failed ? <img loading="lazy" src={url} alt={filename} onError={() => setFailed(true)} /> :
      failed ? <button type="button" aria-label={`重试预览 ${filename}`} onClick={() => { setUrl(""); setAttempt((value) => value + 1); }}>重试预览</button> :
      <span aria-hidden="true">{image ? "图片" : "视频"}</span>}
  </div>;
}
