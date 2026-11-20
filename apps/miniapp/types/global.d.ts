declare namespace NodeJS {
  interface ProcessEnv {
    TARO_APP_API_URL: string;
    TARO_APP_WEB_URL: string;
  }
}

declare const defineAppConfig: <T>(config: T) => T;

declare module "*.png" {
  const asset: string;
  export default asset;
}
