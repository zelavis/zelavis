import { Link, Outlet, createFileRoute, useParams } from "@tanstack/react-router";

import { PageHeader, ResourceNotice, StatusBadge } from "#/components/DashboardPage";
import { buttonVariants } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { buildContentTypeRows } from "#/lib/content-studio";
import {
  getDashboardSettings,
  getResolvedDashboardPreferences,
  getRuntimeConfig,
  listDatabaseCollections,
  listDatabaseSchemaCollections,
} from "#/lib/runtime-api";
import { useRuntimeResource } from "#/lib/use-runtime-resource";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/content/$contentType")({
  component: ContentTypeLayout,
});

function ContentTypeLayout() {
  const { contentType: contentTypeName } = useParams({ from: "/content/$contentType" });
  const runtime = useRuntimeResource(getRuntimeConfig);
  const config = runtime.data;
  const settings = useRuntimeResource(
    async () => (config ? getDashboardSettings(config) : undefined),
    [config],
  );
  const collections = useRuntimeResource(
    async () => (config ? listDatabaseCollections(config) : []),
    [config],
  );
  const schemaCollections = useRuntimeResource(
    async () => (config ? listDatabaseSchemaCollections(config) : []),
    [config],
  );
  const contentType = buildContentTypeRows(
    collections.data ?? [],
    schemaCollections.data ?? [],
    getResolvedDashboardPreferences(settings.data).content,
  ).find((row) => row.name === contentTypeName);

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
              to="/database"
              search={{ sidebar: "Core" }}
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
                to="/content/$contentType"
                params={{ contentType: contentType.name }}
                className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
              >
                Entries
              </Link>
              <Link
                to="/content/$contentType/fields"
                params={{ contentType: contentType.name }}
                className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
              >
                Fields
              </Link>
              <Link
                to="/content/$contentType/edit"
                params={{ contentType: contentType.name }}
                className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
              >
                Type Editor
              </Link>
              <Link
                to="/content/$contentType/settings"
                params={{ contentType: contentType.name }}
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
