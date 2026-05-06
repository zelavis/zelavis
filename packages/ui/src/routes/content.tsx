import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Braces, FileText, LayoutList, Plus } from "lucide-react";

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
  createDatabaseCollection,
  createDatabaseSchema,
  getRuntimeConfig,
  insertDatabaseDocument,
  listDatabaseCollections,
  listDatabaseSchemaCollections,
  queryDatabaseDocuments,
} from "#/lib/runtime-api";
import { useRuntimeResource } from "#/lib/use-runtime-resource";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/content")({ component: Content });

function Content() {
  const runtime = useRuntimeResource(getRuntimeConfig);
  const config = runtime.data;
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [contentTypeName, setContentTypeName] = useState("");
  const [selectedContentType, setSelectedContentType] = useState<string>();
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
  const selectedType = useMemo(
    () => selectedContentType ?? collections.data?.[0]?.name,
    [collections.data, selectedContentType],
  );
  const entries = useRuntimeResource(
    async () => (config && selectedType ? queryDatabaseDocuments(config, selectedType) : []),
    [config, selectedType],
  );

  const contentTypeRows = useMemo(() => {
    const schemaMap = new Map(
      (schemaCollections.data ?? []).map((entry) => [entry.collection, entry] as const),
    );

    return (collections.data ?? []).map((collection) => ({
      name: collection.name,
      documentCount: collection.documentCount,
      tenantId: collection.tenantId,
      activeVersion: schemaMap.get(collection.name)?.activeVersion ?? null,
      versions: schemaMap.get(collection.name)?.versions ?? [],
    }));
  }, [collections.data, schemaCollections.data]);

  async function handleCreateContentType(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!config || !contentTypeName.trim() || saving) {
      return;
    }

    setSaving(true);
    setMessage(undefined);
    setError(undefined);

    try {
      const collection = await createDatabaseCollection(config, {
        name: contentTypeName.trim(),
        metadata: {
          surface: "content-studio",
          kind: "content-type",
        },
      });
      await createDatabaseSchema(config, {
        collection: collection.name,
        version: 1,
        activate: true,
        document: {
          type: "object",
          additionalProperties: false,
          required: ["title", "slug"],
          properties: {
            title: { type: "string", minLength: 1 },
            slug: { type: "string", minLength: 1 },
            excerpt: { type: "string" },
            status: { type: "string" },
          },
        },
        metadata: {
          createdBy: "content-studio",
        },
      });

      await Promise.all([collections.reload(), schemaCollections.reload()]);
      setSelectedContentType(collection.name);
      setContentTypeName("");
      setShowCreateForm(false);
      setMessage(`Created content type ${collection.name} with starter schema v1.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateDraftEntry() {
    if (!config || !selectedType || saving) {
      return;
    }

    setSaving(true);
    setMessage(undefined);
    setError(undefined);

    try {
      const created = await insertDatabaseDocument(config, {
        collection: selectedType,
        data: {
          title: "Untitled draft",
          slug: `draft-${Date.now()}`,
          excerpt: "",
          status: "draft",
        },
      });
      await Promise.all([collections.reload(), entries.reload()]);
      setMessage(`Created draft entry ${created.id} in ${selectedType}.`);
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
        description="Editor-facing content types sit here, while the lower-level database service stays under Core. This is the friendlier surface for managing structured content models."
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
            <form
              className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]"
              onSubmit={handleCreateContentType}
            >
              <Input
                value={contentTypeName}
                onChange={(event) => setContentTypeName(event.target.value)}
                placeholder="articles"
                disabled={saving}
                aria-label="Content type name"
              />
              <Button type="submit" disabled={!contentTypeName.trim() || saving}>
                + Content Type
              </Button>
            </form>
            <p className="text-sm text-muted-foreground">
              This creates the collection and a starter schema in one step, so the content type appears here immediately.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {message ? <ResourceNotice title="Done" description={message} /> : null}
      {error ? <ResourceNotice title="Action failed" description={error} /> : null}

      <Card>
        <CardHeader>
          <CardTitle>Content types</CardTitle>
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
                    <th className="px-4 py-3 font-medium">Name</th>
                    <th className="px-4 py-3 font-medium">Entries</th>
                    <th className="px-4 py-3 font-medium">Active schema</th>
                    <th className="px-4 py-3 font-medium">Versions</th>
                    <th className="px-4 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {contentTypeRows.map((row) => (
                    <tr
                      key={row.name}
                      className={[
                        "border-b last:border-b-0",
                        selectedType === row.name ? "bg-muted/20" : "",
                      ].join(" ")}
                    >
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          className="grid gap-1 text-left"
                          onClick={() => setSelectedContentType(row.name)}
                        >
                          <span className="font-medium text-foreground">{row.name}</span>
                          <span className="text-xs text-muted-foreground">
                            tenant {row.tenantId}
                          </span>
                        </button>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{row.documentCount}</td>
                      <td className="px-4 py-3">
                        <StatusBadge
                          state={row.activeVersion ? "ready" : "planned"}
                        />
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {row.versions.length > 0 ? row.versions.join(", ") : "No schemas"}
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          to="/database"
                          search={{ sidebar: "Core" }}
                          className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
                        >
                          Manage
                        </Link>
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
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div>
            <CardTitle>{selectedType ? `${selectedType} entries` : "Entries"}</CardTitle>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleCreateDraftEntry()}
            disabled={!selectedType || saving}
          >
            <Plus className="size-4" />
            New Entry
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {!selectedType ? (
            <div className="p-4">
              <ResourceNotice
                title="Select a content type"
                description="Choose a content type above to browse its entries from the editor-facing surface."
              />
            </div>
          ) : entries.data && entries.data.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/20 text-left text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Title</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Slug</th>
                    <th className="px-4 py-3 font-medium">Updated</th>
                    <th className="px-4 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.data.map((entry) => {
                    const data = entry.data as Record<string, unknown>;
                    return (
                      <tr key={entry.id} className="border-b last:border-b-0">
                        <td className="px-4 py-3">
                          <div className="grid gap-1">
                            <span className="font-medium text-foreground">
                              {typeof data.title === "string" ? data.title : entry.id}
                            </span>
                            <span className="text-xs text-muted-foreground">{entry.id}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {typeof data.status === "string" ? data.status : "draft"}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {typeof data.slug === "string" ? data.slug : "—"}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {new Date(entry.updatedAt).toLocaleString()}
                        </td>
                        <td className="px-4 py-3">
                          <Link
                            to="/database"
                            search={{ sidebar: "Core" }}
                            className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
                          >
                            Open Raw View
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-4">
              <ResourceNotice
                title="No entries yet"
                description="Create a draft entry here or manage lower-level document edits from Core > Database."
              />
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
