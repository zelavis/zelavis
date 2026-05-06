import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Braces,
  Copy,
  FileText,
  GripVertical,
  LayoutList,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Save,
  X,
} from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import {
  PageHeader,
  ResourceNotice,
  StatCard,
  StatusBadge,
} from "#/components/DashboardPage";
import { Button, buttonVariants } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import {
  buildContentTypeRows,
  getContentTypeLabel,
  slugifyContentTypeLabel,
} from "#/lib/content-studio";
import { createStarterContentTypeSchema } from "#/lib/content-schema";
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
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/content")({ component: Content });

function Content() {
  const runtime = useRuntimeResource(getRuntimeConfig);
  const config = runtime.data;
  const settings = useRuntimeResource(
    async () => (config ? getDashboardSettings(config) : undefined),
    [config],
  );
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [contentTypeLabel, setContentTypeLabel] = useState("");
  const [contentTypeName, setContentTypeName] = useState("");
  const [editingLabelFor, setEditingLabelFor] = useState<string>();
  const [labelDraft, setLabelDraft] = useState("");
  const [duplicatingType, setDuplicatingType] = useState<string>();
  const [duplicateLabel, setDuplicateLabel] = useState("");
  const [duplicateName, setDuplicateName] = useState("");
  const [draggingPinnedType, setDraggingPinnedType] = useState<string>();
  const [dragOverPinnedType, setDragOverPinnedType] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const collections = useRuntimeResource(
    async () => (config ? listDatabaseCollections(config) : []),
    [config],
  );
  const schemaCollections = useRuntimeResource(
    async () => (config ? listDatabaseSchemaCollections(config) : []),
    [config],
  );

  const contentPreferences = getResolvedDashboardPreferences(settings.data).content;
  const contentTypeRows = useMemo(
    () =>
      buildContentTypeRows(
        collections.data ?? [],
        schemaCollections.data ?? [],
        contentPreferences,
      ),
    [collections.data, contentPreferences, schemaCollections.data],
  );
  const pinnedTypes = contentPreferences?.pinnedTypes ?? [];

  async function persistContentPreferences(
    update: {
      pinnedTypes?: string[];
      labels?: Record<string, string>;
    },
  ) {
    if (!config) {
      return;
    }

    await updateDashboardSettings(config, {
      preferences: {
        content: {
          ...(update.pinnedTypes ? { pinnedTypes: update.pinnedTypes } : {}),
          ...(update.labels ? { labels: update.labels } : {}),
        },
      },
    });
    await settings.reload();
  }

  async function handleCreateContentType(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!config || !contentTypeName.trim() || saving) {
      return;
    }

    const normalizedLabel = contentTypeLabel.trim() || contentTypeName.trim();
    const normalizedName = slugifyContentTypeLabel(contentTypeName) || contentTypeName.trim();

    setSaving(true);
    setMessage(undefined);
    setError(undefined);

    try {
      const collection = await createDatabaseCollection(config, {
        name: normalizedName,
        metadata: {
          surface: "content-studio",
          kind: "content-type",
        },
      });
      await createDatabaseSchema(config, {
        collection: collection.name,
        version: 1,
        activate: true,
        document: createStarterContentTypeSchema(),
        metadata: {
          createdBy: "content-studio",
        },
      });

      if (normalizedLabel !== collection.name) {
        await persistContentPreferences({
          labels: {
            [collection.name]: normalizedLabel,
          },
        });
      }

      await Promise.all([collections.reload(), schemaCollections.reload()]);
      setContentTypeLabel("");
      setContentTypeName("");
      setShowCreateForm(false);
      setMessage(`Created content type ${normalizedLabel} (${collection.name}) with starter schema v1.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function handlePinToggle(name: string) {
    if (!config || saving) {
      return;
    }

    const nextPinnedTypes = pinnedTypes.includes(name)
      ? pinnedTypes.filter((entry) => entry !== name)
      : [...pinnedTypes, name];

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      await persistContentPreferences({ pinnedTypes: nextPinnedTypes });
      setMessage(
        pinnedTypes.includes(name)
          ? `Removed ${getContentTypeLabel(name, contentPreferences)} from pinned content types.`
          : `Pinned ${getContentTypeLabel(name, contentPreferences)} to the top of Content Studio.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function handleDropPinnedType(targetName: string) {
    if (!config || saving || !draggingPinnedType || draggingPinnedType === targetName) {
      setDraggingPinnedType(undefined);
      setDragOverPinnedType(undefined);
      return;
    }

    const sourceIndex = pinnedTypes.indexOf(draggingPinnedType);
    const targetIndex = pinnedTypes.indexOf(targetName);
    if (sourceIndex === -1 || targetIndex === -1) {
      setDraggingPinnedType(undefined);
      setDragOverPinnedType(undefined);
      return;
    }

    const nextPinnedTypes = [...pinnedTypes];
    const [moved] = nextPinnedTypes.splice(sourceIndex, 1);
    nextPinnedTypes.splice(targetIndex, 0, moved);

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      await persistContentPreferences({ pinnedTypes: nextPinnedTypes });
      setMessage(
        `Updated pinned order for ${getContentTypeLabel(draggingPinnedType, contentPreferences)}.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
      setDraggingPinnedType(undefined);
      setDragOverPinnedType(undefined);
    }
  }

  async function handleSaveLabel(name: string) {
    const normalizedLabel = labelDraft.trim();
    if (!config || !normalizedLabel || saving) {
      return;
    }

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      await persistContentPreferences({
        labels: {
          [name]: normalizedLabel,
        },
      });
      setEditingLabelFor(undefined);
      setLabelDraft("");
      setMessage(`Updated content type label for ${name}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function handleDuplicateType(sourceName: string) {
    if (!config || !duplicateName.trim() || saving) {
      return;
    }

    const nextName = slugifyContentTypeLabel(duplicateName) || duplicateName.trim();
    const nextLabel = duplicateLabel.trim() || duplicateName.trim();

    setSaving(true);
    setMessage(undefined);
    setError(undefined);

    try {
      const sourceSchemas = await listDatabaseSchemaVersions(config, sourceName);
      const activeSchema =
        sourceSchemas.find((schema) => schema.active) ?? sourceSchemas.at(-1);

      const created = await createDatabaseCollection(config, {
        name: nextName,
        metadata: {
          surface: "content-studio",
          kind: "content-type",
          duplicatedFrom: sourceName,
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
            duplicatedFrom: sourceName,
          },
        });
      }

      if (nextLabel !== created.name) {
        await persistContentPreferences({
          labels: {
            [created.name]: nextLabel,
          },
        });
      }

      await Promise.all([collections.reload(), schemaCollections.reload()]);
      setDuplicatingType(undefined);
      setDuplicateLabel("");
      setDuplicateName("");
      setMessage(`Duplicated ${sourceName} into ${created.name}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Content"
        title="Content Studio"
        description="Editor-facing content types live here. Pinned types stay at the top, while the lower-level document model remains available under Core > Database."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => setShowCreateForm((current) => !current)}
            >
              <Plus className="size-4" />
              Create new Content Type
            </Button>
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

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Content types"
          value={String(contentTypeRows.length)}
          detail="Collections visible through the content-facing layer"
          icon={LayoutList}
        />
        <StatCard
          label="Schemas"
          value={String(contentTypeRows.filter((row) => row.activeVersion).length)}
          detail="Rows already carrying an active schema version"
          icon={Braces}
        />
        <StatCard
          label="Entries"
          value={String(contentTypeRows.reduce((sum, row) => sum + row.documentCount, 0))}
          detail="Documents across the visible content types"
          icon={FileText}
        />
      </div>

      {showCreateForm ? (
        <Card>
          <CardHeader>
            <CardTitle>New content type</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 p-4">
            <form className="grid gap-3" onSubmit={handleCreateContentType}>
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                <Input
                  value={contentTypeLabel}
                  onChange={(event) => {
                    const nextLabel = event.target.value;
                    setContentTypeLabel(nextLabel);
                    if (!contentTypeName.trim()) {
                      setContentTypeName(slugifyContentTypeLabel(nextLabel));
                    }
                  }}
                  placeholder="Articles"
                  disabled={saving}
                  aria-label="Content type label"
                />
                <Input
                  value={contentTypeName}
                  onChange={(event) => setContentTypeName(event.target.value)}
                  placeholder="articles"
                  disabled={saving}
                  aria-label="Content type collection name"
                />
                <Button type="submit" disabled={!contentTypeName.trim() || saving}>
                  + Content Type
                </Button>
              </div>
            </form>
            <p className="text-sm text-muted-foreground">
              The label is editor-facing. The collection name stays the durable slug used by the lower-level database service.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {message ? <ResourceNotice title="Done" description={message} /> : null}
      {error ? <ResourceNotice title="Action failed" description={error} /> : null}

      <Card>
        <CardHeader>
          <CardTitle>Content types</CardTitle>
          <p className="text-sm text-muted-foreground">
            Drag pinned rows to reorder the editor-facing priority list.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {contentTypeRows.length === 0 ? (
            <div className="p-4">
              <ResourceNotice
                title="No content types yet"
                description="Create the first content type here or use the lower-level database screen if you need raw collection control."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/20 text-left text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Type</th>
                    <th className="px-4 py-3 font-medium">Entries</th>
                    <th className="px-4 py-3 font-medium">Schema</th>
                    <th className="px-4 py-3 font-medium">Pinned</th>
                    <th className="px-4 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {contentTypeRows.map((row) => {
                    const isEditingLabel = editingLabelFor === row.name;
                    const isDuplicating = duplicatingType === row.name;
                    const pinnedIndex = pinnedTypes.indexOf(row.name);

                    return (
                      <Fragment key={row.name}>
                        <tr
                          key={row.name}
                          className={cn(
                            "border-b last:border-b-0",
                            row.pinned && dragOverPinnedType === row.name && "bg-muted/10",
                            row.pinned && draggingPinnedType === row.name && "opacity-60",
                          )}
                          draggable={row.pinned}
                          onDragStart={(event) => {
                            if (!row.pinned) {
                              return;
                            }
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", row.name);
                            setDraggingPinnedType(row.name);
                          }}
                          onDragOver={(event) => {
                            if (!row.pinned || !draggingPinnedType) {
                              return;
                            }
                            event.preventDefault();
                            setDragOverPinnedType(row.name);
                          }}
                          onDragLeave={() => {
                            if (dragOverPinnedType === row.name) {
                              setDragOverPinnedType(undefined);
                            }
                          }}
                          onDrop={(event) => {
                            event.preventDefault();
                            void handleDropPinnedType(row.name);
                          }}
                          onDragEnd={() => {
                            setDraggingPinnedType(undefined);
                            setDragOverPinnedType(undefined);
                          }}
                        >
                          <td className="px-4 py-3">
                            <div className="grid gap-1">
                              <span className="font-medium text-foreground">{row.label}</span>
                              <span className="text-xs text-muted-foreground">
                                {row.name} · tenant {row.tenantId}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">{row.documentCount}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <StatusBadge state={row.activeVersion ? "ready" : "planned"} />
                              <span className="text-muted-foreground">
                                {row.activeVersion ? `v${row.activeVersion}` : "No active schema"}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            {row.pinned ? (
                              <div className="flex items-center gap-2 text-muted-foreground">
                                <GripVertical className="size-4" />
                                <Pin className="size-4" />
                                <span>#{pinnedIndex + 1}</span>
                              </div>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <Link
                                to="/content/$contentType"
                                params={{ contentType: row.name }}
                                className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
                              >
                                Open
                              </Link>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setEditingLabelFor(row.name);
                                  setLabelDraft(row.label);
                                  setDuplicatingType(undefined);
                                }}
                              >
                                <Pencil className="size-4" />
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setDuplicatingType(row.name);
                                  setDuplicateLabel(`${row.label} Copy`);
                                  setDuplicateName(`${row.name}-copy`);
                                  setEditingLabelFor(undefined);
                                }}
                              >
                                <Copy className="size-4" />
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => void handlePinToggle(row.name)}
                              >
                                {row.pinned ? (
                                  <PinOff className="size-4" />
                                ) : (
                                  <Pin className="size-4" />
                                )}
                              </Button>
                            </div>
                          </td>
                        </tr>
                        {isEditingLabel ? (
                          <tr key={`${row.name}-edit`} className="border-b bg-muted/10">
                            <td colSpan={5} className="px-4 py-3">
                              <div className="flex flex-wrap items-center gap-2">
                                <Input
                                  value={labelDraft}
                                  onChange={(event) => setLabelDraft(event.target.value)}
                                  className="max-w-sm"
                                  aria-label={`Editor label for ${row.name}`}
                                />
                                <Button
                                  type="button"
                                  size="sm"
                                  onClick={() => void handleSaveLabel(row.name)}
                                  disabled={!labelDraft.trim() || saving}
                                >
                                  <Save className="size-4" />
                                  Save label
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setEditingLabelFor(undefined);
                                    setLabelDraft("");
                                  }}
                                >
                                  <X className="size-4" />
                                  Cancel
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                        {isDuplicating ? (
                          <tr key={`${row.name}-duplicate`} className="border-b bg-muted/10">
                            <td colSpan={5} className="px-4 py-3">
                              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto]">
                                <Input
                                  value={duplicateLabel}
                                  onChange={(event) => setDuplicateLabel(event.target.value)}
                                  placeholder="Articles Copy"
                                  aria-label={`Duplicate label for ${row.name}`}
                                />
                                <Input
                                  value={duplicateName}
                                  onChange={(event) => setDuplicateName(event.target.value)}
                                  placeholder="articles-copy"
                                  aria-label={`Duplicate collection name for ${row.name}`}
                                />
                                <Button
                                  type="button"
                                  size="sm"
                                  onClick={() => void handleDuplicateType(row.name)}
                                  disabled={!duplicateName.trim() || saving}
                                >
                                  <Copy className="size-4" />
                                  Duplicate
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setDuplicatingType(undefined);
                                    setDuplicateLabel("");
                                    setDuplicateName("");
                                  }}
                                >
                                  <X className="size-4" />
                                  Cancel
                                </Button>
                              </div>
                              <p className="mt-2 text-xs text-muted-foreground">
                                Duplicate creates a new content type with the current active schema. Entries stay separate.
                              </p>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
