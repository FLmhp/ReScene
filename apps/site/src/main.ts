import { initSiteTheme } from "./theme";

export {};

initSiteTheme();

const heroStage = document.querySelector<HTMLElement>("[data-hero-stage]");
const heroLoad = heroStage?.querySelector<HTMLAnchorElement>("[data-hero-load]");
if (heroStage && heroLoad) {
  let loading = false;
  heroLoad.addEventListener("click", async (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const src = heroStage.dataset.modelSrc;
    if (!src || loading) return;
    event.preventDefault();
    loading = true;
    const label = heroLoad.querySelector("span");
    const original = label?.textContent ?? "";
    if (label) label.textContent = "正在加载场景…";
    heroLoad.setAttribute("aria-busy", "true");
    try {
      // A static import would ship React and the 3.3 MB WebGL engine to every visitor.
      const { mountHeroViewer } = await import("./hero-viewer");
      mountHeroViewer(heroStage);
    } catch {
      heroLoad.removeAttribute("aria-busy");
      if (label) label.textContent = original;
      loading = false;
      window.location.assign(heroLoad.href);
    }
  });
}

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const header = document.querySelector<HTMLElement>(".site-header");
const navigation = document.querySelector<HTMLDetailsElement>("#mobile-navigation");

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
}

/* ---------- Header state and scrollspy share one frame ---------- */

const sectionIds = ["results", "workflow", "technology", "capabilities", "delivery"];
const sections = sectionIds
  .map((id) => document.getElementById(id))
  .filter((section): section is HTMLElement => section !== null);
const navLinks = document.querySelectorAll<HTMLAnchorElement>(
  ".desktop-nav a[href^='#'], .mobile-navigation a[href^='#']",
);
const backToTop = document.querySelector<HTMLButtonElement>("[data-back-to-top]");
let navFrame = 0;
const updateNavigation = () => {
  navFrame = 0;
  const scrollable = document.documentElement.scrollHeight - window.innerHeight;
  const progress = scrollable > 0 ? Math.min(1, Math.max(0, window.scrollY / scrollable)) : 0;
  document.documentElement.style.setProperty("--scroll-progress", progress.toFixed(3));
  if (backToTop) backToTop.hidden = window.scrollY < 600;
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
  if (navigation) navigation.open = false;
  target.focus({ preventScroll: true });
});

if (backToTop) {
  backToTop.addEventListener("click", () => {
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    window.scrollTo(0, 0);
    root.style.scrollBehavior = previous;
    document.getElementById("main")?.focus({ preventScroll: true });
  });
}

/* ---------- Route tabs ---------- */

const routeTabs = document.querySelector<HTMLElement>("[data-route-tabs]");
if (routeTabs) {
  const tabs = Array.from(routeTabs.querySelectorAll<HTMLButtonElement>("[data-route-tab]"));
  const panels = Array.from(routeTabs.querySelectorAll<HTMLElement>("[data-route-panel]"));
  for (const panel of panels) panel.setAttribute("role", "tabpanel");
  const activate = (name: string, focusTab = false) => {
    for (const tab of tabs) {
      const selected = tab.dataset.routeTab === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focusTab) tab.focus();
    }
    for (const panel of panels) {
      const selected = panel.dataset.routePanel === name;
      panel.classList.toggle("is-active", selected);
      panel.hidden = !selected;
    }
  };
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => activate(tab.dataset.routeTab ?? "balanced"));
    tab.addEventListener("keydown", (event) => {
      const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      let next = index;
      if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      activate(tabs[next].dataset.routeTab ?? "balanced", true);
    });
  }
  activate("balanced");
}

/* ---------- Screenshot lightbox ---------- */

const lightbox = document.querySelector<HTMLDialogElement>("[data-lightbox]");
const lightboxImage = lightbox?.querySelector<HTMLImageElement>("[data-lightbox-image]");
if (lightbox && lightboxImage) {
  for (const trigger of document.querySelectorAll<HTMLAnchorElement>("[data-lightbox-trigger]")) {
    trigger.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (typeof lightbox.showModal !== "function") return;
      event.preventDefault();
      trigger.focus({ preventScroll: true });
      const image = trigger.querySelector("img");
      lightboxImage.alt = image?.alt ?? "";
      lightboxImage.src = trigger.href;
      lightbox.setAttribute("aria-label", lightboxImage.alt || "截图预览");
      lightbox.showModal();
    });
  }
  lightbox.querySelector("[data-lightbox-close]")?.addEventListener("click", () => lightbox.close());
  lightbox.addEventListener("click", (event) => {
    if (event.target === lightbox) lightbox.close();
  });
  lightbox.addEventListener("close", () => {
    if (!lightbox.open) lightboxImage.removeAttribute("src");
  });
}

/* ---------- Reveal ---------- */

const revealTargets = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
if (revealTargets.length) {
  if (typeof IntersectionObserver === "undefined" || reducedMotion.matches) {
    for (const target of revealTargets) target.classList.add("is-visible");
  } else {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    for (const target of revealTargets) observer.observe(target);
  }
}

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
