import type * as React from "react";
import { useLoaderData, useRevalidator } from "react-router";
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
import type { Route } from './+types/builder.pages';

export const handle = {
  pageLabel: "Builder",
  sidebarTrail: ["Workspace", "Builder"],
} as const;

export async function clientLoader(_args: Route.ClientLoaderArgs) {
  const runtime = await getRuntimeConfig();
  const pages = await listWebsitePages(runtime).catch(() => [] as Awaited<ReturnType<typeof listWebsitePages>>);
  return { pages };
}

function BuilderPages() {
  const { pages } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const [title, setTitle] = useState("");
  const [path, setPath] = useState("");
  const [headline, setHeadline] = useState("");
  const [description, setDescription] = useState("");
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const hasHomePage = pages.some((page) => page.path === "/");

  async function handleCreatePage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (saving) {
      return;
    }

    const runtime = await getRuntimeConfig();
    setSaving(true);
    setMessage(undefined);
    setError(undefined);

    try {
      const created = await createWebsitePage(runtime, {
        title,
        path,
        headline: headline || undefined,
        description: description || undefined,
      });
      revalidator.revalidate();
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
                Existing pages: {pages.length}
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

export default BuilderPages;
