/**
 * Reads `event:`/`data:` frames from a response body. A frame ends at a blank line, and a chunk may end anywhere,
 * including mid-line or mid-character. A malformed frame is an error rather than a silently dropped delta.
 */
export interface ServerSentEvent { event: string; data: unknown }

/** Splits what has arrived into complete frames and the unfinished rest. */
export function parseFrames(pending: string, final = false): { frames: ServerSentEvent[]; rest: string } {
  const frames: ServerSentEvent[] = [];
  let rest = pending;
  for (;;) {
    const boundary = rest.indexOf("\n\n");
    if (boundary < 0 && !(final && rest.trim())) break;
    const frame = boundary < 0 ? rest : rest.slice(0, boundary);
    rest = boundary < 0 ? "" : rest.slice(boundary + 2);
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length === 0) continue;
    try { frames.push({ event, data: JSON.parse(data.join("\n")) as unknown }); }
    catch { throw new Error("The server sent a malformed JSON event frame."); }
  }
  return { frames, rest };
}

export async function* readServerSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      const parsed = parseFrames(pending);
      pending = parsed.rest;
      yield* parsed.frames;
    }
    pending += decoder.decode();
    yield* parseFrames(pending, true).frames;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
