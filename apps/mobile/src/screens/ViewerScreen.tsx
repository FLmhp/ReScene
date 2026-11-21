import { useCallback, useEffect, useRef, useState, type ComponentType, type RefAttributes } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import {
  WebView as WebViewBase,
  type WebViewMessageEvent,
  type WebViewProps,
} from "react-native-webview";

import { client, webBaseUrl } from "../api";
import { useAppearance } from "../appearance";
import { Button, useTextStyles } from "../ui";

type WebViewHandle = { injectJavaScript: (script: string) => void };

/**
 * react-native-webview 14 declares the root component as
 * `Component<WebViewProps & undefined>`, so React 19 typings collapse its
 * props to `never`. The runtime component accepts WebViewProps; re-type the
 * same component instead of widening props to `any`.
 */
const WebView = WebViewBase as unknown as ComponentType<WebViewProps & RefAttributes<WebViewHandle>>;

export function ViewerScreen({ reconstructionId, onBack }: { reconstructionId: string; onBack: () => void }) {
  const { theme, dark } = useAppearance();
  const textStyles = useTextStyles();
  const webview = useRef<WebViewHandle>(null);
  const [error, setError] = useState("");
  const [viewer, setViewer] = useState<{ url: string; generation: number; scene: string } | null>(null);
  const generation = useRef(0);
  const scene = JSON.stringify([reconstructionId, dark]);
  const currentScene = useRef(scene);
  currentScene.current = scene;
  const trustedOrigin = new URL(webBaseUrl).origin;

  const load = useCallback(() => {
    const nextGeneration = ++generation.current;
    setError("");
    setViewer({
      url: `${webBaseUrl}/viewer?reconstruction=${encodeURIComponent(reconstructionId)}&theme=${dark ? "dark" : "light"}`,
      generation: nextGeneration,
      scene,
    });
  }, [reconstructionId, dark, scene]);

  useEffect(() => {
    load();
    return () => { generation.current += 1; };
  }, [load]);

  function isCurrent(instance: NonNullable<typeof viewer>) {
    return generation.current === instance.generation && currentScene.current === instance.scene;
  }

  function isViewerDocument(url: string) {
    try {
      const document = new URL(url);
      return document.origin === trustedOrigin && document.pathname.replace(/\/$/, "") === "/viewer";
    } catch { return false; }
  }

  async function receive(event: WebViewMessageEvent, instance: NonNullable<typeof viewer>) {
    try {
      if (!isCurrent(instance)) return;
      // Android's WebMessageListener supplies the source origin, not a document URL.
      // Legacy WebViews can supply the full URL or omit it; navigation pins the viewer document.
      const pageUrl = event.nativeEvent.url;
      if (pageUrl && pageUrl !== trustedOrigin && !isViewerDocument(pageUrl)) return;
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
      if (!isCurrent(instance)) return;
      const data = JSON.stringify(JSON.stringify(response)).replace(/</g, "\\u003c");
      webview.current?.injectJavaScript(`window.dispatchEvent(new MessageEvent('message',{data:${data}})); true;`);
    } catch {
      // Ignore malformed messages from the page, never expose credentials.
    }
  }

  return <View style={{ flex: 1, backgroundColor: theme.bg }}>
    <Button label="返回任务" tone="ghost" onPress={onBack} />
    {viewer && viewer.scene === scene && !error ? <WebView
      key={viewer.generation}
      ref={webview}
      allowsInlineMediaPlayback
      javaScriptEnabled
      mixedContentMode="never"
      originWhitelist={[trustedOrigin]}
      onShouldStartLoadWithRequest={({ url }) => isViewerDocument(url)}
      onMessage={(event) => void receive(event, viewer)}
      onError={(event) => {
        if (isCurrent(viewer) && isViewerDocument(event.nativeEvent.url)) {
          generation.current += 1;
          setError("Viewer 加载失败，请检查网络后重试");
        }
      }}
      onHttpError={(event) => {
        if (isCurrent(viewer) && isViewerDocument(event.nativeEvent.url)) {
          generation.current += 1;
          setError(`Viewer 加载失败 (${event.nativeEvent.statusCode})`);
        }
      }}
      renderLoading={() => <ActivityIndicator accessibilityLabel="正在加载三维场景" />}
      startInLoadingState
      source={{ uri: viewer.url }}
      style={{ flex: 1, backgroundColor: theme.bg }}
    /> : <View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: 12, padding: 24 }}>
      {error ? <>
        <Text accessibilityRole="alert" style={textStyles.error}>{error}</Text>
        <Button label="重试 Viewer" onPress={load} />
      </> : <ActivityIndicator accessibilityLabel="正在获取三维场景" />}
    </View>}
  </View>;
}
