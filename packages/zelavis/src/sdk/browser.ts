export * from "./fetch.js";
export {
  createZelavisClient as createBrowserZelavisClient,
  fetchSdkSurface as browserSdkSurface,
  zelavis,
  default,
} from "./fetch.js";

export const browser = true;
