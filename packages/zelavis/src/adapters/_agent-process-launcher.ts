// A transient exec gate, not a per-workload holder. The parent publishes and
// flushes the process record before releasing this gate. If it dies earlier,
// EOF prevents the customer's executable from ever starting without a record.
import { readSync } from "node:fs";

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
process.execve(executable, [executable, ...args], process.env);
