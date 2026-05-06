import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowDownUp,
  CheckSquare,
  Copy,
  ExternalLink,
  Files,
  ImageIcon,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  PageHeader,
  ResourceNotice,
  StatCard,
  StatusBadge,
} from "#/components/DashboardPage";
import { Button } from "#/components/ui/button";
import { buttonVariants } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import {
  deleteStorageFile,
  getRuntimeConfig,
  getStorageFileMetadata,
  getStorageFileUrl,
  isRenderableImageFile,
  listStorageFiles,
  type StorageFile,
  uploadStorageFile,
} from "#/lib/runtime-api";
import { useRuntimeResource } from "#/lib/use-runtime-resource";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/media")({
  component: MediaRoute,
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

function inferLabel(file: StorageFile) {
  return (
    file.metadata?.label ||
    file.path.split("/").filter(Boolean).at(-1) ||
    file.path
  );
}

function reorderVisibleFiles(
  files: readonly StorageFile[],
  orderedPaths: readonly string[],
) {
  const rankedPaths = new Map(orderedPaths.map((path, index) => [path, index]));

  return [...files].sort((left, right) => {
    const leftRank = rankedPaths.get(left.path) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rankedPaths.get(right.path) ?? Number.MAX_SAFE_INTEGER;

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return left.path.localeCompare(right.path);
  });
}

function MediaRoute() {
  const runtime = useRuntimeResource(getRuntimeConfig);
  const config = runtime.data;
  const storageEnabled = config?.services.some((service) => service.name === "storage");
  const [prefix, setPrefix] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [labelFilter, setLabelFilter] = useState("");
  const [purposeFilter, setPurposeFilter] = useState("");
  const [uploadPath, setUploadPath] = useState("");
  const [uploadLabel, setUploadLabel] = useState("");
  const [uploadAltText, setUploadAltText] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | undefined>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number>();
  const [copyMessage, setCopyMessage] = useState<string>();
  const [isDragging, setIsDragging] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [orderedPaths, setOrderedPaths] = useState<string[]>([]);
  const [draggedAssetPath, setDraggedAssetPath] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const visibleFiles = filesResource.data?.files ?? [];
  const filteredFiles = useMemo(
    () =>
      visibleFiles.filter((file) => {
        const normalizedTypeFilter = typeFilter.trim().toLowerCase();
        const normalizedLabelFilter = labelFilter.trim().toLowerCase();
        const normalizedPurposeFilter = purposeFilter.trim().toLowerCase();
        const contentType = file.contentType?.toLowerCase() ?? "";
        const label = file.metadata?.label?.toLowerCase() ?? "";
        const purpose = file.metadata?.purpose?.toLowerCase() ?? "";

        return (
          (!normalizedTypeFilter || contentType.includes(normalizedTypeFilter)) &&
          (!normalizedLabelFilter || label.includes(normalizedLabelFilter)) &&
          (!normalizedPurposeFilter || purpose.includes(normalizedPurposeFilter))
        );
      }),
    [labelFilter, purposeFilter, typeFilter, visibleFiles],
  );
  const orderedFiles = useMemo(
    () => reorderVisibleFiles(filteredFiles, orderedPaths),
    [filteredFiles, orderedPaths],
  );
  const imageFiles = useMemo(
    () => filteredFiles.filter((file) => isRenderableImageFile(file)),
    [filteredFiles],
  );
  const selectedAsset = visibleFiles.find((file) => file.path === selectedPath);
  const selectedAssets = orderedFiles.filter((file) => selectedPaths.includes(file.path));

  useEffect(() => {
    setOrderedPaths((current) => {
      const visibleSet = new Set(filteredFiles.map((file) => file.path));
      const retained = current.filter((path) => visibleSet.has(path));
      const missing = filteredFiles
        .map((file) => file.path)
        .filter((path) => !retained.includes(path));
      return [...retained, ...missing];
    });
    setSelectedPaths((current) =>
      current.filter((path) => filteredFiles.some((file) => file.path === path)),
    );
  }, [filteredFiles]);

  async function handleUpload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!config || !storageEnabled || !selectedFile || busy) {
      return;
    }

    const path = uploadPath.trim() || selectedFile.name;
    if (!path) {
      setError("Media path is required.");
      return;
    }

    setBusy(true);
    setMessage(undefined);
    setError(undefined);
    setCopyMessage(undefined);

    try {
      const metadata = Object.fromEntries(
        Object.entries({
          label: uploadLabel.trim(),
          alt: uploadAltText.trim(),
          purpose: "media-gallery",
        }).filter(([, value]) => value.length > 0),
      );
      const created = await uploadStorageFile(config, {
        path,
        body: selectedFile,
        contentType: selectedFile.type || "application/octet-stream",
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        onProgress: ({ percent }) => setUploadProgress(percent),
      });

      await filesResource.reload();
      setSelectedPath(created.file.path);
      setSelectedPaths((current) =>
        current.includes(created.file.path) ? current : [...current, created.file.path],
      );
      setUploadPath("");
      setUploadLabel("");
      setUploadAltText("");
      setSelectedFile(undefined);
      setUploadProgress(undefined);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setMessage(`Added ${created.file.path} to the media gallery.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
      setUploadProgress(undefined);
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
      setCopyMessage("Copied media reference JSON.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function handleCopyUrl() {
    if (!config || !selectedAsset || typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }

    try {
      await navigator.clipboard.writeText(getStorageFileUrl(config, selectedAsset.path));
      setCopyMessage("Copied media URL.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function toggleSelectedPath(path: string) {
    setSelectedPaths((current) =>
      current.includes(path)
        ? current.filter((entry) => entry !== path)
        : [...current, path],
    );
  }

  async function handleCopySelectedUrls() {
    if (!config || selectedAssets.length === 0 || !navigator.clipboard) {
      return;
    }

    try {
      await navigator.clipboard.writeText(
        selectedAssets
          .map((file) => getStorageFileUrl(config, file.path))
          .join("\n"),
      );
      setCopyMessage(`Copied ${selectedAssets.length} media URLs.`);
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function handleCopySelectedReferences() {
    if (!config || selectedAssets.length === 0 || !navigator.clipboard) {
      return;
    }

    try {
      const references = await Promise.all(
        selectedAssets.map(async (file) => {
          const metadata = await getStorageFileMetadata(config, file.path);
          return metadata.reference;
        }),
      );
      await navigator.clipboard.writeText(JSON.stringify(references, null, 2));
      setCopyMessage(`Copied ${selectedAssets.length} media references.`);
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function handleDeleteSelected() {
    if (!config || selectedAssets.length === 0 || busy) {
      return;
    }

    setBusy(true);
    setMessage(undefined);
    setError(undefined);
    setCopyMessage(undefined);

    try {
      await Promise.all(selectedAssets.map((file) => deleteStorageFile(config, file.path)));
      await filesResource.reload();
      if (selectedPath && selectedPaths.includes(selectedPath)) {
        setSelectedPath(undefined);
      }
      setSelectedPaths([]);
      setMessage(`Deleted ${selectedAssets.length} selected media item(s).`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  function moveDraggedAsset(beforePath: string) {
    if (!draggedAssetPath || draggedAssetPath === beforePath) {
      return;
    }

    setOrderedPaths((current) => {
      const next = current.filter((path) => path !== draggedAssetPath);
      const targetIndex = next.indexOf(beforePath);
      if (targetIndex === -1) {
        return [...next, draggedAssetPath];
      }

      next.splice(targetIndex, 0, draggedAssetPath);
      return next;
    });
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Media"
        title="Media Gallery"
        description="Editor-facing asset management built on the same Zelavis storage core. Upload visuals, browse reusable files, and hand off structured references when the lower-level storage panel is needed."
        actions={
          <Link
            to="/storage"
            className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
          >
            Open Core Storage
          </Link>
        }
      />

      {!storageEnabled ? (
        <ResourceNotice
          title="Storage service is not mounted"
          description="Add platform file storage or enable the storage core service to use the media gallery."
        />
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Visible assets"
          value={String(visibleFiles.length)}
          detail="Files under the current gallery filters"
          icon={Files}
        />
        <StatCard
          label="Images"
          value={String(imageFiles.length)}
          detail="Renderable image assets ready for previews"
          icon={ImageIcon}
        />
        <StatCard
          label="Selected"
          value={String(selectedPaths.length)}
          detail="Bulk actions stay available for the current selection"
          icon={Upload}
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
                  <label className="text-sm font-medium text-foreground" htmlFor="media-prefix">
                    Gallery filter
                  </label>
                  <Input
                    id="media-prefix"
                    value={prefix}
                    onChange={(event) => setPrefix(event.target.value)}
                    placeholder="uploads/"
                    disabled={busy}
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="media-type-filter">
                    Type filter
                  </label>
                  <Input
                    id="media-type-filter"
                    value={typeFilter}
                    onChange={(event) => setTypeFilter(event.target.value)}
                    placeholder="image/"
                    disabled={busy}
                  />
                </div>
              </div>
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="media-path">
                    Media path
                  </label>
                  <Input
                    id="media-path"
                    value={uploadPath}
                    onChange={(event) => setUploadPath(event.target.value)}
                    placeholder={selectedFile?.name ?? "media/hero.jpg"}
                    disabled={busy}
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="media-label-filter">
                    Label filter
                  </label>
                  <Input
                    id="media-label-filter"
                    value={labelFilter}
                    onChange={(event) => setLabelFilter(event.target.value)}
                    placeholder="hero"
                    disabled={busy}
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="media-purpose-filter">
                    Purpose filter
                  </label>
                  <Input
                    id="media-purpose-filter"
                    value={purposeFilter}
                    onChange={(event) => setPurposeFilter(event.target.value)}
                    placeholder="gallery"
                    disabled={busy}
                  />
                </div>
              </div>
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="media-label">
                    Label
                  </label>
                  <Input
                    id="media-label"
                    value={uploadLabel}
                    onChange={(event) => setUploadLabel(event.target.value)}
                    placeholder="Homepage hero"
                    disabled={busy}
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="media-alt">
                    Alt text
                  </label>
                  <Input
                    id="media-alt"
                    value={uploadAltText}
                    onChange={(event) => setUploadAltText(event.target.value)}
                    placeholder="Product photo on a neutral background"
                    disabled={busy}
                  />
                </div>
              </div>
              <div
                className={[
                  "grid min-h-32 gap-3 rounded-md border border-dashed px-4 py-5 text-sm transition-colors",
                  isDragging ? "border-primary bg-primary/5" : "border-border bg-muted/20",
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
                    This keeps the editor flow lightweight while still writing into the storage core.
                  </p>
                </div>
                <Input
                  ref={fileInputRef}
                  id="media-file"
                  type="file"
                  onChange={(event) =>
                    handleDroppedFile(event.currentTarget.files?.[0] ?? undefined)
                  }
                  disabled={busy}
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  {selectedFile
                    ? `${selectedFile.name} · ${formatBytes(selectedFile.size)}`
                    : "Choose a file to add it to the gallery."}
                </p>
                <Button type="submit" disabled={busy || !selectedFile}>
                  {busy
                    ? uploadProgress !== undefined
                      ? `Uploading ${uploadProgress}%`
                      : "Working…"
                    : "Add media"}
                </Button>
              </div>
            </form>

            {message ? <ResourceNotice title="Done" description={message} /> : null}
            {error ? <ResourceNotice title="Action failed" description={error} /> : null}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/15 px-3 py-3">
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <ArrowDownUp className="size-4" />
                <span>Drag cards to reorder this browser view.</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setSelectedPaths(orderedFiles.map((file) => file.path))}
                  disabled={orderedFiles.length === 0}
                >
                  <CheckSquare className="size-4" />
                  Select All
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setSelectedPaths([])}
                  disabled={selectedPaths.length === 0}
                >
                  Clear
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleCopySelectedUrls}
                  disabled={selectedPaths.length === 0}
                >
                  <Copy className="size-4" />
                  Copy URLs
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleCopySelectedReferences}
                  disabled={selectedPaths.length === 0}
                >
                  <Copy className="size-4" />
                  Copy References
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleDeleteSelected}
                  disabled={selectedPaths.length === 0 || busy}
                >
                  <Trash2 className="size-4" />
                  Delete Selected
                </Button>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {orderedFiles.map((file) => {
                const assetUrl = config ? getStorageFileUrl(config, file.path) : undefined;
                const selected = selectedPath === file.path;
                const checked = selectedPaths.includes(file.path);

                return (
                  <div
                    key={file.path}
                    draggable
                    className={[
                      "grid overflow-hidden rounded-md border text-left transition-colors hover:border-primary/50 hover:bg-muted/15",
                      selected ? "border-primary/60 bg-muted/20" : "border-border",
                    ].join(" ")}
                    onDragStart={() => setDraggedAssetPath(file.path)}
                    onDragOver={(event) => {
                      event.preventDefault();
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      moveDraggedAsset(file.path);
                      setDraggedAssetPath(undefined);
                    }}
                    onDragEnd={() => setDraggedAssetPath(undefined)}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedPath(file.path)}
                      className="contents"
                    >
                    <div className="aspect-[4/3] overflow-hidden bg-muted/30">
                      {assetUrl && isRenderableImageFile(file) ? (
                        <img
                          src={assetUrl}
                          alt={file.metadata?.alt ?? inferLabel(file)}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-muted-foreground">
                          <Files className="size-8" />
                        </div>
                      )}
                    </div>
                    <div className="grid gap-2 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="line-clamp-1 text-sm font-medium text-foreground">
                          {inferLabel(file)}
                        </p>
                        <StatusBadge state={selected ? "ready" : "available"} />
                      </div>
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {file.metadata?.alt || file.path}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {[file.contentType ?? "application/octet-stream", formatBytes(file.size)].join(" · ")}
                      </p>
                    </div>
                    </button>
                    <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSelectedPath(file.path)}
                        />
                        Select
                      </label>
                      <span className="text-xs text-muted-foreground">Drag to reorder</span>
                    </div>
                  </div>
                );
              })}

              {!filesResource.loading && visibleFiles.length === 0 ? (
                <div className="sm:col-span-2 xl:col-span-3">
                  <ResourceNotice
                    title="No media yet"
                    description="Upload a file or clear the current filters to show more assets."
                  />
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Asset details</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 p-4">
            {selectedAsset && metadataResource.data ? (
              <>
                <ResourceNotice
                  title={inferLabel(selectedAsset)}
                  description={selectedAsset.path}
                />
                <div className="grid gap-2 rounded-md border bg-background p-4 text-sm text-muted-foreground">
                  <p>Content type: {selectedAsset.contentType ?? "Unknown"}</p>
                  <p>Size: {formatBytes(selectedAsset.size)}</p>
                  <p>Alt text: {selectedAsset.metadata?.alt ?? "Not set"}</p>
                  <p>Purpose: {selectedAsset.metadata?.purpose ?? "Not set"}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={handleCopyUrl}>
                    <Copy className="size-4" />
                    Copy URL
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={handleCopyReference}>
                    <Copy className="size-4" />
                    Copy Reference
                  </Button>
                  {config ? (
                    <a
                      href={getStorageFileUrl(config, selectedAsset.path)}
                      target="_blank"
                      rel="noreferrer"
                      className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
                    >
                      <ExternalLink className="size-4" />
                      Open File
                    </a>
                  ) : null}
                </div>
                <div className="grid gap-2 rounded-md border bg-background p-4">
                  <p className="text-sm font-medium text-foreground">Reference JSON</p>
                  <pre className="overflow-x-auto text-xs leading-6 text-muted-foreground">
                    {JSON.stringify(metadataResource.data.reference, null, 2)}
                  </pre>
                </div>
                {copyMessage ? (
                  <ResourceNotice title="Clipboard" description={copyMessage} />
                ) : null}
              </>
            ) : (
              <ResourceNotice
                title="Select media"
                description="Choose an asset to preview its reusable URL and Zelavis file reference."
              />
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
