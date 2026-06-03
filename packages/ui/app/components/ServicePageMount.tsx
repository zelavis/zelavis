import * as React from "react";
import { useLocation, useRouteLoaderData } from "react-router";

import { ServiceFrame } from "#/components/ServiceFrame";
import { findServiceMenuPageByPath } from "#/lib/dashboard-data";
import type { clientLoader as rootClientLoader } from '../root';

export function ServicePageMount({
  fallback,
}: {
  fallback: React.ReactNode;
}) {
  const pathname = useLocation().pathname;
  const { runtime } = useRouteLoaderData<typeof rootClientLoader>('root')!;
  const page = findServiceMenuPageByPath(pathname, runtime.serviceRegistry);

  if (!page) {
    return <>{fallback}</>;
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <ServiceFrame src={page.src} title={page.title ?? "Service page"} />
    </section>
  );
}
