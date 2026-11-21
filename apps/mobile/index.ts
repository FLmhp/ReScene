import { registerRootComponent } from "expo";
import { createElement } from "react";
import { initialWindowMetrics, SafeAreaProvider } from "react-native-safe-area-context";

import { AppearanceProvider } from "./src/appearance";
import { AppRoot } from "./src/AppRoot";

function MobileRoot() {
  return createElement(
    SafeAreaProvider,
    { initialMetrics: initialWindowMetrics },
    createElement(AppearanceProvider, null, createElement(AppRoot)),
  );
}

// Expo can resolve a different @types/react peer from the app in the pnpm workspace.
registerRootComponent(MobileRoot as unknown as Parameters<typeof registerRootComponent>[0]);
