import { useLoaderData, useRevalidator, useRouteLoaderData } from "react-router";
import { Files, Trash2, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import {
  DataRow,
  PageHeader,
  ResourceNotice,
  StatCard,
  StatusBadge,
} from "#/components/DashboardPage";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import {
  createDatabaseCollection,
  deleteStorageFile,
  getRuntimeConfig,
  getStorageFileMetadata,
  insertDatabaseDocument,
  listStorageFiles,
  uploadStorageFile,
} from "#/lib/runtime-api";
import { parseAsString, useTypedSearchParams } from "#/lib/use-typed-search-params";
import type { clientLoader as rootClientLoader } from '../root';
import type { Route } from './+types/storage';

export const handle = {
  pageLabel: "Storage",
  sidebarTrail: ["Core"],
} as const;

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const runtime = await getRuntimeConfig();
  const storageEnabled = runtime.services.some((s) => s.name === "@zelavis/storage");
  const url = new URL(request.url);
  const prefix = url.searchParams.get('prefix') || undefined;
  const selectedPath = url.searchParams.get('path') || undefined;

  if (!storageEnabled) {
    return { files: undefined, metadata: undefined };
  }

  const [filesResult, metadata] = await Promise.all([
    listStorageFiles(runtime, prefix).catch(() => undefined),
    selectedPath ? getStorageFileMetadata(runtime, selectedPath).catch(() => undefined) : Promise.resolve(undefined),
  ]);

  return { files: filesResult, metadata };
}

function formatBytes(value: number | undefined): string {
  if (value === undefined) {
    return "Unknown";
  }

  if (value < 1024) {
    return `${value} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = -1;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

const storageSchema = {
  prefix: parseAsString,
  path: parseAsString,
} as const;

function StorageRoute() {
  const { files: filesResult, metadata } = useLoaderData<typeof clientLoader>();
  const { runtime: config } = useRouteLoaderData<typeof rootClientLoader>('root')!;
  const storageEnabled = config.services.some((service) => service.name === "@zelavis/storage");
  const [{ prefix, path: selectedPath }, setParams] = useTypedSearchParams(storageSchema);
  const setPrefix = (value: string) => setParams({ prefix: value || null });
  const setSelectedPath = (value: string | undefined) => setParams({ path: value ?? null });

  const [uploadPath, setUploadPath] = useState("");
  const [uploadLabel, setUploadLabel] = useState("");
  const [uploadAltText, setUploadAltText] = useState("");
  const [uploadPurpose, setUploadPurpose] = useState("");
  const [uploadCacheControl, setUploadCacheControl] = useState("");
  const [uploadContentDisposition, setUploadContentDisposition] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | undefined>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number>();
  const [isDragging, setIsDragging] = useState(false);
  const [copyMessage, setCopyMessage] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const revalidator = useRevalidator();
  const filesResource = { data: filesResult };
  const metadataResource = { data: metadata };

  const fileCount = filesResource.data?.files.length ?? 0;
  const databaseEnabled = config.services.some((service) => service.name === "@zelavis/db");
  const totalSize = useMemo(
    () =>
      (filesResource.data?.files ?? []).reduce(
        (sum, file) => sum + (file.size ?? 0),
        0,
      ),
    [filesResource.data],
  );

  async function handleUpload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!storageEnabled || !selectedFile || busy) {
      return;
    }

    const path = uploadPath.trim() || selectedFile.name;
    if (!path) {
      setError("Storage path is required.");
      return;
    }

    setBusy(true);
    setMessage(undefined);
    setError(undefined);

    try {
      const metadata =
        Object.fromEntries(
          Object.entries({
            label: uploadLabel.trim(),
            alt: uploadAltText.trim(),
            purpose: uploadPurpose.trim(),
          }).filter(([, value]) => value.length > 0),
        );
      const created = await uploadStorageFile(config, {
        path,
        body: selectedFile,
        contentType: selectedFile.type || "application/octet-stream",
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        cacheControl: uploadCacheControl.trim() || undefined,
        contentDisposition: uploadContentDisposition.trim() || undefined,
        onProgress: ({ percent }) => setUploadProgress(percent),
      });

      revalidator.revalidate();
      setSelectedPath(created.file.path);
      setUploadPath("");
      setUploadLabel("");
      setUploadAltText("");
      setUploadPurpose("");
      setUploadCacheControl("");
      setUploadContentDisposition("");
      setSelectedFile(undefined);
      setUploadProgress(undefined);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setMessage(`Uploaded ${created.file.path}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
      setUploadProgress(undefined);
    }
  }

  async function handleDelete(path: string) {
    if (!storageEnabled || busy) {
      return;
    }

    setBusy(true);
    setMessage(undefined);
    setError(undefined);

    try {
      await deleteStorageFile(config, path);
      revalidator.revalidate();
      if (selectedPath === path) {
        setSelectedPath(undefined);
      }
      setMessage(`Deleted ${path}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleInsertSampleDocument() {
    const reference = metadataResource.data?.reference;
    if (!databaseEnabled || !reference || busy) {
      return;
    }

    setBusy(true);
    setMessage(undefined);
    setError(undefined);
    setCopyMessage(undefined);

    try {
      try {
        await createDatabaseCollection(config, {
          name: "storage_assets",
          metadata: {
            createdBy: "zelavis-dashboard",
          },
        });
      } catch (caught) {
        const message =
          caught instanceof Error ? caught.message : String(caught);
        if (!message.toLowerCase().includes("already")) {
          throw caught;
        }
      }

      const title =
        reference.metadata?.label ||
        reference.path.split("/").filter(Boolean).at(-1) ||
        reference.path;

      const document = await insertDatabaseDocument(config, {
        collection: "storage_assets",
        data: {
          title,
          kind: "asset",
          file: reference,
        },
      });

      setMessage(`Inserted sample document ${document.id} into storage_assets.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  function handleDroppedFile(file: File | undefined) {
    if (!file || busy) {
      return;
    }

    setSelectedFile(file);
    if (!uploadPath.trim()) {
      setUploadPath(file.name);
    }
    setIsDragging(false);
  }

  async function handleCopyReference() {
    const reference = metadataResource.data?.reference;
    if (!reference || typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }

    try {
      await navigator.clipboard.writeText(JSON.stringify(reference, null, 2));
      setCopyMessage("Copied file reference JSON.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Core"
        title="Storage"
        description="Platform-backed file storage exposed through Zelavis. Upload files, inspect checksums, and keep references ready for later database document linking."
      />

      {!storageEnabled ? (
        <ResourceNotice
          title="Storage service is not mounted"
          description="Add platform file storage or enable a storage core service to use this panel."
        />
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Files"
          value={String(fileCount)}
          detail="Currently visible under this prefix"
          icon={Files}
        />
        <StatCard
          label="Total size"
          value={formatBytes(totalSize)}
          detail="Sum of the visible files"
          icon={Upload}
        />
        <StatCard
          label="Metadata"
          value={selectedPath ? "Ready" : "Select file"}
          detail="Checksums and file references are available per file"
          icon={Files}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.95fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Upload and browse</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 p-4">
            <form className="grid gap-4" onSubmit={handleUpload}>
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="storage-prefix">
                    Prefix filter
                  </label>
                  <Input
                    id="storage-prefix"
                    value={prefix}
                    onChange={(event) => setPrefix(event.target.value)}
                    placeholder="uploads/"
                    disabled={busy}
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="storage-path">
                    Upload path
                  </label>
                  <Input
                    id="storage-path"
                    value={uploadPath}
                    onChange={(event) => setUploadPath(event.target.value)}
                    placeholder={selectedFile?.name ?? "uploads/hello.txt"}
                    disabled={busy}
                  />
                </div>
              </div>

              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="storage-file">
                    File
                  </label>
                  <div
                    className={[
                      "grid min-h-32 gap-3 rounded-md border border-dashed px-4 py-5 text-sm transition-colors",
                      isDragging
                        ? "border-primary bg-primary/5"
                        : "border-border bg-muted/20",
                    ].join(" ")}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setIsDragging(true);
                    }}
                    onDragLeave={(event) => {
                      event.preventDefault();
                      setIsDragging(false);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      handleDroppedFile(event.dataTransfer.files?.[0]);
                    }}
                  >
                    <div className="grid gap-1">
                      <p className="font-medium text-foreground">
                        Drag a file here or choose one from disk
                      </p>
                      <p className="text-muted-foreground">
                        The upload path stays editable, so you can drop a file and still move it under a prefix like <code>uploads/</code>.
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <Input
                        ref={fileInputRef}
                        id="storage-file"
                        type="file"
                        onChange={(event) =>
                          handleDroppedFile(event.currentTarget.files?.[0] ?? undefined)
                        }
                        disabled={busy}
                      />
                    </div>
                  </div>
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="storage-label">
                    Label metadata
                  </label>
                  <Input
                    id="storage-label"
                    value={uploadLabel}
                    onChange={(event) => setUploadLabel(event.target.value)}
                    placeholder="Hero image"
                    disabled={busy}
                  />
                </div>
              </div>
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="storage-alt">
                    Alt text metadata
                  </label>
                  <Input
                    id="storage-alt"
                    value={uploadAltText}
                    onChange={(event) => setUploadAltText(event.target.value)}
                    placeholder="Product hero shot on white background"
                    disabled={busy}
                  />
                </div>
              </div>
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="storage-purpose">
                    Purpose metadata
                  </label>
                  <Input
                    id="storage-purpose"
                    value={uploadPurpose}
                    onChange={(event) => setUploadPurpose(event.target.value)}
                    placeholder="product-gallery"
                    disabled={busy}
                  />
                </div>
                <div className="grid gap-2">
                  <label
                    className="text-sm font-medium text-foreground"
                    htmlFor="storage-cache-control"
                  >
                    Cache-Control
                  </label>
                  <Input
                    id="storage-cache-control"
                    value={uploadCacheControl}
                    onChange={(event) => setUploadCacheControl(event.target.value)}
                    placeholder="public, max-age=31536000, immutable"
                    disabled={busy}
                  />
                </div>
              </div>
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div className="grid gap-2">
                  <label
                    className="text-sm font-medium text-foreground"
                    htmlFor="storage-content-disposition"
                  >
                    Content-Disposition
                  </label>
                  <Input
                    id="storage-content-disposition"
                    value={uploadContentDisposition}
                    onChange={(event) => setUploadContentDisposition(event.target.value)}
                    placeholder={'inline; filename="hero.jpg"'}
                    disabled={busy}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  {selectedFile
                    ? `${selectedFile.name} · ${formatBytes(selectedFile.size)}`
                    : "Choose a file to upload into the mounted storage service."}
                </p>
                <Button type="submit" disabled={busy || !selectedFile}>
                  {busy
                    ? uploadProgress !== undefined
                      ? `Uploading ${uploadProgress}%`
                      : "Working…"
                    : "Upload file"}
                </Button>
              </div>
              {busy && uploadProgress !== undefined ? (
                <div className="grid gap-2">
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-primary transition-[width]"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Uploading to the mounted storage service.
                  </p>
                </div>
              ) : null}
            </form>

            {message ? (
              <ResourceNotice title="Done" description={message} />
            ) : null}
            {error ? (
              <ResourceNotice title="Action failed" description={error} />
            ) : null}

            <div className="rounded-md border">
              {(filesResource.data?.files ?? []).map((file) => (
                <DataRow
                  key={file.path}
                  label={file.path}
                  detail={[
                    file.contentType ?? "application/octet-stream",
                    formatBytes(file.size),
                    file.updatedAt
                      ? new Date(file.updatedAt).toLocaleString()
                      : "timestamp unavailable",
                  ].join(" · ")}
                  className={selectedPath === file.path ? "bg-muted/35" : undefined}
                  meta={
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setSelectedPath(file.path)}
                      >
                        Inspect
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleDelete(file.path)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  }
                />
              ))}

              {fileCount === 0 ? (
                <div className="p-4">
                  <ResourceNotice
                    title="No files yet"
                    description="Upload a file or clear the prefix filter to see more results."
                  />
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>File details</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 p-4">
            {selectedPath && metadataResource.data ? (
              <>
                <ResourceNotice
                  title={metadataResource.data.file.path}
                  description={metadataResource.data.reference.href}
                />

                <div className="grid gap-3 rounded-md border bg-muted/25 p-4 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Checksum</span>
                    <StatusBadge
                      state={metadataResource.data.file.checksum ? "ready" : "planned"}
                    />
                  </div>
                  <p className="font-mono text-xs leading-6 text-foreground">
                    {metadataResource.data.file.checksum ?? "Unavailable"}
                  </p>
                  <div className="grid gap-2 text-sm text-muted-foreground">
                    <p>Content type: {metadataResource.data.file.contentType ?? "Unknown"}</p>
                    <p>Size: {formatBytes(metadataResource.data.file.size)}</p>
                    <p>
                      Cache-Control: {metadataResource.data.file.cacheControl ?? "Not set"}
                    </p>
                    <p>
                      Content-Disposition:{" "}
                      {metadataResource.data.file.contentDisposition ?? "Not set"}
                    </p>
                    <p>
                      Metadata path: {metadataResource.data.reference.metadataHref}
                    </p>
                  </div>
                </div>

                <div className="grid gap-2 rounded-md border bg-background p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-foreground">Reference JSON</p>
                    <div className="flex flex-wrap items-center gap-2">
                      {databaseEnabled ? (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleInsertSampleDocument}
                        >
                          Insert sample document
                        </Button>
                      ) : null}
                      <Button type="button" variant="outline" onClick={handleCopyReference}>
                        Copy JSON
                      </Button>
                    </div>
                  </div>
                  <pre className="overflow-x-auto text-xs leading-6 text-muted-foreground">
                    {JSON.stringify(metadataResource.data.reference, null, 2)}
                  </pre>
                </div>

                <div className="grid gap-2 rounded-md border bg-background p-4">
                  <p className="text-sm font-medium text-foreground">Metadata</p>
                  <pre className="overflow-x-auto text-xs leading-6 text-muted-foreground">
                    {JSON.stringify(metadataResource.data.file.metadata ?? {}, null, 2)}
                  </pre>
                </div>
                {copyMessage ? (
                  <ResourceNotice title="Clipboard" description={copyMessage} />
                ) : null}
              </>
            ) : (
              <ResourceNotice
                title="Select a file"
                description="Choose a file from the list to inspect checksum, metadata, and its ready-to-use Zelavis file reference."
              />
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

export default StorageRoute;
