import type { ViewerProps } from "@rescene/viewer";

export const DEMO_VIEW = {
  viewDirection: [0.88, 0.32, 0.41],
  viewDistance: 1.43,
  viewSidePadding: 0.05,
} satisfies Pick<ViewerProps, "viewDirection" | "viewDistance" | "viewSidePadding">;
