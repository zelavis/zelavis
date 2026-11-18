import { bodyFlag, integerFlag, required, runTable, type CliTable } from "./command-table.js";
import type { EmailSettingsInput } from "../app/email/contracts.js";

const usage =
  "zelavis email <settings|set-settings|test|deliveries> [ADDRESS] [--data JSON] [--limit N] [--after CURSOR] [--url URL] [--token TOKEN] [--json]   (a Project's email: zelavis projects email-settings …)";

const table: CliTable = {
  name: "email",
  usage,
  valued: ["--data", "--limit", "--after"],
  actions: {
    settings: { run: (input) => input.client.email.settings() },
    "set-settings": { run: (input) => input.client.email.setSettings(bodyFlag<EmailSettingsInput>(input, "--data", "email set-settings")) },
    test: { run: (input) => input.client.email.sendTest(required(input, 0, "An address")) },
    deliveries: {
      run: (input) => {
        const limit = integerFlag(input, "--limit");
        const after = input.flags.get("--after");
        return input.client.email.deliveries({ ...(limit === undefined ? {} : { limit }), ...(after === undefined ? {} : { after }) });
      },
    },
  },
};

/** `zelavis email`: the Platform's own email delivery, through the SDK client's `email`. */
export function runEmailCommand(args: readonly string[]): Promise<void> {
  return runTable(table, args);
}
