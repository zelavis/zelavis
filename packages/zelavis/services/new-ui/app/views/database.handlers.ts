import { getRouter } from "fuzor/runtime";
import type { ResumableHandler } from "fuzor/server-components/browser";
export const refresh: ResumableHandler = async context => {
  const router = getRouter(context.element.ownerDocument);
  if (!router) throw new Error("Dashboard router is unavailable.");
  await router.navigate(router.url(), { focus: "preserve", scroll: "preserve" });
};
