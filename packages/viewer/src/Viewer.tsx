import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { useEffect, useId, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export type ViewerStatus = "loading" | "ready" | "error";

export type ViewerProps = {
  src: string;
  /** Identity of the reconstruction that produced `src`; used by host apps for renewal. */
  reconstructionId?: string;
  /** Manifest artifact kind (`spz` or `ply`) so hosts can cache the right extension. */
  artifactKind?: string;
  /** Hash and byte size of the scene artifact, for host cache identity. */
  sha256?: string;
  size?: number;
  poster?: string;
  onStatus?: (status: ViewerStatus, detail?: string) => void;
  onRetry?: () => void;
  /** Enable arrow-key orbit, +/− zoom and Home reset while the viewport has focus. */
  keyboardControls?: boolean;
  /** Replace the reconstruction-load failure text when the source is not a signed URL. */
  loadErrorMessage?: string;
};

const LOADING = "正在加载场景";
const EXPIRED = "场景地址可能已过期，或场景文件解析失败。请重试以刷新下载地址。";
const ORBIT_STEP = THREE.MathUtils.degToRad(15);
const ZOOM_STEP = 1.15;

export function Viewer({ src, poster, onStatus, onRetry, keyboardControls = false, loadErrorMessage }: ViewerProps) {
  const host = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const [status, setStatus] = useState(LOADING);
  const [failed, setFailed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const hintId = useId();
  const statusCallback = useRef(onStatus);
  statusCallback.current = onStatus;
  const failureMessage = useRef(loadErrorMessage);
  failureMessage.current = loadErrorMessage;

  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === shell.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const toggleFullscreen = () => {
    const target = shell.current;
    if (!target) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    if (target.requestFullscreen) void target.requestFullscreen().catch(() => {});
  };

  useEffect(() => {
    if (!host.current) return;
    let active = true;
    const report = (next: ViewerStatus, detail?: string) => {
      if (!active) return;
      setFailed(next === "error");
      setStatus(detail ?? (next === "ready" ? "" : next === "loading" ? LOADING : "加载失败"));
      statusCallback.current?.(next, detail);
    };
    report("loading");
    const element = host.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070b12);
    const width = Math.max(1, element.clientWidth);
    const height = Math.max(1, element.clientHeight);
    const camera = new THREE.PerspectiveCamera(58, width / height, 0.01, 1000);
    camera.position.set(0, 0, 3);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false });
    } catch {
      report("error", "无法启动 WebGL2。请检查浏览器硬件加速或更换浏览器。");
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, width < 900 ? 1 : 1.5));
    renderer.setSize(width, height);
    element.appendChild(renderer.domElement);
    scene.add(new SparkRenderer({ renderer }));
    const splats = new SplatMesh({ url: src });
    splats.quaternion.set(1, 0, 0, 0);
    scene.add(splats);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controlsRef.current = controls;
    cameraRef.current = camera;
    let needsRender = true;
    let settleUntil = 0;
    let lastSettleRender = 0;
    controls.addEventListener("change", () => { needsRender = true; });
    let decoded = false;
    void splats.initialized.then(
      () => {
        if (!active) return;
        splats.updateMatrixWorld(true);
        const sphere = splats
          .getBoundingBox(true)
          .applyMatrix4(splats.matrixWorld)
          .getBoundingSphere(new THREE.Sphere());
        if (Number.isFinite(sphere.radius) && sphere.radius > 0) {
          controls.target.copy(sphere.center);
          camera.position
            .copy(sphere.center)
            .addScaledVector(new THREE.Vector3(0.35, 0.2, 1).normalize(), 2.2 * sphere.radius);
          camera.near = Math.max(0.001, sphere.radius / 500);
          camera.far = Math.max(100, 30 * sphere.radius);
          camera.updateProjectionMatrix();
          controls.update();
        }
        controls.saveState();
        decoded = true;
        needsRender = true;
        settleUntil = performance.now() + 5000;
      },
      () => report("error", failureMessage.current ?? EXPIRED),
    );
    const resize = () => {
      const nextWidth = Math.max(1, element.clientWidth);
      const nextHeight = Math.max(1, element.clientHeight);
      camera.aspect = nextWidth / nextHeight;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(Math.min(devicePixelRatio, nextWidth < 900 ? 1 : 1.5));
      renderer.setSize(nextWidth, nextHeight);
      needsRender = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    renderer.setAnimationLoop(() => {
      controls.update();
      const now = performance.now();
      if (now < settleUntil && now - lastSettleRender >= 100) {
        lastSettleRender = now;
        needsRender = true;
      }
      if (needsRender) {
        needsRender = false;
        renderer.render(scene, camera);
      }
      if (decoded && !element.dataset.rendered) {
        element.dataset.rendered = "true";
        report("ready");
      }
    });
    return () => {
      active = false;
      observer.disconnect();
      renderer.setAnimationLoop(null);
      controlsRef.current = null;
      cameraRef.current = null;
      controls.dispose();
      splats.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      delete element.dataset.rendered;
    };
  }, [src, attempt]);

  useEffect(() => {
    if (!keyboardControls) return;
    const element = host.current;
    if (!element) return;
    element.tabIndex = 0;
    const orbit = (key: string) => {
      const controls = controlsRef.current;
      const camera = cameraRef.current;
      if (!controls || !camera) return false;
      if (key === "Home") {
        controls.reset();
        return true;
      }
      const spherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
      if (key === "ArrowLeft") spherical.theta -= ORBIT_STEP;
      else if (key === "ArrowRight") spherical.theta += ORBIT_STEP;
      else if (key === "ArrowUp") spherical.phi = Math.max(controls.minPolarAngle, spherical.phi - ORBIT_STEP);
      else if (key === "ArrowDown") spherical.phi = Math.min(controls.maxPolarAngle, spherical.phi + ORBIT_STEP);
      else if (key === "+" || key === "=") spherical.radius = Math.max(controls.minDistance, spherical.radius / ZOOM_STEP);
      else if (key === "-" || key === "_") spherical.radius = Math.min(controls.maxDistance, spherical.radius * ZOOM_STEP);
      else return false;
      spherical.makeSafe();
      camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
      controls.update();
      return true;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (orbit(event.key)) event.preventDefault();
    };
    element.addEventListener("keydown", onKeyDown);
    return () => {
      element.removeEventListener("keydown", onKeyDown);
      element.removeAttribute("tabindex");
    };
  }, [keyboardControls]);

  return (
    <div className="viewer-shell" ref={shell}>
      {poster && status !== "" ? <img className="viewer-poster" src={poster} alt="" /> : null}
      <div
        className="viewer"
        ref={host}
        aria-label="三维 Gaussian Splat 场景查看器"
        aria-describedby={keyboardControls ? hintId : undefined}
      />
      {status ? <p className="viewer-message" role={failed ? "alert" : "status"}>{status}</p> : null}
      {keyboardControls ? <p className="viewer-keyhint" id={hintId}>方向键旋转 · + / − 缩放 · Home 还原</p> : null}
      <div className="viewer-controls">
        <button type="button" onClick={() => controlsRef.current?.reset()} aria-label="将相机恢复到初始视角">重置视角</button>
        <button type="button" onClick={toggleFullscreen} aria-pressed={fullscreen}>
          {fullscreen ? "退出全屏" : "全屏"}
        </button>
        {failed ? <button type="button" onClick={() => {
          onRetry?.();
          setAttempt((value) => value + 1);
        }}>重试</button> : null}
      </div>
    </div>
  );
}
