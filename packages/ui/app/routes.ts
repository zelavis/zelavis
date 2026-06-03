import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/index.tsx"),
  route("agents", "routes/agents.tsx"),
  route("auth", "routes/auth.tsx"),
  route("builder", "routes/builder.tsx"),
  route("builder/pages", "routes/builder.pages.tsx"),
  route("commerce", "routes/commerce.tsx", [
    route("products", "routes/commerce.products.tsx"),
    route("orders", "routes/commerce.orders.tsx"),
    route("customers", "routes/commerce.customers.tsx"),
    route("coupons", "routes/commerce.coupons.tsx"),
  ]),
  route("content", "routes/content.tsx", [
    route("new", "routes/content.new.tsx"),
    route(":contentType", "routes/content.$contentType.tsx", [
      index("routes/content.$contentType.index.tsx"),
      route("fields", "routes/content.$contentType.fields.tsx"),
      route("edit", "routes/content.$contentType.edit.tsx"),
      route("settings", "routes/content.$contentType.settings.tsx"),
      route(":entryId", "routes/content.$contentType.$entryId.tsx"),
    ]),
  ]),
  route("database", "routes/database.tsx"),
  route("database/new", "routes/database.new.tsx"),
  route("marketplace", "routes/marketplace.tsx"),
  route("media", "routes/media.tsx"),
  route("services", "routes/services.tsx"),
  route("settings", "routes/settings.tsx", [
    route("appearance", "routes/settings.appearance.tsx"),
  ]),
  route("storage", "routes/storage.tsx"),
  route("users", "routes/users.tsx"),
  route("_api/relations/:collection", "routes/api.relations.$collection.tsx"),
  route("*", "routes/$.tsx"),
] satisfies RouteConfig;
