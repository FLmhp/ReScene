import { Viewer, type ViewerHandle, type ViewerStatus } from "@rescene/viewer";
import "@rescene/viewer/viewer.css";
import { createElement, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

/** Renders into the poster's place; called only from the click boundary in `main.ts`. */
export function mountHeroViewer(stage: HTMLElement): void {
  const src = stage.dataset.modelSrc;
  const app = stage.querySelector<HTMLElement>("[data-hero-app]");
  if (!src || !app) return;
  createRoot(app).render(createElement(HeroViewer, {
    src,
    poster: stage.dataset.modelPoster ?? "",
    stage,
  }));
}

type HeroViewerProps = {
  src: string;
  poster: string;
  stage: HTMLElement;
};

/** Loaded only after the visitor asks for the scene; the static poster remains the fallback. */
export function HeroViewer({ src, poster, stage }: HeroViewerProps) {
  const viewer = useRef<ViewerHandle>(null);
  const [status, setStatus] = useState<ViewerStatus | "">("");
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [autoRotate, setAutoRotate] = useState(() => !reducedMotion);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    stage.classList.add("is-live");
    return () => {
      stage.classList.remove("is-live", "is-ready", "is-error");
    };
  }, [stage]);

  useEffect(() => {
    stage.classList.toggle("is-ready", status === "ready");
    stage.classList.toggle("is-error", status === "error");
  }, [stage, status]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      setReducedMotion(query.matches);
      if (query.matches) setAutoRotate(false);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === stage);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, [stage]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void stage.requestFullscreen?.().catch(() => {});
    }
  };

  return (
    <>
      <Viewer
        ref={viewer}
        src={src}
        poster={poster}
        showControls={false}
        autoRotate={autoRotate}
        autoRotateSeconds={45}
        viewDirection={[0.93, 0.22, -0.29]}
        viewDistance={1.25}
        onStatus={setStatus}
        loadErrorMessage="场景加载失败，请重试。"
      />
      <div className="hero-toolbar" role="group" aria-label="场景控制" hidden={status !== "ready"}>
        <button
          type="button"
          aria-pressed={autoRotate}
          disabled={reducedMotion}
          title={reducedMotion ? "系统已开启减少动态效果" : undefined}
          onClick={() => setAutoRotate((value) => !value)}
        >
          自动旋转
        </button>
        <button type="button" onClick={() => viewer.current?.zoom(0.82)}>放大</button>
        <button type="button" onClick={() => viewer.current?.zoom(1.22)}>缩小</button>
        <button type="button" onClick={() => viewer.current?.reset()}>重置</button>
        <button type="button" aria-pressed={fullscreen} onClick={toggleFullscreen}>
          {fullscreen ? "退出全屏" : "全屏"}
        </button>
      </div>
    </>
  );
}
