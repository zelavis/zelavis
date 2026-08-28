import { Link, useLoaderData, useRevalidator, useRouteLoaderData } from "react-router";
import {
  ArrowDown,
  ArrowUp,
  Binary,
  Braces,
  CalendarClock,
  CheckSquare,
  Copy,
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Hash,
  LinkIcon,
  List,
  ListChecks,
  PencilLine,
  Pin,
  PinOff,
  Plus,
  Rows3,
  Save,
  SquarePen,
  Text,
  TextCursorInput,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { DataRow, ResourceNotice } from "#/components/DashboardPage";
import { SchemaFieldEditor } from "#/components/content/SchemaFieldEditor";
import { Button, buttonVariants } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Switch } from "#/components/ui/switch";
import {
  contentBuilderInputToEntry,
  contentFieldEntryToBuilderInput,
  createPreviewFieldValue,
  getContentSchemaFields,
  getContentSchemaUi,
  insertCollectionField,
  isRichTextSchemaField,
  moveCollectionField,
  parseCollectionFieldEntriesJson,
  removeCollectionField,
  updateCollectionField,
  validateCollectionFieldName,
  type ContentFieldBuilderInput,
  type ContentFieldBuilderKind,
  type ContentSchemaDefinition,
} from "#/lib/content-schema";
import type {
  CollectionFieldEntry,
  DashboardSettings,
  DatabaseCollection,
  DatabaseSchemaCollectionSummary,
  DatabaseStoredCollectionSchema,
  RuntimeConfig,
} from "#/lib/runtime-api";
import {
  activateDatabaseSchemaVersion,
  createDatabaseCollection,
  createDatabaseSchema,
  getResolvedDashboardPreferences,
  getActiveRuntimeConfig,
  listDatabaseSchemaVersions,
  updateDashboardSettings,
  ZELAVIS_APP_ADMIN_TENANT_ID,
} from "#/lib/runtime-api";
import { toDashboardPath, toProjectPath } from "#/lib/routing";
import { parseAsStringLiteral, useTypedSearchParams } from "#/lib/use-typed-search-params";
import { cn } from "#/lib/utils";
import type { clientLoader as rootClientLoader } from '../root';
import type { Route } from "./+types/content.$contentType.fields";

export const handle = {
  pageLabel: "Content",
  sidebarTrail: ["Content"],
} as const;

const builderViewSearchSchema = {
  view: parseAsStringLiteral(["fields", "editor", "settings"] as const).withDefault("fields"),
} as const;

export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  const runtime = await getActiveRuntimeConfig(request);
  const schemas = await listDatabaseSchemaVersions(runtime, params.contentType);
  return { schemas, contentType: params.contentType };
}

const fieldTypeOptions: Array<{
  value: ContentFieldBuilderKind;
  label: string;
  description: string;
  icon: typeof TextCursorInput;
}> = [
  { value: "text", label: "Short Text", description: "Single-line text input.", icon: TextCursorInput },
  { value: "long-text", label: "Long Text", description: "Multi-line plain text.", icon: Text },
  { value: "rich-text", label: "Rich Text", description: "Lexical editor stored as HTML.", icon: FileText },
  { value: "number", label: "Number", description: "Decimal number.", icon: Hash },
  { value: "integer", label: "Integer", description: "Whole number.", icon: Binary },
  { value: "boolean", label: "Boolean", description: "True or false switch.", icon: CheckSquare },
  { value: "datetime", label: "Date & Time", description: "ISO date-time string.", icon: CalendarClock },
  { value: "select", label: "Select", description: "Single choice from options.", icon: List },
  { value: "multi-select", label: "Multi Select", description: "Multiple choices from options.", icon: ListChecks },
  { value: "status", label: "Status", description: "Draft, review, published, archived.", icon: List },
  { value: "relation", label: "Reference", description: "Link to another collection item.", icon: LinkIcon },
  { value: "repeater", label: "Repeater", description: "Repeatable group of fields.", icon: Rows3 },
  { value: "image", label: "Image", description: "Image file reference.", icon: FileImage },
  { value: "document", label: "Document", description: "PDF, text, JSON, or zip reference.", icon: FileText },
  { value: "audio", label: "Audio", description: "Audio file reference.", icon: FileAudio },
  { value: "video", label: "Video", description: "Video file reference.", icon: FileVideo },
  { value: "file", label: "File", description: "Generic file reference.", icon: File },
  { value: "json", label: "JSON", description: "Arbitrary structured value.", icon: Braces },
  { value: "slug", label: "Slug", description: "URL-safe identifier.", icon: LinkIcon },
  { value: "url", label: "URL", description: "Web address.", icon: LinkIcon },
];

const defaultFieldInput: ContentFieldBuilderInput = {
  name: "",
  label: "",
  description: "",
  kind: "text",
  required: false,
  group: "Content",
  placeholder: "",
  helpText: "",
  rows: 5,
  options: [],
  relationCollection: "",
  relationMultiple: false,
};

function ContentTypeFieldsRoute() {
  const { schemas, contentType } = useLoaderData<typeof clientLoader>();
  const { runtime, settings, databaseCollections, schemaCollections } =
    useRouteLoaderData<typeof rootClientLoader>('root')!;
  const revalidator = useRevalidator();
  const [viewParams, setViewParams] = useTypedSearchParams(builderViewSearchSchema);
  const activeSchema = schemas.find((schema) => schema.active) ?? schemas.at(-1);
  const [schemaDraft, setSchemaDraft] = useState<CollectionFieldEntry[]>();
  const [schemaJsonDraft, setSchemaJsonDraft] = useState("");
  const [selectedFieldName, setSelectedFieldName] = useState<string>();
  const [builderMode, setBuilderMode] = useState<"create" | "edit">("create");
  const [builderInput, setBuilderInput] =
    useState<ContentFieldBuilderInput>(defaultFieldInput);
  const [optionsText, setOptionsText] = useState("");
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<string>();
  const [previewDraft, setPreviewDraft] = useState<Record<string, unknown>>({});

  const collectionRow = databaseCollections.find((collection) => collection.name === contentType);
  const documentCount = collectionRow?.documentCount ?? 0;

  useEffect(() => {
    if (!activeSchema) {
      setSchemaDraft(undefined);
      setSchemaJsonDraft("");
      setSelectedFieldName(undefined);
      return;
    }
    const nextDraft = [...(activeSchema.fields ?? [])];
    setSchemaDraft(nextDraft);
    setSchemaJsonDraft(JSON.stringify(nextDraft, null, 2));
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
  const selectedEntry = schemaDraft?.find((entry) => entry.name === selectedField?.name);

  useEffect(() => {
    if (!fields.length) {
      setSelectedFieldName(undefined);
      return;
    }
    if (!selectedFieldName || !fields.some((field) => field.name === selectedFieldName)) {
      setSelectedFieldName(fields[0]?.name);
    }
  }, [fields, selectedFieldName]);

  useEffect(() => {
    if (!fields.length) {
      setPreviewDraft({});
      return;
    }

    const nextPreview: Record<string, unknown> = {};
    for (const field of fields) {
      nextPreview[field.name] = createPreviewFieldValue(field.definition);
    }
    setPreviewDraft(nextPreview);
  }, [fields]);

  function startCreate(kind: ContentFieldBuilderKind = "text") {
    setBuilderMode("create");
    setBuilderInput({ ...defaultFieldInput, kind });
    setOptionsText(kind === "status" ? "draft\nreview\npublished\narchived" : "");
  }

  function startEdit(entry: CollectionFieldEntry) {
    const input = contentFieldEntryToBuilderInput(entry);
    setBuilderMode("edit");
    setBuilderInput(input);
    setOptionsText((input.options ?? []).join("\n"));
  }

  function confirmRemoveField(fieldName: string) {
    if (!schemaDraft) return;
    setSchemaDraft(removeCollectionField(schemaDraft, fieldName));
    setPendingRemoval(undefined);
    startCreate();
    setError(undefined);
    setMessage(`Removed field "${fieldName}" from the draft schema.`);
  }

  function handleRemoveField(fieldName: string) {
    if (!schemaDraft) return;
    if (documentCount > 0) {
      setPendingRemoval(fieldName);
      setMessage(undefined);
      setError(undefined);
      return;
    }
    confirmRemoveField(fieldName);
  }

  function handleMoveField(fieldName: string, direction: -1 | 1) {
    if (!schemaDraft) return;
    setSchemaDraft(moveCollectionField(schemaDraft, fieldName, direction));
    setError(undefined);
    setMessage(`Reordered field "${fieldName}".`);
  }

  function handleSaveBuilderInput() {
    if (!schemaDraft) return;

    const input = normalizeBuilderInput(builderInput, optionsText);
    const validationError = validateBuilderInput(input);
    if (validationError) {
      setError(validationError);
      setMessage(undefined);
      return;
    }

    try {
      const next =
        builderMode === "edit"
          ? updateCollectionField(schemaDraft, input.name, input)
          : insertCollectionField(schemaDraft, input);
      setSchemaDraft(next);
      setSelectedFieldName(input.name.trim());
      setError(undefined);
      setMessage(
        builderMode === "edit"
          ? `Updated field "${input.name.trim()}".`
          : `Prepared field "${input.name.trim()}" in the draft schema.`,
      );
      if (builderMode === "create") {
        startCreate(input.kind);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setMessage(undefined);
    }
  }

  async function handleSaveSchema() {
    if (!schemaDraft || !activeSchema || saving) {
      return;
    }

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

  async function handleSaveJsonSchema() {
    if (!activeSchema || saving) {
      return;
    }

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      const parsed = parseSchemaJsonDraft(schemaJsonDraft);
      const nextVersion = (activeSchema.version ?? 0) + 1;
      await createDatabaseSchema(runtime, {
        collection: contentType,
        version: nextVersion,
        activate: true,
        fields: parsed,
      });
      setSchemaDraft(parsed);
      revalidator.revalidate();
      setMessage(`Saved and activated schema v${nextVersion}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function handleActivateSchemaVersion(version: number) {
    if (saving) {
      return;
    }

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      await activateDatabaseSchemaVersion(runtime, { collection: contentType, version });
      revalidator.revalidate();
      setMessage(`Activated schema v${version}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <Button
            type="button"
            variant={viewParams.view === "fields" ? "default" : "outline"}
            onClick={() => setViewParams({ view: "fields" })}
          >
            <Rows3 className="size-4" />
            Fields
          </Button>
          <Button
            type="button"
            variant={viewParams.view === "editor" ? "default" : "outline"}
            onClick={() => setViewParams({ view: "editor" })}
          >
            <Braces className="size-4" />
            Type Editor
          </Button>
          <Button
            type="button"
            variant={viewParams.view === "settings" ? "default" : "outline"}
            onClick={() => setViewParams({ view: "settings" })}
          >
            <SquarePen className="size-4" />
            Type Settings
          </Button>
        </CardContent>
      </Card>

      {viewParams.view === "editor" ? (
        <TypeEditorPanel
          schemas={schemas}
          activeSchemaVersion={activeSchema?.version}
          schemaJsonDraft={schemaJsonDraft}
          saving={saving}
          message={message}
          error={error}
          onSchemaJsonDraftChange={setSchemaJsonDraft}
          onSaveJsonSchema={() => void handleSaveJsonSchema()}
          onActivateSchemaVersion={(version) => void handleActivateSchemaVersion(version)}
        />
      ) : viewParams.view === "settings" ? (
        <TypeSettingsPanel
          contentType={contentType}
          runtime={runtime}
          settings={settings}
          databaseCollections={databaseCollections}
          schemaCollections={schemaCollections}
          revalidate={() => revalidator.revalidate()}
        />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(260px,0.82fr)_minmax(0,1.35fr)_minmax(320px,0.9fr)]">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3">
              <CardTitle>Fields</CardTitle>
            <Link
                to={toDashboardPath(toProjectPath("/database"), { sidebar: "Backend" })}
                className={cn(buttonVariants({ variant: "outline" }))}
              >
                Open Backend Database
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
              <Button type="button" onClick={() => startCreate()}>
                <Plus className="size-4" />
                New Field
              </Button>

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
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>{builderMode === "edit" ? "Edit field" : "Field builder"}</CardTitle>
          <Button
            type="button"
            onClick={() => void handleSaveSchema()}
            disabled={!schemaDraft || !activeSchema || saving}
          >
            <Save className="size-4" />
            Save & Activate
          </Button>
        </CardHeader>
        <CardContent className="grid gap-5 p-4">
          {!schemaDraft ? (
            <ResourceNotice
              title="No active schema"
              description="Create or activate a schema before using the builder."
            />
          ) : (
            <>
              <TypePicker
                selectedKind={builderInput.kind}
                onSelect={(kind) => {
                  setBuilderInput((current) => ({
                    ...current,
                    kind,
                    nestedFields: kind === "repeater" ? current.nestedFields ?? [] : current.nestedFields,
                  }));
                  if (kind === "status" && !optionsText.trim()) {
                    setOptionsText("draft\nreview\npublished\narchived");
                  }
                }}
              />

              <FieldConfigForm
                mode={builderMode}
                input={builderInput}
                optionsText={optionsText}
                onOptionsTextChange={setOptionsText}
                onChange={setBuilderInput}
                onSave={handleSaveBuilderInput}
                onCancel={() => startCreate()}
              />
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Document form preview</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 p-4">
            {!schemaDraft || fields.length === 0 ? (
              <ResourceNotice
                title="No fields to preview"
                description="Add fields to the draft schema to preview the entry editor."
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
                  value={previewDraft[field.name]}
                  onChange={(value) =>
                    setPreviewDraft((current) => ({
                      ...current,
                      [field.name]: value,
                    }))
                  }
                />
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Selected field</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 p-4">
            {!schemaDraft || !selectedField || !selectedEntry ? (
              <ResourceNotice
                title="Pick or create a field"
                description="Select a field to inspect its editor behavior."
              />
            ) : (
              <>
                {pendingRemoval === selectedField.name ? (
                  <ResourceNotice
                    title="Remove field from schema?"
                    description={`This collection has ${documentCount} existing ${documentCount === 1 ? "entry" : "entries"}. Removing "${selectedField.name}" will not delete stored values, but those values will no longer be validated or editable until you migrate them.`}
                  />
                ) : null}
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
                    {pendingRemoval === selectedField.name ? (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setPendingRemoval(undefined)}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          onClick={() => confirmRemoveField(selectedField.name)}
                        >
                          <Trash2 className="size-4" />
                          Confirm remove
                        </Button>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleRemoveField(selectedField.name)}
                      >
                        <Trash2 className="size-4" />
                        Remove
                      </Button>
                    )}
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => handleMoveField(selectedField.name, -1)}
                    >
                      <ArrowUp className="size-4" />
                      Move up
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => handleMoveField(selectedField.name, 1)}
                    >
                      <ArrowDown className="size-4" />
                      Move down
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => startEdit(selectedEntry)}
                    >
                      <SquarePen className="size-4" />
                      Edit field
                    </Button>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <FieldPropertyCard
                    label="Editor"
                    value={renderEditorKind(selectedField.definition)}
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
                </div>

                <pre className="overflow-x-auto rounded-md border bg-background p-4 text-xs leading-6 text-muted-foreground">
                  {JSON.stringify(selectedEntry.field, null, 2)}
                </pre>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Draft schema JSON</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 p-4">
            {schemaDraft ? (
              <pre className="max-h-[36rem] overflow-auto rounded-md border bg-muted/25 p-4 text-xs leading-6 text-muted-foreground">
                {JSON.stringify(schemaDraft, null, 2)}
              </pre>
            ) : (
              <ResourceNotice
                title="No active schema"
                description="Save a schema version to preview it here."
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
      )}
    </div>
  );
}

function TypeEditorPanel(props: {
  schemas: readonly DatabaseStoredCollectionSchema[];
  activeSchemaVersion?: number;
  schemaJsonDraft: string;
  saving: boolean;
  message?: string;
  error?: string;
  onSchemaJsonDraftChange: (value: string) => void;
  onSaveJsonSchema: () => void;
  onActivateSchemaVersion: (version: number) => void;
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Type Editor</CardTitle>
          <Button
            type="button"
            onClick={props.onSaveJsonSchema}
            disabled={props.saving || !props.activeSchemaVersion}
          >
            <Save className="size-4" />
            Save & Activate
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4 p-4">
          {props.message ? <ResourceNotice title="Done" description={props.message} /> : null}
          {props.error ? <ResourceNotice title="Action failed" description={props.error} /> : null}
          {!props.activeSchemaVersion ? (
            <ResourceNotice
              title="No active schema"
              description="Create or activate a schema before editing the raw field definition."
            />
          ) : null}
          <textarea
            value={props.schemaJsonDraft}
            onChange={(event) => props.onSchemaJsonDraftChange(event.target.value)}
            rows={28}
            spellCheck={false}
            className="min-h-[36rem] rounded-md border bg-background px-3 py-2 font-mono text-xs leading-6 outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label="Schema JSON"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Schema versions</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 p-4">
          {props.schemas.length === 0 ? (
            <ResourceNotice title="No versions" description="This content type has no saved schemas yet." />
          ) : (
            props.schemas
              .slice()
              .sort((left, right) => right.version - left.version)
              .map((schema) => (
                <div
                  key={schema.version}
                  className="grid gap-2 rounded-md border bg-muted/15 p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-foreground">v{schema.version}</span>
                    <span className="text-xs text-muted-foreground">
                      {schema.active ? "Active" : `${schema.fields.length} fields`}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={props.saving || schema.active}
                    onClick={() => props.onActivateSchemaVersion(schema.version)}
                  >
                    Activate version
                  </Button>
                </div>
              ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TypeSettingsPanel(props: {
  contentType: string;
  runtime: RuntimeConfig;
  settings: DashboardSettings;
  databaseCollections: readonly DatabaseCollection[];
  schemaCollections: readonly DatabaseSchemaCollectionSummary[];
  revalidate: () => void;
}) {
  const contentPreferences = getResolvedDashboardPreferences(props.settings).content;
  const row = useMemo(
    () => props.databaseCollections.find((collection) => collection.name === props.contentType),
    [props.databaseCollections, props.contentType],
  );
  const [labelDraft, setLabelDraft] = useState(
    contentPreferences?.labels?.[props.contentType] ?? props.contentType,
  );
  const [duplicateLabel, setDuplicateLabel] = useState(`${props.contentType} Copy`);
  const [duplicateName, setDuplicateName] = useState(`${props.contentType}-copy`);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const activeSchemaVersion =
    props.schemaCollections.find((entry) => entry.collection === props.contentType)
      ?.activeVersion ?? null;
  const pinnedTypes = contentPreferences?.pinnedTypes ?? [];
  const isPinned = pinnedTypes.includes(props.contentType);

  useEffect(() => {
    setLabelDraft(contentPreferences?.labels?.[props.contentType] ?? props.contentType);
  }, [contentPreferences?.labels, props.contentType]);

  async function handleSaveLabel() {
    if (!labelDraft.trim() || saving) {
      return;
    }

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      await updateDashboardSettings(props.runtime, {
        preferences: {
          content: {
            labels: {
              ...(contentPreferences?.labels ?? {}),
              [props.contentType]: labelDraft.trim(),
            },
            pinnedTypes,
          },
        },
      });
      props.revalidate();
      setMessage(`Updated editor label for ${props.contentType}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function handleTogglePin() {
    if (saving) {
      return;
    }

    const nextPinnedTypes = isPinned
      ? pinnedTypes.filter((entry) => entry !== props.contentType)
      : [...pinnedTypes, props.contentType];

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      await updateDashboardSettings(props.runtime, {
        preferences: {
          content: {
            labels: contentPreferences?.labels ?? {},
            pinnedTypes: nextPinnedTypes,
          },
        },
      });
      props.revalidate();
      setMessage(
        isPinned
          ? `Removed ${props.contentType} from pinned content types.`
          : `Pinned ${props.contentType} to the top of Content Studio.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function handleDuplicateType() {
    if (!duplicateName.trim() || saving) {
      return;
    }

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      const sourceSchemas = await listDatabaseSchemaVersions(props.runtime, props.contentType);
      const activeSchema =
        sourceSchemas.find((schema) => schema.active) ?? sourceSchemas.at(-1);
      const created = await createDatabaseCollection(props.runtime, {
        tenantId: ZELAVIS_APP_ADMIN_TENANT_ID,
        name: duplicateName.trim(),
        surface: "content-studio",
        metadata: {
          kind: "content-type",
          duplicatedFrom: props.contentType,
        },
      });

      if (activeSchema) {
        await createDatabaseSchema(props.runtime, {
          collection: created.name,
          version: 1,
          activate: true,
          fields: activeSchema.fields ?? [],
        });
      }

      await updateDashboardSettings(props.runtime, {
        preferences: {
          content: {
            labels:
              duplicateLabel.trim() && duplicateLabel.trim() !== created.name
                ? {
                    ...(contentPreferences?.labels ?? {}),
                    [created.name]: duplicateLabel.trim(),
                  }
                : contentPreferences?.labels ?? {},
            pinnedTypes,
          },
        },
      });
      props.revalidate();
      setMessage(`Duplicated ${props.contentType} into ${created.name}.`);
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
          <DataRow label="Collection" detail={props.contentType} />
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
              <Button
                type="button"
                onClick={() => void handleSaveLabel()}
                disabled={saving}
              >
                <Save className="size-4" />
                Save label
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleTogglePin()}
                disabled={saving}
              >
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

function parseSchemaJsonDraft(value: string): CollectionFieldEntry[] {
  return parseCollectionFieldEntriesJson(value);
}

function TypePicker(props: {
  selectedKind: ContentFieldBuilderKind;
  onSelect: (kind: ContentFieldBuilderKind) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {fieldTypeOptions.map((option) => {
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => props.onSelect(option.value)}
            className={cn(
              "grid min-h-24 grid-cols-[2.5rem_minmax(0,1fr)] gap-3 rounded-md border p-3 text-left transition-colors hover:bg-accent",
              props.selectedKind === option.value && "border-primary bg-accent/50",
            )}
          >
            <span className="flex size-10 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Icon className="size-5" />
            </span>
            <span className="grid gap-1">
              <span className="text-sm font-medium text-foreground">{option.label}</span>
              <span className="text-xs leading-5 text-muted-foreground">{option.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function FieldConfigForm(props: {
  mode: "create" | "edit";
  input: ContentFieldBuilderInput;
  optionsText: string;
  onOptionsTextChange: (value: string) => void;
  onChange: (input: ContentFieldBuilderInput) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { input, onChange } = props;
  const showTextValidation =
    input.kind === "text" || input.kind === "long-text" || input.kind === "slug";
  const showNumberValidation = input.kind === "number" || input.kind === "integer";
  const showOptions =
    input.kind === "select" || input.kind === "multi-select" || input.kind === "status";
  const showItemLimits = input.kind === "multi-select" || input.kind === "repeater";
  const showRows = input.kind === "long-text" || input.kind === "json";
  const showPlaceholder =
    input.kind === "text" ||
    input.kind === "long-text" ||
    input.kind === "number" ||
    input.kind === "integer" ||
    input.kind === "json" ||
    input.kind === "slug" ||
    input.kind === "url";

  return (
    <div className="grid gap-4 rounded-md border bg-muted/15 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          value={input.label ?? ""}
          onChange={(event) => {
            const label = event.target.value;
            onChange({
              ...input,
              label,
              name: props.mode === "create" && !input.name ? slugifyFieldName(label) : input.name,
            });
          }}
          placeholder="Author Bio"
          aria-label="Field label"
        />
        <Input
          value={input.name}
          onChange={(event) => onChange({ ...input, name: event.target.value })}
          placeholder="authorBio"
          aria-label="Field name"
          disabled={props.mode === "edit"}
        />
      </div>

      <textarea
        value={input.description ?? ""}
        onChange={(event) => onChange({ ...input, description: event.target.value })}
        rows={3}
        placeholder="Optional field description"
        className="rounded-md border bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          value={input.group ?? ""}
          onChange={(event) => onChange({ ...input, group: event.target.value })}
          placeholder="Content"
          aria-label="Field group"
        />
        {showPlaceholder ? (
          <Input
            value={input.placeholder ?? ""}
            onChange={(event) => onChange({ ...input, placeholder: event.target.value })}
            placeholder="Placeholder"
            aria-label="Field placeholder"
          />
        ) : null}
      </div>

      <Input
        value={input.helpText ?? ""}
        onChange={(event) => onChange({ ...input, helpText: event.target.value })}
        placeholder="Help text shown to editors"
        aria-label="Field help text"
      />

      <label className="flex items-center gap-3 text-sm text-foreground">
        <Switch
          checked={input.required ?? false}
          onCheckedChange={(required) => onChange({ ...input, required })}
        />
        Required field
      </label>

      {showTextValidation ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <NumericInput
            value={input.minLength}
            onChange={(minLength) => onChange({ ...input, minLength })}
            placeholder="Min length"
          />
          <NumericInput
            value={input.maxLength}
            onChange={(maxLength) => onChange({ ...input, maxLength })}
            placeholder="Max length"
          />
          <Input
            value={input.pattern ?? ""}
            onChange={(event) => onChange({ ...input, pattern: event.target.value })}
            placeholder={input.kind === "slug" ? "^[a-z0-9]+(?:-[a-z0-9]+)*$" : "Pattern"}
            aria-label="Validation pattern"
          />
        </div>
      ) : null}

      {showNumberValidation ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <NumericInput
            value={input.min}
            onChange={(min) => onChange({ ...input, min })}
            placeholder="Min value"
          />
          <NumericInput
            value={input.max}
            onChange={(max) => onChange({ ...input, max })}
            placeholder="Max value"
          />
        </div>
      ) : null}

      {showOptions ? (
        <textarea
          value={props.optionsText}
          onChange={(event) => props.onOptionsTextChange(event.target.value)}
          rows={5}
          placeholder="Option 1&#10;Option 2&#10;Option 3"
          className="rounded-md border bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
      ) : null}

      {showItemLimits ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <NumericInput
            value={input.minItems}
            onChange={(minItems) => onChange({ ...input, minItems })}
            placeholder="Min items"
          />
          <NumericInput
            value={input.maxItems}
            onChange={(maxItems) => onChange({ ...input, maxItems })}
            placeholder="Max items"
          />
        </div>
      ) : null}

      {showRows ? (
        <NumericInput
          value={input.rows}
          onChange={(rows) => onChange({ ...input, rows })}
          placeholder="Rows"
        />
      ) : null}

      {input.kind === "relation" ? (
        <div className="grid gap-3">
          <Input
            value={input.relationCollection ?? ""}
            onChange={(event) => onChange({ ...input, relationCollection: event.target.value })}
            placeholder="posts"
            aria-label="Related collection"
          />
          <label className="flex items-center gap-3 text-sm text-foreground">
            <Switch
              checked={input.relationMultiple ?? false}
              onCheckedChange={(relationMultiple) => onChange({ ...input, relationMultiple })}
            />
            Allow multiple references
          </label>
        </div>
      ) : null}

      {input.kind === "slug" ? (
        <Input
          value={input.from ?? ""}
          onChange={(event) => onChange({ ...input, from: event.target.value })}
          placeholder="Generate from field, for example title"
          aria-label="Slug source field"
        />
      ) : null}

      {isFileKind(input.kind) ? (
        <NumericInput
          value={input.maxSize}
          onChange={(maxSize) => onChange({ ...input, maxSize })}
          placeholder="Max size in bytes"
        />
      ) : null}

      {input.kind === "repeater" ? (
        <NestedFieldsEditor
          fields={input.nestedFields ?? []}
          onChange={(nestedFields) => onChange({ ...input, nestedFields })}
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={props.onSave}>
          <Save className="size-4" />
          {props.mode === "edit" ? "Update Field" : "Add Field"}
        </Button>
        {props.mode === "edit" ? (
          <Button type="button" variant="outline" onClick={props.onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function NestedFieldsEditor(props: {
  fields: CollectionFieldEntry[];
  onChange: (fields: CollectionFieldEntry[]) => void;
}) {
  const [nestedName, setNestedName] = useState("");
  const [nestedLabel, setNestedLabel] = useState("");
  const [nestedKind, setNestedKind] = useState<ContentFieldBuilderKind>("text");

  function handleAddNestedField() {
    const name = nestedName.trim() || slugifyFieldName(nestedLabel);
    const validationError = validateCollectionFieldName(name);
    if (validationError) {
      return;
    }
    if (props.fields.some((field) => field.name === name)) {
      return;
    }

    props.onChange([
      ...props.fields,
      contentBuilderInputToEntry({
        name,
        label: nestedLabel.trim() || undefined,
        kind: nestedKind,
        required: false,
      }),
    ]);
    setNestedName("");
    setNestedLabel("");
    setNestedKind("text");
  }

  return (
    <div className="grid gap-3 rounded-md border bg-background p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-foreground">Nested fields</p>
        <span className="text-xs text-muted-foreground">{props.fields.length} fields</span>
      </div>
      {props.fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Repeaters need at least one nested field for editors to fill in.
        </p>
      ) : (
        <div className="grid gap-2">
          {props.fields.map((field) => (
            <div
              key={field.name}
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
            >
              <div className="grid gap-0.5">
                <span className="text-sm font-medium text-foreground">{field.field.label}</span>
                <span className="text-xs text-muted-foreground">
                  {field.name} · {field.field._tag}
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  props.onChange(props.fields.filter((entry) => entry.name !== field.name))
                }
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_auto]">
        <Input
          value={nestedName}
          onChange={(event) => setNestedName(event.target.value)}
          placeholder="fieldName"
          aria-label="Nested field name"
        />
        <Input
          value={nestedLabel}
          onChange={(event) => setNestedLabel(event.target.value)}
          placeholder="Field label"
          aria-label="Nested field label"
        />
        <select
          value={nestedKind}
          onChange={(event) => setNestedKind(event.target.value as ContentFieldBuilderKind)}
          className="h-10 rounded-md border bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-label="Nested field type"
        >
          <option value="text">Short Text</option>
          <option value="long-text">Long Text</option>
          <option value="number">Number</option>
          <option value="integer">Integer</option>
          <option value="boolean">Boolean</option>
        </select>
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={handleAddNestedField}
        disabled={!nestedName.trim() && !nestedLabel.trim()}
      >
        <Plus className="size-4" />
        Add nested field
      </Button>
    </div>
  );
}

function NumericInput(props: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  placeholder: string;
}) {
  return (
    <Input
      value={props.value === undefined ? "" : String(props.value)}
      onChange={(event) => {
        const raw = event.target.value.trim();
        props.onChange(raw ? Number(raw) : undefined);
      }}
      placeholder={props.placeholder}
      inputMode="numeric"
      aria-label={props.placeholder}
    />
  );
}

function normalizeBuilderInput(
  input: ContentFieldBuilderInput,
  optionsText: string,
): ContentFieldBuilderInput {
  return {
    ...input,
    options: optionsText
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

function validateBuilderInput(input: ContentFieldBuilderInput): string | undefined {
  const nameIssue = validateCollectionFieldName(input.name);
  if (nameIssue) return nameIssue;
  if (
    (input.kind === "select" || input.kind === "multi-select" || input.kind === "status") &&
    (!input.options || input.options.length === 0)
  ) {
    return "Select fields need at least one option.";
  }
  if (input.kind === "relation" && !input.relationCollection?.trim()) {
    return "Reference fields need a related collection.";
  }
  if (input.kind === "repeater") {
    const nestedFields = input.nestedFields ?? [];
    const nestedNames = new Set<string>();
    for (const nested of nestedFields) {
      const nestedNameIssue = validateCollectionFieldName(nested.name);
      if (nestedNameIssue) {
        return `Nested field "${nested.name || "unnamed"}": ${nestedNameIssue}`;
      }
      if (nestedNames.has(nested.name)) {
        return `Duplicate nested field name "${nested.name}".`;
      }
      nestedNames.add(nested.name);
    }
  }
  if (input.min !== undefined && input.max !== undefined && input.min > input.max) {
    return "Minimum value cannot be greater than maximum value.";
  }
  if (
    input.minLength !== undefined &&
    input.maxLength !== undefined &&
    input.minLength > input.maxLength
  ) {
    return "Minimum length cannot be greater than maximum length.";
  }
  if (
    input.minItems !== undefined &&
    input.maxItems !== undefined &&
    input.minItems > input.maxItems
  ) {
    return "Minimum items cannot be greater than maximum items.";
  }
  return undefined;
}

function slugifyFieldName(label: string) {
  const words = label
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      return index === 0 ? lower : `${lower[0]?.toUpperCase() ?? ""}${lower.slice(1)}`;
    })
    .join("");
}

function isFileKind(kind: ContentFieldBuilderKind) {
  return kind === "image" || kind === "document" || kind === "audio" || kind === "video" || kind === "file";
}

function renderFieldType(definition: ContentSchemaDefinition) {
  const ui = getContentSchemaUi(definition);
  if (ui?.control === "select") return "select";
  if (ui?.control === "multi-select") return "multi-select";
  if (ui?.control === "reference") return "reference";
  if (ui?.control === "slug") return "slug";
  if (ui?.control === "url") return "url";
  if (ui?.control === "json") return "json";
  if (definition.type === "file" && Array.isArray(definition.mimeTypes)) {
    const mimes = definition.mimeTypes as string[];
    if (mimes.some((value) => value.startsWith("image/"))) return "image";
    if (mimes.some((value) => value.startsWith("audio/"))) return "audio";
    if (mimes.some((value) => value.startsWith("video/"))) return "video";
    if (mimes.some((value) => value.includes("pdf"))) return "document";
    return "file";
  }
  if (isRichTextSchemaField("_content", definition)) return "rich text";
  return typeof definition.type === "string" ? definition.type : "custom";
}

function renderEditorKind(definition: ContentSchemaDefinition) {
  const ui = getContentSchemaUi(definition);
  if (isRichTextSchemaField("_content", definition)) return "Lexical rich text";
  if (ui?.control === "textarea") return "Textarea";
  if (ui?.control === "select") return "Select";
  if (ui?.control === "multi-select") return "Multi-select";
  if (ui?.control === "reference") return "Reference picker";
  if (ui?.control === "datetime") return "Date-time input";
  if (ui?.control === "json") return "JSON editor";
  if (definition.type === "boolean") return "Switch";
  return "Input";
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
