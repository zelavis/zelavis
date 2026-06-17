import { useFetcher } from "react-router";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { RichTextEditor } from "#/components/content/RichTextEditor";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Switch } from "#/components/ui/switch";
import {
  getContentSchemaUi,
  getReferenceCollection,
  getRepeaterNestedDefinitions,
  isMultiSelectSchemaField,
  isReferenceMultiple,
  isReferenceSchemaField,
  isRepeaterSchemaField,
  isRichTextSchemaField,
  type ContentSchemaDefinition,
} from "#/lib/content-schema";
import { queryDatabaseDocuments } from "#/lib/runtime-api";

export type SchemaFieldMediaItem = {
  src: string;
  altText: string;
  label: string;
};

export type SchemaFieldFileItem = {
  href: string;
  label: string;
  meta: string;
};

export function SchemaFieldEditor(props: {
  name: string;
  label: string;
  description?: string;
  required: boolean;
  definition: ContentSchemaDefinition;
  value: unknown;
  mediaItems?: SchemaFieldMediaItem[];
  fileItems?: SchemaFieldFileItem[];
  disabled?: boolean;
  onChange?: (value: unknown) => void;
}) {
  const ui = getContentSchemaUi(props.definition);
  const placeholder =
    typeof ui?.placeholder === "string" ? ui.placeholder : `Enter ${props.label.toLowerCase()}`;
  const readOnly = props.disabled || !props.onChange;

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
        mediaItems={props.mediaItems ?? []}
        fileItems={props.fileItems ?? []}
        disabled={readOnly}
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
  mediaItems: SchemaFieldMediaItem[];
  fileItems: SchemaFieldFileItem[];
  disabled?: boolean;
  onChange?: (value: unknown) => void;
}) {
  const disabled = props.disabled || !props.onChange;

  if (props.definition.type === "boolean") {
    return (
      <div className="flex items-center gap-3 rounded-md border px-3 py-2">
        <Switch
          checked={Boolean(props.value)}
          disabled={disabled}
          onCheckedChange={(checked) => props.onChange?.(checked)}
        />
        <span className="text-sm font-normal text-muted-foreground">
          {Boolean(props.value) ? "Enabled" : "Disabled"}
        </span>
      </div>
    );
  }

  if (isRichTextSchemaField(props.name, props.definition)) {
    if (disabled) {
      return (
        <textarea
          value={typeof props.value === "string" ? props.value : ""}
          disabled
          rows={6}
          placeholder={props.placeholder}
          className="min-h-28 rounded-md border bg-background px-3 py-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
      );
    }

    return (
      <RichTextEditor
        value={typeof props.value === "string" ? props.value : ""}
        onChange={props.onChange ?? (() => undefined)}
        placeholder={props.placeholder}
        mediaItems={props.mediaItems}
        fileItems={props.fileItems}
      />
    );
  }

  if (isReferenceSchemaField(props.definition)) {
    return (
      <ReferenceFieldInput
        definition={props.definition}
        value={props.value}
        disabled={disabled}
        onChange={props.onChange}
      />
    );
  }

  if (isMultiSelectSchemaField(props.definition)) {
    return (
      <MultiSelectFieldInput
        definition={props.definition}
        value={Array.isArray(props.value) ? props.value : []}
        disabled={disabled}
        onChange={props.onChange}
      />
    );
  }

  if (isRepeaterSchemaField(props.definition)) {
    return (
      <RepeaterFieldInput
        definition={props.definition}
        value={Array.isArray(props.value) ? props.value : []}
        mediaItems={props.mediaItems}
        fileItems={props.fileItems}
        disabled={disabled}
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
        disabled={disabled}
        onChange={(event) => props.onChange?.(event.target.value)}
        className="h-10 rounded-md border bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
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

  if (getContentSchemaUi(props.definition)?.control === "datetime") {
    return (
      <Input
        type="datetime-local"
        value={toDateTimeLocalValue(props.value)}
        disabled={disabled}
        onChange={(event) =>
          props.onChange?.(
            event.target.value ? new Date(event.target.value).toISOString() : "",
          )
        }
        placeholder={props.placeholder}
      />
    );
  }

  if (
    props.definition.type === "object" ||
    props.definition.type === "file" ||
    getContentSchemaUi(props.definition)?.control === "textarea" ||
    getContentSchemaUi(props.definition)?.control === "json"
  ) {
    return (
      <textarea
        value={typeof props.value === "string" ? props.value : ""}
        disabled={disabled}
        onChange={(event) => props.onChange?.(event.target.value)}
        rows={
          typeof getContentSchemaUi(props.definition)?.rows === "number"
            ? getContentSchemaUi(props.definition)?.rows
            : props.definition.type === "string"
              ? 4
              : 10
        }
        placeholder={props.placeholder}
        className="min-h-28 rounded-md border bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      />
    );
  }

  return (
    <Input
      type={
        props.definition.type === "number" || props.definition.type === "integer"
          ? "number"
          : getContentSchemaUi(props.definition)?.control === "url"
            ? "url"
            : "text"
      }
      value={typeof props.value === "string" ? props.value : ""}
      disabled={disabled}
      onChange={(event) => props.onChange?.(event.target.value)}
      placeholder={props.placeholder}
    />
  );
}

function toDateTimeLocalValue(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "";
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  const date = new Date(timestamp);
  const offset = date.getTimezoneOffset();
  const local = new Date(timestamp - offset * 60_000);
  return local.toISOString().slice(0, 16);
}

function ReferenceFieldInput(props: {
  definition: ContentSchemaDefinition;
  value: unknown;
  disabled?: boolean;
  onChange?: (value: unknown) => void;
}) {
  const relationCollection = getReferenceCollection(props.definition);
  const multiple = isReferenceMultiple(props.definition);
  const fetcher = useFetcher<{ documents: Awaited<ReturnType<typeof queryDatabaseDocuments>> }>();
  const [search, setSearch] = useState("");

  if (relationCollection && fetcher.state === "idle" && !fetcher.data) {
    fetcher.load(`/_api/relations/${encodeURIComponent(relationCollection)}`);
  }

  const relatedDocuments = fetcher.data?.documents ?? [];
  const options = relatedDocuments.filter((document) => {
    const label = String(document.data.title ?? document.id).toLowerCase();
    const slug = String(document.data.slug ?? "").toLowerCase();
    const query = search.trim().toLowerCase();
    return (
      query.length === 0 ||
      label.includes(query) ||
      slug.includes(query) ||
      document.id.toLowerCase().includes(query)
    );
  });

  if (multiple) {
    const selected = Array.isArray(props.value)
      ? props.value.filter(
          (item): item is { collection: string; id: string } =>
            typeof item === "object" &&
            item !== null &&
            "id" in item &&
            typeof (item as { id: unknown }).id === "string",
        )
      : [];
    const selectedIds = new Set(selected.map((item) => item.id));

    return (
      <div className="grid gap-2">
        <Input
          value={search}
          disabled={props.disabled}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search related entries"
        />
        <div className="grid max-h-48 gap-1 overflow-auto rounded-md border p-2">
          {options.map((document) => {
            const checked = selectedIds.has(document.id);
            return (
              <label
                key={document.id}
                className="flex items-center gap-2 rounded-sm px-2 py-1 text-sm font-normal hover:bg-accent"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={props.disabled}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? [
                          ...selected,
                          {
                            collection: relationCollection ?? "",
                            id: document.id,
                          },
                        ]
                      : selected.filter((item) => item.id !== document.id);
                    props.onChange?.(next);
                  }}
                />
                <span>
                  {String(document.data.title ?? document.id)}
                  {document.data.slug ? ` · ${String(document.data.slug)}` : ""}
                </span>
              </label>
            );
          })}
        </div>
        <p className="text-xs font-normal text-muted-foreground">
          {relationCollection
            ? `Links to entries in ${relationCollection}.`
            : "No relation target collection configured yet."}
        </p>
      </div>
    );
  }

  const selectedId =
    typeof props.value === "object" &&
    props.value &&
    "id" in props.value &&
    typeof (props.value as { id: unknown }).id === "string"
      ? (props.value as { id: string }).id
      : typeof props.value === "string"
        ? props.value
        : "";

  return (
    <div className="grid gap-2">
      <Input
        value={search}
        disabled={props.disabled}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search related entries"
      />
      <select
        value={selectedId}
        disabled={props.disabled}
        onChange={(event) => {
          const id = event.target.value;
          props.onChange?.(
            id
              ? {
                  collection: relationCollection ?? "",
                  id,
                }
              : undefined,
          );
        }}
        className="h-10 rounded-md border bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <option value="">Select related entry…</option>
        {options.map((document) => (
          <option key={document.id} value={document.id}>
            {String(document.data.title ?? document.id)}
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

function MultiSelectFieldInput(props: {
  definition: ContentSchemaDefinition;
  value: string[];
  disabled?: boolean;
  onChange?: (value: unknown) => void;
}) {
  const options =
    getContentSchemaUi(props.definition)?.options?.filter(
      (value): value is string => typeof value === "string",
    ) ??
    (Array.isArray(props.definition.items) &&
    typeof props.definition.items === "object" &&
    props.definition.items &&
    "enum" in props.definition.items &&
    Array.isArray((props.definition.items as { enum?: unknown }).enum)
      ? ((props.definition.items as { enum: unknown[] }).enum.filter(
          (value): value is string => typeof value === "string",
        ) ?? [])
      : []);

  return (
    <div className="grid max-h-48 gap-1 overflow-auto rounded-md border p-2">
      {options.map((option) => {
        const checked = props.value.includes(option);
        return (
          <label
            key={option}
            className="flex items-center gap-2 rounded-sm px-2 py-1 text-sm font-normal hover:bg-accent"
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={props.disabled}
              onChange={(event) => {
                const next = event.target.checked
                  ? [...props.value, option]
                  : props.value.filter((value) => value !== option);
                props.onChange?.(next);
              }}
            />
            <span>{option}</span>
          </label>
        );
      })}
    </div>
  );
}

function RepeaterFieldInput(props: {
  definition: ContentSchemaDefinition;
  value: unknown[];
  mediaItems: SchemaFieldMediaItem[];
  fileItems: SchemaFieldFileItem[];
  disabled?: boolean;
  onChange?: (value: unknown) => void;
}) {
  const nestedDefinitions = getRepeaterNestedDefinitions(props.definition);
  const nestedFields = Object.entries(nestedDefinitions).map(([name, definition]) => ({
    name,
    definition,
  }));

  function updateItem(index: number, nextItem: Record<string, unknown>) {
    const next = [...props.value];
    next[index] = nextItem;
    props.onChange?.(next);
  }

  function moveItem(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= props.value.length) {
      return;
    }

    const next = [...props.value];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    props.onChange?.(next);
  }

  return (
    <div className="grid gap-3 rounded-md border bg-muted/10 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">Repeater items</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.disabled}
          onClick={() => props.onChange?.([...(props.value ?? []), {}])}
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
        props.value.map((item, index) => {
          const itemValue =
            typeof item === "object" && item && !Array.isArray(item)
              ? (item as Record<string, unknown>)
              : {};

          return (
            <div key={index} className="grid gap-2 rounded-md border bg-background p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">Item {index + 1}</span>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={props.disabled}
                    onClick={() => moveItem(index, -1)}
                  >
                    <ChevronUp className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={props.disabled}
                    onClick={() => moveItem(index, 1)}
                  >
                    <ChevronDown className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={props.disabled}
                    onClick={() =>
                      props.onChange?.(props.value.filter((_, itemIndex) => itemIndex !== index))
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
              {nestedFields.length > 0 ? (
                nestedFields.map((nested) => (
                  <SchemaFieldEditor
                    key={nested.name}
                    name={nested.name}
                    label={String(nested.definition.label ?? nested.name)}
                    required={Boolean(nested.definition.required)}
                    definition={nested.definition}
                    value={itemValue[nested.name]}
                    mediaItems={props.mediaItems}
                    fileItems={props.fileItems}
                    disabled={props.disabled}
                    onChange={(value) =>
                      updateItem(index, {
                        ...itemValue,
                        [nested.name]: value,
                      })
                    }
                  />
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  Add nested fields to this repeater in the schema builder.
                </p>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
