import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { PageHeader, ResourceNotice } from "#/components/DashboardPage";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import {
  createWebsitePage,
  getRuntimeConfig,
  listWebsitePages,
} from "#/lib/runtime-api";
import { useRuntimeResource } from "#/lib/use-runtime-resource";

export const Route = createFileRoute("/builder/pages")({
  component: BuilderPages,
});

function BuilderPages() {
  const runtime = useRuntimeResource(getRuntimeConfig);
  const config = runtime.data;
  const pages = useRuntimeResource(
    async () => (config ? listWebsitePages(config) : undefined),
    [config],
  );
  const [title, setTitle] = useState("");
  const [path, setPath] = useState("");
  const [headline, setHeadline] = useState("");
  const [description, setDescription] = useState("");
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const hasHomePage = pages.data?.some((page) => page.path === "/") ?? false;

  async function handleCreatePage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!config || saving) {
      return;
    }

    setSaving(true);
    setMessage(undefined);
    setError(undefined);

    try {
      const created = await createWebsitePage(config, {
        title,
        path,
        headline: headline || undefined,
        description: description || undefined,
      });
      await pages.reload();
      setTitle("");
      setPath("");
      setHeadline("");
      setDescription("");
      setMessage(`Created ${created.title} at ${created.path}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mx-auto grid w-full max-w-3xl gap-6">
      <PageHeader
        eyebrow="Builder"
        title="Pages"
        description="Create public website pages. Creating the / page activates the public website, while /zelavis remains the admin dashboard."
      />

      <Card>
        <CardHeader>
          <CardTitle>Create page</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 p-4">
          {!hasHomePage ? (
            <ResourceNotice
              title="Website is not active yet"
              description="Create the home page at / to activate the public website. Until then, / redirects to /zelavis and other public routes return 404."
            />
          ) : null}

          <form className="grid gap-4" onSubmit={handleCreatePage}>
            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-foreground"
                htmlFor="page-title"
              >
                Title
              </label>
              <Input
                id="page-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={hasHomePage ? "About" : "Home"}
                disabled={saving}
              />
            </div>

            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-foreground"
                htmlFor="page-path"
              >
                Path
              </label>
              <Input
                id="page-path"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder={hasHomePage ? "/about" : "/"}
                disabled={saving}
              />
            </div>

            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-foreground"
                htmlFor="page-headline"
              >
                Headline
              </label>
              <Input
                id="page-headline"
                value={headline}
                onChange={(event) => setHeadline(event.target.value)}
                placeholder={
                  hasHomePage ? "About Zelavis" : "Welcome to Zelavis"
                }
                disabled={saving}
              />
            </div>

            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-foreground"
                htmlFor="page-description"
              >
                Description
              </label>
              <textarea
                id="page-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Tell visitors what this page is about."
                disabled={saving}
                className="min-h-28 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                Existing pages: {pages.data?.length ?? 0}
              </p>
              <Button type="submit" disabled={saving}>
                {saving ? "Creating…" : "Create page"}
              </Button>
            </div>
          </form>

          {message ? (
            <ResourceNotice title="Page created" description={message} />
          ) : null}
          {error ? (
            <ResourceNotice title="Action failed" description={error} />
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
