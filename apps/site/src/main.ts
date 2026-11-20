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
