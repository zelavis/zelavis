import { createFileRoute } from "@tanstack/react-router";
import { Files, Trash2, Upload } from "lucide-react";
import { useMemo, useState } from "react";

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
  deleteStorageFile,
  getRuntimeConfig,
  getStorageFileMetadata,
  listStorageFiles,
  uploadStorageFile,
} from "#/lib/runtime-api";
import { useRuntimeResource } from "#/lib/use-runtime-resource";

export const Route = createFileRoute("/storage")({
  component: StorageRoute,
});

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

function StorageRoute() {
  const runtime = useRuntimeResource(getRuntimeConfig);
  const config = runtime.data;
  const storageEnabled = config?.services.some((service) => service.name === "storage");
  const [prefix, setPrefix] = useState("");
  const [uploadPath, setUploadPath] = useState("");
  const [uploadMetadata, setUploadMetadata] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | undefined>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const filesResource = useRuntimeResource(
    async () =>
      config && storageEnabled ? listStorageFiles(config, prefix || undefined) : undefined,
    [config, storageEnabled, prefix],
  );

  const metadataResource = useRuntimeResource(
    async () =>
      config && storageEnabled && selectedPath
        ? getStorageFileMetadata(config, selectedPath)
        : undefined,
    [config, storageEnabled, selectedPath],
  );

  const fileCount = filesResource.data?.files.length ?? 0;
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

    if (!config || !storageEnabled || !selectedFile || busy) {
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
        uploadMetadata.trim().length > 0
          ? { label: uploadMetadata.trim() }
          : undefined;
      const created = await uploadStorageFile(config, {
        path,
        body: selectedFile,
        contentType: selectedFile.type || "application/octet-stream",
        metadata,
      });

      await filesResource.reload();
      setSelectedPath(created.file.path);
      setUploadPath("");
      setUploadMetadata("");
      setSelectedFile(undefined);
      setMessage(`Uploaded ${created.file.path}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(path: string) {
    if (!config || !storageEnabled || busy) {
      return;
    }

    setBusy(true);
    setMessage(undefined);
    setError(undefined);

    try {
      await deleteStorageFile(config, path);
      await filesResource.reload();
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
                  <Input
                    id="storage-file"
                    type="file"
                    onChange={(event) =>
                      setSelectedFile(event.currentTarget.files?.[0] ?? undefined)
                    }
                    disabled={busy}
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="storage-label">
                    Label metadata
                  </label>
                  <Input
                    id="storage-label"
                    value={uploadMetadata}
                    onChange={(event) => setUploadMetadata(event.target.value)}
                    placeholder="Hero image"
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
                  {busy ? "Working…" : "Upload file"}
                </Button>
              </div>
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
                        size="sm"
                        onClick={() => setSelectedPath(file.path)}
                      >
                        Inspect
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleDelete(file.path)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  }
                />
              ))}

              {!filesResource.loading && fileCount === 0 ? (
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
                      Metadata path: {metadataResource.data.reference.metadataHref}
                    </p>
                  </div>
                </div>

                <div className="grid gap-2 rounded-md border bg-background p-4">
                  <p className="text-sm font-medium text-foreground">Metadata</p>
                  <pre className="overflow-x-auto text-xs leading-6 text-muted-foreground">
                    {JSON.stringify(metadataResource.data.file.metadata ?? {}, null, 2)}
                  </pre>
                </div>
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
