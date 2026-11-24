import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { parseArgs } from "node:util"
import { loadSimfileCharts } from "../tests/ssc"
import { computeCounts, computeReference, Case, CaseNote, Result } from "./format"
import { compareCountResults, compareResults } from "./compare"
import { compareDescriptions, describe } from "./describe"
import { lineReader, lineWriter, readLines, readRecords, writeLines } from "./ndjson"
import { mapInWorkers } from "./pool"
import { createProgress, Progress } from "../tests/progress"

// import.meta.dirname: node >= 20.11, the minimum in run.py's dependencies(); keep in sync
const root = path.resolve(import.meta.dirname, "../../..")
const corpusDir = path.join(root, "corpus")
const defaults = {
  inputs: path.join(corpusDir, "inputs.ndjson.gz"),
  reference: path.join(corpusDir, "reference.ndjson.gz"),
}

const defaultHeapMb = (jobs: number) =>
  Math.min(4096, Math.floor((os.totalmem() * 0.7) / jobs / 2 ** 20))

const usage = `usage:
  conformance extract <songsDir>... [--out FILE] [--steps-type T]
      cases from every .ssc/.sm under the dirs (default out: corpus/inputs.ndjson.gz)
  conformance reference [--in FILE] [--out FILE] [--sample N] [-j N] [--heap MB] [--incremental] [--counts]
      run the TS engine over the cases (default out: corpus/reference.ndjson.gz) with
      computeBatch(), compute() with --incremental or analyzeCounts() with --counts;
      a case that fails or exceeds the per-worker heap is recorded as an error
  conformance serve [--incremental] [--counts]
      the TS engine as a port: cases on stdin, results on stdout
  conformance check [--in FILE] [--ref FILE] [--out FILE] [--sample N] [--limit N] [--counts] -- <command...>
      run a port over the cases and diff it against the reference; with --counts,
      run it with --counts (analyzeCounts) and compare only noPath and the counts
  conformance diff <expected> <actual> [--in FILE] [--sample N] [--limit N] [--counts]
      diff two result files (only noPath and the counts with --counts)
  conformance describe
      the TS engine's public constants and edge cases as JSON (describe.ts)
  conformance check-api -- <command...>
      run a port with --describe and compare it with the TS engine's
  --sample N: only the N cases with the lowest hash of their id, the same
      cases on every run; diff compares only those`

function simfiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    const entries = fs.readdirSync(d, { withFileTypes: true })
    const names = entries.filter(e => e.isFile()).map(e => e.name)
    const ssc = names.filter(n => n.toLowerCase().endsWith(".ssc"))
    const sm = names.filter(n => n.toLowerCase().endsWith(".sm"))
    for (const f of ssc.length ? ssc : sm) out.push(path.join(d, f))
    for (const e of entries) if (e.isDirectory()) walk(path.join(d, e.name))
  }
  walk(dir)
  return out.sort()
}

function toCaseNote(n: ReturnType<typeof loadSimfileCharts>[number]["notes"][number]): CaseNote {
  const note: CaseNote = { beat: n.beat, col: n.col, type: n.type, second: n.second }
  if (n.hold !== undefined) note.hold = n.hold
  if (n.warped) note.warped = true
  if (n.fake) note.fake = true
  if (n.parity?.override !== undefined) note.override = n.parity.override
  if (n.parity?.holdOverrides) note.holdOverrides = n.parity.holdOverrides
  return note
}

async function extract(dirs: string[], out: string, stepsType: string) {
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const writer = writeLines(out)
  let cases = 0
  let failed = 0
  for (const dir of dirs) {
    const base = path.basename(path.resolve(dir))
    for (const file of simfiles(dir)) {
      let charts
      try {
        charts = loadSimfileCharts(file, stepsType)
      } catch (err) {
        failed++
        console.error(`${file}: ${(err as Error).message}`)
        continue
      }
      for (const [i, chart] of charts.entries()) {
        if (!chart.notes.length) continue
        const id = `${base}/${path.relative(dir, file)}#${i}:${chart.difficulty}`
        const c: Case = { id, stepsType, notes: chart.notes.map(toCaseNote) }
        await writer.write(JSON.stringify(c))
        cases++
      }
    }
  }
  await writer.close()
  console.error(`${cases} cases -> ${out}${failed ? ` (${failed} files failed to load)` : ""}`)
}

type Cases = (() => AsyncIterable<string>) & { count?: () => Promise<number> }

// progress for a run over the cases; the total arrives once the cases are counted
function caseProgress(task: string, cases: Cases): Progress {
  const progress = createProgress(task)
  void cases.count?.().then(n => progress.setTotal(n), () => {})
  return progress
}

const caseId = (line: string) => JSON.parse(/^\{"id":("(?:[^"\\]|\\.)*")/.exec(line)![1]) as string

function fnv1a(text: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return h >>> 0
}

async function sampleIds(input: string, size: number): Promise<Set<string>> {
  const ranked: [number, string][] = []
  for await (const line of readLines(input)) {
    const id = caseId(line)
    ranked.push([fnv1a(id), id])
  }
  ranked.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  return new Set(ranked.slice(0, size).map(([, id]) => id))
}

function sampledCases(input: string, ids: Set<string> | undefined): Cases {
  if (ids) {
    const cases: Cases = async function* () {
      for await (const line of readLines(input)) if (ids.has(caseId(line))) yield line
    }
    cases.count = async () => ids.size
    return cases
  }
  const cases: Cases = () => readLines(input)
  cases.count = async () => {
    let n = 0
    for await (const _ of readLines(input)) n++
    return n
  }
  return cases
}

function failedCase(line: string, err: Error): string {
  const { id } = JSON.parse(line) as Case
  return JSON.stringify({ id, error: (err as NodeJS.ErrnoException).code ?? err.message })
}

const isFailure = (line: string) => line.includes('"error":')

async function reference(cases: Cases, out: string, jobs: number, heapMb: number, batch: boolean, counts = false) {
  const started = Date.now()
  const lines: string[] = []
  let count = 0
  const progress = caseProgress(counts ? "counts" : "reference", cases)
  for await (const r of mapInWorkers(cases(), jobs, heapMb, { batch, counts }, failedCase)) {
    lines[r.idx] = r.line
    progress.update(++count)
  }
  progress.clear()

  const retry = lines.flatMap((line, i) => (isFailure(line) ? [i] : []))
  if (retry.length) {
    console.error(`retrying ${retry.length} failed cases one at a time`)
    const wanted = new Set(retry)
    async function* retryLines() {
      let i = 0
      for await (const line of cases()) if (wanted.has(i++)) yield line
    }
    const fullHeapMb = Math.floor((os.totalmem() * 0.7) / 2 ** 20)
    for await (const r of mapInWorkers(retryLines(), 1, fullHeapMb, { batch, counts }, failedCase)) {
      lines[retry[r.idx]] = r.line
    }
  }

  const writer = writeLines(out)
  for (const line of lines) {
    if (isFailure(line)) console.error(line)
    await writer.write(line)
  }
  await writer.close()
  const failed = lines.filter(isFailure).length
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  console.error(`${lines.length} results -> ${out} in ${secs}s, ${failed} failed`)
}

async function serve(batch: boolean, counts: boolean) {
  const out = lineWriter(process.stdout)
  for await (const line of lineReader(process.stdin)) {
    if (!line) continue
    const c = JSON.parse(line) as Case
    await out.write(JSON.stringify(counts ? computeCounts(c) : computeReference(c, batch)))
  }
  await out.close()
}

async function readResults(file: string): Promise<Map<string, Result>> {
  const results = new Map<string, Result>()
  for await (const r of readRecords<Result>(file)) results.set(r.id, r)
  return results
}

async function diff(expectedFile: string, actualFile: string, input: string, limit: number, only?: Set<string>, counts = false) {
  const compare = (ref: Result, got: Result, notes?: CaseNote[]) =>
    counts ? compareCountResults(ref, got) : compareResults(ref, got, notes)
  const expected = await readResults(expectedFile)
  if (only) for (const id of expected.keys()) if (!only.has(id)) expected.delete(id)
  const actual = await readResults(actualFile)
  const divergent = new Map<string, Result>()
  let missing = 0
  let skipped = 0
  for (const [id, ref] of expected) {
    if (ref.error) {
      skipped++
      continue
    }
    const got = actual.get(id)
    if (!got) missing++
    else if (compare(ref, got).length) divergent.set(id, got)
  }
  const extra = [...actual.keys()].filter(id => !expected.has(id)).length

  const notes = new Map<string, CaseNote[]>()
  if (divergent.size && fs.existsSync(input)) {
    for await (const c of readRecords<Case>(input)) {
      if (divergent.has(c.id)) notes.set(c.id, c.notes)
    }
  }
  let shown = 0
  for (const [id, got] of divergent) {
    if (shown++ >= limit) break
    console.log(`DIFF ${id}`)
    for (const d of compare(expected.get(id)!, got, notes.get(id))) console.log(`  ${d}`)
  }
  if (divergent.size > limit) console.log(`... ${divergent.size - limit} more`)

  const compared = expected.size - skipped
  const agree = compared - divergent.size - missing
  console.log(
    `${agree}/${compared} agree, ${divergent.size} differ, ${missing} missing, ${extra} unexpected` +
      (skipped ? ` (${skipped} cases skipped: the reference failed)` : "")
  )
  return divergent.size || missing || extra ? 1 : 0
}

async function runPort(command: string[], cases: Cases, out: string) {
  const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "inherit"] })
  const exited = new Promise<number>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", code => resolve(code ?? 1))
  })
  const writer = writeLines(out)
  // engines/<name>/run is named by its directory
  const name = path.basename(command[0]) === "run" ? path.basename(path.dirname(command[0])) : path.basename(command[0])
  const progress = caseProgress(`check ${name}`, cases)
  let count = 0
  const collected = (async () => {
    for await (const line of lineReader(child.stdout)) {
      if (!line) continue
      await writer.write(line)
      progress.update(++count)
    }
    progress.clear()
    await writer.close()
  })()
  // a port that exits early (a failed build, a crash) closes its stdin: stop
  // feeding it and report its exit code rather than the EPIPE
  child.stdin.on("error", () => {})
  const stdin = lineWriter(child.stdin)
  const fed = (async () => {
    for await (const line of cases()) await stdin.write(line)
    await stdin.close()
  })()
  fed.catch(() => {})
  const code = await Promise.race([fed.then(() => exited), exited])
  await collected
  if (code !== 0) throw new Error(`${command.join(" ")} exited with ${code}`)
}

function checkApi(command: string[]) {
  const run = spawnSync(command[0], [...command.slice(1), "--describe"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  })
  if (run.status !== 0) {
    console.error(`${command.join(" ")} --describe exited with ${run.status}`)
    return 1
  }
  const ref = JSON.parse(JSON.stringify(describe()))
  const diffs = compareDescriptions(ref, JSON.parse(run.stdout))
  for (const d of diffs) console.log(d)
  console.log(diffs.length ? `${diffs.length} API differences` : "API agrees")
  return diffs.length ? 1 : 0
}

async function main() {
  const argv = process.argv.slice(2)
  const dashdash = argv.indexOf("--")
  const command = dashdash >= 0 ? argv.slice(dashdash + 1) : []
  const { values, positionals } = parseArgs({
    args: dashdash >= 0 ? argv.slice(0, dashdash) : argv,
    allowPositionals: true,
    options: {
      in: { type: "string", default: defaults.inputs },
      ref: { type: "string", default: defaults.reference },
      out: { type: "string" },
      "steps-type": { type: "string", default: "dance-single" },
      jobs: { type: "string", short: "j", default: String(os.availableParallelism()) },
      heap: { type: "string" },
      incremental: { type: "boolean" },
      counts: { type: "boolean" },
      limit: { type: "string", default: "20" },
      sample: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  })
  const [sub, ...rest] = positionals
  const limit = Number(values.limit)
  const jobs = Number(values.jobs)
  const sample = values.sample === undefined ? undefined : await sampleIds(values.in!, Number(values.sample))

  switch (values.help ? undefined : sub) {
    case "extract":
      if (!rest.length) break
      return extract(rest, values.out ?? defaults.inputs, values["steps-type"]!)
    case "reference":
      return reference(sampledCases(values.in!, sample), values.out ?? defaults.reference, jobs, Number(values.heap ?? defaultHeapMb(jobs)), !values.incremental, !!values.counts)
    case "serve":
      return serve(!values.incremental, !!values.counts)
    case "check": {
      if (!command.length) break
      const out = values.out ?? path.join(corpusDir, `${path.basename(command[0])}${values.counts ? "-counts" : ""}.ndjson.gz`)
      const portCommand = values.counts ? [...command, "--counts"] : command
      await runPort(portCommand, sampledCases(values.in!, sample), out)
      process.exitCode = await diff(values.ref!, out, values.in!, limit, sample, !!values.counts)
      return
    }
    case "describe":
      console.log(JSON.stringify(describe()))
      return
    case "check-api":
      if (!command.length) break
      process.exitCode = checkApi(command)
      return
    case "diff":
      if (rest.length !== 2) break
      process.exitCode = await diff(rest[0], rest[1], values.in!, limit, sample, !!values.counts)
      return
  }
  console.error(usage)
  process.exitCode = 2
}

await main()
