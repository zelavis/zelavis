import { Link, useLoaderData, useNavigate, useRevalidator } from "react-router";
import { Copy, Pencil, Plus, Save, SquarePen, X } from "lucide-react";
import { useMemo, useState } from "react";

import { ResourceNotice } from "#/components/DashboardPage";
import { Button, buttonVariants } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { createStarterContentEntry } from "#/lib/content-schema";
import {
  getRuntimeConfig,
  insertDatabaseDocument,
  queryDatabaseDocuments,
  updateDatabaseDocument,
  type DatabaseDocument,
} from "#/lib/runtime-api";
import { toProjectPath } from "#/lib/routing";
import { cn } from "#/lib/utils";
import type { Route } from './+types/content.$contentType.index';

export const handle = {
  pageLabel: "Content",
  sidebarTrail: ["Content"],
} as const;

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  const runtime = await getRuntimeConfig();
  const contentType = params.contentType;
  const entries = await queryDatabaseDocuments(runtime, contentType);
  return { entries, contentType };
}

function ContentTypeEntriesRoute() {
  const { entries, contentType } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<string>();
  const [entryTitleDraft, setEntryTitleDraft] = useState("");
  const [entrySlugDraft, setEntrySlugDraft] = useState("");

  const contentTypePath = encodeURIComponent(contentType);

  const sortedEntries = useMemo(
    () => [...entries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [entries],
  );

  async function handleCreateDraftEntry() {
    if (saving) {
      return;
    }

    const runtime = await getRuntimeConfig();

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      const created = await insertDatabaseDocument(runtime, {
        collection: contentType,
        data: createStarterContentEntry(),
      });
      revalidator.revalidate();
      setMessage(`Created draft entry ${created.id}.`);
      await navigate(
        toProjectPath(`/content/${contentTypePath}/${encodeURIComponent(created.id)}`),
      );
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
    if (!editingEntryId || saving) {
      return;
    }

    const runtime = await getRuntimeConfig();

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      await updateDatabaseDocument(runtime, {
        collection: entry.collection,
        id: entry.id,
        data: {
          title: entryTitleDraft.trim() || "Untitled draft",
          slug: entrySlugDraft.trim() || `draft-${Date.now()}`,
        },
        mode: "merge",
      });
      revalidator.revalidate();
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
    if (saving) {
      return;
    }

    const runtime = await getRuntimeConfig();
    const data = entry.data as Record<string, unknown>;
    const title = typeof data.title === "string" ? data.title : entry.id;
    const slug = typeof data.slug === "string" ? data.slug : entry.id;

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      const created = await insertDatabaseDocument(runtime, {
        collection: entry.collection,
        data: {
          ...data,
          title: `${title} Copy`,
          slug: `${slug}-copy-${Date.now()}`,
          status: typeof data.status === "string" ? data.status : "draft",
        },
      });
      revalidator.revalidate();
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
        <Button type="button" onClick={() => void handleCreateDraftEntry()} disabled={saving}>
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
              description="Create a draft entry."
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
                            <Link
                              to={`/content/${contentTypePath}/${encodeURIComponent(entry.id)}`}
                              className="font-medium text-foreground underline-offset-4 hover:underline"
                            >
                              {typeof data.title === "string" ? data.title : entry.id}
                            </Link>
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
                                onClick={() => void handleSaveEntry(entry)}
                                disabled={saving}
                              >
                                <Save className="size-4" />
                              </Button>
                              <Button
                                type="button"
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
                              <Link
                                to={`/content/${contentTypePath}/${encodeURIComponent(entry.id)}`}
                                className={cn(buttonVariants({ variant: "outline" }))}
                              >
                                <SquarePen className="size-4" />
                              </Link>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => beginEditingEntry(entry)}
                              >
                                <Pencil className="size-4" />
                              </Button>
                              <Button
                                type="button"
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

export default ContentTypeEntriesRoute;
