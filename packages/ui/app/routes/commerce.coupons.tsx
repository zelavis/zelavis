import { useLoaderData, useRevalidator, useRouteLoaderData } from "react-router";
import { useState } from "react";
import type { FormEvent } from "react";

import { ResourceNotice } from "#/components/DashboardPage";
import { ServicePageMount } from "#/components/ServicePageMount";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import {
  createCommerceCoupon,
  getActiveRuntimeConfig,
  listCommerceCoupons,
} from "#/lib/runtime-api";
import type { clientLoader as rootClientLoader } from "../root";
import type { Route } from "./+types/commerce.coupons";

export const handle = {
  pageLabel: "Commerce",
  sidebarTrail: ["Extensions", "Ecommerce", "More"],
} as const;

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const runtime = await getActiveRuntimeConfig(request);
  const coupons = await listCommerceCoupons(runtime).catch(() => [] as Awaited<ReturnType<typeof listCommerceCoupons>>);
  return { coupons };
}

function CommerceCoupons() {
  const { coupons } = useLoaderData<typeof clientLoader>();
  const { runtime } = useRouteLoaderData<typeof rootClientLoader>("root")!;
  const revalidator = useRevalidator();
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [discountType, setDiscountType] = useState<"percentage" | "fixed">("percentage");
  const [discountValue, setDiscountValue] = useState("10");
  const [active, setActive] = useState(true);
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
      const created = await createCommerceCoupon(runtime, {
        code,
        description: description || undefined,
        discountType,
        discountValue: Number(discountValue),
        active,
      });
      setCode("");
      setDescription("");
      setDiscountType("percentage");
      setDiscountValue("10");
      setActive(true);
      setMessage(`Created coupon ${created.code}.`);
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
            <CardTitle>Coupon codes</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {coupons.length > 0 ? (
              <div className="overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">Code</th>
                      <th className="px-4 py-3">Rule</th>
                      <th className="px-4 py-3">State</th>
                      <th className="px-4 py-3">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {coupons.map((coupon) => (
                      <tr key={coupon.code} className="border-t">
                        <td className="px-4 py-3 font-mono text-sm font-medium text-foreground">
                          {coupon.code}
                        </td>
                        <td className="px-4 py-3">
                          {coupon.discountType === "percentage"
                            ? `${coupon.discountValue}% off`
                            : `${coupon.discountValue} off`}
                        </td>
                        <td className="px-4 py-3">{coupon.active ? "Active" : "Inactive"}</td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {new Date(coupon.updatedAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-4">
                <ResourceNotice title="No coupons yet" description="Create the first coupon." />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>New coupon</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="grid gap-3" onSubmit={(event) => void handleSubmit(event)}>
              <Input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="Code" />
              <Input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Description"
              />
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
                <select
                  value={discountType}
                  onChange={(event) => setDiscountType(event.target.value as "percentage" | "fixed")}
                  className="h-10 rounded-md border bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <option value="percentage">Percentage</option>
                  <option value="fixed">Fixed</option>
                </select>
                <Input
                  value={discountValue}
                  onChange={(event) => setDiscountValue(event.target.value)}
                  inputMode="decimal"
                  placeholder="Value"
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />
                Active
              </label>
              {message ? <p className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p> : null}
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <Button type="submit" disabled={saving || !code.trim()}>
                Create coupon
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </section>
  } />
  );
}

export default CommerceCoupons;
