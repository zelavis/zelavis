import * as React from "react";
import { useLocation } from "@tanstack/react-router";

import { PluginFrame } from "#/components/PluginFrame";
import { findPluginMenuPageByPath } from "#/lib/dashboard-data";
import { getRuntimeConfig } from "#/lib/runtime-api";
import { useRuntimeResource } from "#/lib/use-runtime-resource";

export function PluginPageMount({
  fallback,
}: {
  fallback: React.ReactNode;
}) {
  const pathname = useLocation({
    select: (location) => location.pathname,
  });
  const runtime = useRuntimeResource(getRuntimeConfig);
  const page = findPluginMenuPageByPath(pathname, runtime.data?.plugins);

  if (!page) {
    return <>{fallback}</>;
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PluginFrame src={page.src} title={page.title ?? "Plugin page"} />
    </section>
  );
}
