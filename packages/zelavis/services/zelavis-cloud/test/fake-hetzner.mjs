// Minimal in-process fake of the Hetzner Cloud API: servers, SSH keys and
// actions, which is what Alchemy's Hetzner.Server provider calls. It is shaped
// by Hetzner's documented API (including `409 uniqueness_error` for a duplicate
// name) but is not Hetzner: confirm the scenarios against a real project before
// trusting them.
//
// Faults are consumed once:
//   faults.dropResponseAfterCreate = n   commit the create, then close the socket
//   faults.failCreateWith = [[status, code]]   answer the next creates with an error
import http from "node:http";

export function startFakeHetzner({ token = "test-token" } = {}) {
  const servers = new Map();
  const sshKeys = new Map();
  const actions = new Map();
  let nextId = 1000;
  const log = [];
  // Faults: each is consumed once.
  const faults = { dropResponseAfterCreate: 0, failCreateWith: [] };

  const now = () => new Date().toISOString();
  const pagination = (n) => ({
    pagination: { page: 1, per_page: 50, previous_page: null, next_page: null, last_page: 1, total_entries: n },
  });
  const action = (command, resources = []) => {
    const a = {
      id: nextId++, command, status: "success", progress: 100,
      started: now(), finished: now(), resources, error: null,
    };
    actions.set(a.id, a);
    return a;
  };
  const serverJson = (s) => ({
    id: s.id, name: s.name, status: "running", created: s.created,
    public_net: {
      ipv4: { ip: `203.0.113.${s.id % 250}`, blocked: false, dns_ptr: `s${s.id}.example`, id: s.id + 1 },
      ipv6: { ip: `2001:db8:${s.id}::/64`, blocked: false, dns_ptr: [], id: s.id + 2 },
      floating_ips: [], firewalls: [],
    },
    private_net: [],
    server_type: {
      id: 22, name: s.server_type, description: "CPX11", cores: 2, memory: 2, disk: 40,
      deprecated: false, storage_type: "local", cpu_type: "shared", architecture: "x86",
      category: "regular_purpose", prices: [], included_traffic: 20000000000,
    },
    location: {
      id: 1, name: s.location, description: "Fake", country: "DE", city: "Falkenstein",
      latitude: 0, longitude: 0, network_zone: "eu-central",
    },
    image: {
      id: 1, type: "system", status: "available", name: s.image, description: s.image,
      image_size: null, disk_size: 5, created: now(), created_from: null, bound_to: null,
      os_flavor: "ubuntu", os_version: "24.04", rapid_deploy: true, protection: { delete: false },
      deprecated: null, deleted: null, labels: {}, architecture: "x86",
    },
    iso: null, rescue_enabled: false, locked: false, backup_window: null,
    outgoing_traffic: 0, ingoing_traffic: 0, included_traffic: 20000000000,
    protection: { delete: false, rebuild: false },
    labels: s.labels, volumes: [], load_balancers: [], primary_disk_size: 40, placement_group: null,
  });
  const sshJson = (k) => ({
    id: k.id, name: k.name, fingerprint: k.fingerprint, public_key: k.public_key,
    labels: k.labels, created: k.created,
  });
  const matchesSelector = (labels, selector) => {
    if (!selector) return true;
    return selector.split(",").every((part) => {
      const [k, v] = part.split("=");
      return v === undefined ? k in labels : labels[k] === v;
    });
  };

  const body = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        resolve(raw ? JSON.parse(raw) : {});
      });
    });
  const send = (res, status, json) => {
    if (status === 204) { res.writeHead(204); return res.end(); }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(json));
  };
  const apiError = (res, status, code, message) => send(res, status, { error: { code, message } });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname.replace(/^\/v1/, "");
    const m = req.method;
    log.push(`${m} ${path}${url.search}`);
    if (req.headers.authorization !== `Bearer ${token}`) return apiError(res, 401, "unauthorized", "bad token");
    const b = ["POST", "PUT"].includes(m) ? await body(req) : {};
    let r;

    if (m === "GET" && path === "/ssh_keys") {
      const name = url.searchParams.get("name");
      const fp = url.searchParams.get("fingerprint");
      const list = [...sshKeys.values()].filter((k) => (!name || k.name === name) && (!fp || k.fingerprint === fp));
      return send(res, 200, { ssh_keys: list.map(sshJson), meta: pagination(list.length) });
    }
    if (m === "POST" && path === "/ssh_keys") {
      if ([...sshKeys.values()].some((k) => k.name === b.name)) return apiError(res, 409, "uniqueness_error", "ssh key name");
      const k = { id: nextId++, name: b.name, public_key: b.public_key, fingerprint: `aa:bb:${nextId}`, labels: b.labels ?? {}, created: now() };
      sshKeys.set(k.id, k);
      return send(res, 201, { ssh_key: sshJson(k) });
    }
    if ((r = path.match(/^\/ssh_keys\/(\d+)$/))) {
      const k = sshKeys.get(Number(r[1]));
      if (!k) return apiError(res, 404, "not_found", "ssh key not found");
      if (m === "GET") return send(res, 200, { ssh_key: sshJson(k) });
      if (m === "DELETE") { sshKeys.delete(k.id); return send(res, 204); }
    }

    if (m === "GET" && path === "/servers") {
      const name = url.searchParams.get("name");
      const sel = url.searchParams.get("label_selector");
      const list = [...servers.values()].filter((s) => (!name || s.name === name) && matchesSelector(s.labels, sel));
      return send(res, 200, { servers: list.map(serverJson), meta: pagination(list.length) });
    }
    if (m === "POST" && path === "/servers") {
      if (faults.failCreateWith.length) {
        const [status, code] = faults.failCreateWith.shift();
        return apiError(res, status, code, "injected");
      }
      if ([...servers.values()].some((s) => s.name === b.name)) return apiError(res, 409, "uniqueness_error", "server name");
      const s = {
        id: nextId++, name: b.name, server_type: b.server_type, image: b.image, location: b.location ?? "nbg1",
        labels: b.labels ?? {}, created: now(), user_data: b.user_data, ssh_keys: b.ssh_keys ?? [],
      };
      servers.set(s.id, s);
      const out = { server: serverJson(s), action: action("create_server", [{ id: s.id, type: "server" }]), next_actions: [], root_password: null };
      if (faults.dropResponseAfterCreate > 0) {
        // The create is committed, but the caller never hears back.
        faults.dropResponseAfterCreate--;
        return req.socket.destroy();
      }
      return send(res, 201, out);
    }
    if ((r = path.match(/^\/servers\/(\d+)$/))) {
      const s = servers.get(Number(r[1]));
      if (!s) return apiError(res, 404, "not_found", "server not found");
      if (m === "GET") return send(res, 200, { server: serverJson(s) });
      if (m === "PUT") { if (b.name) s.name = b.name; if (b.labels) s.labels = b.labels; return send(res, 200, { server: serverJson(s) }); }
      if (m === "DELETE") { servers.delete(s.id); return send(res, 200, { action: action("delete_server", [{ id: s.id, type: "server" }]) }); }
    }
    if ((r = path.match(/^\/actions\/(\d+)$/)) && m === "GET") {
      const a = actions.get(Number(r[1]));
      return a ? send(res, 200, { action: a }) : apiError(res, 404, "not_found", "action not found");
    }
    return apiError(res, 404, "not_found", `fake has no ${m} ${path}`);
  });

  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1`, token, servers, sshKeys, actions, faults, log,
        reset: () => { servers.clear(); sshKeys.clear(); actions.clear(); log.length = 0; },
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
      });
    }),
  );
}
