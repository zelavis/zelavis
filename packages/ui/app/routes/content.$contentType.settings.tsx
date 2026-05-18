import { useParams } from "react-router";
import { Copy, Pin, PinOff, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { DataRow, ResourceNotice } from "#/components/DashboardPage";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import {
  createDatabaseCollection,
  createDatabaseSchema,
  getDashboardSettings,
  getResolvedDashboardPreferences,
  getRuntimeConfig,
  listDatabaseCollections,
  listDatabaseSchemaCollections,
  listDatabaseSchemaVersions,
  updateDashboardSettings,
} from "#/lib/runtime-api";
import { useRuntimeResource } from "#/lib/use-runtime-resource";

export const handle = {
  pageLabel: "Content",
  sidebarTrail: ["Content"],
} as const;

function ContentTypeSettingsRoute() {
  const contentType = useParams().contentType ?? "";
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
  const row = useMemo(
    () => collections.data?.find((collection) => collection.name === contentType),
    [collections.data, contentType],
  );
  const [labelDraft, setLabelDraft] = useState(
    getResolvedDashboardPreferences(settings.data).content?.labels?.[contentType] ?? contentType,
  );
  const [duplicateLabel, setDuplicateLabel] = useState(`${contentType} Copy`);
  const [duplicateName, setDuplicateName] = useState(`${contentType}-copy`);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const activeSchemaVersion =
    schemaCollections.data?.find((entry) => entry.collection === contentType)?.activeVersion ?? null;
  const contentPreferences = getResolvedDashboardPreferences(settings.data).content;
  const pinnedTypes = contentPreferences?.pinnedTypes ?? [];
  const isPinned = pinnedTypes.includes(contentType);

  useEffect(() => {
    setLabelDraft(contentPreferences?.labels?.[contentType] ?? contentType);
  }, [contentPreferences?.labels, contentType]);

  async function handleSaveLabel() {
    if (!config || !labelDraft.trim() || saving) {
      return;
    }

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      await updateDashboardSettings(config, {
        preferences: {
          content: {
            labels: {
              [contentType]: labelDraft.trim(),
            },
          },
        },
      });
      await settings.reload();
      setMessage(`Updated editor label for ${contentType}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function handleTogglePin() {
    if (!config || saving) {
      return;
    }

    const nextPinnedTypes = isPinned
      ? pinnedTypes.filter((entry) => entry !== contentType)
      : [...pinnedTypes, contentType];

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      await updateDashboardSettings(config, {
        preferences: {
          content: {
            pinnedTypes: nextPinnedTypes,
          },
        },
      });
      await settings.reload();
      setMessage(
        isPinned
          ? `Removed ${contentType} from pinned content types.`
          : `Pinned ${contentType} to the top of Content Studio.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function handleDuplicateType() {
    if (!config || !duplicateName.trim() || saving) {
      return;
    }

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      const sourceSchemas = await listDatabaseSchemaVersions(config, contentType);
      const activeSchema =
        sourceSchemas.find((schema) => schema.active) ?? sourceSchemas.at(-1);
      const created = await createDatabaseCollection(config, {
        name: duplicateName.trim(),
        metadata: {
          surface: "content-studio",
          kind: "content-type",
          duplicatedFrom: contentType,
        },
      });

      if (activeSchema) {
        await createDatabaseSchema(config, {
          collection: created.name,
          version: 1,
          activate: true,
          document: activeSchema.document,
          metadata: {
            ...(activeSchema.metadata ?? {}),
            duplicatedFrom: contentType,
          },
        });
      }

      await updateDashboardSettings(config, {
        preferences: {
          content: {
            labels:
              duplicateLabel.trim() && duplicateLabel.trim() !== created.name
                ? {
                    [created.name]: duplicateLabel.trim(),
                  }
                : undefined,
          },
        },
      });
      await Promise.all([collections.reload(), schemaCollections.reload(), settings.reload()]);
      setMessage(`Duplicated ${contentType} into ${created.name}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Content type settings</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {message ? <ResourceNotice title="Done" description={message} /> : null}
          {error ? <ResourceNotice title="Action failed" description={error} /> : null}
          <DataRow label="Collection" detail={contentType} />
          <DataRow label="Entries" detail={String(row?.documentCount ?? 0)} />
          <DataRow
            label="Active schema"
            detail={activeSchemaVersion ? `v${activeSchemaVersion}` : "No active schema"}
          />
          <div className="grid gap-3 border-t p-4">
            <label className="grid gap-2 text-sm font-medium text-foreground">
              Editor label
              <Input value={labelDraft} onChange={(event) => setLabelDraft(event.target.value)} />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" onClick={() => void handleSaveLabel()} disabled={saving}>
                <Save className="size-4" />
                Save label
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void handleTogglePin()}>
                {isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                {isPinned ? "Unpin" : "Pin"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Duplicate this content type</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 p-4">
          <label className="grid gap-2 text-sm font-medium text-foreground">
            New label
            <Input
              value={duplicateLabel}
              onChange={(event) => setDuplicateLabel(event.target.value)}
            />
          </label>
          <label className="grid gap-2 text-sm font-medium text-foreground">
            New collection name
            <Input
              value={duplicateName}
              onChange={(event) => setDuplicateName(event.target.value)}
            />
          </label>
          <p className="text-sm text-muted-foreground">
            Duplication copies the active schema and keeps entries separate, which is usually the right starting point for a fresh content model.
          </p>
          <div>
            <Button
              type="button"
              size="sm"
              onClick={() => void handleDuplicateType()}
              disabled={!duplicateName.trim() || saving}
            >
              <Copy className="size-4" />
              Duplicate content type
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default ContentTypeSettingsRoute;
