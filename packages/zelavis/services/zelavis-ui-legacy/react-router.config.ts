import type { Config } from "@react-router/dev/config";

function normalizeBasename(path: string | undefined) {
  if (!path || path === "/") {
    return "/";
  }

  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  return `${withLeadingSlash.replace(/\/+$/, "")}/`;
}

export default {
  basename: normalizeBasename(process.env.ZELAVIS_UI_BASE_PATH),
  ssr: false,
} satisfies Config;
