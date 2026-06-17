import { Link, useLoaderData, useRevalidator, useRouteLoaderData } from "react-router";
import { Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { SchemaFieldEditor } from "#/components/content/SchemaFieldEditor";
import { DataRow, ResourceNotice } from "#/components/DashboardPage";
import { Button, buttonVariants } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import {
  getContentSchemaFields,
  initializeFieldDraftValue,
  normalizeSchemaFieldValue,
} from "#/lib/content-schema";
import {
  getDatabaseDocument,
  getRuntimeConfig,
  getStorageFileUrl,
  listDatabaseSchemaVersions,
  listStorageFiles,
  updateDatabaseDocument,
} from "#/lib/runtime-api";
import { cn } from "#/lib/utils";
import type { Route } from './+types/content.$contentType.$entryId';
import type { clientLoader as rootClientLoader } from '../root';

export const handle = {
  pageLabel: "Content",
  sidebarTrail: ["Content"],
} as const;

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  const runtime = await getRuntimeConfig();
  const [schemas, entry, media] = await Promise.all([
    listDatabaseSchemaVersions(runtime, params.contentType),
    getDatabaseDocument(runtime, { collection: params.contentType, id: params.entryId }),
    listStorageFiles(runtime).catch(() => ({ files: [], references: [] })),
  ]);
  return { schemas, entry, media, contentType: params.contentType, entryId: params.entryId };
}

function ContentEntryEditorRoute() {
  const { schemas, entry, media, contentType, entryId } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const contentTypePath = encodeURIComponent(contentType);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const activeSchema = schemas.find((schema) => schema.active) ?? schemas.at(-1);
  const fields = useMemo(
    () => getContentSchemaFields(activeSchema?.fields ?? []),
    [activeSchema?.fields],
  );
  const documentData = (entry.data as Record<string, unknown>) ?? {};
  const { runtime } = useRouteLoaderData<typeof rootClientLoader>('root')!;

  const mediaItems = useMemo(
    () =>
      (media.files ?? [])
            .filter((file) => file.contentType?.startsWith("image/"))
            .slice(0, 12)
            .map((file) => ({
              src: getStorageFileUrl(runtime, file.path),
              altText:
                typeof file.metadata?.alt === "string"
                  ? file.metadata.alt
                  : typeof file.metadata?.label === "string"
                    ? file.metadata.label
                    : file.path,
              label:
                typeof file.metadata?.label === "string"
                  ? file.metadata.label
                  : file.path.split("/").pop() ?? file.path,
            })),
    [media.files, runtime],
  );
  const fileItems = useMemo(
    () =>
      (media.files ?? []).slice(0, 16).map((file) => ({
            href: getStorageFileUrl(runtime, file.path),
            label:
              typeof file.metadata?.label === "string"
                ? file.metadata.label
                : file.path.split("/").pop() ?? file.path,
            meta: [
              file.contentType,
              typeof file.metadata?.purpose === "string"
                ? file.metadata.purpose
                : undefined,
            ]
              .filter(Boolean)
              .join(" · "),
          })),
    [media.files, runtime],
  );

  useEffect(() => {
    if (!entry || fields.length === 0) {
      return;
    }

    const nextDraft: Record<string, unknown> = {};
    for (const field of fields) {
      nextDraft[field.name] = initializeFieldDraftValue(
        field.definition,
        documentData[field.name],
      );
    }

    setDraft(nextDraft);
  }, [documentData, entry, fields]);

  function updateDraftValue(name: string, value: unknown) {
    setDraft((current) => ({
      ...current,
      [name]: value,
    }));
  }

  async function handleSaveEntry() {
    if (!activeSchema || saving) {
      return;
    }

    const updates: Record<string, unknown> = {};

    try {
      for (const field of fields) {
        const rawValue = draft[field.name];
        const normalized = normalizeSchemaFieldValue(field.definition, rawValue);

        if (normalized === undefined && field.definition.type !== "string") {
          continue;
        }

        updates[field.name] =
          normalized === undefined && field.definition.type === "string"
            ? ""
            : normalized;
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return;
    }

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      await updateDatabaseDocument(runtime, {
        collection: contentType,
        id: entryId,
        data: updates,
        mode: "merge",
      });
      revalidator.revalidate();
      setMessage(`Saved ${entryId}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.6fr)]">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div className="grid gap-1">
            <CardTitle>Edit entry</CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to={`/content/${contentTypePath}`}
              className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
            >
              Back to Entries
            </Link>
            <Button type="button" size="sm" onClick={() => void handleSaveEntry()} disabled={saving}>
              <Save className="size-4" />
              Save Entry
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-5 p-4">
          {message ? <ResourceNotice title="Done" description={message} /> : null}
          {error ? <ResourceNotice title="Action failed" description={error} /> : null}
          {!activeSchema ? (
            <ResourceNotice
              title="No active schema"
              description="Activate a schema first."
            />
          ) : fields.length === 0 ? (
            <ResourceNotice
              title="No fields in schema"
              description="Add fields to this schema first."
            />
          ) : (
            fields.map((field) => (
              <SchemaFieldEditor
                key={field.name}
                name={field.name}
                label={field.label}
                description={field.description}
                required={field.required}
                definition={field.definition}
                value={draft[field.name]}
                mediaItems={mediaItems}
                fileItems={fileItems}
                onChange={(value) => updateDraftValue(field.name, value)}
              />
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Entry details</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataRow label="ID" detail={entryId} />
          <DataRow label="Collection" detail={contentType} />
          <DataRow
            label="Schema"
            detail={activeSchema ? `v${activeSchema.version}` : "No active schema"}
          />
          <DataRow
            label="Updated"
            detail={new Date(entry.updatedAt).toLocaleString()}
          />
        </CardContent>
      </Card>
    </div>
  );
}

export default ContentEntryEditorRoute;
