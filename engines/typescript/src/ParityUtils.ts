import { HoldNotedataEntry } from "./NoteTypes.js"
import {
  Row,
  Foot,
  FootOverride,
  OTHER_PART_OF_FOOT,
  ParityState,
  PlacementData,
} from "./ParityDataTypes.js"

/** two times closer than this are the same row */
export const SECOND_EPSILON = 0.0005

// Beats within 1/96 are the same row for annotation purposes (charts are
// quantized to 1/48; half of that absorbs float drift).
export const HOLD_OVERRIDE_EPSILON = 1 / 96

/**
 * The takeover annotation governing a hold's column at the given beat: the
 * latest holdOverrides entry at or before the beat. Entries at the hold head
 * are ignored (the head note's ordinary override covers that row).
 */
export function holdOverrideAt(
  hold: HoldNotedataEntry,
  beat: number
): FootOverride | undefined {
  const list = hold.parity?.holdOverrides
  if (!list?.length) return undefined
  let result: FootOverride | undefined
  for (const entry of list) {
    if (entry.beat > beat + HOLD_OVERRIDE_EPSILON) break
    if (entry.beat <= hold.beat + HOLD_OVERRIDE_EPSILON) continue
    result = entry.foot
  }
  return result
}

// Stepjumps are played at 8th speed or thereabouts; a shared panel further
// apart than this is two separate events.
export const StepjumpMaxGap = 0.5

function noteColumns(row: Row) {
  const cols: number[] = []
  row.notes.forEach((n, c) => {
    if (n !== undefined) cols.push(c)
  })
  return cols
}

// A two-arrow jump whose adjacent single (the row before or after) is on one
// of the jump's panels, so that foot stays planted across the jump. Shared by
// the label (SJ in place of JU) and the cost (no jump-jack charge for the
// planted foot's re-press).
export function isStepjump(rows: Row[], idx: number) {
  const jump = rows[idx]
  const panels = noteColumns(jump)
  if (panels.length != 2) return false
  const sharesPanel = (row: Row | undefined) => {
    if (!row || Math.abs(row.second - jump.second) > StepjumpMaxGap) return false
    const cols = noteColumns(row)
    return cols.length == 1 && panels.includes(cols[0])
  }
  return sharesPanel(rows[idx - 1]) || sharesPanel(rows[idx + 1])
}

// A foot re-stepping a panel it is already on as part of a jump, right after
// that foot moved — a minijack demand for that foot even though the row is a
// jump. Shared by cost (calcJackCost) and annotation (calculateRowStats).
/**
 * How a foot re-presses on a jump row right after it moved: "same" when it
 * presses exactly the panels it pressed before (a repeated jump, labelled and
 * priced as a jack), "subset" when it presses one panel of its previous
 * bracket (only a part lifts and taps: no label, priced like a stepjump's
 * planted re-press), null otherwise. Parts still holding are not presses.
 */
export function jumpRepress(
  initialState: ParityState,
  resultState: ParityState,
  heel: Foot
): "same" | "subset" | null {
  const toe = OTHER_PART_OF_FOOT[heel]
  if (!initialState.movedFeet.has(heel) && !initialState.movedFeet.has(toe)) {
    return null
  }
  const before: number[] = []
  const now: number[] = []
  for (let col = 0; col < resultState.action.length; col++) {
    const a = initialState.action[col]
    if ((a == heel || a == toe) && !initialState.holdFeet.has(a)) before.push(col)
    const foot = resultState.action[col]
    if ((foot == heel || foot == toe) && !resultState.holdFeet.has(foot)) now.push(col)
  }
  if (now.length == 0 || !now.some(c => before.includes(c))) return null
  if (now.length == before.length && now.every((c, i) => c == before[i])) return "same"
  return "subset"
}

// A two-arrow jump within StepjumpMaxGap of the previous row where exactly
// one foot re-presses a panel it stood on and the other foot moves to a new
// panel: only one foot moves, so the row is a stepjump whatever the previous
// row was (a single, or a jump sharing the planted panel).
export function isPlantedJump(
  row: Row,
  initialState: ParityState,
  resultState: ParityState,
  elapsedTime: number
): boolean {
  if (elapsedTime > StepjumpMaxGap || noteColumns(row).length != 2) return false
  const l = jumpRepress(initialState, resultState, Foot.LEFT_HEEL) != null
  const r = jumpRepress(initialState, resultState, Foot.RIGHT_HEEL) != null
  return l != r
}


export function doFeetOverlap(
  oldHeel: number,
  oldToe: number,
  newHeel: number,
  newToe: number
): boolean {
  if (oldHeel != -1) {
    if (oldHeel == newHeel || oldHeel == newToe) {
      return true
    }
  }

  if (oldToe != -1) {
    if (oldToe == newHeel || oldToe == newToe) {
      return true
    }
  }

  return false
}

export function getPlayerAngle(
  left: { x: number; y: number },
  right: { x: number; y: number }
) {
  const x1 = right.x - left.x
  const y1 = right.y - left.y
  const x2 = 1
  const y2 = 0
  const dot = x1 * x2 + y1 * y2
  const det = x1 * y2 - y1 * x2
  return Math.atan2(det, dot)
}

// A mine right before a repeated note says "switch feet": the chart author
// marks a footswitch with a mine, on the note's column or on the panel the
// other foot should leave. The hint only applies inside a running pattern.
// After a rest both feet are in the air anyway, and a mine sweep during the
// rest (MAYDAY 109-113.5, mines on all four panels before a plain repeat) says
// nothing about which foot takes the next note.
export const MINE_FOOTSWITCH_MAX_GAP = 2.0
// how long after a rotation ended a rotation the other way is a reversal
export const REVERSAL_WINDOW = 0.5

// How long a hold or roll survives with no foot on it (ITGmania with Simply
// Love's TimingWindowSecondsHold / TimingWindowSecondsRoll).
export const HOLD_RELEASE_WINDOW = 0.32
export const ROLL_RELEASE_WINDOW = 0.35
export function mineForcesFootswitch(data: PlacementData, row: Row, elapsedTime: number): boolean {
  if (!data.leftJack && !data.rightJack) return false
  if (elapsedTime >= MINE_FOOTSWITCH_MAX_GAP) return false
  return row.mines.some(x => x !== undefined) || row.fakeMines.some(x => x !== undefined)
}
