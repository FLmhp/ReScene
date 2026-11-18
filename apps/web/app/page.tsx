"use client";

import { ResceneClient } from "@rescene/api-client";
import { createWebUploader } from "@rescene/uploader/web";
import dynamic from "next/dynamic";
const Viewer = dynamic(() => import("@rescene/viewer").then((module) => module.Viewer), { ssr: false });
import { Workbench, type KeyValueStore } from "@rescene/workbench";
import { useState } from "react";

import { API_BASE as API, WEB_BASE } from "./env";

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
    />
  );
}
