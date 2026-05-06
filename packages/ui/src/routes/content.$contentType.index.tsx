import { createFileRoute, useParams } from "@tanstack/react-router";
import { Copy, Pencil, Plus, Save, X } from "lucide-react";
import { useMemo, useState } from "react";

import { ResourceNotice } from "#/components/DashboardPage";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import {
  getRuntimeConfig,
  insertDatabaseDocument,
  queryDatabaseDocuments,
  updateDatabaseDocument,
  type DatabaseDocument,
} from "#/lib/runtime-api";
import { useRuntimeResource } from "#/lib/use-runtime-resource";

export const Route = createFileRoute("/content/$contentType/")({
  component: ContentTypeEntriesRoute,
});

function ContentTypeEntriesRoute() {
  const { contentType } = useParams({ from: "/content/$contentType/" });
  const runtime = useRuntimeResource(getRuntimeConfig);
  const config = runtime.data;
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<string>();
  const [entryTitleDraft, setEntryTitleDraft] = useState("");
  const [entrySlugDraft, setEntrySlugDraft] = useState("");

  const entries = useRuntimeResource(
    async () => (config ? queryDatabaseDocuments(config, contentType) : []),
    [config, contentType],
  );

  const sortedEntries = useMemo(
    () => [...(entries.data ?? [])].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [entries.data],
  );

  async function handleCreateDraftEntry() {
    if (!config || saving) {
      return;
    }

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      const created = await insertDatabaseDocument(config, {
        collection: contentType,
        data: {
          title: "Untitled draft",
          slug: `draft-${Date.now()}`,
          excerpt: "",
          status: "draft",
        },
      });
      await entries.reload();
      setMessage(`Created draft entry ${created.id}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  function beginEditingEntry(entry: DatabaseDocument) {
    const data = entry.data as Record<string, unknown>;
    setEditingEntryId(entry.id);
    setEntryTitleDraft(typeof data.title === "string" ? data.title : entry.id);
    setEntrySlugDraft(typeof data.slug === "string" ? data.slug : "");
  }

  async function handleSaveEntry(entry: DatabaseDocument) {
    if (!config || !editingEntryId || saving) {
      return;
    }

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      await updateDatabaseDocument(config, {
        collection: contentType,
        id: entry.id,
        data: {
          title: entryTitleDraft.trim() || "Untitled draft",
          slug: entrySlugDraft.trim() || `draft-${Date.now()}`,
        },
        mode: "merge",
      });
      await entries.reload();
      setEditingEntryId(undefined);
      setEntryTitleDraft("");
      setEntrySlugDraft("");
      setMessage(`Updated ${entry.id}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function handleDuplicateEntry(entry: DatabaseDocument) {
    if (!config || saving) {
      return;
    }

    const data = entry.data as Record<string, unknown>;
    const title = typeof data.title === "string" ? data.title : entry.id;
    const slug = typeof data.slug === "string" ? data.slug : entry.id;

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      const created = await insertDatabaseDocument(config, {
        collection: contentType,
        data: {
          ...data,
          title: `${title} Copy`,
          slug: `${slug}-copy-${Date.now()}`,
          status: typeof data.status === "string" ? data.status : "draft",
        },
      });
      await entries.reload();
      setMessage(`Duplicated ${entry.id} into ${created.id}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle>Entries</CardTitle>
        <Button type="button" size="sm" onClick={() => void handleCreateDraftEntry()} disabled={saving}>
          <Plus className="size-4" />
          New Entry
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4 p-0">
        {message ? <ResourceNotice title="Done" description={message} /> : null}
        {error ? <ResourceNotice title="Action failed" description={error} /> : null}
        {sortedEntries.length === 0 ? (
          <div className="p-4">
            <ResourceNotice
              title="No entries yet"
              description="Create a draft entry here. This stays editor-facing while Core > Database keeps the raw document surface."
            />
          </div>
        ) : (
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
                {sortedEntries.map((entry) => {
                  const data = entry.data as Record<string, unknown>;
                  const isEditing = editingEntryId === entry.id;
                  return (
                    <tr key={entry.id} className="border-b last:border-b-0">
                      <td className="px-4 py-3">
                        {isEditing ? (
                          <Input
                            value={entryTitleDraft}
                            onChange={(event) => setEntryTitleDraft(event.target.value)}
                            aria-label={`Title for ${entry.id}`}
                          />
                        ) : (
                          <div className="grid gap-1">
                            <span className="font-medium text-foreground">
                              {typeof data.title === "string" ? data.title : entry.id}
                            </span>
                            <span className="text-xs text-muted-foreground">{entry.id}</span>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {typeof data.status === "string" ? data.status : "draft"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {isEditing ? (
                          <Input
                            value={entrySlugDraft}
                            onChange={(event) => setEntrySlugDraft(event.target.value)}
                            aria-label={`Slug for ${entry.id}`}
                          />
                        ) : typeof data.slug === "string" ? (
                          data.slug
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {new Date(entry.updatedAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          {isEditing ? (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                onClick={() => void handleSaveEntry(entry)}
                                disabled={saving}
                              >
                                <Save className="size-4" />
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setEditingEntryId(undefined);
                                  setEntryTitleDraft("");
                                  setEntrySlugDraft("");
                                }}
                              >
                                <X className="size-4" />
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => beginEditingEntry(entry)}
                              >
                                <Pencil className="size-4" />
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => void handleDuplicateEntry(entry)}
                              >
                                <Copy className="size-4" />
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
