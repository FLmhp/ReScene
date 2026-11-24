import { Viewer, type ViewerHandle, type ViewerStatus } from "@rescene/viewer";
import "@rescene/viewer/viewer.css";
import { createElement, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

const megabytes = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

/** Renders into the poster's place; called only from the click boundary in `main.ts`. */
export function mountHeroViewer(stage: HTMLElement): void {
  const src = stage.dataset.modelSrc;
  const app = stage.querySelector<HTMLElement>("[data-hero-app]");
  if (!src || !app) return;

  const load = stage.querySelector<HTMLElement>("[data-hero-load]");
  const label = stage.querySelector<HTMLElement>("[data-hero-load-label]");
  const detail = stage.querySelector<HTMLElement>("[data-hero-load-detail]");
  let shownPercent = -1;

  // Byte counts come from the real artifact download, never a timer.
  const onProgress = (loaded: number, total: number) => {
    if (!load) return;
    load.style.setProperty("--hero-progress", total > 0 ? Math.min(1, loaded / total).toFixed(3) : "0");
    if (total <= 0) return;
    const percent = Math.min(100, Math.floor((loaded / total) * 100));
    if (percent !== shownPercent) {
      shownPercent = percent;
      if (label) label.textContent = `正在加载场景… ${percent}%`;
    }
    if (detail) detail.textContent = `${megabytes(loaded)} / ${megabytes(total)} MB`;
  };

  createRoot(app).render(createElement(HeroViewer, {
    src,
    poster: stage.dataset.modelPoster ?? "",
    stage,
    onProgress,
  }));
}

type HeroViewerProps = {
  src: string;
  poster: string;
  stage: HTMLElement;
  onProgress: (loaded: number, total: number) => void;
};

/** Loaded only after the visitor asks for the scene; the static poster remains the fallback. */
export function HeroViewer({ src, poster, stage, onProgress }: HeroViewerProps) {
  const viewer = useRef<ViewerHandle>(null);
  const [status, setStatus] = useState<ViewerStatus | "">("");
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [autoRotate, setAutoRotate] = useState(() => !reducedMotion);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    stage.classList.toggle("is-ready", status === "ready");
    stage.classList.toggle("is-error", status === "error");
    if (status === "ready" || status === "error") {
      const load = stage.querySelector<HTMLElement>("[data-hero-load]");
      load?.removeAttribute("aria-busy");
      // The pill fades out; take it out of the tab order and the accessibility tree
      // too, so keyboard focus never lands on an invisible link.
      if (load) load.inert = true;
    }
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
        viewDirection={[0.88, 0.25, -0.41]}
        viewDistance={1.43}
        onStatus={setStatus}
        onProgress={onProgress}
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
