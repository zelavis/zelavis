import { Link, Outlet, useLoaderData, useLocation } from "react-router";

import {
  DataRow,
  ResourceNotice,
  StatusBadge,
} from "#/components/DashboardPage";
import { ServicePageMount } from "#/components/ServicePageMount";
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
import { matchesProjectPath, toProjectPath } from "#/lib/routing";
export const handle = {
  pageLabel: "Commerce",
  sidebarTrail: ["Extensions", "Ecommerce"],
} as const;

export async function clientLoader() {
  const runtime = await getRuntimeConfig();
  const [products, orders, customers, coupons, providers, paymentAttempts] = await Promise.all([
    listCommerceProducts(runtime).catch(() => [] as Awaited<ReturnType<typeof listCommerceProducts>>),
    listCommerceOrders(runtime).catch(() => [] as Awaited<ReturnType<typeof listCommerceOrders>>),
    listCommerceCustomers(runtime).catch(() => [] as Awaited<ReturnType<typeof listCommerceCustomers>>),
    listCommerceCoupons(runtime).catch(() => [] as Awaited<ReturnType<typeof listCommerceCoupons>>),
    listCommerceProviders(runtime).catch(() => [] as Awaited<ReturnType<typeof listCommerceProviders>>),
    listCommercePaymentAttempts(runtime).catch(() => [] as Awaited<ReturnType<typeof listCommercePaymentAttempts>>),
  ]);
  return { products, orders, customers, coupons, providers, paymentAttempts };
}

function Commerce() {
  const pathname = useLocation().pathname;
  const { products, orders, customers, coupons, providers, paymentAttempts } = useLoaderData<typeof clientLoader>();

  if (!matchesProjectPath(pathname, "/commerce")) {
    return <Outlet />;
  }

  return (
    <ServicePageMount fallback={
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Collections</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <DataRow
              label="Products"
              detail={`${products.length} items`}
              meta={<Link to={toProjectPath("/commerce/products")} className="text-sm text-primary">Open</Link>}
            />
            <DataRow
              label="Orders"
              detail={`${orders.length} orders`}
              meta={<Link to={toProjectPath("/commerce/orders")} className="text-sm text-primary">Open</Link>}
            />
            <DataRow
              label="Customers"
              detail={`${customers.length} records`}
              meta={<Link to={toProjectPath("/commerce/customers")} className="text-sm text-primary">Open</Link>}
            />
            <DataRow
              label="Coupons"
              detail={`${coupons.length} codes`}
              meta={<Link to={toProjectPath("/commerce/coupons")} className="text-sm text-primary">Open</Link>}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payments</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <DataRow
              label="Child services"
              detail={`${providers.length} payment providers`}
              meta={
                <StatusBadge
                  state={providers.length > 0 ? "ready" : "planned"}
                />
              }
            />
            <DataRow
              label="Attempts"
              detail={`${paymentAttempts.length} payment attempts`}
            />
            {providers.map((provider) => (
              <DataRow
                key={provider.name}
                label={provider.name}
                detail={provider.parentService}
                meta={<StatusBadge state={provider.childService ? "ready" : "planned"} />}
              />
            ))}
          </CardContent>
        </Card>
      </div>
    </section>
  } />
  );
}

export default Commerce;
