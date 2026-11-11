import { colors } from "@rescene/design-tokens";
import Taro, { useLaunch } from "@tarojs/taro";
import type { PropsWithChildren } from "react";

import "./polyfill";
import "./app.css";

export default function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    void Taro.setNavigationBarColor({
      frontColor: "#ffffff",
      backgroundColor: colors.bg,
      animation: { duration: 0, timingFunc: "linear" },
    }).catch(() => undefined);
    void Taro.setBackgroundColor({
      backgroundColor: colors.bg,
      backgroundColorTop: colors.bg,
      backgroundColorBottom: colors.bg,
    }).catch(() => undefined);
    void Taro.setBackgroundTextStyle({ textStyle: "light" }).catch(() => undefined);
  });

  return children;
}
