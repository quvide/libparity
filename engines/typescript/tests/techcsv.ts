// Tech-count CSV for a pack directory: runs the engine's natural (override-free)
// interpretation of every song's Challenge chart and proposes a tech notation.
//   npx tsx tests/techcsv.ts <packDir> <out.csv> [difficulty]
import * as fs from "node:fs"
import * as path from "node:path"
import { loadSSC, smToSsc } from "./ssc"
import { runEngine } from "./engine"
import { ParityInternals } from "../src/index"
import type { Notedata } from "../src/index"

const [packDir, outCsv, difficulty = "Challenge"] = process.argv.slice(2)
if (!packDir || !outCsv) {
  console.error("usage: techcsv <packDir> <out.csv> [difficulty]")
  process.exit(2)
}

const TECHS = ["XO", "FS", "SS", "JA", "BR", "DS", "KS", "BT", "SJ", "HS", "JU"]
// notation = engine tech categories minus JU (jumps aren't tech). Densities are
// per 100 rows; distinctive techs get half thresholds since a few of them
// already characterise a chart.
const NOTATED = TECHS.filter(t => t !== "JU")
const HALF_THRESHOLD = new Set(["XO", "SS", "KS", "BT", "HS"])
const HEAVY = 6
const MAIN = 2.5
const SIDE = 0.6

function notation(techs: Record<string, number>, rows: number) {
  const scored = NOTATED.map(t => {
    const scale = HALF_THRESHOLD.has(t) ? 0.5 : 1
    return { t, d: ((techs[t] ?? 0) / rows) * 100 / scale }
  }).sort((a, b) => b.d - a.d)
  const main = scored.filter(s => s.d >= MAIN).map(s => (s.d >= HEAVY ? `${s.t}+` : s.t))
  const side = scored.filter(s => s.d >= SIDE && s.d < MAIN).map(s => `${s.t}-`)
  return { main: main.join(" "), side: side.join(" "), full: [...main, ...side].join(" ") || "(none)" }
}

const csvCell = (v: string | number) => {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const header = [
  "Title", "Stepartist", "Meter", "File", "Notes", "Rows", "Duration (s)", "Jumps", "Holds", "Mines",
  "XO (crossover entries)", "Crossed rows", "FS", "SS", "JA", "BR", "DS", "DS unmarked", "KS", "BT", "SJ", "HS", "JU",
  "Candles", "Ambiguous rows", "Main techs", "Side techs", "Tech notation",
]
const lines = [header.map(csvCell).join(",")]

const folders = fs
  .readdirSync(packDir)
  .filter(f => fs.statSync(path.join(packDir, f)).isDirectory())
  .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))

for (const folder of folders) {
  const dir = path.join(packDir, folder)
  const files = fs.readdirSync(dir)
  const ssc = files.find(f => f.toLowerCase().endsWith(".ssc"))
  const sm = files.find(f => f.toLowerCase().endsWith(".sm"))
  const chartFile = ssc ?? sm
  if (!chartFile) continue
  const chartPath = path.join(dir, chartFile)

  let chart
  try {
    chart = loadSSC(chartPath, { difficulty })
  } catch (e) {
    console.error(`${folder}: ${(e as Error).message}`)
    continue
  }
  const natural = chart.notes.map(n => {
    const { parity, ...rest } = n
    return rest as typeof n
  })
  const run = runEngine(natural, chart.lastBeat)
  const internals = new ParityInternals("dance-single")
  const candles = internals.compute(-1, chart.lastBeat + 4, natural as Notedata)?.candles.size ?? 0

  const errors: Record<string, number> = {}
  for (const r of run.rows) for (const e of r.errors) errors[e] = (errors[e] ?? 0) + 1
  const real = natural.filter(n => n.type !== "Mine" && !n.fake)
  const perBeat = new Map<number, number>()
  for (const n of real) perBeat.set(n.beat, (perBeat.get(n.beat) ?? 0) + 1)
  const secs = real.map(n => n.second)

  const raw = fs.readFileSync(chartPath, "utf8")
  const content = sm && !ssc ? smToSsc(raw) : raw
  const credits = [...content.matchAll(/#CREDIT:([^;]*);/g)].map(m => m[1].trim()).filter(Boolean)
  const stepartist = credits.pop() ?? folder.replace(/.*\[(.*)\].*/, "$1")
  const meter = content.match(/#METER:([^;]*);/)?.[1].trim() ?? ""
  const note = notation(run.techCounts, run.rows.length)

  lines.push(
    [
      chart.title, stepartist, meter, path.basename(ssc ?? sm!),
      real.length, run.rows.length, Math.round(Math.max(...secs) - Math.min(...secs)),
      [...perBeat.values()].filter(c => c >= 2).length,
      natural.filter(n => (n.type === "Hold" || n.type === "Roll") && !n.fake).length,
      natural.filter(n => n.type === "Mine").length,
      run.techCounts.XO ?? 0, run.facings.filter(f => f !== "F").length,
      ...TECHS.filter(t => t !== "XO" && t !== "DS").slice(0, 4).map(t => run.techCounts[t] ?? 0),
      run.techCounts.DS ?? 0, errors.DS ?? 0,
      ...["KS", "BT", "SJ", "HS", "JU"].map(t => run.techCounts[t] ?? 0),
      candles, errors.AM ?? 0,
      note.main, note.side, note.full,
    ].map(csvCell).join(",")
  )
  for (const w of chart.warnings) if (!w.startsWith("failed to parse data.sme")) console.error(`${folder}: ${w}`)
}
fs.writeFileSync(outCsv, lines.join("\n") + "\n")
console.log(`${lines.length - 1} charts -> ${outCsv}`)
