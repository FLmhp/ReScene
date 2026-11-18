import { registerRootComponent } from "expo";

import { createElement } from "react";
import { AppearanceProvider } from "./src/appearance";

import { AppRoot } from "./src/AppRoot";

registerRootComponent(() => createElement(AppearanceProvider, null, createElement(AppRoot)));
