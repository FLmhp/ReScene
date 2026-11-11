import { Button, Text, View, WebView } from "@tarojs/components";
import { useRouter, useShareAppMessage } from "@tarojs/taro";
import { useState } from "react";

import { webBaseUrl } from "../../api";

function decodeParam(value: string | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

export default function ViewerPage() {
  const { params } = useRouter();
  const reconstruction = decodeParam(params.id);
  const share = decodeParam(params.share);
  const baseUrl = (webBaseUrl ?? "").replace(/\/+$/, "");
  const validBase = /^https:\/\/[^/?#\s]+(?:\/[^?#\s]*)?$/.test(baseUrl);
  const validRoute = Boolean(reconstruction) !== Boolean(share);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  useShareAppMessage(() => ({
    title: "ReScene 三维场景",
    path: share ? `/pages/viewer/index?share=${encodeURIComponent(share)}` : "/pages/index/index",
  }));

  const src = validBase && validRoute
    ? share
      ? `${baseUrl}/share/${encodeURIComponent(share)}`
      : `${baseUrl}/viewer?reconstruction=${encodeURIComponent(reconstruction)}`
    : "";

  if (open && src) {
    return <WebView src={src} onError={() => { setOpen(false); setFailed(true); }} />;
  }

  return (
    <View className="screen">
      <Text className="title">三维场景</Text>
      {!validRoute ? (
        <Text className="error">场景链接无效。请从项目重新打开，或使用有效的分享链接。</Text>
      ) : !validBase ? (
        <Text className="error">查看器地址未配置为有效的 HTTPS 地址，请联系管理员。</Text>
      ) : (
        <>
          <Text className="muted">场景将在小程序内的网页中打开。小程序需要在后台配置查看器业务域名，且设备和网络须支持 WebGL。</Text>
          {share ? (
            <Text className="muted">分享无需登录；链接失效或被撤销时，请联系分享者重新获取。</Text>
          ) : (
            <Text className="muted">网页使用独立登录，请使用已有账户登录；登录过期后需重新登录。场景加载失败时可在网页中重试。</Text>
          )}
          {failed ? <Text className="error">网页打开失败。请检查网络、HTTPS 和小程序业务域名配置后重试。</Text> : null}
          <Button className="button" onClick={() => { setFailed(false); setOpen(true); }}>
            {failed ? "重试打开" : "打开场景"}
          </Button>
        </>
      )}
    </View>
  );
}
