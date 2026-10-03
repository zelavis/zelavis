# @zelavis/wordpress

## 7.1.3-alpha.0

### Patch Changes

- Provision the WordPress host stack through a separately supervised, operation-only root Agent with signed, bounded requests and explicit server.packages.install authorization. System installs and updates configure the broker automatically; Project processes remain unprivileged. Project creation exposes the same package-install opt-in through the dashboard, HTTP, SDK and CLI. Package installation preserves existing host services and suppresses package-triggered starts; uninstall restores only the owned policy.
  
  Separate WordPress software pins from recipe revisions. The recipe no longer invokes APT or sudo or asks operators to run the Platform as root; its pinned WordPress archive is unchanged.
- Updated dependencies [bbe74e4]
- Updated dependencies
- Updated dependencies
  - zelavis@2.0.0-alpha.12
