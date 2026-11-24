import { once } from "node:events"
import * as fs from "node:fs"
import * as readline from "node:readline"
import * as zlib from "node:zlib"
import { Readable, Writable } from "node:stream"

const isGzip = (path: string) => path.endsWith(".gz")

export function lineReader(input: Readable): AsyncIterable<string> {
  return readline.createInterface({ input, crlfDelay: Infinity })
}

export async function* readLines(path: string): AsyncGenerator<string> {
  const file = fs.createReadStream(path)
  for await (const line of lineReader(isGzip(path) ? file.pipe(zlib.createGunzip()) : file)) {
    if (line) yield line
  }
}

export async function* readRecords<T>(path: string): AsyncGenerator<T> {
  for await (const line of readLines(path)) yield JSON.parse(line) as T
}

export interface LineWriter {
  write(line: string): Promise<void>
  close(): Promise<void>
}

export function writeLines(path: string): LineWriter {
  const file = fs.createWriteStream(path)
  const out: Writable = isGzip(path) ? zlib.createGzip() : file
  if (out !== file) out.pipe(file)
  return lineWriter(out, new Promise(resolve => file.on("close", () => resolve(undefined))))
}

export function lineWriter(out: Writable, closed?: Promise<unknown>): LineWriter {
  return {
    write: async line => {
      if (!out.write(line + "\n")) await once(out, "drain")
    },
    close: async () => {
      await new Promise<void>(resolve => out.end(resolve))
      await closed
    },
  }
}
