import { Link, createFileRoute, useParams } from "@tanstack/react-router";

import { ResourceNotice } from "#/components/DashboardPage";
import { buttonVariants } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { getRuntimeConfig, listDatabaseSchemaVersions } from "#/lib/runtime-api";
import { useRuntimeResource } from "#/lib/use-runtime-resource";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/content/$contentType/fields")({
  component: ContentTypeFieldsRoute,
});

function ContentTypeFieldsRoute() {
  const { contentType } = useParams({ from: "/content/$contentType/fields" });
  const runtime = useRuntimeResource(getRuntimeConfig);
  const config = runtime.data;
  const schemas = useRuntimeResource(
    async () => (config ? listDatabaseSchemaVersions(config, contentType) : []),
    [config, contentType],
  );
  const activeSchema = schemas.data?.find((schema) => schema.active) ?? schemas.data?.at(-1);
  const properties =
    activeSchema?.document &&
    typeof activeSchema.document === "object" &&
    activeSchema.document !== null &&
    "properties" in activeSchema.document &&
    typeof activeSchema.document.properties === "object" &&
    activeSchema.document.properties !== null
      ? Object.entries(activeSchema.document.properties as Record<string, Record<string, unknown>>)
      : [];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Field summary</CardTitle>
          <Link
            to="/database"
            search={{ sidebar: "Core" }}
            className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
          >
            Open raw schema editor
          </Link>
        </CardHeader>
        <CardContent className="p-0">
          {properties.length === 0 ? (
            <div className="p-4">
              <ResourceNotice
                title="No schema properties yet"
                description="Create or activate a schema version to see field definitions here."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/20 text-left text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Field</th>
                    <th className="px-4 py-3 font-medium">Type</th>
                    <th className="px-4 py-3 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {properties.map(([name, definition]) => (
                    <tr key={name} className="border-b last:border-b-0">
                      <td className="px-4 py-3 font-medium text-foreground">{name}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {typeof definition.type === "string" ? definition.type : "custom"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {typeof definition.description === "string"
                          ? definition.description
                          : "Managed through the active content schema."}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active schema JSON</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 p-4">
          {activeSchema ? (
            <>
              <p className="text-sm text-muted-foreground">
                This is the active schema powering the friendlier content surface.
              </p>
              <pre className="overflow-x-auto rounded-md border bg-muted/25 p-4 text-xs leading-6 text-muted-foreground">
                {JSON.stringify(activeSchema.document, null, 2)}
              </pre>
            </>
          ) : (
            <ResourceNotice
              title="No active schema"
              description="Once this content type has a schema version, it will show up here alongside editor-facing field summaries."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
