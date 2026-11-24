import { Notedata } from "./NoteTypes.js"
import { Foot, TechCategory, TechErrors } from "./ParityDataTypes.js"
import { ParityInternals } from "./ParityInternals.js"
import { ParityComputeData } from "./ParityResultTypes.js"
import { STAGE_LAYOUTS, StageLayout } from "./StageLayouts.js"

/**
 * Bumped whenever the engine's output on the conformance corpus changes.
 * Every port declares the same value; consumers store it next to derived data.
 */
export const ENGINE_VERSION = 1

export const TECH_CATEGORY_COUNT = TechCategory.MineDodges + 1
export const TECH_ERROR_COUNT = TechErrors.Ambiguous + 1

export interface AnalysisRow {
  beat: number
  second: number
  /** sorted ascending */
  techs: TechCategory[]
  /** sorted ascending */
  errors: TechErrors[]
  /** Foot.NONE unless the row is a candle */
  candle: Foot
  /** indexed by Foot: the column each part is planted on after this row, -1 when lifted; [Foot.NONE] is -1 */
  footColumns: number[]
  /** atan2(-dy, dx) of left foot -> right foot in stage coordinates; 0 on the first row */
  angle: number
}

/** a beat with only mines that carries techs */
export interface AnalysisMineRow {
  beat: number
  second: number
  /** sorted ascending */
  techs: TechCategory[]
}

export interface ParityAnalysis {
  /** one per input note, in input order; Foot.NONE for mines, fakes and unassigned notes */
  feet: Foot[]
  /** one per input note: index into `rows`, -1 when the note has no foot */
  noteRows: number[]
  rows: AnalysisRow[]
  /** mine-only beats that carry techs (MD), by beat; not part of `rows` or `noteRows` */
  mineRows: AnalysisMineRow[]
  /** where a roll is taken as re-tapped between rows (by the foot taking it
   * over, or the foot staying on it in a stream gap), by beat */
  rollTaps: { beat: number; second: number; col: number; foot: Foot }[]
  /** holds whose covering foot changes mid-hold; `note` indexes the input */
  holdOwnership: { note: number; timeline: { beat: number; foot: Foot }[] }[]
  /** indexed by TechCategory */
  techCounts: number[]
  /** indexed by TechErrors */
  techErrorCounts: number[]
}

/** dance-double has a stage layout but is untested, so it is not supported */
export const SUPPORTED_STEPS_TYPES: readonly string[] = ["dance-single"]

export function isSupportedStepsType(stepsType: string): boolean {
  return SUPPORTED_STEPS_TYPES.includes(stepsType)
}

/** panel geometry of a supported steps type */
export function stageLayout(stepsType: string): StageLayout | null {
  return isSupportedStepsType(stepsType) ? STAGE_LAYOUTS[stepsType] : null
}

/** whole-chart analysis; null when the steps type is unsupported or no foot path exists */
export function analyze(stepsType: string, notes: Notedata): ParityAnalysis | null {
  if (!isSupportedStepsType(stepsType)) return null
  const [start, end] = analysisRange(notes)
  const data = new ParityInternals(stepsType).computeBatch(start, end, notes)
  return data && toAnalysis(notes, data)
}

export interface TechCounts {
  /** indexed by TechCategory */
  techCounts: number[]
  /** indexed by TechErrors */
  techErrorCounts: number[]
}

/**
 * analyze()'s techCounts and techErrorCounts alone, in memory bounded by the
 * search window instead of chart length; null as for analyze
 */
export function analyzeCounts(stepsType: string, notes: Notedata): TechCounts | null {
  if (!isSupportedStepsType(stepsType)) return null
  const [start, end] = analysisRange(notes)
  const counts = new ParityInternals(stepsType).computeBatchCounts(start, end, notes)
  return counts && denseCounts(counts)
}

function denseCounts(counts: TechCounts): TechCounts {
  const dense = (values: number[], n: number) =>
    Array.from({ length: n }, (_, i) => values[i] || 0)
  return {
    techCounts: dense(counts.techCounts, TECH_CATEGORY_COUNT),
    techErrorCounts: dense(counts.techErrorCounts, TECH_ERROR_COUNT),
  }
}

/**
 * Editor use (reference only): keeps the search graph between calls so an
 * edit only recomputes the rows in [startBeat, endBeat]. The first call must
 * cover the whole chart (the default range).
 */
export class ParitySession {
  /** unstable: debug data and graph access */
  readonly internals: ParityInternals

  constructor(stepsType: string) {
    if (!isSupportedStepsType(stepsType)) {
      throw new Error(`Unsupported steps type: ${stepsType}`)
    }
    this.internals = new ParityInternals(stepsType)
  }

  update(notes: Notedata, startBeat?: number, endBeat?: number): ParityAnalysis | null {
    const [start, end] = analysisRange(notes)
    const data = this.internals.compute(startBeat ?? start, endBeat ?? end, notes)
    return data && toAnalysis(notes, data)
  }
}

/** the beat range `analyze` computes, for callers driving ParityInternals themselves */
export function analysisRange(notes: Notedata): [number, number] {
  let lastBeat = 0
  for (const n of notes) lastBeat = Math.max(lastBeat, n.beat + ("hold" in n ? n.hold : 0))
  return [-1, lastBeat + 4]
}

const noteKey = (beat: number, col: number) => beat.toFixed(3) + "-" + col

/** per-note view of a compute()/computeBatch() result over `notes` */
export function toAnalysis(notes: Notedata, data: ParityComputeData): ParityAnalysis {
  const feet: Foot[] = []
  const noteRows: number[] = []
  const holdOwnership: ParityAnalysis["holdOwnership"] = []
  notes.forEach((n, i) => {
    const key = noteKey(n.beat, n.col)
    const foot = data.parityLabels.get(key) ?? Foot.NONE
    feet.push(foot)
    noteRows.push(foot == Foot.NONE ? -1 : (data.labelRows.get(key) ?? -1))
    const timeline = data.holdOwnership.get(key)
    if (timeline) holdOwnership.push({ note: i, timeline })
  })
  const rows = data.rowTimestamps.map(({ beat, second }, i) => ({
    beat,
    second,
    techs: [...(data.techRows[i] ?? [])].sort((a, b) => a - b),
    errors: [...(data.techErrors.get(i) ?? [])].sort((a, b) => a - b),
    candle: data.candles.get(i) ?? Foot.NONE,
    // states has the start node in front of the rows
    footColumns: [-1, ...data.states[i + 1].footColumns.slice(1, 5)],
    angle: data.facingRows[i] ?? 0,
  }))
  const mineRows = data.mineRows.map(({ beat, second, techs }) => ({
    beat,
    second,
    techs: [...techs].sort((a, b) => a - b),
  }))
  return { feet, noteRows, rows, mineRows, rollTaps: data.rollTaps.map(t => ({ ...t })), holdOwnership, ...denseCounts(data) }
}
