import Taro from "@tarojs/taro";

export const HOME_PAGE = "/pages/index/index";

let logoutNotice = "";
let materialsReturn: { projectId: string; ownerId: string } | null = null;

export function setLogoutNotice(notice: string): void { logoutNotice = notice; }
export function consumeLogoutNotice(): string { const notice = logoutNotice; logoutNotice = ""; return notice; }
export function requestMaterialsReturn(projectId: string, ownerId: string): void { materialsReturn = { projectId, ownerId }; }
export function consumeMaterialsReturn(projectId: string, ownerId: string): boolean {
  if (!materialsReturn || materialsReturn.projectId !== projectId || materialsReturn.ownerId !== ownerId) return false;
  materialsReturn = null;
  return true;
}

export function openHome(): Promise<TaroGeneral.CallbackResult> {
  return Taro.reLaunch({ url: HOME_PAGE });
}
