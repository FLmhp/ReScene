import { Screen } from "../../screen";
import { Button, Text, View } from "@tarojs/components";
import Taro, { useRouter, useShareAppMessage } from "@tarojs/taro";

import { hasToken, webBaseUrl } from "../../api";
import { HOME_PAGE, openHome } from "../../navigation";

function decodeParam(value: string | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

export default function ViewerPage() {
  const params = useRouter()?.params ?? {};
  const reconstruction = decodeParam(params.id);
  const share = decodeParam(params.share);
  const baseUrl = (webBaseUrl ?? "").replace(/\/+$/, "");
  const validBase = /^https:\/\/[^/?#\s]+(?:\/[^?#\s]*)?$/.test(baseUrl);
  const validRoute = Boolean(reconstruction) !== Boolean(share);

  useShareAppMessage(() => ({
    title: "ReScene 三维场景",
    path: share ? `/pages/viewer/index?share=${encodeURIComponent(share)}` : HOME_PAGE,
  }));

  const src = validBase && validRoute
    ? share
      ? `${baseUrl}/share/${encodeURIComponent(share)}`
      : `${baseUrl}/viewer?reconstruction=${encodeURIComponent(reconstruction)}`
    : "";

  return (
    <Screen>
      <Text className="title">三维场景</Text>
      {!validRoute ? (
        <Text className="error">场景链接无效。请从项目重新打开，或使用有效的分享链接。</Text>
      ) : reconstruction && !hasToken() ? (
        <Text className="error">登录后可从项目打开该场景。</Text>
      ) : !validBase ? (
        <Text className="error">查看器地址未配置为有效的 HTTPS 地址，请联系管理员。</Text>
      ) : (
        <View className="card">
          <Text className="section-heading">在浏览器中查看</Text>
          {share ? (
            <Text className="muted">复制链接到手机浏览器即可查看，无需登录。链接失效时请联系分享者。</Text>
          ) : (
            <Text className="muted">复制链接到手机浏览器，用 ReScene 账号登录后查看场景。</Text>
          )}
          <Button className="button" onClick={() => void Taro.setClipboardData({ data: src }).catch(() => Taro.showToast({ title: "复制失败", icon: "none" }))}>
            复制查看链接
          </Button>
        </View>
      )}
      <Button className="button ghost" onClick={() => void openHome().catch(() => undefined)}>返回首页</Button>
    </Screen>
  );
}
