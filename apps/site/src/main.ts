import { initSiteTheme } from "./theme";

export {};

initSiteTheme();

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const printMedia = window.matchMedia("print");
const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
const header = document.querySelector<HTMLElement>(".site-header");
const navigation = document.querySelector<HTMLDetailsElement>("#mobile-navigation");
const inspector = document.querySelector<HTMLElement>("#sample-inspector");
const sampleWindow = inspector?.querySelector<HTMLElement>(".inspector-stage");
const sampleImage = sampleWindow?.querySelector<HTMLImageElement>(".inspector-poster");
const points = sampleWindow?.querySelector<HTMLCanvasElement>(".sample-points");

let cancelSample = () => {};

/* ---------- One-shot pixel preview over the public-model poster ---------- */

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
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancelSample();
  });
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) cancelSample();
  });
  printMedia.addEventListener("change", () => {
    if (printMedia.matches) cancelSample();
  });
  window.addEventListener("pagehide", cancelSample);
  if ("IntersectionObserver" in window) {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => !entry.isIntersecting)) cancelSample();
    });
    observer.observe(frameWindow);
  }
  const navigationEntry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (!visible() || document.hidden || reducedMotion.matches || printMedia.matches || navigationEntry?.type === "back_forward") cancelSample();

  const start = async () => {
    try {
      if (cancelled) return;
      await image.decode();
      if (cancelled || !visible() || document.hidden || reducedMotion.matches || printMedia.matches) return cancelSample();
      const source = document.createElement("canvas");
      source.width = 36;
      source.height = 24;
      const sourceContext = source.getContext("2d", { willReadFrequently: true });
      const context = canvas.getContext("2d");
      if (!sourceContext || !context) return cancelSample();
      sourceContext.drawImage(image, 0, 0, 36, 24);
      const pixels = sourceContext.getImageData(0, 0, 36, 24).data;
      canvas.width = 540;
      canvas.height = 358;
      const dots: { x: number; y: number; dx: number; dy: number; color: string }[] = [];
      for (let y = 0; y < 24; y++) {
        for (let x = 0; x < 36; x++) {
          const offset = (y * 36 + x) * 4;
          const [r, g, b, alpha] = [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
          if (alpha < 16) continue;
          const hash = (((x + 1) * 73856093) ^ ((y + 1) * 19349663)) >>> 0;
          dots.push({
            x: ((x + 0.5) / 36) * 540,
            y: ((y + 0.5) / 24) * 358,
            dx: (x < 18 ? -1 : 1) * ((hash % 1000) / 1000) * 540 * 0.18,
            dy: ((((hash >>> 10) % 2000) / 1000) - 1) * 358 * 0.07,
            color: `rgb(${r},${g},${b})`,
          });
        }
      }
      canvas.hidden = false;
      const started = performance.now();
      const draw = (now: number) => {
        if (cancelled) return;
        const elapsed = now - started;
        if (elapsed >= 920) return cancelSample();
        context.clearRect(0, 0, 540, 358);
        const progress = 1 - (1 - Math.min(elapsed / 680, 1)) ** 3;
        context.globalAlpha = 1 - Math.max(0, (elapsed - 420) / 500);
        const radius = ((1.4 + 1.2 * progress) * 540) / frameWindow.clientWidth;
        for (const dot of dots) {
          context.fillStyle = dot.color;
          context.beginPath();
          context.arc(dot.x + dot.dx * (1 - progress), dot.y + dot.dy * (1 - progress), radius, 0, Math.PI * 2);
          context.fill();
        }
        frame = requestAnimationFrame(draw);
      };
      frame = requestAnimationFrame(draw);
    } catch {
      cancelSample();
    }
  };
  if (!cancelled) {
    if (image.complete) void start();
    else image.addEventListener("load", () => void start(), { once: true });
    image.addEventListener("error", cancelSample, { once: true });
  }
}

/* ---------- Calibration layer parallax (fine pointers, at most 4px) ---------- */

const decor = inspector?.querySelector<HTMLElement>(".inspector-decor");
let parallaxFrame = 0;
const resetParallax = () => {
  cancelAnimationFrame(parallaxFrame);
  if (!decor) return;
  decor.style.setProperty("--inspector-x", "0");
  decor.style.setProperty("--inspector-y", "0");
};
if (inspector && decor) {
  inspector.addEventListener("pointermove", (event) => {
    if (!finePointer.matches || reducedMotion.matches || event.pointerType !== "mouse") return;
    const rect = inspector.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const y = ((event.clientY - rect.top) / rect.height) * 2 - 1;
    cancelAnimationFrame(parallaxFrame);
    parallaxFrame = requestAnimationFrame(() => {
      decor.style.setProperty("--inspector-x", Math.max(-1, Math.min(1, x)).toFixed(3));
      decor.style.setProperty("--inspector-y", Math.max(-1, Math.min(1, y)).toFixed(3));
    });
  });
  inspector.addEventListener("pointerleave", resetParallax);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) resetParallax();
  });
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) resetParallax();
  });
  window.addEventListener("pagehide", resetParallax);
}

/* ---------- Mobile navigation drawer ---------- */

if (navigation) {
  const summary = navigation.querySelector<HTMLElement>("summary");
  navigation.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("nav a")) navigation.open = false;
  });
  document.addEventListener("click", (event) => {
    if (event.target instanceof Node && !navigation.contains(event.target)) navigation.open = false;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && navigation.open) {
      navigation.open = false;
      summary?.focus();
    }
  });
  const desktop = window.matchMedia("(width > 1024px)");
  desktop.addEventListener("change", (event) => {
    if (event.matches) navigation.open = false;
  });
  navigation.addEventListener("toggle", () => {
    if (navigation.open) cancelSample();
  });
}

/* ---------- Flow highlight, once, when a quarter of the steps is visible ---------- */

const steps = document.querySelector<HTMLElement>(".steps");
if (steps) {
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries, current) => {
        if (!entries.some((entry) => entry.intersectionRatio >= 0.25)) return;
        current.disconnect();
        if (!reducedMotion.matches) steps.classList.add("is-lit");
      },
      { threshold: [0.25] },
    );
    observer.observe(steps);
  }
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) steps.classList.remove("is-lit");
  });
}

/* ---------- Header state and scrollspy share one frame ---------- */

const sectionIds = ["results", "workflow", "technology", "capabilities", "delivery"];
const sections = sectionIds
  .map((id) => document.getElementById(id))
  .filter((section): section is HTMLElement => section !== null);
const navLinks = document.querySelectorAll<HTMLAnchorElement>(
  ".desktop-nav a[href^='#'], .mobile-navigation a[href^='#']",
);
let navFrame = 0;
const updateNavigation = () => {
  navFrame = 0;
  if (!header) return;
  const headerHeight = header.offsetHeight;
  document.documentElement.style.setProperty("--header-offset", `${headerHeight}px`);
  header.classList.toggle("is-scrolled", window.scrollY > 16);
  let current = "";
  for (const section of sections) {
    if (section.getBoundingClientRect().top <= headerHeight + 24) current = section.id;
  }
  if (window.scrollY > 0 && innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) current = "delivery";
  for (const link of navLinks) {
    if (link.getAttribute("href") === `#${current}`) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
};
const scheduleNavigation = () => {
  if (!navFrame) navFrame = requestAnimationFrame(updateNavigation);
};
window.addEventListener("scroll", scheduleNavigation, { passive: true });
window.addEventListener("resize", scheduleNavigation);
window.addEventListener("hashchange", scheduleNavigation);
window.addEventListener("pageshow", scheduleNavigation);
if (header) new ResizeObserver(scheduleNavigation).observe(header);
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

/* ---------- Architecture flow demo ---------- */

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
    for (const path of paths) {
      path.classList.remove("active");
      path.style.removeProperty("stroke-dashoffset");
    }
    for (const point of endpoints) point.classList.remove("active");
    demoStatus.textContent = "";
  };
  demoButton.addEventListener("click", () => {
    diagram.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (reducedMotion.matches) {
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
    const timing: [number, number][] = [
      [0, 360],
      [300, 620],
      [660, 1020],
      [420, 820],
      [900, 1280],
      [1120, 1480],
    ];
    const animate = (now: number) => {
      const elapsed = now - started;
      endpointGroup.classList.add("active");
      timing.forEach(([start, end], index) => {
        const path = paths[index];
        const endpoint = endpoints[index];
        if (!path || !endpoint) return;
        const progress = (elapsed - start) / (end - start);
        path.classList.toggle("active", progress >= 0 && progress <= 1);
        path.style.strokeDashoffset = String(100 - Math.max(0, Math.min(1, progress)) * 118);
        endpoint.classList.toggle("active", progress >= 0.8 && progress <= 1);
      });
      if (elapsed < 1600) animationFrame = requestAnimationFrame(animate);
      else {
        reset();
        demoStatus.textContent = "任务流向演示结束。";
      }
    };
    animationFrame = requestAnimationFrame(animate);
  });
}
