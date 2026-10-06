export interface ServerSentEvent {
  event: string
  data: unknown
}

/**
 * Reads `event:`/`data:` frames from a response body. A frame ends at a blank
 * line, and a chunk may end anywhere, including mid-line or mid-character.
 */
export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ""

  function* frames(final: boolean): Generator<ServerSentEvent> {
    for (;;) {
      const boundary = pending.indexOf("\n\n")
      if (boundary < 0 && !(final && pending.trim())) return
      const frame = boundary < 0 ? pending : pending.slice(0, boundary)
      pending = boundary < 0 ? "" : pending.slice(boundary + 2)
      let event = "message"
      const data: string[] = []
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim()
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
      }
      if (data.length === 0) continue
      try {
        yield { event, data: JSON.parse(data.join("\n")) }
      } catch {
        // A malformed frame cannot silently discard an assistant delta.
        throw new Error("The server sent a malformed JSON event frame.");
      }
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
      yield* frames(false)
    }
    pending += decoder.decode()
    yield* frames(true)
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
