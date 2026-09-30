import { describe, expect, it } from "vitest"

import { readServerSentEvents } from "./sse"

function streamOf(chunks: (string | Uint8Array)[]) {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk)
      }
      controller.close()
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const events = []
  for await (const event of readServerSentEvents(stream)) events.push(event)
  return events
}

describe("readServerSentEvents", () => {
  it("reads frames split across arbitrary chunk boundaries", async () => {
    const text = 'event: text\ndata: {"delta":"Hel"}\n\nevent: done\ndata: {"ok":true}\n\n'
    const chunks = text.match(/[\s\S]{1,7}/g)!
    expect(await collect(streamOf(chunks))).toEqual([
      { event: "text", data: { delta: "Hel" } },
      { event: "done", data: { ok: true } },
    ])
  })

  it("keeps a multi-byte character that a chunk splits in half", async () => {
    const bytes = new TextEncoder().encode('event: text\ndata: {"delta":"é"}\n\n')
    const split = bytes.indexOf(0xc3) + 1
    expect(await collect(streamOf([bytes.slice(0, split), bytes.slice(split)]))).toEqual([
      { event: "text", data: { delta: "é" } },
    ])
  })

  it("accepts CRLF, a final frame without a blank line, and skips comments and junk", async () => {
    expect(
      await collect(
        streamOf([': hi\r\n\r\nevent: text\r\ndata: {"delta":"a"}\r\n\r\ndata: nope\n\nevent: done\ndata: {"n":1}'])
      ),
    ).toEqual([
      { event: "text", data: { delta: "a" } },
      { event: "done", data: { n: 1 } },
    ])
  })
})
