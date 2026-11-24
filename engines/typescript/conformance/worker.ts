import { parentPort, workerData } from "node:worker_threads"
import { computeCounts, computeReference, Case } from "./format"

const port = parentPort
if (!port) throw new Error("worker.ts must run as a worker thread")

port.on("message", (msg: { idx: number; line: string } | null) => {
  if (msg === null) {
    port.close()
    return
  }
  const c = JSON.parse(msg.line) as Case
  let line: string
  try {
    line = JSON.stringify(workerData.counts ? computeCounts(c) : computeReference(c, workerData.batch))
  } catch (err) {
    line = JSON.stringify({ id: c.id, error: (err as Error).message })
  }
  port.postMessage({ idx: msg.idx, line })
})
