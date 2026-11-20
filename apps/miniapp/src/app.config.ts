export default defineAppConfig({
  entryPagePath: "pages/index/index",
  pages: ["pages/index/index", "pages/project/index", "pages/viewer/index", "pages/admin/index"],
  darkmode: true,
  window: {
    navigationBarTitleText: "ReScene",
    navigationBarBackgroundColor: "#0B0D12",
    navigationBarTextStyle: "white",
    backgroundColor: "#0B0D12",
  },
});
