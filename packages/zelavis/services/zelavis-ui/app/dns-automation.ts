import { Effect } from "effect";
import { array, label, object, request } from "./api.ts";
import { button, empty, message, node } from "./dom.ts";
import { dropdown } from "./dropdown.ts";
import { canAccess } from "./navigation-menu.ts";
import { badge, card, dataRow, flashNotice, rowsCard, setFlash } from "./page-kit.ts";
import type { ScreenContext } from "./screens.ts";

/**
 * Server → Domains, DNS automation: provider connections (credentials are written, never read back), adopted zones with
 * their hosted subdomains and address targets, and each zone's wildcard certificate. A client of `/runtime/edge/dns/*`.
 * The selected zone lives in the URL (`?zone=`); the provider whose zones are listed for adoption in `?provider=`.
 */
export const dnsAutomationCards = Effect.fn("ui.dnsAutomation")(function* (context: ScreenContext) {
  const api = `${context.config.api.basePath}/runtime/edge/dns`;
  const manage = canAccess(context.config.access, { permissions: ["server.edge.manage"] });
  // An installation without DNS automation (or certificates) answers 404/503 here; the page then shows the inventory alone.
  const optional = (path: string, key: string) => request(path).pipe(
    Effect.map(body => array(object(body)[key]).map(object)),
    Effect.catch(error => error.status === 404 || error.status === 503 ? Effect.succeed(undefined) : Effect.fail(error)));
  const providers = yield* optional(`${api}/providers`, "providers");
  if (!providers) return [];
  const zones = (yield* optional(`${api}/zones`, "zones")) ?? [];
  const certificates = (yield* optional(`${context.config.api.basePath}/runtime/edge/certificates`, "certificates")) ?? [];
  const selectedZone = context.url.searchParams.get("zone") ?? "";
  const listedProvider = context.url.searchParams.get("provider") ?? "";
  const feedback = node("div", { "aria-live": "polite", "data-dns-feedback": "" }, flashNotice("DNS automation", "dns"));

  const act = (operation: Effect.Effect<unknown, Error>, notice: string, search?: Record<string, string | undefined>) => {
    feedback.replaceChildren(message("Working…"));
    context.run(Effect.result(operation), result => {
      if (result._tag === "Failure") { feedback.replaceChildren(message(result.failure.message, true)); return; }
      setFlash(notice, "dns");
      if (search) context.setSearch(search);
      else context.refresh();
    });
  };

  const providerCards = providers.map(provider => {
    const name = label(provider.name);
    const connected = provider.connected === true;
    const fields = array(provider.credentials).map(object).map(field => {
      const input = node("input", { name: label(field.name), type: field.secret === true ? "password" : "text", autocomplete: "off", required: "", maxlength: "1024", spellcheck: "false" });
      return { name: label(field.name), input, element: node("label", {}, node("span", {}, label(field.label)), input) };
    });
    const form = node("form", { class: "form", "data-dns-connect": name }, ...fields.map(field => field.element),
      node("div", { class: "actions" }, node("button", { type: "submit", class: "primary" }, connected ? "Replace credentials" : `Connect ${label(provider.title)}`)));
    form.addEventListener("submit", event => {
      event.preventDefault();
      const credentials = Object.fromEntries(fields.map(field => [field.name, field.input.value]));
      act(request(`${api}/connections/${encodeURIComponent(name)}`, "PUT", {
        credentials, ...(typeof provider.revision === "number" ? { expectedRevision: provider.revision } : {}),
      }), `${label(provider.title)} connected.`);
    });
    return card(label(provider.title),
      node("div", { class: "actions" }, badge(connected ? "connected" : "not connected"),
        node("span", { class: "muted" }, provider.source === "plugin" ? `From ${label(provider.plugin)}` : "Built in")),
      node("p", {}, label(provider.tokenGuidance)),
      node("p", { class: "muted" }, "Use a token made only for Zelavis, limited to the zones it should manage. It is stored encrypted and never shown again."),
      manage ? form : undefined,
      manage && connected ? node("div", { class: "actions" },
        button("Choose a zone", () => context.setSearch({ provider: name, zone: undefined })),
        button("Disconnect", () => {
          if (!window.confirm(`Disconnect ${label(provider.title)}? Zones adopted through it must be released first.`)) return;
          act(request(`${api}/connections/${encodeURIComponent(name)}`, "DELETE"), "Disconnected.", listedProvider === name ? { provider: undefined, cursor: undefined } : undefined);
        }, { class: "danger" })) : undefined);
  });

  const wildcardStatus = (zone: Record<string, unknown>) => {
    const ref = typeof zone.wildcardCertificateRef === "string" ? zone.wildcardCertificateRef : undefined;
    const certificate = ref ? certificates.find(entry => entry.ref === ref) : undefined;
    if (!certificate) return "No wildcard certificate yet";
    return `Wildcard ${label(certificate.hostname)} · ${label(certificate.status)} · expires ${new Date(label(certificate.expiresAt)).toLocaleDateString()}`;
  };
  const targetsText = (zone: Record<string, unknown>) => {
    const targets = object(zone.targets);
    const cname = typeof targets.cname === "string" ? targets.cname : undefined;
    return cname ? `CNAME ${cname}` : [...array(targets.a).map(String), ...array(targets.aaaa).map(String)].join(", ") || "No address targets";
  };
  const zoneRows = zones.map(zone => dataRow(label(zone.apex),
    [label(zone.provider), zone.hostedSubdomains === true ? "Hosted subdomains on" : "Hosted subdomains off", wildcardStatus(zone)].join(" · "),
    button(selectedZone === zone.apex ? "Selected" : "Open", () => context.setSearch({ zone: label(zone.apex), provider: undefined }))));

  const selected = zones.find(zone => zone.apex === selectedZone);
  const zoneDetail = selected ? card(label(selected.apex),
    node("p", {}, `Records go to ${label(selected.provider)} zone ${label(selected.zoneId)}. Hosted subdomains point at ${targetsText(selected)}.`),
    node("p", { class: "muted", "data-dns-wildcard": label(selected.apex) }, wildcardStatus(selected)),
    node("p", { class: "muted" }, "The wildcard's private key stays on this Platform; nothing copies it to other servers."),
    manage ? node("div", { class: "actions" },
      button(selected.wildcardCertificateRef ? "Renew wildcard certificate" : "Order wildcard certificate", () =>
        act(request(`${api}/zones/${encodeURIComponent(label(selected.apex))}/wildcard-certificate`, "POST"), "Wildcard certificate issued."), { class: "primary" }),
      button("Release zone", () => {
        if (!window.confirm(`Release ${label(selected.apex)}? Zelavis stops managing records in it.`)) return;
        act(request(`${api}/zones/${encodeURIComponent(label(selected.apex))}`, "DELETE"), "Zone released.", { zone: undefined });
      }, { class: "danger" })) : undefined) : undefined;

  let adoption: HTMLElement | undefined;
  const chosen = providers.find(provider => provider.name === listedProvider && provider.connected === true);
  if (manage && chosen) {
    const page = object(yield* request(`${api}/connections/${encodeURIComponent(listedProvider)}/zones${
      context.url.searchParams.get("cursor") ? `?cursor=${encodeURIComponent(context.url.searchParams.get("cursor")!)}` : ""}`));
    const options = array(page.zones).map(object).map(zone => ({ value: label(zone.id), label: label(zone.apex) }));
    const zone = dropdown({ label: "Provider zone", value: options[0]?.value ?? "" }, options);
    const apex = node("input", { name: "apex", id: "dns-zone-apex", maxlength: "253", placeholder: "apps.example.com", required: "", autocapitalize: "none", spellcheck: "false" });
    const hosted = node("input", { type: "checkbox", name: "hostedSubdomains", checked: "" });
    const a = node("input", { name: "a", placeholder: "203.0.113.7", spellcheck: "false" });
    const aaaa = node("input", { name: "aaaa", placeholder: "2001:db8::7", spellcheck: "false" });
    const cname = node("input", { name: "cname", placeholder: "ingress.example.net", spellcheck: "false" });
    const list = (input: HTMLInputElement) => input.value.split(",").map(value => value.trim()).filter(Boolean);
    const form = node("form", { class: "form", "data-dns-adopt": "" },
      node("label", {}, node("span", {}, "Provider zone"), zone),
      node("label", {}, node("span", {}, "Zone apex Zelavis manages"), apex),
      node("label", { class: "checkbox" }, hosted, node("span", {}, "Let Projects take a subdomain one label below it")),
      node("label", {}, node("span", {}, "IPv4 addresses (comma separated)"), a),
      node("label", {}, node("span", {}, "IPv6 addresses (comma separated)"), aaaa),
      node("label", {}, node("span", {}, "Or one CNAME target"), cname),
      node("div", { class: "actions" }, node("button", { type: "submit", class: "primary" }, "Adopt zone"),
        typeof page.next === "string" ? button("More zones", () => context.setSearch({ cursor: String(page.next) })) : undefined,
        button("Cancel", () => context.setSearch({ provider: undefined, cursor: undefined }))));
    form.addEventListener("submit", event => {
      event.preventDefault();
      const target = apex.value.trim().toLowerCase();
      const existing = zones.find(entry => entry.apex === target);
      act(request(`${api}/zones/${encodeURIComponent(target)}`, "PUT", {
        provider: listedProvider, zoneId: zone.value, hostedSubdomains: hosted.checked,
        targets: { a: list(a), aaaa: list(aaaa), ...(cname.value.trim() ? { cname: cname.value.trim().toLowerCase() } : {}) },
        ...(existing ? { expectedRevision: existing.revision } : {}),
      }), `${target} adopted.`, { provider: undefined, cursor: undefined, zone: target });
    });
    adoption = card(`Adopt a ${label(chosen.title)} zone`,
      options.length ? form : empty("No zones", "This connection lists no zones. Check what the token can reach."));
  }

  return [
    feedback,
    ...(providerCards.length ? providerCards : [card("DNS providers", empty("No DNS providers", "This installation has no DNS provider driver."))]),
    adoption,
    rowsCard("Adopted zones", ...(zoneRows.length ? zoneRows : [dataRow("No zones adopted", "Connect a provider, then choose a zone for automatic records and wildcard certificates.")])),
    zoneDetail,
  ].filter((entry): entry is HTMLElement => entry !== undefined);
});
