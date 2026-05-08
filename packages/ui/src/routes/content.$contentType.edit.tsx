import { createFileRoute, useParams } from "@tanstack/react-router";
import { FileImage, Files, FileText, Save, Volume2, Video } from "lucide-react";
import { useMemo, useState } from "react";

import { ResourceNotice } from "#/components/DashboardPage";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import {
  activateDatabaseSchemaVersion,
  createDatabaseCollection,
  createDatabaseSchema,
  getRuntimeConfig,
  insertDatabaseDocument,
  listDatabaseSchemaVersions,
} from "#/lib/runtime-api";
import { useRuntimeResource } from "#/lib/use-runtime-resource";

export const Route = createFileRoute("/content/$contentType/edit")({
  component: ContentTypeEditorRoute,
});

type FileSchemaTemplateKind =
  | "image"
  | "file"
  | "document"
  | "audio"
  | "video";

function createFileSchemaTemplate(kind: FileSchemaTemplateKind) {
  switch (kind) {
    case "image":
      return {
        type: "file",
        mimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
        maxSize: 5_000_000,
      };
    case "document":
      return {
        type: "file",
        mimeTypes: [
          "application/pdf",
          "text/plain",
          "application/json",
          "application/zip",
        ],
        maxSize: 10_000_000,
      };
    case "audio":
      return {
        type: "file",
        mimeTypes: ["audio/mpeg", "audio/wav", "audio/ogg", "audio/webm"],
        maxSize: 20_000_000,
      };
    case "video":
      return {
        type: "file",
        mimeTypes: ["video/mp4", "video/webm", "video/ogg", "video/quicktime"],
        maxSize: 50_000_000,
      };
    case "file":
    default:
      return { type: "file" };
  }
}

function createSampleFileReference(fieldName: string, kind: FileSchemaTemplateKind) {
  const byKind = {
    image: {
      path: `media/${fieldName}.jpg`,
      contentType: "image/jpeg",
    },
    file: {
      path: `uploads/${fieldName}.bin`,
      contentType: "application/octet-stream",
    },
    document: {
      path: `documents/${fieldName}.pdf`,
      contentType: "application/pdf",
    },
    audio: {
      path: `audio/${fieldName}.mp3`,
      contentType: "audio/mpeg",
    },
    video: {
      path: `video/${fieldName}.mp4`,
      contentType: "video/mp4",
    },
  } as const;

  const chosen = byKind[kind];

  return {
    kind: "file",
    path: chosen.path,
    href: `/zelavis/api/v1/storage/files/${chosen.path}`,
    metadataHref: `/zelavis/api/v1/storage/files/${chosen.path}?format=metadata`,
    contentType: chosen.contentType,
    metadata: {
      label: fieldName,
      purpose: "sample-document",
    },
  };
}

function insertFileFieldIntoSchema(input: {
  schemaJson: string;
  fieldName: string;
  kind: FileSchemaTemplateKind;
  required: boolean;
}) {
  const parsed = JSON.parse(input.schemaJson) as Record<string, unknown>;

  if (parsed.type !== "object") {
    throw new Error("The schema root must be an object before adding a file field.");
  }

  const properties =
    parsed.properties && typeof parsed.properties === "object"
      ? ({ ...(parsed.properties as Record<string, unknown>) })
      : {};

  if (input.fieldName in properties) {
    throw new Error(`A schema field named "${input.fieldName}" already exists.`);
  }

  properties[input.fieldName] = createFileSchemaTemplate(input.kind);
  parsed.properties = properties;

  const existingRequired = Array.isArray(parsed.required)
    ? parsed.required.filter((value): value is string => typeof value === "string")
    : [];

  parsed.required = input.required
    ? [...new Set([...existingRequired, input.fieldName])]
    : existingRequired.filter((value) => value !== input.fieldName);

  return JSON.stringify(parsed, null, 2);
}

function insertFileReferenceIntoSampleDocument(input: {
  documentJson: string;
  fieldName: string;
  kind: FileSchemaTemplateKind;
}) {
  const parsed = JSON.parse(input.documentJson) as Record<string, unknown>;

  if (parsed[input.fieldName] !== undefined) {
    return JSON.stringify(parsed, null, 2);
  }

  if (typeof parsed.name !== "string") {
    parsed.name = "Draft item";
  }

  parsed[input.fieldName] = createSampleFileReference(input.fieldName, input.kind);
  return JSON.stringify(parsed, null, 2);
}

function ContentTypeEditorRoute() {
  const { contentType } = useParams({ from: "/content/$contentType/edit" });
  const runtime = useRuntimeResource(getRuntimeConfig);
  const config = runtime.data;
  const schemaVersions = useRuntimeResource(
    async () => (config ? listDatabaseSchemaVersions(config, contentType) : []),
    [config, contentType],
  );
  const activeSchema = schemaVersions.data?.find((schema) => schema.active) ?? schemaVersions.data?.at(-1);

  const [schemaVersion, setSchemaVersion] = useState(String((activeSchema?.version ?? 0) + 1));
  const [schemaJson, setSchemaJson] = useState(
    activeSchema
      ? JSON.stringify(activeSchema.document, null, 2)
      : '{\n  "type": "object",\n  "additionalProperties": false,\n  "required": ["name"],\n  "properties": {\n    "name": { "type": "string", "minLength": 1 }\n  }\n}',
  );
  const [documentId, setDocumentId] = useState("");
  const [documentJson, setDocumentJson] = useState('{\n  "name": "Draft item"\n}');
  const [schemaFieldName, setSchemaFieldName] = useState("heroImage");
  const [schemaFieldKind, setSchemaFieldKind] = useState<FileSchemaTemplateKind>("image");
  const [schemaFieldRequired, setSchemaFieldRequired] = useState(true);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const schemaCount = schemaVersions.data?.length ?? 0;

  const nextVersion = useMemo(() => {
    const requested = Number(schemaVersion);
    return Number.isInteger(requested) ? requested : (activeSchema?.version ?? 0) + 1;
  }, [activeSchema?.version, schemaVersion]);

  async function handleRegisterSchema(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config || saving || !Number.isInteger(nextVersion)) {
      return;
    }

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      await createDatabaseCollection(config, {
        name: contentType,
        metadata: {
          surface: "content-studio",
          kind: "content-type",
        },
      }).catch(() => undefined);

      const created = await createDatabaseSchema(config, {
        collection: contentType,
        version: nextVersion,
        document: JSON.parse(schemaJson) as Record<string, unknown>,
        activate: schemaCount === 0,
        metadata: {
          source: "content-type-editor",
        },
      });
      await schemaVersions.reload();
      setSchemaVersion(String(created.version + 1));
      setMessage(`Registered schema v${created.version} for ${contentType}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function handleActivate(version: number) {
    if (!config || saving) {
      return;
    }

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      await activateDatabaseSchemaVersion(config, {
        collection: contentType,
        version,
      });
      await schemaVersions.reload();
      setMessage(`Activated schema v${version} for ${contentType}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function handleInsertSampleDocument(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config || saving) {
      return;
    }

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      const inserted = await insertDatabaseDocument(config, {
        collection: contentType,
        id: documentId.trim(),
        data: JSON.parse(documentJson) as Record<string, unknown>,
      });
      setDocumentId("");
      setMessage(`Inserted ${inserted.id} into ${contentType}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  function handleInsertFileField() {
    try {
      const fieldName = schemaFieldName.trim();
      if (!fieldName) {
        throw new Error("A schema field name is required.");
      }

      const nextSchema = insertFileFieldIntoSchema({
        schemaJson,
        fieldName,
        kind: schemaFieldKind,
        required: schemaFieldRequired,
      });
      const nextDocument = insertFileReferenceIntoSampleDocument({
        documentJson,
        fieldName,
        kind: schemaFieldKind,
      });

      setSchemaJson(nextSchema);
      setDocumentJson(nextDocument);
      setError(undefined);
      setMessage(
        `Inserted ${schemaFieldKind} field "${fieldName}" and prepared a matching sample document.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setMessage(undefined);
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Collection editor</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 p-4">
          {message ? <ResourceNotice title="Done" description={message} /> : null}
          {error ? <ResourceNotice title="Action failed" description={error} /> : null}

          <form className="grid gap-3" onSubmit={handleRegisterSchema}>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <Input
                value={schemaVersion}
                onChange={(event) => setSchemaVersion(event.target.value)}
                inputMode="numeric"
                placeholder="schema version"
                aria-label="Schema version"
              />
              <Button type="submit" size="sm" disabled={saving || !Number.isInteger(nextVersion)}>
                <Save className="size-4" />
                Register schema
              </Button>
            </div>
            <div className="grid gap-3 rounded-md border bg-muted/20 p-3 lg:grid-cols-[minmax(0,1fr)_12rem_auto_auto]">
              <Input
                value={schemaFieldName}
                onChange={(event) => setSchemaFieldName(event.target.value)}
                placeholder="heroImage"
                aria-label="Schema field name"
              />
              <select
                value={schemaFieldKind}
                onChange={(event) => setSchemaFieldKind(event.target.value as FileSchemaTemplateKind)}
                className="h-10 rounded-md border bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <option value="image">Image</option>
                <option value="file">Generic file</option>
                <option value="document">Document</option>
                <option value="audio">Audio</option>
                <option value="video">Video</option>
              </select>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={schemaFieldRequired}
                  onChange={(event) => setSchemaFieldRequired(event.target.checked)}
                />
                Required
              </label>
              <Button type="button" size="sm" variant="outline" onClick={handleInsertFileField}>
                {schemaFieldKind === "image" ? <FileImage className="size-4" /> : null}
                {schemaFieldKind === "file" ? <Files className="size-4" /> : null}
                {schemaFieldKind === "document" ? <FileText className="size-4" /> : null}
                {schemaFieldKind === "audio" ? <Volume2 className="size-4" /> : null}
                {schemaFieldKind === "video" ? <Video className="size-4" /> : null}
                Insert File Field
              </Button>
            </div>
            <textarea
              value={schemaJson}
              onChange={(event) => setSchemaJson(event.target.value)}
              className="min-h-72 resize-y rounded-md border bg-background px-3 py-2 font-mono text-sm"
              spellCheck={false}
            />
          </form>
        </CardContent>
      </Card>

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Schema versions</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 p-4">
            {(schemaVersions.data ?? []).length > 0 ? (
              (schemaVersions.data ?? []).map((schema) => (
                <div key={`${schema.collection}:${schema.version}`} className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">v{schema.version}</p>
                      <p className="text-xs text-muted-foreground">
                        {schema.active ? "Active schema" : "Inactive schema"}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={schema.active || saving}
                      onClick={() => void handleActivate(schema.version)}
                    >
                      Activate
                    </Button>
                  </div>
                </div>
              ))
            ) : (
              <ResourceNotice
                title="No schemas yet"
                description="Register the first schema version."
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sample document</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 p-4">
            <form className="grid gap-3" onSubmit={handleInsertSampleDocument}>
              <Input
                value={documentId}
                onChange={(event) => setDocumentId(event.target.value)}
                placeholder="optional document id"
                aria-label="Sample document id"
              />
              <textarea
                value={documentJson}
                onChange={(event) => setDocumentJson(event.target.value)}
                className="min-h-56 resize-y rounded-md border bg-background px-3 py-2 font-mono text-sm"
                spellCheck={false}
              />
              <Button type="submit" size="sm" disabled={saving}>
                Insert sample document
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
