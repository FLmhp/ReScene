"use client";

import { ResceneClient } from "@rescene/api-client";
import { createWebUploader } from "@rescene/uploader/web";
import dynamic from "next/dynamic";
import { Workbench, type KeyValueStore, type WorkbenchViewerProps } from "@rescene/workbench";
import { useState, type ComponentType } from "react";

import { API_BASE as API, WEB_BASE } from "./env";

// next/dynamic resolves React through pnpm's hoisted @types/react, which can be the Taro
// copy. Erase the viewer's React identity at this boundary and restore the app's own
// component contract afterwards, so two React type sets never meet inside next/dynamic.
const loadViewer = () =>
  import("@rescene/viewer").then((module) => module.Viewer as unknown as never);

const Viewer = dynamic(loadViewer, {
  ssr: false,
}) as unknown as ComponentType<WorkbenchViewerProps>;

const tokenStore: KeyValueStore = {
  get: (key) => (typeof window === "undefined" ? null : window.localStorage.getItem(key)),
  set: (key, value) => window.localStorage.setItem(key, value),
  remove: (key) => window.localStorage.removeItem(key),
};

export default function Page() {
  const [client] = useState(() => new ResceneClient(API));
  const [uploader] = useState(() => createWebUploader(client));
  const [webBaseUrl] = useState(
    () => WEB_BASE || (typeof window === "undefined" ? "" : window.location.origin),
  );
  return (
    <Workbench
      client={client}
      uploader={uploader}
      viewer={Viewer}
      tokenStore={tokenStore}
      webBaseUrl={webBaseUrl}
      platform="web"
    />
  );
}
