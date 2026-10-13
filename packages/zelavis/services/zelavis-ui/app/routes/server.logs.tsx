import { ReceiptText } from "lucide-react";
import { Form, Link, useLoaderData, useRevalidator } from "react-router";

import { ResourceNotice } from "#/components/DashboardPage";
import { Button, buttonVariants } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { getActiveRuntimeConfig, readPlatformLogs } from "#/lib/runtime-api";
import type { Route } from "./+types/server.logs";

export const handle = {
  pageLabel: "Logs",
  sidebarTrail: ["Server"],
} as const;

const LEVELS = ["debug", "info", "warn", "error"] as const;

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const runtime = await getActiveRuntimeConfig(request);
  const url = new URL(request.url);
  const level = url.searchParams.get("level") ?? "";
  const correlationId = url.searchParams.get("ref")?.trim() ?? "";
  const filter = {
    level: LEVELS.includes(level as (typeof LEVELS)[number]) ? level : "",
    ref: /^[0-9a-f]{1,64}$/.test(correlationId) ? correlationId : "",
  };
  const page = await readPlatformLogs(runtime, { level: filter.level, correlationId: filter.ref, limit: 300 });
  return { page, filter, invalidRef: correlationId !== "" && filter.ref === "" };
}

const tone = { error: "text-destructive", warn: "text-amber-600 dark:text-amber-400", info: "", debug: "text-muted-foreground" } as const;

export default function ServerLogsRoute() {
  const { page, filter, invalidRef } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  // Newest first reads best on screen; the API returns newest last.
  const entries = [...page.entries].reverse();
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-4">
      <ResourceNotice
        title="Platform log"
        description="What this Platform recorded about itself since it started, newest first. It is kept in memory and emptied by a restart; the service journal keeps the same error lines. Paste the reference from an “Action failed” message to see the cause behind it."
      />
      <Form method="get" className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">
          Reference
          <Input name="ref" defaultValue={filter.ref} placeholder="8ad2ea39082e4cf6" className="w-56 font-mono" aria-invalid={invalidRef} />
        </label>
        <label className="grid gap-1 text-sm">
          Level
          <select name="level" defaultValue={filter.level} className="h-9 rounded-md border bg-background px-2 text-sm">
            <option value="">All levels</option>
            {LEVELS.map((level) => <option key={level} value={level}>{level} and above</option>)}
          </select>
        </label>
        <Button type="submit">Filter</Button>
        {filter.ref || filter.level ? <Link to="/server/logs" className={buttonVariants({ variant: "outline" })}>Clear</Link> : null}
        <Button type="button" variant="outline" onClick={() => revalidator.revalidate()} disabled={revalidator.state === "loading"}>Refresh</Button>
      </Form>
      {invalidRef ? <p className="text-sm text-destructive">A reference is the hexadecimal code shown with the error.</p> : null}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ReceiptText className="size-4" />
            {entries.length} {entries.length === 1 ? "entry" : "entries"}{page.truncated ? " (older entries were dropped)" : ""}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {entries.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Nothing recorded{filter.ref || filter.level ? " for this filter" : " yet"}. Unexpected request failures appear here with their reference.</p>
          ) : (
            <ul className="divide-y">
              {entries.map((entry) => (
                <li key={entry.sequence} className="grid gap-1 p-3 text-sm">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <time className="font-mono text-xs text-muted-foreground" dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time>
                    <span className={`font-mono text-xs uppercase ${tone[entry.level]}`}>{entry.level}</span>
                    <span className="text-xs text-muted-foreground">{entry.source}</span>
                    {entry.correlationId ? <Link to={`/server/logs?ref=${entry.correlationId}`} className="font-mono text-xs underline underline-offset-4">{entry.correlationId}</Link> : null}
                  </div>
                  <p className="break-words">{entry.message}</p>
                  {entry.detail ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{entry.detail}</pre> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
