import { Socket } from "node:net";
import { Effect } from "effect";

/** Whether something accepts a connection on this loopback port within a second. */
export const loopbackPortAccepts = (port: number): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const socket = new Socket();
    const settle = (accepted: boolean) => { socket.destroy(); resume(Effect.succeed(accepted)); };
    socket.setTimeout(1000);
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.once("timeout", () => settle(false));
    socket.connect(port, "127.0.0.1");
    return Effect.sync(() => socket.destroy());
  });
