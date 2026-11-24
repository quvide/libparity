import {
  Foot,
  ParityInternals,
  TECH_ERROR_INFO,
  TECH_INFO,
  analysisRange,
  analyzeCounts,
  isSupportedStepsType,
  toAnalysis,
} from "../src/index"
import type { AnalysisRow } from "../src/index"
import type { CodeInfo, FootOverride, NoteType, Notedata } from "../src/index"

export const FORMAT_VERSION = 3

export interface CaseNote {
  beat: number
  col: number
  type: NoteType
  second: number
  hold?: number
  warped?: true
  fake?: true
  override?: FootOverride
  holdOverrides?: { beat: number; foot: FootOverride }[]
}

export interface Case {
  id: string
  stepsType: string
  notes: CaseNote[]
}

export type Row = [beat: number, techs: string[], errors: string[]]

export interface Result {
  id: string
  error?: string
  noPath?: true
  feet: string
  rowCount: number
  rows: Row[]
  mineRows: [beat: number, techs: string[]][]
  holdOwnership: [note: number, timeline: [beat: number, foot: string][]][]
  candles: [beat: number, foot: string][]
  stance: string
  angleChecksum: number
  counts: Record<string, number>
  errorCounts: Record<string, number>
}

export const FOOT_CHARS = ".LlRr"

// four characters per row, one per foot part (L l R r): its column in base 36, "." when lifted
function stance(rows: AnalysisRow[]) {
  let out = ""
  for (const r of rows)
    for (let f = 1; f < 5; f++) out += r.footColumns[f] < 0 ? "." : r.footColumns[f].toString(36)
  return out
}

// sum of (row index + 1) * angle, accumulated in row order
function angleChecksum(rows: AnalysisRow[]) {
  let sum = 0
  rows.forEach((r, i) => (sum += (i + 1) * r.angle))
  return sum
}

function toNotedata(notes: CaseNote[]): Notedata {
  return notes.map(n => {
    const parity =
      n.override !== undefined || n.holdOverrides
        ? { override: n.override, holdOverrides: n.holdOverrides }
        : undefined
    const base = {
      beat: n.beat,
      col: n.col,
      second: n.second,
      warped: n.warped ?? false,
      fake: n.fake ?? false,
      parity,
    }
    return n.type === "Hold" || n.type === "Roll"
      ? { ...base, type: n.type, hold: n.hold ?? 0 }
      : { ...base, type: n.type }
  }) as Notedata
}

function namedCounts(counts: number[], names: readonly CodeInfo[]) {
  const out: Record<string, number> = {}
  counts.forEach((count, i) => {
    if (count) out[names[i].code] = count
  })
  return out
}

/** analyzeCounts() as a Result with only id, noPath, counts and errorCounts */
export type CountsResult = Pick<Result, "id" | "error" | "noPath" | "counts" | "errorCounts">

export function computeCounts(c: Case): CountsResult {
  if (!isSupportedStepsType(c.stepsType)) throw new Error(`Unsupported steps type: ${c.stepsType}`)
  const counts = analyzeCounts(c.stepsType, toNotedata(c.notes))
  if (!counts) return { id: c.id, noPath: true, counts: {}, errorCounts: {} }
  return {
    id: c.id,
    counts: namedCounts(counts.techCounts, TECH_INFO),
    errorCounts: namedCounts(counts.techErrorCounts, TECH_ERROR_INFO),
  }
}

export function computeReference(c: Case, batch = false): Result {
  if (!isSupportedStepsType(c.stepsType)) throw new Error(`Unsupported steps type: ${c.stepsType}`)
  const notedata = toNotedata(c.notes)
  const [start, end] = analysisRange(notedata)
  const internals = new ParityInternals(c.stepsType)
  const data = batch
    ? internals.computeBatch(start, end, notedata)
    : internals.compute(start, end, notedata)
  if (!data) {
    return {
      id: c.id,
      noPath: true,
      feet: "",
      rowCount: 0,
      rows: [],
      mineRows: [],
      holdOwnership: [],
      candles: [],
      stance: "",
      angleChecksum: 0,
      counts: {},
      errorCounts: {},
    }
  }
  const a = toAnalysis(notedata, data)
  return {
    id: c.id,
    feet: a.feet.map(f => FOOT_CHARS[f]).join(""),
    rowCount: a.rows.length,
    rows: a.rows
      .filter(r => r.techs.length || r.errors.length)
      .map(r => [
        r.beat,
        r.techs.map(t => TECH_INFO[t].code),
        r.errors.map(e => TECH_ERROR_INFO[e].code),
      ]),
    mineRows: a.mineRows.map(m => [m.beat, m.techs.map(t => TECH_INFO[t].code)]),
    holdOwnership: a.holdOwnership.map(h => [
      h.note,
      h.timeline.map(t => [t.beat, FOOT_CHARS[t.foot]]),
    ]),
    candles: a.rows.filter(r => r.candle != Foot.NONE).map(r => [r.beat, FOOT_CHARS[r.candle]]),
    stance: stance(a.rows),
    angleChecksum: angleChecksum(a.rows),
    counts: namedCounts(a.techCounts, TECH_INFO),
    errorCounts: namedCounts(a.techErrorCounts, TECH_ERROR_INFO),
  }
}
