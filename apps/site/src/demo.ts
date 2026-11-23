import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Viewer } from "@rescene/viewer";
import "@rescene/viewer/viewer.css";
import { initSiteTheme } from "./theme";

initSiteTheme();

const viewport = document.querySelector<HTMLElement>("#demo-viewport");
const status = document.querySelector<HTMLElement>("[data-demo-status]");
const modelSrc = viewport?.dataset.modelSrc?.trim();

if (!viewport || !modelSrc) {
  if (status) status.textContent = "演示模型地址缺失，页面只显示模型预览图。请返回官网重试。";
} else {
  createRoot(viewport).render(
    createElement(Viewer, {
      src: modelSrc,
      poster: "/media/knock-community-hall-cropped.webp",
      keyboardControls: true,
      viewDirection: [0.88, 0.25, -0.41],
      viewDistance: 1.43,
      loadErrorMessage: "公开建筑模型加载失败，请重试",
    }),
  );
}
