import { useLoaderData, useRevalidator, useRouteLoaderData } from "react-router";
import { useMemo, useState } from "react";
import type { FormEvent } from "react";

import { ResourceNotice } from "#/components/DashboardPage";
import { ServicePageMount } from "#/components/ServicePageMount";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import {
  createCommerceOrder,
  getActiveRuntimeConfig,
  listCommerceCustomers,
  listCommerceOrders,
  listCommerceProducts,
} from "#/lib/runtime-api";
import type { clientLoader as rootClientLoader } from "../root";
import type { Route } from "./+types/commerce.orders";

export const handle = {
  pageLabel: "Commerce",
  sidebarTrail: ["Extensions", "Ecommerce"],
} as const;

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const runtime = await getActiveRuntimeConfig(request);
  const [orders, customers, products] = await Promise.all([
    listCommerceOrders(runtime).catch(() => [] as Awaited<ReturnType<typeof listCommerceOrders>>),
    listCommerceCustomers(runtime).catch(() => [] as Awaited<ReturnType<typeof listCommerceCustomers>>),
    listCommerceProducts(runtime).catch(() => [] as Awaited<ReturnType<typeof listCommerceProducts>>),
  ]);
  return { orders, customers, products };
}

function formatMoney(amount: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(amount / 100);
}

function CommerceOrders() {
  const { orders, customers, products } = useLoaderData<typeof clientLoader>();
  const { runtime } = useRouteLoaderData<typeof rootClientLoader>("root")!;
  const revalidator = useRevalidator();
  const [customerId, setCustomerId] = useState("");
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [currency, setCurrency] = useState("USD");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const selectedProduct = useMemo(
    () => products.find((product) => product.id === productId),
    [productId, products],
  );
  const unitPrice = selectedProduct?.price.amount ?? 0;
  const computedQuantity = Math.max(1, Number(quantity || "1"));
  const computedSubtotal = unitPrice * computedQuantity;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving || !selectedProduct) {
      return;
    }

    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      const created = await createCommerceOrder(runtime, {
        customerId,
        items: [
          {
            productId: selectedProduct.id,
            quantity: computedQuantity,
            unitPrice: selectedProduct.price.amount,
          },
        ],
        totals: {
          subtotal: computedSubtotal,
          discountTotal: 0,
          taxTotal: 0,
          grandTotal: computedSubtotal,
          currency,
        },
      });
      setProductId("");
      setCustomerId("");
      setQuantity("1");
      setCurrency(selectedProduct.price.currency);
      setMessage(`Created draft order ${created.id}.`);
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
            <CardTitle>Orders</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {orders.length > 0 ? (
              <div className="overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">Order</th>
                      <th className="px-4 py-3">Customer</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Total</th>
                      <th className="px-4 py-3">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((order) => (
                      <tr key={order.id} className="border-t">
                        <td className="px-4 py-3 font-mono text-xs text-foreground">{order.id}</td>
                        <td className="px-4 py-3 text-muted-foreground">{order.customerId}</td>
                        <td className="px-4 py-3">{order.status}</td>
                        <td className="px-4 py-3">
                          {formatMoney(order.totals.grandTotal, order.totals.currency)}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {new Date(order.updatedAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-4">
                <ResourceNotice title="No orders yet" description="Create the first draft order." />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>New order</CardTitle>
          </CardHeader>
          <CardContent>
            {customers.length > 0 && products.length > 0 ? (
              <form className="grid gap-3" onSubmit={(event) => void handleSubmit(event)}>
                <select
                  value={customerId}
                  onChange={(event) => setCustomerId(event.target.value)}
                  className="h-10 rounded-md border bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <option value="">Customer</option>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.email}
                    </option>
                  ))}
                </select>
                <select
                  value={productId}
                  onChange={(event) => {
                    const nextProductId = event.target.value;
                    setProductId(nextProductId);
                    const nextProduct = products.find((product) => product.id === nextProductId);
                    if (nextProduct) {
                      setCurrency(nextProduct.price.currency);
                    }
                  }}
                  className="h-10 rounded-md border bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <option value="">Product</option>
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.title}
                    </option>
                  ))}
                </select>
                <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
                  <Input
                    value={quantity}
                    onChange={(event) => setQuantity(event.target.value)}
                    inputMode="numeric"
                    placeholder="Qty"
                  />
                  <Input value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} placeholder="USD" />
                </div>
                <div className="rounded-md border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                  {selectedProduct
                    ? `Draft total: ${formatMoney(computedSubtotal, currency)}`
                    : "Select a product to calculate totals."}
                </div>
                {message ? <p className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p> : null}
                {error ? <p className="text-sm text-destructive">{error}</p> : null}
                <Button
                  type="submit"
                  disabled={saving || !customerId || !productId || !Number.isFinite(computedSubtotal)}
                >
                  Create order
                </Button>
              </form>
            ) : (
              <ResourceNotice
                title="Need customers and products"
                description="Create at least one customer and one product before creating orders."
              />
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  } />
  );
}

export default CommerceOrders;
