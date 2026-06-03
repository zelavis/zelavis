import { Link, Outlet, useParams, useRouteLoaderData } from "react-router";

import { PageHeader, ResourceNotice, StatusBadge } from "#/components/DashboardPage";
import { buttonVariants } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { buildContentTypeRows } from "#/lib/content-studio";
import { getResolvedDashboardPreferences } from "#/lib/runtime-api";
import { toDashboardPath } from "#/lib/routing";
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
  const contentTypePath = encodeURIComponent(contentType?.name ?? "");

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Content"
        title={contentType?.label ?? contentTypeName}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/content"
              className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
            >
              Back to Content
            </Link>
            <Link
              to={toDashboardPath("/database", { sidebar: "Core" })}
              className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
            >
              Open Core Database
            </Link>
          </div>
        }
      />

      {!contentType ? (
        <ResourceNotice
          title="Unknown content type"
          description={`No content type named ${contentTypeName} is available.`}
        />
      ) : (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-center gap-2 p-4">
              <Link
                to={`/content/${contentTypePath}`}
                className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
              >
                Entries
              </Link>
              <Link
                to={`/content/${contentTypePath}/fields`}
                className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
              >
                Fields
              </Link>
              <Link
                to={`/content/${contentTypePath}/edit`}
                className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
              >
                Type Editor
              </Link>
              <Link
                to={`/content/${contentTypePath}/settings`}
                className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
              >
                Type Settings
              </Link>
              <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
                <StatusBadge state={contentType.activeVersion ? "ready" : "planned"} />
                <span>{contentType.activeVersion ? `Schema v${contentType.activeVersion}` : "No active schema"}</span>
              </div>
            </CardContent>
          </Card>
          <Outlet />
        </>
      )}
    </section>
  );
}

export default ContentTypeLayout;
