import { Effect, Schema } from "effect";
import { ApiError, request } from "./api.ts";
import { button, empty, message, node } from "./dom.ts";
import { dropdown } from "./dropdown.ts";
import { canAccess, projectDomainAccess } from "./navigation-menu.ts";
import { badge, card, page } from "./page-kit.ts";
import { projectContext } from "./project-context.ts";
import type { ScreenContext } from "./screens.ts";

const Domain = Schema.Struct({
  hostname: Schema.String,
  tlsMode: Schema.Literals(["external", "managed"]),
  state: Schema.Literals(["pending_dns", "verified", "publishing", "active", "removing"]),
  revision: Schema.Natural,
  publicUrl: Schema.optionalKey(Schema.String),
  challenge: Schema.optionalKey(Schema.Struct({ name: Schema.String, value: Schema.String, expiresAt: Schema.String })),
  issue: Schema.optionalKey(Schema.Literals(["dns_pending", "dns_unavailable", "edge_unavailable", "certificate_pending", "publication_pending"])),
});
const decodeInventory = (value: unknown) => Schema.decodeUnknownEffect(Schema.Struct({ domains: Schema.Array(Domain) }))(value).pipe(
  Effect.mapError(() => new ApiError({ message: "The Project domain inventory could not be read." })));

const decodeDomain = Schema.decodeUnknownEffect(Domain);
const decodeRemoval = Schema.decodeUnknownEffect(Schema.Struct({ removed: Schema.Boolean, pending: Schema.Boolean }));
const labels = {
  pending_dns: "Awaiting DNS proof", verified: "DNS verified", publishing: "Publishing", active: "Active", removing: "Withdrawing",
};
const issues = {
  dns_pending: "Create the TXT record, then verify.",
  dns_unavailable: "DNS verification is temporarily unavailable.",
  edge_unavailable: "Ingress for this TLS mode is unavailable. Ask the server operator to configure it.",
  certificate_pending: "HTTPS issuance is pending. Check that DNS points at the ingress before retrying.",
  publication_pending: "Waiting for ingress to confirm the change.",
};

export const projectDomainPath = (context: ScreenContext, projectId: string) =>
  `${context.config.api.basePath}/runtime/projects/${encodeURIComponent(projectId)}/domains`;
export const readProjectDomains = (context: ScreenContext, projectId: string) =>
  request(projectDomainPath(context, projectId)).pipe(Effect.flatMap(decodeInventory));

export function activeProjectDomainUrl(domain: typeof Domain.Type): string | undefined {
  return domain.state === "active" && domain.publicUrl === `https://${domain.hostname}/` ? domain.publicUrl : undefined;
}

export const projectDomainsScreen = Effect.fn("ui.projectDomains")(function* (context: ScreenContext, projectId: string) {
  const entered = yield* projectContext(context, { optionalRuntime: true });
  if (entered.missing) return entered.missing;
  if (!canAccess(context.config.access, projectDomainAccess(projectId))) {
    return page(empty("Domains unavailable", "You need permission to view domains for this Project."));
  }
  const manage = canAccess(context.config.access, projectDomainAccess(projectId, true));
  const path = projectDomainPath(context, projectId);
  const read = readProjectDomains(context, projectId);
  const { domains } = yield* read;
  const inventory = node("div", { class: "project-domain-inventory", "data-project-domains": "" });
  const feedback = node("div", { "aria-live": "polite" });
  const hostname = node("input", { name: "hostname", id: "domain-hostname", maxlength: "254", placeholder: "app.example.com", required: "", autocapitalize: "none", spellcheck: "false" });
  const tls = dropdown({ label: "TLS mode", value: "external" }, [
    { value: "external", label: "External TLS" }, { value: "managed", label: "Zelavis-managed HTTPS" },
  ]);
  const add = node("button", { type: "submit", class: "primary" }, "Add domain");
  const form = node("form", { class: "form" }, node("label", {}, node("span", {}, "Hostname"), hostname),
    node("label", {}, node("span", {}, "TLS mode"), tls), node("div", { class: "actions" }, add));
  let busy = false;

  const mutate = <A>(operation: Effect.Effect<A, Error>, notice: (value: A) => string) => {
    if (busy) return;
    busy = true;
    add.disabled = true;
    for (const control of inventory.querySelectorAll("button")) control.disabled = true;
    feedback.replaceChildren(message("Updating domain…"));
    context.run(Effect.gen(function* () {
      const result = yield* Effect.result(operation);
      const current = yield* Effect.result(read);
      return { result, current };
    }), ({ result, current }) => {
      busy = false;
      add.disabled = false;
      if (current._tag === "Success") render(current.success.domains);
      else for (const control of inventory.querySelectorAll("button")) control.disabled = false;
      if (result._tag === "Failure") feedback.replaceChildren(message(result.failure.message, true));
      else if (current._tag === "Failure") feedback.replaceChildren(message(current.failure.message, true));
      else feedback.replaceChildren(message(notice(result.success)));
    });
  };

  function copy(title: string, value: string) {
    const input = node("input", { value, readonly: "", "aria-label": title, spellcheck: "false" });
    return node("div", { class: "project-domain-dns" }, node("label", {}, node("span", {}, title), input),
      button(`Copy ${title}`, () => {
        context.run(Effect.result(Effect.tryPromise({
          try: () => navigator.clipboard.writeText(value), catch: cause => new Error("Clipboard unavailable", { cause }),
        })), result => {
          if (result._tag === "Failure") { input.focus(); input.select(); }
          feedback.replaceChildren(message(result._tag === "Success" ? `${title} copied.` : "Copy the selected text."));
        });
      }));
  }

  function render(entries: readonly typeof Domain.Type[]) {
    inventory.replaceChildren(...(entries.length ? entries.map(domain => {
      const domainPath = `${path}/${encodeURIComponent(domain.hostname)}`;
      const url = activeProjectDomainUrl(domain);
      const expiry = domain.challenge ? new Date(domain.challenge.expiresAt) : undefined;
      const expired = expiry !== undefined && expiry.getTime() <= Date.now();
      const check = () => {
        const operation = expired
          ? request(path, "POST", { hostname: domain.hostname, tlsMode: domain.tlsMode })
          : request(`${domainPath}/verify`, "POST", { expectedRevision: domain.revision });
        mutate(operation.pipe(Effect.flatMap(decodeDomain)), next => labels[next.state]);
      };
      const remove = () => {
        if (domain.state !== "removing" && !window.confirm(`Remove ${domain.hostname} from this Project?`)) return;
        mutate(request(`${domainPath}?revision=${domain.revision}`, "DELETE").pipe(Effect.flatMap(decodeRemoval)),
          result => result.pending ? "Withdrawal is still pending." : "Domain removed.");
      };
      return card(domain.hostname,
        node("div", { class: "actions" }, badge(labels[domain.state]),
          node("span", { class: "muted" }, domain.tlsMode === "external" ? "External TLS" : "Zelavis-managed HTTPS")),
        domain.issue ? node("p", { class: "muted" }, issues[domain.issue]) : undefined,
        domain.challenge && expiry ? node("div", { class: "form" }, copy("TXT name", domain.challenge.name),
          copy("TXT value", domain.challenge.value), node("p", { class: "muted" }, `Expires ${expiry.toLocaleString()}`)) : undefined,
        node("div", { class: "actions" },
          url ? node("a", { href: url, target: "_blank", rel: "noreferrer" }, "Open site") : undefined,
          manage && domain.state !== "active" && domain.state !== "removing"
            ? button(expired ? "Renew challenge" : domain.state === "pending_dns" ? "Verify DNS" : "Retry activation", check, { class: "primary" }) : undefined,
          manage ? button(domain.state === "removing" ? "Retry removal" : "Remove domain", remove, { class: "danger" }) : undefined));
    }) : [empty("No domains connected", "Add a hostname you control to serve this Project on your domain.")]));
  }
  render(domains);
  form.addEventListener("submit", event => {
    event.preventDefault();
    mutate(request(path, "POST", { hostname: hostname.value.trim(), tlsMode: tls.value || "external" }).pipe(Effect.flatMap(decodeDomain)), next => {
      hostname.value = "";
      return next.challenge ? "TXT challenge created." : labels[next.state];
    });
  });

  return page(card(manage ? "Connect a hostname" : undefined,
    node("p", {}, "Point an A or AAAA record, or a CNAME for a subdomain, at the ingress address from your server operator. Add the separate TXT record shown for each hostname."),
    manage ? node("p", {}, "With external TLS, your server operator provides the HTTPS certificate and proxy.") : undefined,
    manage ? form : undefined, feedback), inventory);
});
