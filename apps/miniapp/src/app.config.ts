export default defineAppConfig({
  entryPagePath: "pages/index/index",
  pages: ["pages/index/index", "pages/project/index", "pages/viewer/index", "pages/admin/index", "pages/focus/index"],
  darkmode: true,
  themeLocation: "theme.json",
  window: {
    navigationBarTitleText: "ReScene",
    navigationBarBackgroundColor: "@navBgColor",
    navigationBarTextStyle: "@navTxtStyle",
    backgroundColor: "@bgColor",
  },
});
