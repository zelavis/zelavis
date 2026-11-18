import { bodyFlag, integerFlag, required, runTable, type CliTable } from "./command-table.js";
import type { ConnectRegistrarInput, RegistrarOrderInput, SetRegistrarContactInput } from "../edge/registrar.js";
const table: CliTable = {
  name: "registrar",
  usage: "zelavis registrar <providers|connection|connect|disconnect|contact|set-contact|check|quote|order|orders|order-status|domains|set-nameservers> [DOMAIN...] [--data JSON] [--limit N] [--after CURSOR] [--cursor CURSOR] [--url URL] [--token TOKEN] [--json]",
  valued: ["--data", "--limit", "--after", "--cursor"],
  actions: {
    providers: { run: input => input.client.registrar.providers() },
    connection: { run: input => input.client.registrar.connection() },
    connect: { run: input => input.client.registrar.connect(bodyFlag<ConnectRegistrarInput>(input, "--data", "registrar connect")) },
    disconnect: { run: input => input.client.registrar.disconnect() },
    contact: { run: input => input.client.registrar.contact() },
    "set-contact": { run: input => input.client.registrar.setContact(bodyFlag<SetRegistrarContactInput>(input, "--data", "registrar set-contact")) },
    check: { run: input => { required(input, 0, "A domain"); return input.client.registrar.check(input.positional); } },
    quote: { run: input => input.client.registrar.quote(bodyFlag<{ domain: string; kind: "register" | "renew" | "transfer"; years: number }>(input, "--data", "registrar quote")) },
    order: { run: input => input.client.registrar.order(bodyFlag<RegistrarOrderInput>(input, "--data", "registrar order")) },
    orders: { run: input => input.client.registrar.orders({ limit: integerFlag(input, "--limit"), after: input.flags.get("--after") }) },
    "order-status": { run: input => input.client.registrar.getOrder(required(input, 0, "An order ID")) },
    domains: { run: input => input.client.registrar.domains(input.flags.get("--cursor")) },
    "set-nameservers": { run: input => { required(input, 2, "At least two nameservers"); return input.client.registrar.setNameservers(required(input, 0, "A domain"), input.positional.slice(1)); } },
  },
};
export function runRegistrarCommand(args: readonly string[]): Promise<void> { return runTable(table, args); }
