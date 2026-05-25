import * as React from "react";
import { useLocation } from "react-router";

import { ServiceFrame } from "#/components/ServiceFrame";
import { findServiceMenuPageByPath } from "#/lib/dashboard-data";
import { getRuntimeConfig } from "#/lib/runtime-api";
import { useRuntimeResource } from "#/lib/use-runtime-resource";

export function ServicePageMount({
  fallback,
}: {
  fallback: React.ReactNode;
}) {
  const pathname = useLocation().pathname;
  const runtime = useRuntimeResource(getRuntimeConfig);
  const page = findServiceMenuPageByPath(pathname, runtime.data?.serviceRegistry);

  if (!page) {
    return <>{fallback}</>;
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <ServiceFrame src={page.src} title={page.title ?? "Service page"} />
    </section>
  );
}
