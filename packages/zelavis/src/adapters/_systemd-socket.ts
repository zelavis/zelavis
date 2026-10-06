/**
 * A listening socket handed over by systemd (socket activation).
 *
 * systemd passes sockets as file descriptors starting at 3 and says how many in
 * `LISTEN_FDS`, but only to the process named in `LISTEN_PID`, so a variable
 * inherited by a child process names someone else and must be ignored. Taking
 * the socket and then clearing the variables keeps the Projects and the Agent
 * this Platform starts from mistaking descriptor 3 for theirs.
 */
export const SYSTEMD_FIRST_FD = 3;

export interface InheritedSocket {
  readonly fd: number;
}

/** The inherited listening socket for this process, if systemd gave it one. Clears the variables when it does. */
export function takeInheritedSocket(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): InheritedSocket | undefined {
  const count = Number(env.LISTEN_FDS);
  const ours = env.LISTEN_PID === String(pid) && Number.isInteger(count) && count >= 1;
  delete env.LISTEN_FDS;
  delete env.LISTEN_PID;
  delete env.LISTEN_FDNAMES;
  return ours ? { fd: SYSTEMD_FIRST_FD } : undefined;
}
