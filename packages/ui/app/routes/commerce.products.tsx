import { useLoaderData, useRevalidator } from "react-router";
import { useState } from "react";
import type { FormEvent } from "react";

import { PageHeader, ResourceNotice } from "#/components/DashboardPage";
import { ServicePageMount } from "#/components/ServicePageMount";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import {
  createCommerceProduct,
  getRuntimeConfig,
  listCommerceProducts,
} from "#/lib/runtime-api";

export const handle = {
  pageLabel: "Commerce",
  sidebarTrail: ["Workspace", "Ecommerce"],
} as const;

export async function clientLoader() {
  const runtime = await getRuntimeConfig();
  const products = await listCommerceProducts(runtime).catch(() => [] as Awaited<ReturnType<typeof listCommerceProducts>>);
  return { products };
}

function formatMoney(amount: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(amount / 100);
}

function CommerceProducts() {
  const { products } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("5900");
  const [currency, setCurrency] = useState("USD");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) {
      return;
    }

    const runtime = await getRuntimeConfig();
    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      const created = await createCommerceProduct(runtime, {
        title,
        slug: slug || undefined,
        description: description || undefined,
        price: {
          amount: Number(amount),
          currency,
        },
      });
      setTitle("");
      setSlug("");
      setDescription("");
      setAmount("5900");
      setCurrency(created.price.currency);
      setMessage(`Created ${created.title}.`);
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
      <PageHeader eyebrow="Commerce" title="Products" />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.85fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Catalog</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {products.length > 0 ? (
              <div className="overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">Title</th>
                      <th className="px-4 py-3">Slug</th>
                      <th className="px-4 py-3">Price</th>
                      <th className="px-4 py-3">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((product) => (
                      <tr key={product.id} className="border-t">
                        <td className="px-4 py-3">
                          <div className="font-medium text-foreground">{product.title}</div>
                          {product.description ? (
                            <div className="text-xs text-muted-foreground">{product.description}</div>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                          {product.slug}
                        </td>
                        <td className="px-4 py-3">
                          {formatMoney(product.price.amount, product.price.currency)}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {new Date(product.updatedAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-4">
                <ResourceNotice title="No products yet" description="Create the first product." />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>New product</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="grid gap-3" onSubmit={(event) => void handleSubmit(event)}>
              <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" />
              <Input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="Slug (optional)" />
              <Input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Description"
              />
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
                <Input
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  inputMode="numeric"
                  placeholder="Amount in minor units"
                />
                <Input value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} placeholder="USD" />
              </div>
              {message ? <p className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p> : null}
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <Button type="submit" disabled={saving || !title.trim()}>
                Create product
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </section>
  } />
  );
}

export default CommerceProducts;
