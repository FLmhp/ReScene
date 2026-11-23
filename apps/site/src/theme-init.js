/* Runs before the stylesheet so a saved choice never flashes the wrong theme. */
(function () {
  var key = "rescene-theme";
  var saved = null;
  try {
    var value = localStorage.getItem(key);
    if (value === "light" || value === "dark") saved = value;
  } catch {}
  var theme = saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  var root = document.documentElement;
  root.dataset.siteTheme = theme;
  root.style.colorScheme = theme;
  root.classList.add("js");
})();
