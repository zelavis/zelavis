import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/projects.index.tsx"),
  route("assistant", "routes/assistant.tsx"),
  route("marketplace", "routes/marketplace.tsx"),
  route("projects", "routes/projects.tsx"),
  route("resources", "routes/resources.tsx"),
  route("security", "routes/security.tsx"),
  route("services", "routes/services.tsx"),
  route("server", "routes/server.tsx", [
    route("domains", "routes/server.domains.tsx"),
    route("backups", "routes/server.backups.tsx"),
    route("logs", "routes/server.logs.tsx"),
  ]),
  route("settings", "routes/settings.tsx", [
    route("appearance", "routes/settings.appearance.tsx"),
  ]),
  route("projects/:projectId", "routes/index.tsx"),
  route("projects/:projectId/agents", "routes/agents.tsx"),
  route("projects/:projectId/auth", "routes/auth.tsx"),
  route("projects/:projectId/commerce", "routes/commerce.tsx", [
    route("products", "routes/commerce.products.tsx"),
    route("orders", "routes/commerce.orders.tsx"),
    route("customers", "routes/commerce.customers.tsx"),
    route("coupons", "routes/commerce.coupons.tsx"),
  ]),
  route("projects/:projectId/content", "routes/content.tsx", [
    route("new", "routes/content.new.tsx"),
    route(":contentType", "routes/content.$contentType.tsx", [
      index("routes/content.$contentType.index.tsx"),
      route("fields", "routes/content.$contentType.fields.tsx"),
      route(":entryId", "routes/content.$contentType.$entryId.tsx"),
    ]),
  ]),
  route("projects/:projectId/database", "routes/database.tsx"),
  route("projects/:projectId/database/new", "routes/database.new.tsx"),
  route("projects/:projectId/media", "routes/media.tsx"),
  route("projects/:projectId/marketplace", "routes/project.marketplace.tsx"),
  route("projects/:projectId/settings", "routes/project.settings.tsx"),
  route("projects/:projectId/storage", "routes/storage.tsx"),
  route("projects/:projectId/users", "routes/users.tsx"),
  route("projects/:projectId/website", "routes/website.tsx"),
  route("projects/:projectId/:managedSection", "routes/project.managed.$managedSection.tsx"),
  route("_api/assistant", "routes/api.assistant.tsx"),
  route("_api/relations/:collection", "routes/api.relations.$collection.tsx"),
  route("*", "routes/$.tsx"),
] satisfies RouteConfig;
