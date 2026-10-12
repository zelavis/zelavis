# @zelavis/php-builds

Builds the PHP that the Zelavis recipes run, on the server Zelavis runs on, and publishes it to a mirror, from the
dashboard (or the SDK, HTTP or CLI: `zelavis plugins phpBuilds builds create --file build.json`).

It is a plugin with no authority of its own. Its manifest names six fixed host operations
(`zelavis.host-report`, `zelavis.container-probe`, `zelavis.php-build-start|status|upload|clean`) and every call is
made with the principal of the person who asked, so the Platform checks that person's own permissions:
`server.php-builds.view` to look, `server.php-builds.run` to build, upload or remove. A build runs in one labeled,
resource-limited container (at most half the host's cores and free memory, one at a time) from a digest-pinned
image; nothing is installed on the host and the host's own state is the truth. It needs a system installation (the
operation Agent) and a container engine, which the page checks and reports.

Publishing goes straight from the build's output to a short-lived presigned Cloudflare R2 address, so no storage
credential reaches the build host and an archive never passes through the Platform. The mirror is configured by the
operator in the Platform's environment file (`/etc/zelavis/zelavis.env`), never stored by this service and never
returned:

```
ZELAVIS_PHP_BUILDS_R2_ACCOUNT_ID=…
ZELAVIS_PHP_BUILDS_R2_BUCKET=zelavis-mirror
ZELAVIS_PHP_BUILDS_R2_ACCESS_KEY_ID=…
ZELAVIS_PHP_BUILDS_R2_SECRET_ACCESS_KEY=…
ZELAVIS_PHP_BUILDS_PUBLIC_URL=https://mirror.zelavis.com
```

Use an R2 API token limited to that one bucket. After an upload the page shows the digests to feed
`distribution/php-builds/pin.mjs`; pinning them into the recipes stays a repository change shipped through npm.

Source of the build: `distribution/php-builds` (`build.sh`, `extensions.txt`, `spc.pins`), carried inside the start
operation. See `website/src/content/docs/architecture/php-builds.md`.
