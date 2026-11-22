export {};

const inspector = document.querySelector<HTMLElement>("#sample-inspector");
const sampleWindow = inspector?.querySelector<HTMLElement>("#sample-window");
const sampleImage = sampleWindow?.querySelector<HTMLImageElement>("img");
const sampleControls = inspector?.querySelector<HTMLElement>(".sample-controls");
const sampleToggle = inspector?.querySelector<HTMLButtonElement>(".sample-toggle");
const directions = inspector?.querySelector<HTMLElement>(".sample-directions");
let cancelSample = () => {};

if (inspector && sampleWindow && sampleImage && sampleControls && sampleToggle && directions) {
  sampleControls.hidden = false;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let zoomAnimation: Animation | undefined;
  reducedMotion.addEventListener("change", () => { if (reducedMotion.matches) zoomAnimation?.cancel(); });
  let zoomed = false;
  let drag: { x: number; y: number; left: number; top: number } | null = null;
  const setZoom = (value: boolean) => {
    cancelSample();
    zoomed = value;
    inspector.classList.toggle("is-zoomed", value);
    sampleToggle.textContent = value ? "还原样张" : "放大样张";
    sampleToggle.setAttribute("aria-pressed", String(value));
    directions.hidden = !value;
    zoomAnimation?.cancel();
    if (value) {
      sampleWindow.scrollTo((sampleWindow.scrollWidth - sampleWindow.clientWidth) / 2, (sampleWindow.scrollHeight - sampleWindow.clientHeight) / 2);
      if (!reducedMotion.matches) {
        const scale = sampleWindow.clientWidth / sampleImage.offsetWidth;
        zoomAnimation = sampleImage.animate([{ transform: `scale(${scale})` }, { transform: "scale(1)" }], { duration: 280, easing: "cubic-bezier(.22,.7,.22,1)" });
      }
    } else {
      drag = null;
      sampleWindow.scrollTo(0, 0);
    }
  };
  sampleToggle.addEventListener("click", () => setZoom(!zoomed));
  directions.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-pan]") : null;
    if (!button) return;
    const step = sampleWindow.clientWidth / 4;
    const delta: Record<string, [number, number]> = { left: [-step, 0], right: [step, 0], up: [0, -step], down: [0, step] };
    const [left, top] = delta[button.dataset.pan ?? ""] ?? [0, 0];
    sampleWindow.scrollBy(left, top);
  });
  sampleWindow.addEventListener("pointerdown", (event) => {
    if (!zoomed || (event.pointerType === "mouse" && event.button !== 0)) return;
    drag = { x: event.clientX, y: event.clientY, left: sampleWindow.scrollLeft, top: sampleWindow.scrollTop };
    sampleWindow.setPointerCapture(event.pointerId);
  });
  sampleWindow.addEventListener("pointermove", (event) => {
    if (!zoomed) return;
    if (drag) {
      sampleWindow.scrollLeft = drag.left - (event.clientX - drag.x);
      sampleWindow.scrollTop = drag.top - (event.clientY - drag.y);
    } else if (event.pointerType === "mouse") {
      const rect = sampleWindow.getBoundingClientRect();
      sampleWindow.scrollLeft = (event.clientX - rect.left) / rect.width * (sampleWindow.scrollWidth - rect.width);
      sampleWindow.scrollTop = (event.clientY - rect.top) / rect.height * (sampleWindow.scrollHeight - rect.height);
    }
  });
  sampleWindow.addEventListener("pointerup", () => { drag = null; });
  sampleWindow.addEventListener("pointercancel", () => { drag = null; });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !document.querySelector<HTMLDetailsElement>("#mobile-navigation")?.open && zoomed) {
      setZoom(false);
      sampleToggle.focus();
    }
  });
}

const navigation = document.querySelector<HTMLDetailsElement>("#mobile-navigation");

if (navigation) {
  const summary = navigation.querySelector<HTMLElement>("summary");
  navigation.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("nav a")) {
      navigation.open = false;
    }
  });
  document.addEventListener("click", (event) => {
    if (event.target instanceof Node && !navigation.contains(event.target)) {
      navigation.open = false;
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && navigation.open) {
      navigation.open = false;
      summary?.focus();
    }
  });
  const desktop = window.matchMedia("(width > 800px)");
  desktop.addEventListener("change", (event) => {
    if (event.matches) navigation.open = false;
  });
  navigation.addEventListener("toggle", () => { if (navigation.open) cancelSample(); });
}

const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
const print = window.matchMedia("print");
const points = sampleWindow?.querySelector<HTMLCanvasElement>(".sample-points");
if (sampleWindow && sampleImage && points) {
  const frameWindow = sampleWindow;
  const image = sampleImage;
  const canvas = points;
  let cancelled = false;
  let frame = 0;
  const visible = () => {
    const rect = frameWindow.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
  };
  let observer: IntersectionObserver | undefined;
  cancelSample = () => {
    cancelled = true;
    cancelAnimationFrame(frame);
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    canvas.hidden = true;
    observer?.disconnect();
  };
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancelSample(); });
  motion.addEventListener("change", () => { if (motion.matches) cancelSample(); });
  print.addEventListener("change", () => { if (print.matches) cancelSample(); });
  window.addEventListener("pagehide", cancelSample);
  if ("IntersectionObserver" in window) {
    observer = new IntersectionObserver((entries) => { if (entries.some((entry) => !entry.isIntersecting)) cancelSample(); });
    observer.observe(frameWindow);
  }
  const navigationEntry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (!visible() || document.hidden || motion.matches || print.matches || navigationEntry?.type === "back_forward") cancelSample();
  const start = async () => {
    try {
      if (cancelled) return;
      await image.decode();
      if (cancelled || !visible() || document.hidden || motion.matches || print.matches) return cancelSample();
      const source = document.createElement("canvas");
      source.width = 36; source.height = 24;
      const sourceContext = source.getContext("2d", { willReadFrequently: true });
      const context = canvas.getContext("2d");
      if (!sourceContext || !context) return cancelSample();
      sourceContext.drawImage(image, 0, 0, 36, 24);
      const pixels = sourceContext.getImageData(0, 0, 36, 24).data;
      canvas.width = 540; canvas.height = 358;
      const dots: { x: number; y: number; dx: number; dy: number; color: string }[] = [];
      for (let y = 0; y < 24; y++) for (let x = 0; x < 36; x++) {
        const offset = (y * 36 + x) * 4;
        const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
        const max = Math.max(r, g, b);
        if (max < 36 || (max - Math.min(r, g, b) < 8 && max < 64)) continue;
        const hash = ((x + 1) * 73856093 ^ (y + 1) * 19349663) >>> 0;
        dots.push({ x: (x + .5) / 36 * 540, y: (y + .5) / 24 * 358, dx: (x < 18 ? -1 : 1) * (hash % 1000) / 1000 * 540 * .18, dy: (((hash >>> 10) % 2000) / 1000 - 1) * 358 * .07, color: `rgb(${r},${g},${b})` });
      }
      canvas.hidden = false;
      const started = performance.now();
      const draw = (now: number) => {
        if (cancelled) return;
        const elapsed = now - started;
        if (elapsed >= 920) return cancelSample();
        context.clearRect(0, 0, 540, 358);
        const progress = 1 - Math.pow(1 - Math.min(elapsed / 680, 1), 3);
        context.globalAlpha = 1 - Math.max(0, (elapsed - 420) / 500);
        const radius = (1.4 + 1.2 * progress) * 540 / frameWindow.clientWidth;
        for (const dot of dots) {
          context.fillStyle = dot.color;
          context.beginPath();
          context.arc(dot.x + dot.dx * (1 - progress), dot.y + dot.dy * (1 - progress), radius, 0, Math.PI * 2);
          context.fill();
        }
        frame = requestAnimationFrame(draw);
      };
      frame = requestAnimationFrame(draw);
    } catch { cancelSample(); }
  };
  if (!cancelled) {
    if (image.complete) void start();
    else image.addEventListener("load", () => { void start(); }, { once: true });
    image.addEventListener("error", cancelSample, { once: true });
  }
}

const sectionIds = ["results", "workflow", "technology", "capabilities", "delivery"];
const sections = sectionIds.map((id) => document.getElementById(id)).filter((section): section is HTMLElement => !!section);
const navLinks = document.querySelectorAll<HTMLAnchorElement>(".desktop-nav a[href^='#'], .mobile-navigation a[href^='#']");
let navFrame = 0;
const updateNavigation = () => {
  navFrame = 0;
  const headerBottom = document.querySelector<HTMLElement>(".site-header")?.getBoundingClientRect().bottom ?? 0;
  let current = "";
  for (const section of sections) if (section.getBoundingClientRect().top <= headerBottom + 24) current = section.id;
  if (window.scrollY > 0 && innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) current = "delivery";
  navLinks.forEach((link) => {
    if (link.getAttribute("href") === `#${current}`) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
};
const scheduleNavigation = () => { if (!navFrame) navFrame = requestAnimationFrame(updateNavigation); };
window.addEventListener("scroll", scheduleNavigation, { passive: true });
window.addEventListener("resize", scheduleNavigation);
window.addEventListener("hashchange", scheduleNavigation);
window.addEventListener("pageshow", scheduleNavigation);
scheduleNavigation();
document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href^='#']") : null;
  if (!link) return;
  const target = document.getElementById(link.hash.slice(1));
  if (!target) return;
  cancelSample();
  if (navigation) navigation.open = false;
  target.focus({ preventScroll: true });
});

const demo = document.querySelector<HTMLElement>(".diagram-demo");
const demoButton = demo?.querySelector<HTMLButtonElement>("button");
const demoStatus = demo?.querySelector<HTMLElement>("[role=status]");
const diagram = document.querySelector<HTMLElement>(".architecture-frame");
const flow = document.querySelector<SVGGElement>(".diagram-flow");
const paths = Array.from(document.querySelectorAll<SVGPathElement>(".diagram-flow path"));
const endpoints = Array.from(document.querySelectorAll<SVGCircleElement>(".diagram-endpoints circle"));
const endpointGroup = document.querySelector<SVGGElement>(".diagram-endpoints");
if (demo && demoButton && demoStatus && diagram && flow && endpointGroup) {
  demo.hidden = false;
  let animationFrame = 0;
  let staticOn = false;
  const reset = () => {
    cancelAnimationFrame(animationFrame);
    staticOn = false;
    flow.classList.remove("static");
    endpointGroup.classList.remove("active");
    paths.forEach((path) => { path.classList.remove("active"); path.style.removeProperty("stroke-dashoffset"); });
    endpoints.forEach((point) => point.classList.remove("active"));
    demoStatus.textContent = "";
  };
  demoButton.addEventListener("click", () => {
    diagram.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (motion.matches) {
      const next = !staticOn;
      reset();
      staticOn = next;
      flow.classList.toggle("static", next);
      demoStatus.textContent = next ? "已显示全部示意路径。" : "已清除示意路径。";
      return;
    }
    reset();
    demoStatus.textContent = "正在演示任务流向。";
    const started = performance.now();
    const timing: [number, number][] = [[0, 360], [320, 650], [1100, 1660], [650, 1100], [1100, 1660]];
    const animate = (now: number) => {
      const elapsed = now - started;
      endpointGroup.classList.add("active");
      timing.forEach(([start, end], index) => {
        const progress = (elapsed - start) / (end - start);
        paths[index].classList.toggle("active", progress >= 0 && progress <= 1);
        paths[index].style.strokeDashoffset = String(100 - Math.max(0, Math.min(1, progress)) * 118);
        endpoints[index].classList.toggle("active", progress >= .8 && progress <= 1);
      });
      if (elapsed < 1660) animationFrame = requestAnimationFrame(animate);
      else { reset(); demoStatus.textContent = "任务流向演示结束。"; }
    };
    animationFrame = requestAnimationFrame(animate);
  });
  motion.addEventListener("change", reset);
  document.addEventListener("visibilitychange", () => { if (document.hidden) reset(); });
  if ("IntersectionObserver" in window) new IntersectionObserver((entries) => { if (entries.some((entry) => !entry.isIntersecting)) reset(); }).observe(diagram);
}
