import * as React from "react";
import { useLocation, useRouteLoaderData } from "react-router";

import { ResourceNotice } from "#/components/DashboardPage";
import { ServiceFrame } from "#/components/ServiceFrame";
import { findServiceMenuContentByPath } from "#/lib/dashboard-data";
import type { clientLoader as rootClientLoader } from '../root';

export function ServicePageMount({
  allowPlaceholder = false,
  fallback,
}: {
  allowPlaceholder?: boolean;
  fallback: React.ReactNode;
}) {
  const pathname = useLocation().pathname;
  const { runtime } = useRouteLoaderData<typeof rootClientLoader>('root')!;
  const content = findServiceMenuContentByPath(
    pathname,
    runtime.services,
    runtime.serviceRegistry,
  );

  if (!content) {
    return <>{fallback}</>;
  }

  if (content.kind === "placeholder" && !allowPlaceholder) {
    return <>{fallback}</>;
  }

  if (content.kind === "placeholder") {
    return (
      <section className="mx-auto grid w-full max-w-7xl gap-6">
        <ResourceNotice
          title={content.title}
          description={content.description}
        />
      </section>
    );
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <ServiceFrame src={content.page.src} title={content.title} />
    </section>
  );
}
