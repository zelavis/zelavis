import { Link, Outlet, useParams, useRouteLoaderData } from "react-router";

import { ResourceNotice } from "#/components/DashboardPage";
import { buttonVariants } from "#/components/ui/button";
import { buildContentTypeRows } from "#/lib/content-studio";
import { getResolvedDashboardPreferences } from "#/lib/runtime-api";
import { toDashboardPath, toProjectPath } from "#/lib/routing";
import { cn } from "#/lib/utils";
import type { clientLoader as rootClientLoader } from '../root';

export const handle = {
  pageLabel: "Content",
  sidebarTrail: ["Content"],
} as const;

function ContentTypeLayout() {
  const contentTypeName = useParams().contentType ?? "";
  const { settings, databaseCollections, schemaCollections } = useRouteLoaderData<typeof rootClientLoader>('root')!;
  const contentType = buildContentTypeRows(
    databaseCollections,
    schemaCollections,
    getResolvedDashboardPreferences(settings).content,
  ).find((row) => row.name === contentTypeName);

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link
          to={toProjectPath("/content")}
          className={cn(buttonVariants({ variant: "outline" }))}
        >
          Back to Content
        </Link>
        <Link
          to={toDashboardPath(toProjectPath("/database"), { sidebar: "Backend" })}
          className={cn(buttonVariants({ variant: "outline" }))}
        >
          Open Backend Database
        </Link>
      </div>

      {!contentType ? (
        <ResourceNotice
          title="Unknown content type"
          description={`No content type named ${contentTypeName} is available.`}
        />
      ) : (
        <Outlet />
      )}
    </section>
  );
}

export default ContentTypeLayout;
