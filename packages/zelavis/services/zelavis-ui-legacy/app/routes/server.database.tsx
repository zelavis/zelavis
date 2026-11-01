import { Link, useLoaderData } from "react-router";
import { ResourceNotice } from "#/components/DashboardPage";
import { Card, CardContent } from "#/components/ui/card";
import { buttonVariants } from "#/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table";
import { getActiveRuntimeConfig, listSystemStoreNamespaces, listSystemStoreRecords } from "#/lib/runtime-api";
import type { Route } from "./+types/server.database";

export const handle = { pageLabel: "Platform Database", sidebarTrail: ["Server", "Database"] } as const;
export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const runtime = await getActiveRuntimeConfig(request);
  const url = new URL(request.url);
  const namespace = url.searchParams.get("namespace") || undefined;
  const after = url.searchParams.get("after") ?? undefined;
  const namespaces = await listSystemStoreNamespaces(runtime);
  const page = namespace ? await listSystemStoreRecords(runtime, namespace, after) : undefined;
  return { namespaces, namespace, page, after };
}
function tableUrl(namespace: string, after?: string) {
  const query = new URLSearchParams({ namespace });
  if (after !== undefined) query.set("after", after);
  return `/server/database?${query}`;
}
export default function PlatformDatabaseRoute() {
  const { namespaces, namespace, page, after } = useLoaderData<typeof clientLoader>();
  return <section className="mx-auto grid w-full max-w-7xl gap-4">
    <ResourceNotice title="Platform backend" description="Read-only System Store tables. Credentials and secrets are redacted. Project databases are managed inside each Project." />
    {namespace ? <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="font-medium">{namespace}</span>
        <Link to="/server/database" className={buttonVariants({ variant: "outline" })}>All tables</Link>
      </div>
      <Card><CardContent className="overflow-auto p-0">
        <Table aria-label={`${namespace} records`}><TableHeader><TableRow>
          <TableHead>Key</TableHead><TableHead>Value</TableHead><TableHead>Updated</TableHead>
        </TableRow></TableHeader><TableBody>
          {page?.records.map(record => <TableRow key={record.key}>
            <TableCell className="align-top font-mono">{record.key}</TableCell>
            <TableCell><pre className="max-w-xl whitespace-pre-wrap break-all text-xs">{JSON.stringify(record.value, null, 2)}</pre></TableCell>
            <TableCell className="align-top">{record.updatedAt}</TableCell>
          </TableRow>)}
          {!page?.records.length ? <TableRow><TableCell colSpan={3}>No records on this page.</TableCell></TableRow> : null}
        </TableBody></Table>
      </CardContent></Card>
      <div className="flex gap-2">
        {after !== undefined ? <Link to={tableUrl(namespace)} className={buttonVariants({ variant: "outline" })}>First page</Link> : null}
        {page?.next ? <Link to={tableUrl(namespace, page.next)} className={buttonVariants({ variant: "outline" })}>Next page</Link> : null}
      </div>
    </> : <Card><CardContent className="p-0">
      <Table aria-label="Platform backend tables"><TableHeader><TableRow><TableHead>Table</TableHead><TableHead>Records</TableHead></TableRow></TableHeader><TableBody>
        {namespaces.map(table => <TableRow key={table.namespace}>
          <TableCell><Link to={tableUrl(table.namespace)} className="underline underline-offset-4">{table.namespace}</Link></TableCell>
          <TableCell>{table.recordCount}</TableCell>
        </TableRow>)}
        {!namespaces.length ? <TableRow><TableCell colSpan={2}>No backend tables.</TableCell></TableRow> : null}
      </TableBody></Table>
    </CardContent></Card>}
  </section>;
}
