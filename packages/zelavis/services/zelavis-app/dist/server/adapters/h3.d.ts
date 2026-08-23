import type { H3 } from "h3";
import type { ZelavisServerRuntime } from "../contracts.js";
export declare function h3Adapter<TService = unknown>(runtime: Pick<ZelavisServerRuntime<TService>, "dispatch">): Parameters<H3["use"]>[0];
