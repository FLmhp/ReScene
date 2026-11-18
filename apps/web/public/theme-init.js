try {
  var query = new URLSearchParams(location.search).get("theme");
  var preference = query === "light" || query === "dark" ? query : localStorage.getItem("rescene-theme");
  document.documentElement.dataset.theme = preference === "light" || preference === "dark"
    ? preference : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
} catch (error) {}
