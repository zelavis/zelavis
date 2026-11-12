/**
 * The host environment a Project process inherits: locale, temp and certificate
 * locations, never the Platform's own variables. A leaf module on purpose, so a
 * Project's persistent host can read it without loading the Project driver.
 */
const INHERITED_PROJECT_ENVIRONMENT = Object.freeze([
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "NODE_ENV",
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
    // Where the officially maintained services lie in a development checkout, so a
    // Project's marketplace offers them too. A path, not a secret.
    "ZELAVIS_OFFICIAL_SERVICES_DIR",
]);
export function projectProcessEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const name of INHERITED_PROJECT_ENVIRONMENT) {
        const value = process.env[name];
        if (value !== undefined) {
            environment[name] = value;
        }
    }
    return environment;
}
