import { Worker } from "node:worker_threads"

export interface PoolResult {
  idx: number
  line: string
}

export async function* mapInWorkers(
  lines: AsyncIterable<string>,
  concurrency: number,
  heapMb: number,
  workerData: unknown,
  onFailure: (line: string, err: Error) => string
): AsyncGenerator<PoolResult> {
  const source = lines[Symbol.asyncIterator]()
  const done: PoolResult[] = []
  const workers = new Set<Worker>()
  let wake: (() => void) | undefined
  let next = 0
  let busy = 0
  let exhausted = false

  const feed = async (w: Worker, job: { current?: PoolResult }) => {
    const item = exhausted ? undefined : await source.next()
    if (!item || item.done) {
      exhausted = true
      job.current = undefined
      return
    }
    busy++
    job.current = { idx: next++, line: item.value }
    w.postMessage(job.current)
  }

  const spawn = () => {
    const w = new Worker(new URL("./workerEntry.mjs", import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: heapMb },
      workerData,
    })
    const job: { current?: PoolResult } = {}
    workers.add(w)
    w.on("message", (msg: PoolResult) => {
      busy--
      done.push(msg)
      void feed(w, job).finally(() => wake?.())
    })
    w.on("error", err => {
      workers.delete(w)
      if (job.current) {
        busy--
        done.push({ idx: job.current.idx, line: onFailure(job.current.line, err) })
      }
      void w.terminate()
      if (!exhausted) spawn()
      wake?.()
    })
    void feed(w, job).finally(() => wake?.())
  }

  for (let i = 0; i < Math.max(1, concurrency); i++) spawn()

  try {
    while (true) {
      if (done.length) {
        yield done.shift()!
        continue
      }
      if (exhausted && busy === 0) break
      await new Promise<void>(resolve => (wake = resolve))
    }
  } finally {
    for (const w of workers) void w.terminate()
  }
}
