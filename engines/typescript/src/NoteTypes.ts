import { FootOverride } from "./ParityDataTypes.js"

export const HOLD_NOTE_TYPES = ["Hold", "Roll"] as const
export const TAP_NOTE_TYPES = ["Tap", "Mine", "Lift", "Fake"] as const

export type HoldNoteType = (typeof HOLD_NOTE_TYPES)[number]
export type TapNoteType = (typeof TAP_NOTE_TYPES)[number]
export type NoteType = TapNoteType | HoldNoteType

// The engine reads these fields and never writes to a note. Any richer note
// object (SMEditor's NotedataEntry) is structurally assignable.
export interface NotedataEntryBase {
  beat: number
  col: number
  second: number
  warped?: boolean
  fake?: boolean
  parity?: {
    override?: FootOverride
    /** hold notes only: the foot covering the hold from each beat onward, sorted by beat */
    holdOverrides?: { beat: number; foot: FootOverride }[]
  }
}

export type TapNotedataEntry = NotedataEntryBase & { type: TapNoteType }
export type HoldNotedataEntry = NotedataEntryBase & {
  type: HoldNoteType
  /** length in beats */
  hold: number
}
export type NotedataEntry = TapNotedataEntry | HoldNotedataEntry

/** sorted by beat, then column */
export type Notedata = NotedataEntry[]

export function isHoldNote(note: NotedataEntry): note is HoldNotedataEntry {
  return HOLD_NOTE_TYPES.includes(note.type as HoldNoteType)
}
