import { Link, createFileRoute, useParams } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { DataRow, ResourceNotice } from "#/components/DashboardPage";
import { RichTextEditor } from "#/components/content/RichTextEditor";
import { Button, buttonVariants } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Switch } from "#/components/ui/switch";
import {
  getContentSchemaFields,
  getContentSchemaUi,
  isRichTextSchemaField,
  normalizeSchemaFieldValue,
  stringifySchemaFieldValue,
  type ContentSchemaDefinition,
} from "#/lib/content-schema";
import {
  getDatabaseDocument,
  queryDatabaseDocuments,
  getRuntimeConfig,
  getStorageFileUrl,
  listDatabaseSchemaVersions,
  listStorageFiles,
  updateDatabaseDocument,
} from "#/lib/runtime-api";
import { useRuntimeResource } from "#/lib/use-runtime-resource";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/content/$contentType/$entryId")({
  component: ContentEntryEditorRoute,
});

function ContentEntryEditorRoute() {
  const { contentType, entryId } = useParams({
    from: "/content/$contentType/$entryId",
  });
  const runtime = useRuntimeResource(getRuntimeConfig);
  const config = runtime.data;
  const schemas = useRuntimeResource(
    async () => (config ? listDatabaseSchemaVersions(config, contentType) : []),
    [config, contentType],
  );
  const entry = useRuntimeResource(
    async () =>
      config
        ? getDatabaseDocument(config, {
            collection: contentType,
            id: entryId,
          })
        : undefined,
    [config, contentType, entryId],
  );
  const media = useRuntimeResource(
    async () => (config ? listStorageFiles(config) : { files: [], references: [] }),
    [config],
  );
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const activeSchema = schemas.data?.find((schema) => schema.active) ?? schemas.data?.at(-1);
  const fields = useMemo(
    () => getContentSchemaFields(activeSchema?.document),
    [activeSchema?.document],
  );
  const documentData = (entry.data?.data ?? {}) as Record<string, unknown>;
  const mediaItems = useMemo(
    () =>
      config
        ? (media.data?.files ?? [])
            .filter((file) => file.contentType?.startsWith("image/"))
            .slice(0, 12)
            .map((file) => ({
              src: getStorageFileUrl(config, file.path),
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
            }))
        : [],
    [config, media.data?.files],
  );
  const fileItems = useMemo(
    () =>
      config
        ? (media.data?.files ?? []).slice(0, 16).map((file) => ({
            href: getStorageFileUrl(config, file.path),
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
          }))
        : [],
    [config, media.data?.files],
  );

  useEffect(() => {
    if (!entry.data || fields.length === 0) {
      return;
    }

    const nextDraft: Record<string, unknown> = {};
    for (const field of fields) {
      const value = documentData[field.name];
      if (field.definition.type === "boolean") {
        nextDraft[field.name] = Boolean(value);
        continue;
      }

      if (
        field.definition.type === "array" ||
        (field.definition.type === "string" &&
          typeof field.definition.format === "string" &&
          field.definition.format === "collection-reference")
      ) {
        nextDraft[field.name] = value;
        continue;
      }

      nextDraft[field.name] = stringifySchemaFieldValue(field.definition, value);
    }

    setDraft(nextDraft);
  }, [documentData, entry.data, fields]);

  function updateDraftValue(name: string, value: unknown) {
    setDraft((current) => ({
      ...current,
      [name]: value,
    }));
  }

  async function handleSaveEntry() {
    if (!config || !entry.data || !activeSchema || saving) {
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
      await updateDatabaseDocument(config, {
        collection: contentType,
        id: entryId,
        data: updates,
        mode: "merge",
      });
      await entry.reload();
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
            <p className="text-sm text-muted-foreground">
              This editor follows the active content schema. Rich-text fields use Lexical when the schema asks for it.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/content/$contentType"
              params={{ contentType }}
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
              description="This editor needs an active schema for the content type. Activate one under Fields or Core > Database first."
            />
          ) : !entry.data ? (
            <ResourceNotice
              title="Loading entry"
              description="Fetching the current document so the schema-driven editor can bind the right fields."
            />
          ) : fields.length === 0 ? (
            <ResourceNotice
              title="No fields in schema"
              description="The active schema does not expose any properties yet."
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
            detail={
              entry.data?.updatedAt
                ? new Date(entry.data.updatedAt).toLocaleString()
                : "Loading…"
            }
          />
          <div className="border-t p-4">
            <p className="text-sm text-muted-foreground">
              The default `_content` field is stored as HTML today, while the dashboard uses Lexical as the editing surface. That keeps the runtime portable and still gives editors a real rich-text experience.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function SchemaFieldEditor(props: {
  name: string;
  label: string;
  description?: string;
  required: boolean;
  definition: ContentSchemaDefinition;
  value: unknown;
  mediaItems: Array<{ src: string; altText: string; label: string }>;
  fileItems: Array<{ href: string; label: string; meta: string }>;
  onChange: (value: unknown) => void;
}) {
  const ui = getContentSchemaUi(props.definition);
  const placeholder =
    typeof ui?.placeholder === "string" ? ui.placeholder : `Enter ${props.label.toLowerCase()}`;

  return (
    <label className="grid gap-2 text-sm font-medium text-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <span>{props.label}</span>
        {props.required ? (
          <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            Required
          </span>
        ) : null}
      </div>
      {props.description ? (
        <span className="text-sm font-normal text-muted-foreground">{props.description}</span>
      ) : null}
      <SchemaFieldInput
        name={props.name}
        definition={props.definition}
        placeholder={placeholder}
        value={props.value}
        mediaItems={props.mediaItems}
        fileItems={props.fileItems}
        onChange={props.onChange}
      />
      {props.definition.type === "file" ? (
        <span className="text-xs font-normal text-muted-foreground">
          Paste a Zelavis file reference JSON from Media Gallery or Core &gt; Storage.
        </span>
      ) : null}
    </label>
  );
}

function SchemaFieldInput(props: {
  name: string;
  definition: ContentSchemaDefinition;
  placeholder: string;
  value: unknown;
  mediaItems: Array<{ src: string; altText: string; label: string }>;
  fileItems: Array<{ href: string; label: string; meta: string }>;
  onChange: (value: unknown) => void;
}) {
  if (props.definition.type === "boolean") {
    return (
      <div className="flex items-center gap-3 rounded-md border px-3 py-2">
        <Switch
          checked={Boolean(props.value)}
          onCheckedChange={(checked) => props.onChange(checked)}
        />
        <span className="text-sm font-normal text-muted-foreground">
          {Boolean(props.value) ? "Enabled" : "Disabled"}
        </span>
      </div>
    );
  }

  if (isRichTextSchemaField(props.name, props.definition)) {
    return (
      <RichTextEditor
        value={typeof props.value === "string" ? props.value : ""}
        onChange={props.onChange}
        placeholder={props.placeholder}
        mediaItems={props.mediaItems}
        fileItems={props.fileItems}
      />
    );
  }

  if (
    props.definition.type === "string" &&
    typeof props.definition.format === "string" &&
    props.definition.format === "collection-reference"
  ) {
    return (
      <RelationFieldInput
        definition={props.definition}
        value={typeof props.value === "string" ? props.value : ""}
        onChange={props.onChange}
      />
    );
  }

  if (props.definition.type === "array") {
    return (
      <RepeaterFieldInput
        value={Array.isArray(props.value) ? props.value : []}
        onChange={props.onChange}
      />
    );
  }

  if (
    props.definition.type === "string" &&
    Array.isArray(props.definition.enum) &&
    props.definition.enum.every((value) => typeof value === "string")
  ) {
    return (
      <select
        value={typeof props.value === "string" ? props.value : ""}
        onChange={(event) => props.onChange(event.target.value)}
        className="h-10 rounded-md border bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <option value="">Select…</option>
        {props.definition.enum.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
    );
  }

  if (
    props.definition.type === "object" ||
    props.definition.type === "array" ||
    props.definition.type === "file" ||
    getContentSchemaUi(props.definition)?.control === "textarea"
  ) {
    return (
      <textarea
        value={typeof props.value === "string" ? props.value : ""}
        onChange={(event) => props.onChange(event.target.value)}
        rows={
          typeof getContentSchemaUi(props.definition)?.rows === "number"
            ? getContentSchemaUi(props.definition)?.rows
            : props.definition.type === "string"
              ? 4
              : 10
        }
        placeholder={props.placeholder}
        className="min-h-28 rounded-md border bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      />
    );
  }

  return (
    <Input
      type={props.definition.type === "number" ? "number" : "text"}
      value={typeof props.value === "string" ? props.value : ""}
      onChange={(event) => props.onChange(event.target.value)}
      placeholder={props.placeholder}
    />
  );
}

function RelationFieldInput(props: {
  definition: ContentSchemaDefinition;
  value: string;
  onChange: (value: unknown) => void;
}) {
  const runtime = useRuntimeResource(getRuntimeConfig);
  const config = runtime.data;
  const relationCollection =
    typeof props.definition.relation === "object" &&
    props.definition.relation &&
    typeof (props.definition.relation as { collection?: unknown }).collection === "string"
      ? (props.definition.relation as { collection: string }).collection
      : undefined;

  const relatedDocuments = useRuntimeResource(
    async () =>
      config && relationCollection
        ? queryDatabaseDocuments(config, relationCollection)
        : [],
    [config, relationCollection],
  );
  const [search, setSearch] = useState("");
  const options = (relatedDocuments.data ?? []).filter((document) => {
    const label = String(document.data.title ?? document.data.name ?? document.id).toLowerCase();
    const slug = String(document.data.slug ?? "").toLowerCase();
    const query = search.trim().toLowerCase();
    return query.length === 0 || label.includes(query) || slug.includes(query) || document.id.toLowerCase().includes(query);
  });

  return (
    <div className="grid gap-2">
      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search related entries"
      />
      <select
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className="h-10 rounded-md border bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <option value="">Select related entry…</option>
        {options.map((document) => (
          <option key={document.id} value={document.id}>
            {String(document.data.title ?? document.data.name ?? document.id)}
            {document.data.slug ? ` · ${String(document.data.slug)}` : ""}
          </option>
        ))}
      </select>
      <p className="text-xs font-normal text-muted-foreground">
        {relationCollection
          ? `Links to entries in ${relationCollection}.`
          : "No relation target collection configured yet."}
      </p>
    </div>
  );
}

function RepeaterFieldInput(props: {
  value: unknown[];
  onChange: (value: unknown) => void;
}) {
  function updateItem(index: number, nextItem: Record<string, string>) {
    const next = [...props.value];
    next[index] = nextItem;
    props.onChange(next);
  }

  function moveItem(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= props.value.length) {
      return;
    }

    const next = [...props.value];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    props.onChange(next);
  }

  return (
    <div className="grid gap-3 rounded-md border bg-muted/10 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">Repeater items</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => props.onChange([...(props.value ?? []), {}])}
        >
          <Plus className="size-4" />
          Add item
        </Button>
      </div>
      {props.value.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No items yet. Add the first repeatable item above.
        </p>
      ) : (
        props.value.map((item, index) => (
          <div key={index} className="grid gap-2 rounded-md border bg-background p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-foreground">Item {index + 1}</span>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => moveItem(index, -1)}>
                  <ChevronUp className="size-4" />
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => moveItem(index, 1)}>
                  <ChevronDown className="size-4" />
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => props.onChange(props.value.filter((_, itemIndex) => itemIndex !== index))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
            <RepeaterObjectEditor
              value={typeof item === "object" && item && !Array.isArray(item) ? (item as Record<string, unknown>) : {}}
              onChange={(nextItem) => updateItem(index, nextItem)}
            />
          </div>
        ))
      )}
    </div>
  );
}

function RepeaterObjectEditor(props: {
  value: Record<string, unknown>;
  onChange: (value: Record<string, string>) => void;
}) {
  const entries = Object.entries(props.value).map(([key, value]) => ({
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));

  function commit(entriesToCommit: Array<{ key: string; value: string }>) {
    const next: Record<string, string> = {};
    for (const entry of entriesToCommit) {
      if (entry.key.trim()) {
        next[entry.key.trim()] = entry.value;
      }
    }
    props.onChange(next);
  }

  const safeEntries = entries.length > 0 ? entries : [{ key: "", value: "" }];

  return (
    <div className="grid gap-2">
      {safeEntries.map((entry, index) => (
        <div key={`${entry.key}:${index}`} className="grid gap-2 md:grid-cols-[minmax(0,0.35fr)_minmax(0,0.65fr)_auto]">
          <Input
            value={entry.key}
            onChange={(event) => {
              const next = [...safeEntries];
              next[index] = { ...entry, key: event.target.value };
              commit(next);
            }}
            placeholder="field"
          />
          <Input
            value={entry.value}
            onChange={(event) => {
              const next = [...safeEntries];
              next[index] = { ...entry, value: event.target.value };
              commit(next);
            }}
            placeholder="value"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              const next = safeEntries.filter((_, entryIndex) => entryIndex !== index);
              commit(next);
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => commit([...safeEntries, { key: "", value: "" }])}
      >
        <Plus className="size-4" />
        Add field
      </Button>
    </div>
  );
}
