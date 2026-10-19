// A transient exec gate, not a per-workload holder. The parent publishes and
// flushes the process record before releasing this gate. If it dies earlier,
// EOF prevents the customer's executable from ever starting without a record.
import { accessSync, constants, readSync, statSync } from "node:fs";
import { resolve } from "node:path";

const [nonce, executable, ...args] = process.argv.slice(2);
if (!nonce || !/^[A-Za-z0-9_-]{43}$/.test(nonce) || !executable || !process.execve) process.exit(125);
let activation = "";
const byte = Buffer.alloc(1);
while (activation.length <= 43) {
  if (readSync(0, byte, 0, 1, null) !== 1) process.exit(125);
  if (byte[0] === 10) break;
  activation += byte.toString("ascii");
}
if (activation !== nonce) process.exit(125);
// Read exactly the gate bytes. Interactive input remains in the kernel pipe;
// ordinary workloads receive EOF because the parent closes its writer.
// execve has no PATH search. Match spawn's executable lookup for recipes whose
// verified command catalogue names a program rather than an absolute file.
let file = executable;
if (!executable.includes("/")) {
  const directories = (process.env.PATH ?? "/usr/bin:/bin").split(":");
  const found = directories.find(directory => {
    const candidate = resolve(directory || ".", executable);
    try { accessSync(candidate, constants.X_OK); return statSync(candidate).isFile(); }
    catch (cause) {
      if (cause instanceof Error && "code" in cause && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(cause.code))) return false;
      throw cause;
    }
  });
  if (found === undefined) { process.stderr.write("Project executable was not found on its PATH.\n"); process.exit(127); }
  file = resolve(found || ".", executable);
}
process.execve(file, [executable, ...args], process.env);
