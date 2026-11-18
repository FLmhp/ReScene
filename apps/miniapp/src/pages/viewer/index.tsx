import { Screen } from "../../screen";
import { Button, Text, View, WebView } from "@tarojs/components";
import Taro, { useRouter, useShareAppMessage } from "@tarojs/taro";
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
    <Screen>
      <Text className="title">三维场景</Text>
      {!validRoute ? (
        <Text className="error">场景链接无效。请从项目重新打开，或使用有效的分享链接。</Text>
      ) : !validBase ? (
        <Text className="error">查看器地址未配置为有效的 HTTPS 地址，请联系管理员。</Text>
      ) : (
        <View className="card">
          <Text className="section-heading">在浏览器查看</Text>
          {share ? (
            <Text className="muted">分享无需登录；链接失效或被撤销时，请联系分享者重新获取。</Text>
          ) : (
            <Text className="muted">复制链接到手机浏览器，用 ReScene 账号登录后查看场景。</Text>
          )}
          <Button className="button" onClick={() => void Taro.setClipboardData({ data: src }).catch(() => Taro.showToast({ title: "复制失败", icon: "none" }))}>
            复制查看链接
          </Button>
          {failed ? <Text className="error">小程序内打开失败，请复制链接到浏览器。</Text> : null}
          <Button className="button ghost" onClick={() => { setFailed(false); setOpen(true); }}>在小程序内打开</Button>
        </View>
      )}
    </Screen>
  );
}
