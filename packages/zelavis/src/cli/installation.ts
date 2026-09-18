/**
 * Which installation of Zelavis is answering, and where it lives.
 *
 * The command name is shared by installs that cannot see each other. A `.deb`
 * links `/usr/bin/zelavis`, the archive installer links `/usr/local/bin/zelavis`,
 * and `npm install --global zelavis` writes into npm's own prefix — which is
 * commonly `/usr/local/bin` too. On Debian and Ubuntu `/usr/local/bin` precedes
 * `/usr/bin`, so an npm install silently shadows a packaged one: both are
 * present, both look healthy, and `zelavis` quietly means the npm copy.
 *
 * Nothing can be inferred from the version alone in that situation, because the
 * two installs may be the same version or differ in either direction. So
 * `zelavis --version` reports the path it is running from, which turns "the
 * package upgrade did not take effect" into a question that answers itself.
 */
export type ZelavisInstallationKind = "packaged" | "npm" | "source";

export interface ZelavisInstallation {
  /** How this copy was installed, as far as its location reveals. */
  readonly kind: ZelavisInstallationKind;
  /** Real path of the running CLI, with symlinks resolved. */
  readonly path: string;
  /** Root this copy belongs to: the release prefix, or the package directory. */
  readonly root?: string;
}

/**
 * Classifies an installation from the resolved path of its CLI entrypoint.
 *
 * `cliPath` must already have symlinks resolved: the whole point is to look
 * past `/usr/local/bin/zelavis` at what it actually points to.
 */
export function describeInstallation(cliPath: string): ZelavisInstallation {
  // The archive and .deb layouts both place releases under a prefix, with
  // `current` pointing at the selected one. The prefix is configurable
  // (ZELAVIS_PREFIX), so match the layout rather than a fixed /opt/zelavis.
  const release = /^(?<root>.*)\/releases\/[^/]+\/bin\/zelavis$/u.exec(cliPath);
  if (release?.groups?.root) {
    return { kind: "packaged", path: cliPath, root: release.groups.root };
  }
  if (cliPath.startsWith("/opt/zelavis/")) {
    return { kind: "packaged", path: cliPath, root: "/opt/zelavis" };
  }

  // npm keeps the package itself under <prefix>/lib/node_modules/zelavis and
  // links the bin separately, so the resolved path lands inside node_modules.
  const index = cliPath.lastIndexOf("/node_modules/zelavis/");
  if (index !== -1) {
    return {
      kind: "npm",
      path: cliPath,
      root: cliPath.slice(0, index + "/node_modules/zelavis".length),
    };
  }

  return { kind: "source", path: cliPath };
}

/** One line naming the installation, for `--version`. */
export function formatInstallation(installation: ZelavisInstallation): string {
  const where = installation.root ?? installation.path;
  switch (installation.kind) {
    case "packaged":
      return `packaged installation at ${where}`;
    case "npm":
      return `npm installation at ${where}`;
    case "source":
      return `running from source at ${where}`;
  }
}
