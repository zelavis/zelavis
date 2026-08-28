import packageMetadata from "../package.json" with { type: "json" };

/** The exact version of the installed Zelavis framework and App Platform. */
export const ZELAVIS_VERSION = packageMetadata.version;
