import { registerRootComponent } from "expo";
import { createElement } from "react";
import { initialWindowMetrics, SafeAreaProvider } from "react-native-safe-area-context";

import { AppearanceProvider } from "./src/appearance";
import { AppRoot } from "./src/AppRoot";

registerRootComponent(() => createElement(
  SafeAreaProvider,
  { initialMetrics: initialWindowMetrics },
  createElement(AppearanceProvider, null, createElement(AppRoot)),
));
