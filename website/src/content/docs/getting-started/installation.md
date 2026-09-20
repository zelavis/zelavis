---
title: Installation
description: Install the long-running Zelavis Platform OS with the quick installer, Debian package, archive, or npm.
---

Zelavis is a long-running Platform OS. It is installed on a server or local
machine; it is not deployed as an ephemeral serverless function.

## Quick install

The quick installer automatically detects your operating system and CPU
architecture (`x86_64` / `amd64` and `arm64`). On production Linux servers
(such as Hetzner, AWS, DigitalOcean, or bare metal), it pulls the
verified standalone distribution bundle from the release registry, verifies its
SHA-256 integrity, unpacks the private Node 24 runtime, registers the `zelavis`
system user, and sets up systemd service units.

Zero build dependencies are required on your server: no `git`, `node`, `pnpm`,
or compilers are needed.

```bash
# Production server installation (enables Edge Agent & Traefik management)
curl -fsSL https://raw.githubusercontent.com/zelavis/zelavis/main/distribution/installers/install.sh | sudo ZELAVIS_ENABLE_AGENT=1 sh
```

Or via the canonical short URL:

```bash
curl -fsSL https://zelavis.com/install.sh | sudo ZELAVIS_ENABLE_AGENT=1 sh
```

The packaged installation contains an isolated, private pinned Node runtime. It
does not replace or interfere with the host's global Node installation. Setting
`ZELAVIS_ENABLE_AGENT=1` ensures the Zelavis Edge Agent service (`zelavis-agent.service`)
is enabled alongside the main Platform OS (`zelavis.service`), allowing automated
Let's Encrypt TLS certificate issuance and reverse-proxy cutovers via Traefik.

## Direct Debian / Ubuntu package (.deb)

If you prefer managing packages natively with `apt`, download the `.deb` release
matching your server CPU and install it:

```bash
# For x86_64 / amd64 servers (e.g. Hetzner CX22, standard cloud instances)
curl -fsSLO https://github.com/zelavis/zelavis/releases/download/v1.0.1-alpha.2/zelavis_1.0.1.alpha.2_amd64.deb
sudo apt install -y ./zelavis_1.0.1.alpha.2_amd64.deb

# For ARM64 servers (e.g. AWS Graviton, Ampere)
curl -fsSLO https://github.com/zelavis/zelavis/releases/download/v1.0.1-alpha.2/zelavis_1.0.1.alpha.2_arm64.deb
sudo apt install -y ./zelavis_1.0.1.alpha.2_arm64.deb
```

Installing through `apt install ./<package>.deb` rather than `dpkg` directly
allows the system package manager to verify dependencies and maintain package
database integrity.

## Manual release archive (.tar.gz)

The standalone `.tar.gz` and `.zip` archives are self-contained and suitable for
manual download, SFTP upload, or air-gapped environments:

```bash
# 1. Download and extract the matching archive
curl -fsSLO https://github.com/zelavis/zelavis/releases/latest/download/zelavis-linux-x64.tar.gz
tar -xzf zelavis-linux-x64.tar.gz
cd zelavis-*

# 2. Run the archive installer
sudo ZELAVIS_ENABLE_AGENT=1 ./install.sh
```

The installer places versioned releases under `/opt/zelavis/releases/<version>`,
symlinks `/opt/zelavis/current`, links the CLI binary to `/usr/local/bin/zelavis`,
creates the dedicated `zelavis` system user, and enables the systemd services.

## npm (Self-managed Node runtime)

Use npm when you deliberately manage the host runtime yourself:

```bash
npm install --global zelavis
zelavis serve
```

The npm path requires Node.js 24 or newer. It exposes the same CLI as the
operating-system packages.

Both paths install a command called `zelavis`. The archive installer refuses to
replace a `zelavis` binary it did not create rather than overwriting an npm install
silently. `zelavis --version` prints which installation is currently active:

```bash
zelavis --version
# 1.0.1-alpha.2
# packaged installation at /opt/zelavis
```

Platform data is written to `/var/lib/zelavis` for packaged systemd services, or
to `~/.local/share/zelavis` for user-run npm processes.

---

## First-Run Setup & Ownership Claim

When Zelavis finishes installing, it starts its HTTP service listener at
`http://0.0.0.0:3000` (listening on port 3000).

Public web ports (`80` and `443`) intentionally remain dormant during first install:
Zelavis never hijacks public HTTP/HTTPS ports before you have explicitly configured
your domain and verified DNS.

A one-time **bootstrap token** is generated during installation and printed in
your terminal output (also saved in `/var/lib/zelavis/system/bootstrap.token` with
strict `0600` permissions).

You have two primary ways to access the graphical onboarding wizard, plus an
interactive terminal option:

### Option A: Direct Browser Access (Without SSH Tunnel)

If your server's cloud firewall allows inbound traffic on port 3000 (which is the
default on new cloud instances like Hetzner CX22 unless an external firewall profile
is attached):

1. Open your browser and navigate directly to:
   ```text
   http://<your-server-ip>:3000/zelavis/setup
   ```
2. Paste the **bootstrap token** from `/var/lib/zelavis/system/bootstrap.token`.
3. Enter your administrator email and password to claim the **Owner** account.
4. In the **Edge Onboarding** step, enter your domain name (e.g. `app.example.com` or `example.com`).
   Make sure your domain's DNS A/AAAA record points to your server's public IP.
5. Select **Managed TLS** and click **Continue**.
6. Zelavis performs DNS preflight verification, requests automated Let's Encrypt
   certificates using pure RFC 8555 ACME v2, and switches Traefik to serve production
   traffic on standard ports **80** and **443**.
7. Once completed, port 3000 is no longer needed—you can close it in your firewall
   and access your dashboard directly over secure HTTPS at:
   ```text
   https://yourdomain.com/zelavis
   ```

### Option B: Secure Access via SSH Port Forwarding (With SSH Tunnel)

Use an SSH tunnel if port 3000 is blocked by a cloud firewall, or if you prefer not
transmitting initial setup credentials over unencrypted HTTP over the public internet
before TLS is active:

1. On your **local machine**, open an SSH tunnel using your preferred SSH authentication method:

   **Using an explicit SSH private key (recommended for cloud servers like Hetzner/AWS):**
   ```bash
   ssh -i ~/.ssh/id_ed25519 -L 3000:localhost:3000 root@<your-server-ip>
   ```
   *(Replace `~/.ssh/id_ed25519` with the path to your private key, such as `~/.ssh/id_rsa`).*

   **Using a non-root user (e.g. `ubuntu` or `debian`):**
   ```bash
   ssh -i ~/.ssh/id_ed25519 -L 3000:localhost:3000 ubuntu@<your-server-ip>
   ```

   **Using a non-standard SSH port (e.g. port 2222):**
   ```bash
   ssh -i ~/.ssh/id_ed25519 -p 2222 -L 3000:localhost:3000 root@<your-server-ip>
   ```

   **Using an SSH config host alias (`~/.ssh/config`):**
   ```bash
   # If ~/.ssh/config defines Host my-server:
   ssh -L 3000:localhost:3000 my-server
   ```

   *(Keep this terminal session open while you perform setup).*

2. Open your local web browser to:
   ```text
   http://localhost:3000/zelavis/setup
   ```
3. Enter the **bootstrap token** from `/var/lib/zelavis/system/bootstrap.token` and configure your Owner credentials.
4. Select **Managed TLS** and provide your domain.
5. When the wizard confirms your domain is live and certificates are active, close
   the SSH tunnel (`Ctrl+C` or exit the SSH session).
6. Access your platform directly at:
   ```text
   https://yourdomain.com/zelavis
   ```

### Option C: Interactive Terminal Setup (CLI)

If you are logged into the server over SSH and prefer completing setup directly in the
terminal without a web browser:

```bash
zelavis setup
```

The CLI wizard prompts for the bootstrap token, creates the first Owner, runs
DNS preflight checks on your domain, issues certificates, and activates Edge Traefik
routing.

For unattended automation or cloud-init scripts, use the non-interactive equivalent:
```bash
zelavis bootstrap --email admin@example.com --password-stdin < my-password.txt
```

---

## Completely uninstall a packaged installation

To return a host to a clean state where the Zelavis installer can be run again
from scratch, inspect the scope first with a dry run:

```bash
sudo zelavis uninstall --all --dry-run
```

Then execute the complete removal with the confirmation phrase:

```bash
sudo zelavis uninstall --all --confirm DELETE-ALL-ZELAVIS-DATA
```

This:
- Stops and disables `zelavis.service`, `zelavis-agent.service`, and `zelavis-traefik.service`.
- Removes `/opt/zelavis`, `/usr/local/bin/zelavis`, and systemd unit files.
- Removes configuration, signed host operations, and certificates.
- Completely deletes `/var/lib/zelavis`, including all project databases and runtimes.
- Removes the `zelavis` system account.
