import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["ali-oss"],
  transpilePackages: [
    "@rescene/api-client",
    "@rescene/design-tokens",
    "@rescene/schemas",
    "@rescene/uploader",
    "@rescene/viewer",
    "@rescene/workbench",
  ],
};

export default config;
