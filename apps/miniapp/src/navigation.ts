import Taro from "@tarojs/taro";

export const HOME_PAGE = "/pages/index/index";

export function openHome(): Promise<TaroGeneral.CallbackResult> {
  return Taro.reLaunch({ url: HOME_PAGE });
}
