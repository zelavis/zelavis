import { Link, Outlet, createFileRoute, useLocation } from "@tanstack/react-router";

import {
  DataRow,
  PageHeader,
  ResourceNotice,
  StatusBadge,
} from "#/components/DashboardPage";
import { PluginPageMount } from "#/components/PluginPageMount";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import {
  getRuntimeConfig,
  listCommerceCoupons,
  listCommerceCustomers,
  listCommerceOrders,
  listCommercePaymentAttempts,
  listCommerceProducts,
  listCommerceProviders,
} from "#/lib/runtime-api";
import { useRuntimeResource } from "#/lib/use-runtime-resource";

export const Route = createFileRoute("/commerce")({ component: Commerce });

function Commerce() {
  const pathname = useLocation({
    select: (location) => location.pathname,
  });
  const runtime = useRuntimeResource(getRuntimeConfig);
  const config = runtime.data;
  const products = useRuntimeResource(
    async () => (config ? listCommerceProducts(config) : []),
    [config],
  );
  const orders = useRuntimeResource(
    async () => (config ? listCommerceOrders(config) : []),
    [config],
  );
  const customers = useRuntimeResource(
    async () => (config ? listCommerceCustomers(config) : []),
    [config],
  );
  const coupons = useRuntimeResource(
    async () => (config ? listCommerceCoupons(config) : []),
    [config],
  );
  const providers = useRuntimeResource(
    async () => (config ? listCommerceProviders(config) : []),
    [config],
  );
  const paymentAttempts = useRuntimeResource(
    async () => (config ? listCommercePaymentAttempts(config) : []),
    [config],
  );

  if (pathname !== "/commerce") {
    return <Outlet />;
  }

  return (
    <PluginPageMount fallback={
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader eyebrow="Commerce" title="Ecommerce" />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Collections</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <DataRow
              label="Products"
              detail={`${products.data?.length ?? 0} items`}
              meta={<Link to="/commerce/products" className="text-sm text-primary">Open</Link>}
            />
            <DataRow
              label="Orders"
              detail={`${orders.data?.length ?? 0} orders`}
              meta={<Link to="/commerce/orders" className="text-sm text-primary">Open</Link>}
            />
            <DataRow
              label="Customers"
              detail={`${customers.data?.length ?? 0} records`}
              meta={<Link to="/commerce/customers" className="text-sm text-primary">Open</Link>}
            />
            <DataRow
              label="Coupons"
              detail={`${coupons.data?.length ?? 0} codes`}
              meta={<Link to="/commerce/coupons" className="text-sm text-primary">Open</Link>}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payments</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <DataRow
              label="Child plugins"
              detail={`${providers.data?.length ?? 0} payment providers`}
              meta={
                <StatusBadge
                  state={providers.data && providers.data.length > 0 ? "ready" : "planned"}
                />
              }
            />
            <DataRow
              label="Attempts"
              detail={`${paymentAttempts.data?.length ?? 0} payment attempts`}
            />
            {(providers.data ?? []).map((provider) => (
              <DataRow
                key={provider.name}
                label={provider.name}
                detail={`${provider.targetPlugin} · ${provider.extensionPoint}`}
                meta={<StatusBadge state={provider.childPlugin ? "ready" : "planned"} />}
              />
            ))}
            {providers.error ? (
              <div className="p-4">
                <ResourceNotice
                  title="Payments unavailable"
                  description={providers.error.message}
                />
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </section>
  } />
  );
}
