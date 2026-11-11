export default defineAppConfig({
  pages: ["pages/index/index", "pages/project/index", "pages/viewer/index", "pages/admin/index"],
  lazyCodeLoading: "requiredComponents",
  window: {
    navigationBarTitleText: "ReScene",
    navigationBarBackgroundColor: "#0B0D12",
    navigationBarTextStyle: "white",
    backgroundColor: "#0B0D12",
  },
});
