import { Socket } from "node:net";
import { Effect } from "effect";

/**
 * Whether something accepts a connection on this loopback port within a second. With `greeting`, whether the
 * server also speaks first (MySQL and MariaDB send a handshake at once): a published container port accepts
 * before the server behind it is up and then closes without a byte, so only the greeting proves it is ready.
 */
export const loopbackPortAccepts = (port: number, options: { readonly greeting?: boolean } = {}): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const socket = new Socket();
    const settle = (accepted: boolean) => { socket.destroy(); resume(Effect.succeed(accepted)); };
    socket.setTimeout(1000);
    if (options.greeting === true) {
      socket.once("data", () => settle(true));
      socket.once("close", () => settle(false));
    } else {
      socket.once("connect", () => settle(true));
    }
    socket.once("error", () => settle(false));
    socket.once("timeout", () => settle(false));
    socket.connect(port, "127.0.0.1");
    return Effect.sync(() => socket.destroy());
  });
