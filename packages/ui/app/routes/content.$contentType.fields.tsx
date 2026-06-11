import { Link, useLoaderData, useRevalidator } from "react-router";
import { ArrowDown, ArrowUp, PencilLine, Plus, Save, SquarePen, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ResourceNotice } from "#/components/DashboardPage";
import { Button, buttonVariants } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Switch } from "#/components/ui/switch";
import {
  getContentSchemaFields,
  getContentSchemaUi,
  inferFieldKindFromEntry,
  insertCollectionField,
  isRichTextSchemaField,
  moveCollectionField,
  removeCollectionField,
  updateCollectionField,
  type ContentFieldBuilderKind,
  type ContentSchemaDefinition,
} from "#/lib/content-schema";
import type { CollectionFieldEntry } from "#/lib/runtime-api";
import {
  createDatabaseSchema,
  getRuntimeConfig,
  listDatabaseSchemaVersions,
} from "#/lib/runtime-api";
import { toDashboardPath } from "#/lib/routing";
import type { Route } from './+types/content.$contentType.fields';
import { cn } from "#/lib/utils";

export const handle = {
  pageLabel: "Content",
  sidebarTrail: ["Content"],
} as const;

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  const runtime = await getRuntimeConfig();
  const schemas = await listDatabaseSchemaVersions(runtime, params.contentType);
  return { schemas, contentType: params.contentType };
}

const fieldTypeOptions: Array<{
  value: ContentFieldBuilderKind;
  label: string;
  description: string;
}> = [
  { value: "text", label: "Text", description: "Single-line text field." },
  { value: "long-text", label: "Long text", description: "Textarea for summaries or notes." },
  { value: "rich-text", label: "Rich text", description: "Lexical editor stored as HTML." },
  { value: "number", label: "Number", description: "Numeric field for counts and prices." },
  { value: "boolean", label: "Boolean", description: "True/false switch." },
  { value: "status", label: "Status", description: "Draft, review, and published states." },
  { value: "relation", label: "Relation", description: "Reference another content collection." },
  { value: "repeater", label: "Repeater", description: "Repeatable list of structured items." },
  { value: "image", label: "Image", description: "Image file reference." },
  { value: "document", label: "Document", description: "PDF, text, JSON, or zip reference." },
  { value: "audio", label: "Audio", description: "Audio file reference." },
  { value: "video", label: "Video", description: "Video file reference." },
  { value: "file", label: "Generic file", description: "Unrestricted file reference." },
  { value: "json", label: "JSON object", description: "Structured object value." },
];

function ContentTypeFieldsRoute() {
  const { schemas, contentType } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const activeSchema = schemas.find((schema) => schema.active) ?? schemas.at(-1);
  const [schemaDraft, setSchemaDraft] = useState<CollectionFieldEntry[]>();
  const [selectedFieldName, setSelectedFieldName] = useState<string>();
  const [newFieldName, setNewFieldName] = useState("");
  const [newFieldLabel, setNewFieldLabel] = useState("");
  const [newFieldDescription, setNewFieldDescription] = useState("");
  const [newFieldGroup, setNewFieldGroup] = useState("Content");
  const [newFieldKind, setNewFieldKind] =
    useState<ContentFieldBuilderKind>("text");
  const [newFieldRequired, setNewFieldRequired] = useState(false);
  const [newFieldPlaceholder, setNewFieldPlaceholder] = useState("");
  const [newFieldHelpText, setNewFieldHelpText] = useState("");
  const [newFieldRows, setNewFieldRows] = useState("5");
  const [newFieldRelationCollection, setNewFieldRelationCollection] = useState("");
  const [editingFieldName, setEditingFieldName] = useState<string>();
  const [editingFieldLabel, setEditingFieldLabel] = useState("");
  const [editingFieldDescription, setEditingFieldDescription] = useState("");
  const [editingFieldGroup, setEditingFieldGroup] = useState("Content");
  const [editingFieldKind, setEditingFieldKind] =
    useState<ContentFieldBuilderKind>("text");
  const [editingFieldRequired, setEditingFieldRequired] = useState(false);
  const [editingFieldPlaceholder, setEditingFieldPlaceholder] = useState("");
  const [editingFieldHelpText, setEditingFieldHelpText] = useState("");
  const [editingFieldRows, setEditingFieldRows] = useState("5");
  const [editingFieldRelationCollection, setEditingFieldRelationCollection] = useState("");
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!activeSchema) {
      setSchemaDraft(undefined);
      setSelectedFieldName(undefined);
      return;
    }
    setSchemaDraft([...(activeSchema.fields ?? [])]);
  }, [activeSchema]);

  const fields = useMemo(
    () => getContentSchemaFields(schemaDraft ?? []),
    [schemaDraft],
  );
  const fieldGroups = useMemo(() => {
    const grouped = new Map<string, typeof fields>();
    for (const field of fields) {
      const group = getContentSchemaUi(field.definition)?.group?.trim() || "Content";
      const existing = grouped.get(group) ?? [];
      existing.push(field);
      grouped.set(group, existing);
    }

    return Array.from(grouped.entries());
  }, [fields]);
  const selectedField = fields.find((field) => field.name === selectedFieldName) ?? fields[0];

  useEffect(() => {
    if (!fields.length) {
      setSelectedFieldName(undefined);
      return;
    }

    if (!selectedFieldName || !fields.some((field) => field.name === selectedFieldName)) {
      setSelectedFieldName(fields[0]?.name);
    }
  }, [fields, selectedFieldName]);

  function resetFieldComposer() {
    setNewFieldName("");
    setNewFieldLabel("");
    setNewFieldDescription("");
    setNewFieldGroup("Content");
    setNewFieldKind("text");
    setNewFieldRequired(false);
    setNewFieldPlaceholder("");
    setNewFieldHelpText("");
    setNewFieldRows("5");
    setNewFieldRelationCollection("");
  }

  function handleAddField() {
    if (!schemaDraft) return;
    try {
      const next = insertCollectionField(schemaDraft, {
        name: newFieldName,
        label: newFieldLabel,
        description: newFieldDescription,
        group: newFieldGroup,
        kind: newFieldKind,
        required: newFieldRequired,
        placeholder: newFieldPlaceholder,
        helpText: newFieldHelpText,
        rows: Number.isFinite(Number(newFieldRows)) ? Number(newFieldRows) : undefined,
        relationCollection: newFieldRelationCollection,
      });
      setSchemaDraft(next);
      setSelectedFieldName(newFieldName.trim());
      setError(undefined);
      setMessage(`Prepared field "${newFieldName.trim()}" in the draft schema.`);
      resetFieldComposer();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setMessage(undefined);
    }
  }

  function handleRemoveField(fieldName: string) {
    if (!schemaDraft) return;
    setSchemaDraft(removeCollectionField(schemaDraft, fieldName));
    setError(undefined);
    setMessage(`Removed field "${fieldName}" from the draft schema.`);
  }

  function beginEditingField(fieldName: string) {
    const entry = schemaDraft?.find((e) => e.name === fieldName);
    if (!entry) return;
    setEditingFieldName(entry.name);
    setEditingFieldLabel(entry.field.label);
    setEditingFieldDescription("");
    setEditingFieldGroup("Content");
    setEditingFieldKind(inferFieldKindFromEntry(entry));
    setEditingFieldRequired(entry.field.required);
    setEditingFieldPlaceholder("");
    setEditingFieldHelpText("");
    setEditingFieldRows("5");
    setEditingFieldRelationCollection("");
  }

  function handleSaveFieldEdits() {
    if (!schemaDraft || !editingFieldName) return;
    try {
      const next = updateCollectionField(schemaDraft, editingFieldName, {
        name: editingFieldName,
        label: editingFieldLabel,
        description: editingFieldDescription,
        group: editingFieldGroup,
        kind: editingFieldKind,
        required: editingFieldRequired,
        placeholder: editingFieldPlaceholder,
        helpText: editingFieldHelpText,
        rows: Number.isFinite(Number(editingFieldRows)) ? Number(editingFieldRows) : undefined,
        relationCollection: editingFieldRelationCollection,
      });
      setSchemaDraft(next);
      setMessage(`Updated field "${editingFieldName}".`);
      setError(undefined);
      setEditingFieldName(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setMessage(undefined);
    }
  }

  function handleMoveField(fieldName: string, direction: -1 | 1) {
    if (!schemaDraft) return;
    setSchemaDraft(moveCollectionField(schemaDraft, fieldName, direction));
    setError(undefined);
    setMessage(`Reordered field "${fieldName}".`);
  }

  async function handleSaveSchema() {
    if (!schemaDraft || !activeSchema || saving) {
      return;
    }

    const runtime = await getRuntimeConfig();
    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      const nextVersion = (activeSchema.version ?? 0) + 1;
      await createDatabaseSchema(runtime, {
        collection: contentType,
        version: nextVersion,
        activate: true,
        fields: schemaDraft,
      });
      revalidator.revalidate();
      setMessage(`Saved and activated schema v${nextVersion}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.4fr)_minmax(320px,0.9fr)]">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Fields</CardTitle>
          <Link
            to={toDashboardPath("/database", { sidebar: "Core" })}
            className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
          >
            Open Core Database
          </Link>
        </CardHeader>
        <CardContent className="grid gap-4 p-4">
          {message ? <ResourceNotice title="Done" description={message} /> : null}
          {error ? <ResourceNotice title="Action failed" description={error} /> : null}

          {!schemaDraft ? (
            <ResourceNotice
              title="No active schema"
              description="Activate a schema to edit fields."
            />
          ) : (
            <>
              <div className="grid gap-4">
                {fieldGroups.map(([group, groupedFields]) => (
                  <div key={group} className="grid gap-2">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {group}
                      </p>
                      <span className="text-xs text-muted-foreground">
                        {groupedFields.length} fields
                      </span>
                    </div>
                    {groupedFields.map((field) => (
                      <button
                        key={field.name}
                        type="button"
                        onClick={() => setSelectedFieldName(field.name)}
                        className={cn(
                          "grid gap-1 rounded-md border px-3 py-3 text-left transition-colors hover:bg-accent",
                          selectedField?.name === field.name && "border-primary bg-accent/50",
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-medium text-foreground">{field.label}</span>
                          <span className="text-xs text-muted-foreground">
                            {field.required ? "Required" : "Optional"}
                          </span>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {field.name} · {renderFieldType(field.definition)}
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>

              <div className="rounded-md border bg-muted/20 p-3">
                <p className="text-sm font-medium text-foreground">Add field</p>
                <div className="mt-3 grid gap-3">
                  <Input
                    value={newFieldName}
                    onChange={(event) => setNewFieldName(event.target.value)}
                    placeholder="authorBio"
                    aria-label="Field name"
                  />
                  <Input
                    value={newFieldLabel}
                    onChange={(event) => setNewFieldLabel(event.target.value)}
                    placeholder="Author bio"
                    aria-label="Field label"
                  />
                  <textarea
                    value={newFieldDescription}
                    onChange={(event) => setNewFieldDescription(event.target.value)}
                    placeholder="Optional field help text"
                    rows={3}
                    className="rounded-md border bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  />
                  <Input
                    value={newFieldGroup}
                    onChange={(event) => setNewFieldGroup(event.target.value)}
                    placeholder="Content"
                    aria-label="Field group"
                  />
                  <select
                    value={newFieldKind}
                    onChange={(event) =>
                      setNewFieldKind(event.target.value as ContentFieldBuilderKind)
                    }
                    className="h-10 rounded-md border bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    {fieldTypeOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <Input
                    value={newFieldPlaceholder}
                    onChange={(event) => setNewFieldPlaceholder(event.target.value)}
                    placeholder="Placeholder"
                    aria-label="Field placeholder"
                  />
                  <Input
                    value={newFieldHelpText}
                    onChange={(event) => setNewFieldHelpText(event.target.value)}
                    placeholder="Help text shown to editors"
                    aria-label="Field help text"
                  />
                  {newFieldKind === "long-text" || newFieldKind === "json" || newFieldKind === "repeater" ? (
                    <Input
                      value={newFieldRows}
                      onChange={(event) => setNewFieldRows(event.target.value)}
                      placeholder="Rows"
                      inputMode="numeric"
                      aria-label="Field rows"
                    />
                  ) : null}
                  {newFieldKind === "relation" ? (
                    <Input
                      value={newFieldRelationCollection}
                      onChange={(event) => setNewFieldRelationCollection(event.target.value)}
                      placeholder="posts"
                      aria-label="Related collection"
                    />
                  ) : null}
                  <label className="flex items-center gap-3 text-sm text-foreground">
                    <Switch
                      checked={newFieldRequired}
                      onCheckedChange={setNewFieldRequired}
                    />
                    Required field
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleAddField}
                    disabled={!newFieldName.trim()}
                  >
                    <Plus className="size-4" />
                    Add Field
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Field builder</CardTitle>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSaveSchema()}
            disabled={!schemaDraft || !activeSchema || saving}
          >
            <Save className="size-4" />
            Save & Activate
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4 p-4">
          {!schemaDraft || !selectedField ? (
            <ResourceNotice
              title="Pick or create a field"
              description="Select a field to edit it."
            />
          ) : (
            <>
              <div className="rounded-md border bg-muted/15 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="grid gap-1">
                    <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <PencilLine className="size-4" />
                      {selectedField.label}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {selectedField.name} · {renderFieldType(selectedField.definition)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => handleRemoveField(selectedField.name)}
                  >
                    <Trash2 className="size-4" />
                    Remove
                  </Button>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => handleMoveField(selectedField.name, -1)}
                  >
                    <ArrowUp className="size-4" />
                    Move up
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => handleMoveField(selectedField.name, 1)}
                  >
                    <ArrowDown className="size-4" />
                    Move down
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => beginEditingField(selectedField.name)}
                  >
                    <SquarePen className="size-4" />
                    Edit field
                  </Button>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <FieldPropertyCard
                    label="Editor"
                    value={
                      isRichTextSchemaField(selectedField.name, selectedField.definition)
                        ? "Lexical rich text"
                        : getContentSchemaUi(selectedField.definition)?.control === "textarea"
                          ? "Textarea"
                          : selectedField.definition.type === "boolean"
                            ? "Switch"
                            : "Input"
                    }
                  />
                  <FieldPropertyCard
                    label="Required"
                    value={selectedField.required ? "Yes" : "No"}
                  />
                  <FieldPropertyCard
                    label="Group"
                    value={getContentSchemaUi(selectedField.definition)?.group ?? "Content"}
                  />
                  <FieldPropertyCard
                    label="Schema type"
                    value={String(selectedField.definition.type ?? "custom")}
                  />
                  <FieldPropertyCard
                    label="Placeholder"
                    value={getContentSchemaUi(selectedField.definition)?.placeholder ?? "None"}
                  />
                  <FieldPropertyCard
                    label="Help text"
                    value={getContentSchemaUi(selectedField.definition)?.helpText ?? "None"}
                  />
                  <FieldPropertyCard
                    label="Description"
                    value={
                      selectedField.description ??
                      "No helper copy yet. Add a description when you want editors guided."
                    }
                  />
                </div>
                {selectedField.definition.type === "string" &&
                Array.isArray(selectedField.definition.enum) ? (
                  <div className="mt-4 rounded-md border bg-background p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Allowed values
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {selectedField.definition.enum.map((value) => (
                        <span
                          key={String(value)}
                          className="rounded-md border px-2 py-1 text-xs text-muted-foreground"
                        >
                          {String(value)}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
                {selectedField.definition.type === "file" ? (
                  <div className="mt-4 rounded-md border bg-background p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      File validation
                    </p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {Array.isArray(selectedField.definition.mimeTypes)
                        ? `${selectedField.definition.mimeTypes.length} allowed MIME types`
                        : "Any MIME type"}
                      {typeof selectedField.definition.maxSize === "number"
                        ? ` · max ${selectedField.definition.maxSize.toLocaleString()} bytes`
                        : ""}
                    </p>
                  </div>
                ) : null}
              </div>

              <div className="rounded-md border bg-muted/15 p-4">
                <p className="text-sm font-medium text-foreground">Field preview</p>
                <pre className="mt-3 overflow-x-auto rounded-md border bg-background p-4 text-xs leading-6 text-muted-foreground">
                  {JSON.stringify(
                    schemaDraft?.find((e) => e.name === selectedField.name)?.field,
                    null, 2
                  )}
                </pre>
              </div>
              {editingFieldName ? (
                <div className="rounded-md border bg-muted/15 p-4">
                  <p className="text-sm font-medium text-foreground">Edit field</p>
                  <div className="mt-3 grid gap-3">
                    <Input
                      value={editingFieldLabel}
                      onChange={(event) => setEditingFieldLabel(event.target.value)}
                      placeholder="Field label"
                      aria-label="Edit field label"
                    />
                    <textarea
                      value={editingFieldDescription}
                      onChange={(event) => setEditingFieldDescription(event.target.value)}
                      rows={3}
                      placeholder="Field description"
                      className="rounded-md border bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    />
                    <Input
                      value={editingFieldGroup}
                      onChange={(event) => setEditingFieldGroup(event.target.value)}
                      placeholder="Content"
                      aria-label="Edit field group"
                    />
                    <select
                      value={editingFieldKind}
                      onChange={(event) =>
                        setEditingFieldKind(event.target.value as ContentFieldBuilderKind)
                      }
                      className="h-10 rounded-md border bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      {fieldTypeOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <Input
                      value={editingFieldPlaceholder}
                      onChange={(event) => setEditingFieldPlaceholder(event.target.value)}
                      placeholder="Field placeholder"
                      aria-label="Edit field placeholder"
                    />
                    <Input
                      value={editingFieldHelpText}
                      onChange={(event) => setEditingFieldHelpText(event.target.value)}
                      placeholder="Field help text"
                      aria-label="Edit field help text"
                    />
                    {editingFieldKind === "long-text" || editingFieldKind === "json" || editingFieldKind === "repeater" ? (
                      <Input
                        value={editingFieldRows}
                        onChange={(event) => setEditingFieldRows(event.target.value)}
                        placeholder="Rows"
                        inputMode="numeric"
                        aria-label="Edit field rows"
                      />
                    ) : null}
                    {editingFieldKind === "relation" ? (
                      <Input
                        value={editingFieldRelationCollection}
                        onChange={(event) => setEditingFieldRelationCollection(event.target.value)}
                        placeholder="posts"
                        aria-label="Edit related collection"
                      />
                    ) : null}
                    <label className="flex items-center gap-3 text-sm text-foreground">
                      <Switch
                        checked={editingFieldRequired}
                        onCheckedChange={setEditingFieldRequired}
                      />
                      Required field
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" size="sm" onClick={handleSaveFieldEdits}>
                        <Save className="size-4" />
                        Save field
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setEditingFieldName(undefined)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active schema JSON</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 p-4">
          {schemaDraft ? (
            <>
              <pre className="overflow-x-auto rounded-md border bg-muted/25 p-4 text-xs leading-6 text-muted-foreground">
                {JSON.stringify(schemaDraft, null, 2)}
              </pre>
            </>
          ) : (
            <ResourceNotice
              title="No active schema"
              description="Save a schema version to preview it here."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function renderFieldType(definition: ContentSchemaDefinition) {
  if (definition.type === "file" && Array.isArray(definition.mimeTypes)) {
    const mimes = definition.mimeTypes as string[];
    if (mimes.some((v) => v.startsWith("image/"))) return "image";
    if (mimes.some((v) => v.startsWith("audio/"))) return "audio";
    if (mimes.some((v) => v.startsWith("video/"))) return "video";
    if (mimes.some((v) => v.includes("pdf"))) return "document";
    return "file";
  }
  if (isRichTextSchemaField("_content", definition)) return "rich text";
  return typeof definition.type === "string" ? definition.type : "custom";
}

function FieldPropertyCard(props: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{props.label}</p>
      <p className="mt-2 text-sm text-foreground">{props.value}</p>
    </div>
  );
}

export default ContentTypeFieldsRoute;
