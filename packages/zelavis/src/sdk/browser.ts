export * from "./fetch.js";
export {
  createZelavisClient as createBrowserZelavisClient,
  fetchSdkSurface as browserSdkSurface,
} from "./fetch.js";

export const browser = true;
