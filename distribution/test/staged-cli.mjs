import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Supply the packaged CLI omitted by the old shell-only fixtures. */
export async function stageCli(release) {
  const pkg = fileURLToPath(new URL("../../packages/zelavis/", import.meta.url));
  await mkdir(join(release, "platform"), { recursive: true });
  await cp(join(pkg, "dist"), join(release, "platform", "dist"), { recursive: true });
  await writeFile(join(release, "platform", "package.json"), JSON.stringify({ type: "module", version: "1.0.0" }));
  await symlink(join(pkg, "node_modules"), join(release, "platform", "node_modules"));
}

/** A currently free loopback port, so tests never depend on 3000 being unused. */
export async function freePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}
