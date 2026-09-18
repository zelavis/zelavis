import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Where a CLI-managed Platform keeps its data when nothing else says.
 *
 * The packaged installs never reach this. Their systemd units set
 * `ZELAVIS_DATA_DIR=/var/lib/zelavis`, and the CLI resolves that ahead of the
 * default, so `.deb` and archive installations keep the FHS location a system
 * service belongs in. What lands here is the npm path — `npm install --global
 * zelavis && zelavis serve` — where no installer has chosen a location.
 *
 * It is the user's data directory rather than the current one because a
 * Platform OS holds owners, Tenants and databases: state that belongs to the
 * machine's user, not to whatever directory the command was typed in. A
 * relative default made `cd` part of the addressing — `zelavis serve` from two
 * directories served two unrelated installations, with nothing on screen
 * saying so.
 *
 * A relative `.zelavis` remains right for Project-scoped state stored inside a
 * Project's own directory, the way `.git` is: that state *is* about the
 * directory. This is the opposite case.
 *
 * `$XDG_DATA_HOME` is honoured, and ignored when relative, because the
 * specification requires a relative value to be treated as unset.
 */
export function defaultCliDataDirectory(): string {
  const configured = process.env.XDG_DATA_HOME?.trim();
  if (configured && isAbsolute(configured)) {
    return join(configured, "zelavis");
  }
  return join(homedir(), ".local", "share", "zelavis");
}

/**
 * Resolves the Platform data directory for a CLI command to an absolute path.
 *
 * `explicit` is whatever the caller already resolved from `--data-dir` and
 * then `ZELAVIS_DATA_DIR`; the default applies only when neither named one.
 */
export function resolveCliDataDirectory(explicit?: string): string {
  return resolve(explicit?.trim() ? explicit : defaultCliDataDirectory());
}
