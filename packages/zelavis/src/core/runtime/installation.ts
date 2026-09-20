/** Exact acknowledgement required before a complete installation wipe. */
export const ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION =
  "DELETE-ALL-ZELAVIS-DATA";

export type ZelavisInstallationKind = "packaged" | "npm" | "source";

/** The concrete copy of Zelavis a host-maintenance adapter is acting on. */
export interface ZelavisInstallationIdentity {
  readonly kind: ZelavisInstallationKind;
  /** Real path of the running CLI entrypoint, with symlinks resolved. */
  readonly path: string;
  /** Installation prefix or package root, when the layout identifies one. */
  readonly root?: string;
}

export type ZelavisInstallationRemovalTargetKind =
  | "service"
  | "package"
  | "command"
  | "directory"
  | "configuration"
  | "repository"
  | "account";

export interface ZelavisInstallationRemovalTarget {
  readonly id: string;
  readonly kind: ZelavisInstallationRemovalTargetKind;
  readonly description: string;
  readonly path?: string;
  /** False means inspection proved that this target is already absent. */
  readonly exists?: boolean;
}

export interface ZelavisInstallationUninstallPlan {
  readonly adapter: string;
  readonly installation: ZelavisInstallationIdentity;
  readonly dataDirectory: string;
  readonly targets: readonly ZelavisInstallationRemovalTarget[];
  /** Host state intentionally retained because Zelavis cannot prove ownership. */
  readonly retained: readonly string[];
}

export interface ZelavisInstallationUninstallResult {
  readonly removed: true;
  readonly plan: ZelavisInstallationUninstallPlan;
  readonly output?: string;
}

/**
 * Host-local complete-removal capability supplied by a long-running adapter.
 *
 * This is deliberately not a Platform HTTP capability. It removes the
 * Platform, its Agent and their authority material, so exposing it through the
 * server being removed would invert the host authority boundary. Operators use
 * the local JavaScript adapter or `zelavis uninstall` while logged into the
 * machine.
 */
export interface ZelavisInstallationUninstaller {
  plan(): Promise<ZelavisInstallationUninstallPlan>;
  uninstall(input: {
    readonly confirmation: string;
  }): Promise<ZelavisInstallationUninstallResult>;
}

export class ZelavisInstallationUninstallConfirmationError extends Error {
  constructor() {
    super(
      `Complete uninstall requires the exact confirmation ${ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION}.`,
    );
    this.name = "ZelavisInstallationUninstallConfirmationError";
  }
}

export function assertCompleteUninstallConfirmation(
  confirmation: string,
): void {
  if (confirmation !== ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION) {
    throw new ZelavisInstallationUninstallConfirmationError();
  }
}
