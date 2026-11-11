import { useCallback, useEffect, useRef, useState, type ComponentType, type RefAttributes } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import {
  WebView as WebViewBase,
  type WebViewMessageEvent,
  type WebViewProps,
} from "react-native-webview";

import { client, webBaseUrl } from "../api";
import { theme } from "../theme";
import { Button, textStyles } from "../ui";

type WebViewHandle = { injectJavaScript: (script: string) => void };

/**
 * react-native-webview 14 declares the root component as
 * `Component<WebViewProps & undefined>`, so React 19 typings collapse its
 * props to `never`. The runtime component accepts WebViewProps; re-type the
 * same component instead of widening props to `any`.
 */
const WebView = WebViewBase as unknown as ComponentType<WebViewProps & RefAttributes<WebViewHandle>>;

export function ViewerScreen({ reconstructionId, onBack }: { reconstructionId: string; onBack: () => void }) {
  const webview = useRef<WebViewHandle>(null);
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  const [viewerUrl, setViewerUrl] = useState("");
  const trustedOrigin = new URL(webBaseUrl).origin;

  const load = useCallback(async () => {
    setError("");
    setViewerUrl("");
    try {
      const manifest = await client.getManifest(reconstructionId);
      const artifact = manifest.artifacts.find((item) => item.kind === "spz") ?? manifest.artifacts.find((item) => item.kind === "ply");
      if (!artifact) throw new Error("没有可显示的 SPZ 或 PLY 产物");
      // The web viewer accepts a short-lived signed URL, so the bearer token
      // never enters the page. The native bridge remains for in-page renewal.
      setViewerUrl(`${webBaseUrl}/viewer?reconstruction=${encodeURIComponent(reconstructionId)}&src=${encodeURIComponent(artifact.url)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "获取场景失败");
    }
  }, [reconstructionId]);

  useEffect(() => { void load(); }, [load]);

  async function receive(event: WebViewMessageEvent) {
    try {
      // Android WebView does not always expose `nativeEvent.url`; the WebView
      // source and onShouldStartLoadWithRequest already pin the trusted origin.
      const pageUrl = event.nativeEvent.url;
      if (pageUrl) {
        const source = new URL(pageUrl);
        if (source.origin !== trustedOrigin || !source.pathname.startsWith("/viewer")) return;
      }
      const request: unknown = JSON.parse(event.nativeEvent.data);
      if (!request || typeof request !== "object") return;
      const payload = request as Record<string, unknown>;
      if (payload.type !== "RESCENE_MANIFEST_REQUEST" || payload.reconstructionId !== reconstructionId || typeof payload.requestId !== "string") return;
      let response: Record<string, string>;
      try {
        const manifest = await client.getManifest(reconstructionId);
        const artifact = manifest.artifacts.find((item) => item.kind === "spz") ?? manifest.artifacts.find((item) => item.kind === "ply");
        if (!artifact) throw new Error("没有可显示的 SPZ 或 PLY 产物");
        response = { type: "RESCENE_MANIFEST_RESPONSE", requestId: payload.requestId, src: artifact.url };
      } catch (reason) {
        response = { type: "RESCENE_MANIFEST_RESPONSE", requestId: payload.requestId, error: reason instanceof Error ? reason.message : "获取产物失败" };
      }
      const data = JSON.stringify(JSON.stringify(response)).replace(/</g, "\\u003c");
      webview.current?.injectJavaScript(`window.dispatchEvent(new MessageEvent('message',{data:${data}})); true;`);
    } catch {
      // Ignore malformed messages from the page, never expose credentials.
    }
  }

  return <View style={{ flex: 1, backgroundColor: theme.bg }}>
    <Button label="返回任务" tone="ghost" onPress={onBack} />
    {viewerUrl ? <WebView
      key={generation}
      ref={webview}
      allowsInlineMediaPlayback
      javaScriptEnabled
      mixedContentMode="never"
      originWhitelist={[trustedOrigin]}
      onShouldStartLoadWithRequest={(request) => {
        try {
          const url = new URL(request.url);
          return url.origin === trustedOrigin && url.pathname.startsWith("/viewer");
        } catch { return false; }
      }}
      onMessage={(event) => void receive(event)}
      onError={() => setError("Viewer 加载失败，请检查网络后重试")}
      onHttpError={(event) => setError(`Viewer 加载失败 (${event.nativeEvent.statusCode})`)}
      renderLoading={() => <ActivityIndicator accessibilityLabel="正在加载三维场景" />}
      startInLoadingState
      source={{ uri: viewerUrl }}
      style={{ flex: 1, backgroundColor: theme.bg }}
    /> : <View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: 12, padding: 24 }}>
      {error ? <>
        <Text accessibilityRole="alert" style={textStyles.error}>{error}</Text>
        <Button label="重试 Viewer" onPress={() => { setGeneration((value) => value + 1); void load(); }} />
      </> : <ActivityIndicator accessibilityLabel="正在获取三维场景" />}
    </View>}
  </View>;
}
