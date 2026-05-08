import { Link, createFileRoute, useParams } from "@tanstack/react-router";
import { PencilLine, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ResourceNotice } from "#/components/DashboardPage";
import { Button, buttonVariants } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Switch } from "#/components/ui/switch";
import {
  createContentFieldDefinition,
  getContentSchemaFields,
  getContentSchemaUi,
  insertFieldIntoSchemaDocument,
  isRichTextSchemaField,
  removeFieldFromSchemaDocument,
  type ContentFieldBuilderKind,
  type ContentSchemaDefinition,
} from "#/lib/content-schema";
import {
  createDatabaseSchema,
  getRuntimeConfig,
  listDatabaseSchemaVersions,
} from "#/lib/runtime-api";
import { useRuntimeResource } from "#/lib/use-runtime-resource";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/content/$contentType/fields")({
  component: ContentTypeFieldsRoute,
});

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
  { value: "image", label: "Image", description: "Image file reference." },
  { value: "document", label: "Document", description: "PDF, text, JSON, or zip reference." },
  { value: "audio", label: "Audio", description: "Audio file reference." },
  { value: "video", label: "Video", description: "Video file reference." },
  { value: "file", label: "Generic file", description: "Unrestricted file reference." },
  { value: "json", label: "JSON object", description: "Structured object value." },
];

function ContentTypeFieldsRoute() {
  const { contentType } = useParams({ from: "/content/$contentType/fields" });
  const runtime = useRuntimeResource(getRuntimeConfig);
  const config = runtime.data;
  const schemas = useRuntimeResource(
    async () => (config ? listDatabaseSchemaVersions(config, contentType) : []),
    [config, contentType],
  );
  const activeSchema = schemas.data?.find((schema) => schema.active) ?? schemas.data?.at(-1);
  const [schemaDraft, setSchemaDraft] = useState<Record<string, unknown>>();
  const [selectedFieldName, setSelectedFieldName] = useState<string>();
  const [newFieldName, setNewFieldName] = useState("");
  const [newFieldLabel, setNewFieldLabel] = useState("");
  const [newFieldDescription, setNewFieldDescription] = useState("");
  const [newFieldKind, setNewFieldKind] =
    useState<ContentFieldBuilderKind>("text");
  const [newFieldRequired, setNewFieldRequired] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!activeSchema?.document || typeof activeSchema.document !== "object") {
      setSchemaDraft(undefined);
      setSelectedFieldName(undefined);
      return;
    }

    setSchemaDraft(structuredClone(activeSchema.document) as Record<string, unknown>);
  }, [activeSchema?.document]);

  const fields = useMemo(
    () => getContentSchemaFields(schemaDraft),
    [schemaDraft],
  );
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
    setNewFieldKind("text");
    setNewFieldRequired(false);
  }

  function handleAddField() {
    if (!schemaDraft) {
      return;
    }

    try {
      const nextDocument = insertFieldIntoSchemaDocument({
        document: schemaDraft,
        field: {
          name: newFieldName,
          label: newFieldLabel,
          description: newFieldDescription,
          kind: newFieldKind,
          required: newFieldRequired,
        },
      });
      setSchemaDraft(nextDocument);
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
    if (!schemaDraft) {
      return;
    }

    const nextDocument = removeFieldFromSchemaDocument({
      document: schemaDraft,
      fieldName,
    });
    setSchemaDraft(nextDocument);
    setError(undefined);
    setMessage(`Removed field "${fieldName}" from the draft schema.`);
  }

  async function handleSaveSchema() {
    if (!config || !schemaDraft || !activeSchema || saving) {
      return;
    }

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      const nextVersion = (activeSchema.version ?? 0) + 1;
      await createDatabaseSchema(config, {
        collection: contentType,
        version: nextVersion,
        activate: true,
        document: schemaDraft,
        metadata: {
          source: "content-fields-builder",
          basedOnVersion: activeSchema.version,
        },
      });
      await schemas.reload();
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
            to="/database"
            search={{ sidebar: "Core" }}
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
              description="This content type needs an active schema before the field builder can edit it."
            />
          ) : (
            <>
              <div className="grid gap-2">
                {fields.map((field) => (
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
              description="Fields added here become the editor-facing model for this content type. Core > Database stays the lower-level data surface."
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
                    label="Schema type"
                    value={String(selectedField.definition.type ?? "custom")}
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
                <p className="text-sm font-medium text-foreground">Schema preview</p>
                <pre className="mt-3 overflow-x-auto rounded-md border bg-background p-4 text-xs leading-6 text-muted-foreground">
                  {JSON.stringify(createContentFieldDefinition({
                    name: selectedField.name,
                    label: selectedField.label,
                    description: selectedField.description,
                    required: selectedField.required,
                    kind: inferFieldKind(selectedField.name, selectedField.definition),
                  }), null, 2)}
                </pre>
              </div>
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
              <p className="text-sm text-muted-foreground">
                This stays transparent on purpose. The friendly field builder writes ordinary schema JSON, then Core &gt; Database can still inspect the raw shape.
              </p>
              <pre className="overflow-x-auto rounded-md border bg-muted/25 p-4 text-xs leading-6 text-muted-foreground">
                {JSON.stringify(schemaDraft, null, 2)}
              </pre>
            </>
          ) : (
            <ResourceNotice
              title="No active schema"
              description="Once this content type has an active schema, it will show up here alongside the field builder."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function renderFieldType(definition: ContentSchemaDefinition) {
  if (definition.type === "file" && Array.isArray(definition.mimeTypes)) {
    if (definition.mimeTypes.some((value) => String(value).startsWith("image/"))) {
      return "image";
    }
    if (definition.mimeTypes.some((value) => String(value).startsWith("audio/"))) {
      return "audio";
    }
    if (definition.mimeTypes.some((value) => String(value).startsWith("video/"))) {
      return "video";
    }
    if (definition.mimeTypes.some((value) => String(value).includes("pdf"))) {
      return "document";
    }
    return "file";
  }

  if (isRichTextSchemaField("_content", definition)) {
    return "rich text";
  }

  return typeof definition.type === "string" ? definition.type : "custom";
}

function inferFieldKind(
  name: string,
  definition: ContentSchemaDefinition,
): ContentFieldBuilderKind {
  if (isRichTextSchemaField(name, definition)) {
    return "rich-text";
  }

  if (definition.type === "file") {
    return renderFieldType(definition) as ContentFieldBuilderKind;
  }

  if (definition.type === "string" && getContentSchemaUi(definition)?.control === "textarea") {
    return "long-text";
  }

  if (
    definition.type === "string" &&
    Array.isArray(definition.enum) &&
    definition.enum.join(",") === "draft,review,published"
  ) {
    return "status";
  }

  switch (definition.type) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "json";
    case "string":
    default:
      return "text";
  }
}

function FieldPropertyCard(props: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{props.label}</p>
      <p className="mt-2 text-sm text-foreground">{props.value}</p>
    </div>
  );
}
