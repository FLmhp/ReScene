const inspector = document.querySelector<HTMLElement>("#sample-inspector");
const sampleWindow = inspector?.querySelector<HTMLElement>("#sample-window");
const sampleImage = sampleWindow?.querySelector<HTMLImageElement>("img");
const sampleControls = inspector?.querySelector<HTMLElement>(".sample-controls");
const sampleToggle = inspector?.querySelector<HTMLButtonElement>(".sample-toggle");
const directions = inspector?.querySelector<HTMLElement>(".sample-directions");

if (inspector && sampleWindow && sampleImage && sampleControls && sampleToggle && directions) {
  sampleControls.hidden = false;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let zoomAnimation: Animation | undefined;
  reducedMotion.addEventListener("change", () => { if (reducedMotion.matches) zoomAnimation?.cancel(); });
  let zoomed = false;
  let drag: { x: number; y: number; left: number; top: number } | null = null;
  const setZoom = (value: boolean) => {
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
    if (event.key === "Escape" && zoomed) {
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
}
