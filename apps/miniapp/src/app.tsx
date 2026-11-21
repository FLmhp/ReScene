import type { PropsWithChildren } from "react";
import { usePageNotFound } from "@tarojs/taro";
import { openHome } from "./navigation";
import "./polyfill";
import "./app.css";

export default function App({ children }: PropsWithChildren) {
  usePageNotFound(() => { void openHome().catch(() => undefined); });
  return children;
}
