import fs from "node:fs";
import path from "node:path";

import type { ConfigEnv, UserConfigExport } from "@tarojs/cli";
import { dotenvParse } from "@tarojs/helper";

const DEVELOPMENT_API_URL = "http://localhost:8000";
const DEVELOPMENT_WEB_URL = "http://localhost:3000";
const DEVELOPMENT_PROJECT_CONFIG = "config/project.config.development.json";
const TOURIST_APP_ID = "touristappid";

const WECHAT_APP_ID_PATTERN = /^wx[0-9a-f]{16}$/;

type MiniappEnv = {
  TARO_APP_API_URL?: string;
  TARO_APP_ID?: string;
  TARO_APP_WEB_URL?: string;
  TARO_APP_WECHAT_APP_ID?: string;
};

type ResolvedBuildConfig = {
  apiUrl: string;
  appId: string;
  webUrl: string;
};

function trimValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readEnv(mode: string): MiniappEnv {
  const fileEnv = dotenvParse(path.resolve(__dirname, ".."), ["TARO_APP_"], mode);
  return { ...fileEnv, ...process.env } as MiniappEnv;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

function parseUrl(
  name: string,
  value: string | undefined,
  issues: string[],
  options: { requireHttps: boolean; rejectLoopback: boolean },
): string | undefined {
  if (!value) {
    issues.push(`${name} is required${options.requireHttps ? " and must be an HTTPS URL" : ""}`);
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    issues.push(`${name} must be an absolute URL, received "${value}"`);
    return undefined;
  }

  if (options.requireHttps && url.protocol !== "https:") {
    issues.push(`${name} must use HTTPS in production, received "${value}"`);
    return undefined;
  }
  if (!options.requireHttps && url.protocol !== "http:" && url.protocol !== "https:") {
    issues.push(`${name} must use HTTP or HTTPS, received "${value}"`);
    return undefined;
  }
  if (url.username || url.password) {
    issues.push(`${name} must not contain credentials`);
    return undefined;
  }
  if (url.search || url.hash) {
    issues.push(`${name} must not contain a query string or fragment`);
    return undefined;
  }
  if (options.rejectLoopback && isLoopbackHost(url.hostname)) {
    issues.push(`${name} must not point at localhost or a loopback address in production, received "${value}"`);
    return undefined;
  }

  return value.replace(/\/+$/, "");
}

function resolveProductionEnv(env: MiniappEnv): ResolvedBuildConfig {
  const issues: string[] = [];
  const appId = trimValue(env.TARO_APP_WECHAT_APP_ID);
  const apiUrl = parseUrl("TARO_APP_API_URL", trimValue(env.TARO_APP_API_URL), issues, {
    rejectLoopback: true,
    requireHttps: true,
  });
  const webUrl = parseUrl("TARO_APP_WEB_URL", trimValue(env.TARO_APP_WEB_URL), issues, {
    rejectLoopback: true,
    requireHttps: true,
  });

  if (!appId) {
    issues.push("TARO_APP_WECHAT_APP_ID is required");
  } else if (appId === TOURIST_APP_ID) {
    issues.push("TARO_APP_WECHAT_APP_ID must be a real WeChat Mini Program AppID, not touristappid");
  } else if (!WECHAT_APP_ID_PATTERN.test(appId)) {
    issues.push(`TARO_APP_WECHAT_APP_ID must be "wx" plus 16 hexadecimal characters, received "${appId}"`);
  }

  if (issues.length > 0 || !appId || !apiUrl || !webUrl) {
    throw new Error(
      [
        "[@rescene/miniapp] Production builds require an explicit, non-tourist configuration:",
        ...issues.map(issue => `  - ${issue}`),
        "Set these values in the shell or in an ignored .env/.env.production file, then retry the production build.",
      ].join("\n"),
    );
  }

  return { apiUrl, appId, webUrl };
}

function resolveDevelopmentEnv(env: MiniappEnv): ResolvedBuildConfig {
  const issues: string[] = [];
  const apiValue = trimValue(env.TARO_APP_API_URL);
  const webValue = trimValue(env.TARO_APP_WEB_URL);
  const apiUrl = apiValue
    ? parseUrl("TARO_APP_API_URL", apiValue, issues, {
        rejectLoopback: false,
        requireHttps: false,
      })
    : undefined;
  const webUrl = webValue
    ? parseUrl("TARO_APP_WEB_URL", webValue, issues, {
        rejectLoopback: false,
        requireHttps: false,
      })
    : undefined;

  if (issues.length > 0) {
    throw new Error(
      ["[@rescene/miniapp] Development configuration is invalid:", ...issues.map(issue => `  - ${issue}`)].join(
        "\n",
      ),
    );
  }

  return {
    apiUrl: apiUrl ?? DEVELOPMENT_API_URL,
    appId: TOURIST_APP_ID,
    webUrl: webUrl ?? DEVELOPMENT_WEB_URL,
  };
}

function rewriteProductionProjectConfig(appId: string): void {
  if (!WECHAT_APP_ID_PATTERN.test(appId)) {
    throw new Error(`[@rescene/miniapp] Refusing to emit a production project config with AppID "${appId}".`);
  }

  const projectConfigPath = path.resolve(__dirname, "..", "dist", "project.config.json");
  const sourcePath = path.resolve(__dirname, "..", "project.config.json");
  if (!fs.existsSync(projectConfigPath) && !fs.existsSync(sourcePath)) {
    throw new Error(`[@rescene/miniapp] No template to emit a production project config at ${projectConfigPath}.`);
  }

  const templatePath = fs.existsSync(projectConfigPath) ? projectConfigPath : sourcePath;
  const generated = JSON.parse(fs.readFileSync(templatePath, "utf8")) as {
    appid?: string;
    miniprogramRoot?: string;
    setting?: Record<string, unknown>;
    [key: string]: unknown;
  };
  if (!generated.miniprogramRoot) {
    generated.miniprogramRoot = "./";
  }

  const projectConfig = {
    ...generated,
    appid: appId,
    miniprogramRoot: "./",
    setting: {
      ...generated.setting,
      minified: true,
      urlCheck: true,
    },
  };
  fs.writeFileSync(projectConfigPath, `${JSON.stringify(projectConfig, null, 2)}\n`);
}

export default (_merge?: unknown, configEnv?: Partial<ConfigEnv>): UserConfigExport => {
  // Taro defaults NODE_ENV to production for any non-watch build; development
  // therefore requires the explicit `--env development` this repo's scripts pass.
  const isDevelopment = process.env.NODE_ENV !== "production";
  const mode =
    configEnv?.mode ??
    process.env.NODE_ENV ??
    (isDevelopment ? "development" : "production");
  const env = readEnv(mode);
  const resolved = isDevelopment ? resolveDevelopmentEnv(env) : resolveProductionEnv(env);

  // Taro reads TARO_APP_ID when it generates dist/project.config.json.
  // Production uses the validated value; development always stays a tourist build.
  process.env.TARO_APP_ID = resolved.appId;

  const config = {
    projectName: "rescene-miniapp",
    date: "2026-11-10",
    designWidth: 750,
    deviceRatio: { 640: 2.34 / 2, 750: 1, 828: 1.81 / 2 },
    sourceRoot: "src",
    outputRoot: "dist",
    plugins: [],
    onBuildFinish: async ({ error }: { error?: unknown }): Promise<void> => {
      if (error || isDevelopment) {
        return;
      }
      rewriteProductionProjectConfig(resolved.appId);
    },
    defineConstants: {
      "process.env.TARO_APP_API_URL": JSON.stringify(resolved.apiUrl),
      "process.env.TARO_APP_WEB_URL": JSON.stringify(resolved.webUrl),
    },
    copy: { patterns: [], options: {} },
    framework: "react",
    compiler: "webpack5",
    cache: { enable: false },
    alias: {
      "@": path.resolve(__dirname, "..", "src"),
    },
    mini: {
      compile: {
        include: [path.resolve(__dirname, "..", "..", "..", "packages")],
      },
      // Taro's build command can replace the config-level onBuildFinish hook with
      // its own plugin hook; afterEmit keeps the emitted config rewrite guaranteed.
      webpackChain(chain, webpack) {
        if (isDevelopment) {
          return;
        }
        chain.plugin("rescene-production-project-config").use({
          apply(compiler: InstanceType<typeof webpack.Compiler>) {
            compiler.hooks.afterEmit.tap("ResceneProductionProjectConfig", () => {
              rewriteProductionProjectConfig(resolved.appId);
            });
          },
        });
      },
      postcss: {
        pxtransform: { enable: true, config: {} },
        url: { enable: true, config: { limit: 1024 } },
        cssModules: {
          enable: false,
          config: { namingPattern: "module", generateScopedName: "[name]__[local]___[hash:base64:5]" },
        },
      },
    },
    h5: {},
  } satisfies UserConfigExport;

  if (!isDevelopment) {
    return config;
  }

  return {
    ...config,
    projectConfigName: DEVELOPMENT_PROJECT_CONFIG,
  } as UserConfigExport;
};
