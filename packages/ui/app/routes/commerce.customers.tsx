import { useLoaderData, useRevalidator, useRouteLoaderData } from "react-router";
import { useState } from "react";
import type { FormEvent } from "react";

import { ResourceNotice } from "#/components/DashboardPage";
import { ServicePageMount } from "#/components/ServicePageMount";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import {
  createCommerceCustomer,
  getActiveRuntimeConfig,
  listCommerceCustomers,
} from "#/lib/runtime-api";
import type { clientLoader as rootClientLoader } from "../root";
import type { Route } from "./+types/commerce.customers";

export const handle = {
  pageLabel: "Commerce",
  sidebarTrail: ["Extensions", "Ecommerce", "More"],
} as const;

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const runtime = await getActiveRuntimeConfig(request);
  const customers = await listCommerceCustomers(runtime).catch(() => [] as Awaited<ReturnType<typeof listCommerceCustomers>>);
  return { customers };
}

function CommerceCustomers() {
  const { customers } = useLoaderData<typeof clientLoader>();
  const { runtime } = useRouteLoaderData<typeof rootClientLoader>("root")!;
  const revalidator = useRevalidator();
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [accountId, setAccountId] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) {
      return;
    }

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      const created = await createCommerceCustomer(runtime, {
        email,
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        accountId: accountId || undefined,
      });
      setEmail("");
      setFirstName("");
      setLastName("");
      setAccountId("");
      setMessage(`Created ${created.email}.`);
      revalidator.revalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ServicePageMount fallback={
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.85fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Customer records</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {customers.length > 0 ? (
              <div className="overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">Email</th>
                      <th className="px-4 py-3">Name</th>
                      <th className="px-4 py-3">Account</th>
                      <th className="px-4 py-3">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {customers.map((customer) => (
                      <tr key={customer.id} className="border-t">
                        <td className="px-4 py-3 font-medium text-foreground">{customer.email}</td>
                        <td className="px-4 py-3">
                          {[customer.firstName, customer.lastName].filter(Boolean).join(" ") || "—"}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                          {customer.accountId ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {new Date(customer.updatedAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-4">
                <ResourceNotice title="No customers yet" description="Create the first customer." />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>New customer</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="grid gap-3" onSubmit={(event) => void handleSubmit(event)}>
              <Input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" />
              <div className="grid gap-3 sm:grid-cols-2">
                <Input value={firstName} onChange={(event) => setFirstName(event.target.value)} placeholder="First name" />
                <Input value={lastName} onChange={(event) => setLastName(event.target.value)} placeholder="Last name" />
              </div>
              <Input value={accountId} onChange={(event) => setAccountId(event.target.value)} placeholder="Account ID (optional)" />
              {message ? <p className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p> : null}
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <Button type="submit" disabled={saving || !email.trim()}>
                Create customer
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </section>
  } />
  );
}

export default CommerceCustomers;
