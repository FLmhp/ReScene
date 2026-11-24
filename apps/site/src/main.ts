import { initSiteTheme } from "./theme";

export {};

initSiteTheme();

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");

const hero = document.querySelector<HTMLElement>("[data-hero]");
if (hero && finePointer.matches) {
  let glowFrame = 0;
  let glowX = 0;
  let glowY = 0;
  // Coalesce pointer moves into one style write per frame.
  hero.addEventListener("pointermove", (event) => {
    if (reducedMotion.matches) return;
    const box = hero.getBoundingClientRect();
    glowX = event.clientX - box.left;
    glowY = event.clientY - box.top;
    if (glowFrame) return;
    glowFrame = requestAnimationFrame(() => {
      glowFrame = 0;
      hero.style.setProperty("--hero-x", `${glowX}px`);
      hero.style.setProperty("--hero-y", `${glowY}px`);
      hero.classList.add("is-pointer-active");
    });
  });
  hero.addEventListener("pointerleave", () => {
    if (glowFrame) cancelAnimationFrame(glowFrame);
    glowFrame = 0;
    hero.classList.remove("is-pointer-active");
  });
}

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
    const label = heroLoad.querySelector<HTMLElement>("[data-hero-load-label]");
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

const sectionIds = ["workflow", "results", "technology", "capabilities", "delivery"];
const sections = sectionIds
  .map((id) => document.getElementById(id))
  .filter((section): section is HTMLElement => section !== null);
const navLinks = document.querySelectorAll<HTMLAnchorElement>(
  ".desktop-nav a[href^='#'], .mobile-navigation a[href^='#']",
);
const desktopNav = document.querySelector<HTMLElement>(".desktop-nav");
const navHighlight = document.querySelector<HTMLElement>("[data-nav-highlight]");
const desktopLinks = Array.from(desktopNav?.querySelectorAll<HTMLAnchorElement>("a[href^='#']") ?? []);

/** Move the shared pill under a desktop link; hides it when nothing is active. */
const highlightLink = (link: HTMLAnchorElement | null) => {
  if (!desktopNav || !navHighlight) return;
  // `offsetParent` is null while the desktop nav is display:none below 1024px.
  if (!link || !desktopNav.offsetParent) {
    navHighlight.classList.remove("is-visible");
    return;
  }
  const navBox = desktopNav.getBoundingClientRect();
  const linkBox = link.getBoundingClientRect();
  desktopNav.style.setProperty("--nav-x", `${linkBox.left - navBox.left}px`);
  desktopNav.style.setProperty("--nav-width", `${linkBox.width}px`);
  navHighlight.classList.add("is-visible");
};
const syncNavHighlight = (link?: HTMLAnchorElement) => {
  highlightLink(link ?? desktopLinks.find((item) => item.getAttribute("aria-current") === "location") ?? null);
};

if (desktopNav) {
  desktopNav.addEventListener("pointerover", (event) => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href^='#']") : null;
    if (link && desktopNav.contains(link)) highlightLink(link);
  });
  desktopNav.addEventListener("pointerleave", () => syncNavHighlight());
  desktopNav.addEventListener("focusin", (event) => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href^='#']") : null;
    if (link) highlightLink(link);
  });
  desktopNav.addEventListener("focusout", () => syncNavHighlight());
}
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
  header.classList.toggle("is-scrolled", window.scrollY > 80);
  let current = "";
  for (const section of sections) {
    if (section.getBoundingClientRect().top <= headerHeight + 24) current = section.id;
  }
  if (window.scrollY > 0 && innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) current = "delivery";
  for (const link of navLinks) {
    if (link.getAttribute("href") === `#${current}`) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
  syncNavHighlight();
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
// Web-font metrics change link widths; re-measure once they finish loading.
document.fonts?.ready.then(scheduleNavigation);
document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href^='#']") : null;
  if (!link) return;
  const target = document.getElementById(link.hash.slice(1));
  if (!target) return;
  if (navigation) navigation.open = false;
  if (desktopNav?.contains(link)) syncNavHighlight(link);
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

/* ---------- Workflow narrative ---------- */

const workflow = document.querySelector<HTMLElement>("[data-workflow]");
if (workflow) {
  const steps = Array.from(workflow.querySelectorAll<HTMLElement>("[data-workflow-step]"));
  const triggers = steps
    .map((step) => step.querySelector<HTMLButtonElement>(".step-trigger"))
    .filter((trigger): trigger is HTMLButtonElement => trigger !== null);
  const frameLinks = Array.from(workflow.querySelectorAll<HTMLAnchorElement>("[data-workflow-link]"));
  const stepList = workflow.querySelector<HTMLElement>(".steps");
  const caption = workflow.querySelector<HTMLElement>("[data-workflow-caption]");
  const captions: Record<string, string> = {
    upload: "手机网页版 · 素材上传",
    submit: "微信小程序 · 选择重建路线",
    result: "Android · 查看重建结果",
  };
  let activeWorkflow = "";
  let workflowLockedUntil = 0;
  let workflowPinned = false;
  let workflowFrame = 0;

  const activateWorkflow = (name: string) => {
    if (!name || name === activeWorkflow) return;
    activeWorkflow = name;
    for (const step of steps) {
      const selected = step.dataset.workflowStep === name;
      step.classList.toggle("is-active", selected);
      const trigger = step.querySelector<HTMLButtonElement>(".step-trigger");
      if (!trigger) continue;
      if (selected) trigger.setAttribute("aria-current", "step");
      else trigger.removeAttribute("aria-current");
    }
    for (const link of frameLinks) {
      const selected = link.dataset.workflowLink === name;
      link.classList.toggle("is-active", selected);
      // Hidden panels are neither clickable nor reachable by keyboard or screen readers.
      if (selected) {
        link.removeAttribute("inert");
        link.removeAttribute("aria-hidden");
      } else {
        link.setAttribute("inert", "");
        link.setAttribute("aria-hidden", "true");
      }
    }
    if (caption) caption.textContent = captions[name] ?? "";
  };

  const updateWorkflow = () => {
    workflowFrame = 0;
    if (!stepList || !steps.length) return;
    const box = stepList.getBoundingClientRect();
    const anchor = innerHeight * 0.42;
    // 0 at the first step reaching the anchor, 1 once the last step passes it.
    const progress = Math.min(1, Math.max(0, (anchor - box.top) / Math.max(1, box.height)));
    stepList.style.setProperty("--workflow-progress", progress.toFixed(3));
    // Below 900px the panel is hidden and each step carries its own screenshot.
    if (window.matchMedia("(max-width: 900px)").matches) return;
    // Keep a clicked step active until the visitor scrolls again; late font or
    // resize recalculations must not undo the choice.
    if (workflowPinned || performance.now() < workflowLockedUntil) return;
    let nearest = steps[0];
    let nearestDistance = Infinity;
    for (const step of steps) {
      const rect = step.getBoundingClientRect();
      const distance = Math.abs(rect.top + rect.height / 2 - anchor);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = step;
      }
    }
    if (nearest.dataset.workflowStep) activateWorkflow(nearest.dataset.workflowStep);
  };
  const scheduleWorkflow = () => {
    if (!workflowFrame) workflowFrame = requestAnimationFrame(updateWorkflow);
  };

  for (const trigger of triggers) {
    trigger.addEventListener("click", () => {
      const step = trigger.closest<HTMLElement>("[data-workflow-step]");
      const name = step?.dataset.workflowStep;
      if (!name) return;
      activateWorkflow(name);
      workflowPinned = true;
      // The smooth scroll fires frames; keep the chosen step active until it lands.
      workflowLockedUntil = performance.now() + 1200;
      const triggerBox = trigger.getBoundingClientRect();
      const safeTop = (header?.offsetHeight ?? 0) + 24;
      const safeBottom = innerHeight - 24;
      // Only scroll when the trigger is not already fully visible. Centring it on
      // desktop used to pull the section heading under the sticky header, and on
      // mobile the step is taller than the viewport, so align its title instead.
      if (triggerBox.top < safeTop || triggerBox.bottom > safeBottom) {
        window.scrollTo({
          top: Math.max(0, window.scrollY + triggerBox.top - safeTop),
          behavior: reducedMotion.matches ? "auto" : "smooth",
        });
      }
    });
  }

  activateWorkflow("upload");
  window.addEventListener("scroll", () => {
    if (performance.now() >= workflowLockedUntil) workflowPinned = false;
    scheduleWorkflow();
  }, { passive: true });
  window.addEventListener("resize", scheduleWorkflow);
  document.fonts?.ready.then(scheduleWorkflow);
  updateWorkflow();
}

/* ---------- Route comparison ---------- */

const routeCompare = document.querySelector<HTMLElement>("[data-route-compare]");
if (routeCompare) {
  const routeButtons = Array.from(routeCompare.querySelectorAll<HTMLButtonElement>("[data-route]"));
  const routeCells = Array.from(routeCompare.querySelectorAll<HTMLElement>("[data-route-cell]"));
  const routeNote = routeCompare.querySelector<HTMLElement>("[data-route-note]");
  const activateRoute = (name: string) => {
    let note = "";
    for (const button of routeButtons) {
      const selected = button.dataset.route === name;
      button.setAttribute("aria-pressed", String(selected));
      if (selected) note = button.dataset.note ?? "";
    }
    for (const cell of routeCells) cell.classList.toggle("is-active", cell.dataset.routeCell === name);
    if (routeNote && routeNote.textContent !== note) routeNote.textContent = note;
  };
  for (const button of routeButtons) {
    button.addEventListener("click", () => {
      if (button.dataset.route) activateRoute(button.dataset.route);
    });
  }
  activateRoute("balanced");
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

/* ---------- Pointer glow ---------- */

if (finePointer.matches) {
  for (const target of document.querySelectorAll<HTMLElement>("[data-glow]")) {
    let frame = 0;
    let x = 0;
    let y = 0;
    target.addEventListener("pointermove", (event) => {
      if (reducedMotion.matches) return;
      const box = target.getBoundingClientRect();
      x = event.clientX - box.left;
      y = event.clientY - box.top;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        target.style.setProperty("--mouse-x", `${x}px`);
        target.style.setProperty("--mouse-y", `${y}px`);
      });
    });
    target.addEventListener("pointerleave", () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    });
  }
}

/* ---------- Architecture node explorer ---------- */

const architectureDiagram = document.querySelector<SVGElement>(".architecture-diagram");
const architectureButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-architecture-node]"));
const architectureCaption = document.querySelector<HTMLElement>("[data-architecture-caption]");
const architectureNodes: Record<string, string> = {
  client: "客户端经 HTTPS 提交任务并查询进度；素材通过 API 签发的地址直传私有 OSS。",
  api: "API Server 负责鉴权、项目与任务、租约调度，并签发上传、下载和分享地址。",
  postgres: "PostgreSQL 保存项目、任务、租约和 Worker 心跳；GPU Worker 不直接连接数据库。",
  oss: "私有 OSS 保存素材与交付文件；客户端直传，Worker 读写，均使用限时签名地址。",
  gpu: "GPU Worker 通过 API 领取租约并上报心跳，从 OSS 读取素材并写入重建结果。",
};
let selectedArchitectureNode = "";
const setArchitectureNode = (name: string) => {
  // Clicking the active node clears the selection.
  const next = name === selectedArchitectureNode ? "" : name;
  selectedArchitectureNode = next;
  architectureDiagram?.classList.toggle("has-selection", next !== "");
  for (const button of architectureButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.architectureNode === next));
  }
  for (const rect of document.querySelectorAll<SVGRectElement>(".diagram-boxes rect[data-node]")) {
    rect.classList.toggle("is-selected", rect.dataset.node === next);
  }
  for (const path of document.querySelectorAll<SVGPathElement>(".diagram-lines path[data-connects]")) {
    path.classList.toggle("is-lit", next !== "" && (path.dataset.connects ?? "").split(" ").includes(next));
  }
  for (const label of document.querySelectorAll<SVGTextElement>(".diagram-edge-labels text[data-connects]")) {
    label.classList.toggle("is-muted", next !== "" && !(label.dataset.connects ?? "").split(" ").includes(next));
  }
  if (architectureCaption) {
    architectureCaption.textContent = next ? architectureNodes[next] ?? "" : "选择节点查看连接关系与职责。";
  }
};
for (const button of architectureButtons) {
  button.addEventListener("click", () => setArchitectureNode(button.dataset.architectureNode ?? ""));
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
    // Keep only one highlight system active at a time.
    setArchitectureNode("");
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
