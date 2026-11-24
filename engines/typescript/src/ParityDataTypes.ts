import { HoldNotedataEntry, NotedataEntry } from "./NoteTypes.js"

export enum Foot {
  NONE,
  LEFT_HEEL,
  LEFT_TOE,
  RIGHT_HEEL,
  RIGHT_TOE,
}

export const FEET = [
  Foot.LEFT_HEEL,
  Foot.LEFT_TOE,
  Foot.RIGHT_HEEL,
  Foot.RIGHT_TOE,
]

// Instead of having to write out if((someFootPart == Foot.LEFT_TOE && someOtherPart != Foot.LEFT_HEEL || someFootPart == Foot.LEFT_HEEL && someOtherPart != Foot.LEFT_TOE))
// get the other part of the foot for a given value, if(OTHER_PART_OF_FOOT[someFootPart] != someOtherPart)
export const OTHER_PART_OF_FOOT = [
  Foot.NONE,
  Foot.LEFT_TOE,
  Foot.LEFT_HEEL,
  Foot.RIGHT_TOE,
  Foot.RIGHT_HEEL,
]

export type FootOverride = "Left" | "Right" | Foot

export interface PlacementData {
  previousLeftPos: { x: number; y: number } // can probably cache this?
  previousRightPos: { x: number; y: number }
  leftPos: { x: number; y: number }
  rightPos: { x: number; y: number }
  movedLeft: boolean
  movedRight: boolean
  previousMovedLeft: boolean
  previousMovedRight: boolean
  leftBracket: boolean
  rightBracket: boolean
  previousJumped: boolean
  jumped: boolean
  leftJack: boolean
  rightJack: boolean
  leftDoubleStep: boolean
  rightDoubleStep: boolean
  /** roll columns the engine takes as re-tapped between the rows, and by which foot */
  rollTaps: { col: number; foot: Foot }[]
  leftAfterStepjump: boolean
  rightAfterStepjump: boolean
  // leftJumpedDS: boolean
  // rightJumpedDS: boolean

  initialState: ParityState
  resultState: ParityState
}

export const DEFAULT_WEIGHTS: { [key: string]: number } = {
  DOUBLESTEP: 100,
  BRACKETJACK: 60,
  JACK: 80,
  JUMP: 100,
  SLOW_BRACKET: 300,
  TWISTED_FOOT: 100000,
  BRACKETTAP: 400,
  XO_BR: 200,
  HOLDSWITCH: 500,
  HOLD_RELEASE: 500,
  ROLLSWITCH: 50,
  MINE: 10000,
  MINE_DODGE: 200,
  FOOTSWITCH: 325,
  MISSED_FOOTSWITCH: 500,
  FACING: 3,
  DISTANCE: 6,
  SPIN: 3000,
  SIDESWITCH: 150,
  CROWDED_BRACKET: 100,
  OTHER: 0,
  START_XO: 10000,
  XO_JUMP: 600,
  XO_ENTRY: 150,
  XO_STAY: 30,
  LIFTED_DS: 1500,
  DS_JUMP: 100,
}

export const WEIGHT_SHORT_NAMES: { [id: string]: string } = {
  DOUBLESTEP: "DST",
  BRACKETJACK: "BRJ",
  JACK: "JAK",
  JUMP: "JMP",
  SLOW_BRACKET: "SLWB",
  TWISTED_FOOT: "TWST",
  BRACKETTAP: "BRT",
  XO_BR: "XBR",
  XO_JUMP: "XOJ",
  XO_ENTRY: "XOE",
  XO_STAY: "XOS",
  LIFTED_DS: "LDS",
  DS_JUMP: "DSJ",
  HOLDSWITCH: "HLS",
  HOLD_RELEASE: "HLR",
  ROLLSWITCH: "RLS",
  XO_ROLL_RESOLVED: "XRR",
  MINE: "MNE",
  MINE_DODGE: "MDG",
  FOOTSWITCH: "FSW",
  MISSED_FOOTSWITCH: "MFS",
  FACING: "FAC",
  DISTANCE: "DIS",
  SPIN: "SPN",
  SIDESWITCH: "SSW",
  CROWDED_BRACKET: "CBK",
  OTHER: "OTH",
  OVERRIDE: "OVR",
  TOTAL: "TOT",
}

export enum TechCategory {
  Crossovers = 0,
  Footswitches,
  Sideswitches,
  Jacks,
  Brackets,
  Doublesteps,
  Holdswitch,
  Jumps,
  Brackettaps,
  Stepjumps,
  Kickswitches,
  LateralCrossovers,
  MineDodges,
}

export enum TechErrors {
  UnmarkedDoublestep = 0,
  MissedFootswitch,
  Ambiguous,
}

/** English defaults for an enumeration value; `code` is the stable identifier */
export interface CodeInfo {
  code: string
  name: string
  description: string
}

/** indexed by Foot */
export const FOOT_INFO: readonly CodeInfo[] = [
  {
    code: ".",
    name: "None",
    description:
      "No foot: mines, fakes and notes without an assigned foot.",
  },
  {
    code: "L",
    name: "Left Heel",
    description:
      "The heel of the left foot. A foot on a single panel is labeled by its heel.",
  },
  {
    code: "l",
    name: "Left Toe",
    description:
      "The toe of the left foot, on a second panel (brackets and bracket-taps).",
  },
  {
    code: "R",
    name: "Right Heel",
    description:
      "The heel of the right foot. A foot on a single panel is labeled by its heel.",
  },
  {
    code: "r",
    name: "Right Toe",
    description:
      "The toe of the right foot, on a second panel (brackets and bracket-taps).",
  },
]

/** indexed by TechCategory */
export const TECH_INFO: readonly CodeInfo[] = [
  {
    code: "XO",
    name: "Crossover",
    description:
      "One of the player's feet crosses over the other foot.",
  },
  {
    code: "FS",
    name: "Footswitch",
    description:
      "The player uses alternating feet to hit the same arrow.",
  },
  {
    code: "SS",
    name: "Sideswitch",
    description:
      "The player uses alternating feet to hit the same arrow. The arrow appears on the left or right side of the stage.",
  },
  {
    code: "JA",
    name: "Jack",
    description:
      "The player uses the same foot to hit the same arrow.",
  },
  {
    code: "BR",
    name: "Bracket",
    description:
      "The player uses one foot to diagonally hit two arrows at once.",
  },
  {
    code: "DS",
    name: "Doublestep",
    description:
      "The player uses the same foot twice in a row to hit two different arrows.",
  },
  {
    code: "HS",
    name: "Holdswitch",
    description:
      "The player swaps which foot is holding a hold.",
  },
  {
    code: "JU",
    name: "Jump",
    description:
      "The player hits multiple arrows with both feet at the same time.",
  },
  {
    code: "BT",
    name: "Bracket-tap",
    description:
      "One part of a foot taps an adjacent arrow while the other part stays on a hold.",
  },
  {
    code: "SJ",
    name: "Stepjump",
    description:
      "A single sandwiched between jumps, or a jump sandwiched between singles (single-jump-single / jump-single-jump).",
  },
  {
    code: "KS",
    name: "Kickswitch",
    description:
      "Nickname for a combined FS DS",
  },
  {
    code: "LX",
    name: "Lateral crossover",
    description:
      "A foot crosses over onto the far side panel while the other foot is already on the opposite side panel, so both feet are crossed.",
  },
  {
    code: "MD",
    name: "Mine dodge",
    description:
      "A mine lands on a panel a foot is standing on, and the next step does not lift that foot anyway: the player lifts it just to avoid the mine.",
  },
]

/** indexed by TechErrors */
export const TECH_ERROR_INFO: readonly CodeInfo[] = [
  {
    code: "DS",
    name: "Unmarked Doublestep",
    description:
      "A doublestep is present but there is no marking for it. You can mark a doublestep with a mine following it or having a hold on the other foot.",
  },
  {
    code: "FS",
    name: "Mismarked Footswitch",
    description:
      "A mine that indicates a footswitch was placed for a jack. Either there is a doublestep or the mine is unnecessary.",
  },
  {
    code: "AM",
    name: "Ambiguous Step",
    description:
      "The player does not know which foot to use for this step (usually after a jump).",
  },
]

const fromCode = <T>(table: readonly CodeInfo[], code: string): T | null => {
  const i = table.findIndex(info => info.code === code)
  return i < 0 ? null : (i as T)
}

export const footFromCode = (code: string) => fromCode<Foot>(FOOT_INFO, code)
export const techFromCode = (code: string) =>
  fromCode<TechCategory>(TECH_INFO, code)
export const techErrorFromCode = (code: string) =>
  fromCode<TechErrors>(TECH_ERROR_INFO, code)

export enum Facing {
  Left = -1,
  Forward = 0,
  Right = 1,
}

export const FacingLabels: Record<Facing, string> = {
  [Facing.Left]: "L",
  [Facing.Forward]: "F",
  [Facing.Right]: "R",
}
export const FacingDescriptions: Record<Facing, string> = {
  [Facing.Left]: "Left",
  [Facing.Forward]: "Forward",
  [Facing.Right]: "Right",
}

export class ParityState {
  action: Foot[] = []
  combinedColumns: Foot[] = []
  movedFeet: Set<Foot> = new Set()
  holdFeet: Set<Foot> = new Set()
  frontFoot: Foot | null = null
  facing: Facing = Facing.Forward
  // the crossed facing was chosen while a foot was lifted (a sideswitch into
  // a cross): its direction is settled when that foot lands
  facingProvisional = false
  // the last rotation (Left/Right) the body held and the second it ended:
  // a rotation the other way soon after is a reversal (calcXOTransitionCost)
  lastTurn: Facing = Facing.Forward
  lastTurnEnd = -Infinity
  second: number
  beat: number
  rowKey: string

  footColumns: number[] = []

  // Heels of feet that TRAVELED this row: pressed at least one column they
  // were not already occupying. A re-press (jack/jump-jack/hold head on the
  // same panel) moves without traveling. Used to distinguish real jumps
  // (both feet traveled, replanting the stance) from phantom ones when
  // granting doublestep shields.
  traveledFeet: Set<Foot> = new Set()

  // Per foot, indexed by its heel: the panel its free part hovers over, or
  // -1. A foot that moved between adjacent panels keeps its trailing part over
  // the panel it came from; a holding foot whose planted free part was taken
  // by the other foot re-orients over the hold's other neighbour. A tap there
  // is a primed bracket tap. Hover is not occupancy: it feeds no footswitch,
  // jack, position or facing check.
  hover: number[] = [-1, -1, -1, -1, -1]
  // the hover came from a re-orientation on the hold (the planted free part
  // was taken), not from the part trailing an adjacent move
  hoverPivot: boolean[] = [false, false, false, false, false]

  // Per column: the second the hold or roll there was released (no foot on
  // it), while it stays released; undefined otherwise.
  released: (number | undefined)[] = []

  // The side column of a roll head a crossed-over foot pressed on this row,
  // where the crossover began; -1 otherwise. The other foot taking that roll
  // over on the next row resolves the crossover like a sideswitch.
  crossedOntoRoll = -1

  constructor(
    row: { second: number; beat: number; id: string },
    action: Foot[],
    columns: number[] = []
  ) {
    this.second = row.second
    this.beat = row.beat
    this.rowKey = row.id
    this.action = [...action]
    this.footColumns = [...columns]
  }

  cloneWithFacing(facing: Facing): ParityState {
    const clone = new ParityState(
      { second: this.second, beat: this.beat, id: this.rowKey },
      this.action,
      this.footColumns
    )
    clone.combinedColumns = [...this.combinedColumns]
    clone.movedFeet = new Set(this.movedFeet)
    clone.holdFeet = new Set(this.holdFeet)
    clone.traveledFeet = new Set(this.traveledFeet)
    clone.hover = [...this.hover]
    clone.hoverPivot = [...this.hoverPivot]
    clone.released = [...this.released]
    clone.crossedOntoRoll = this.crossedOntoRoll
    clone.frontFoot = this.frontFoot
    clone.facing = facing
    clone.facingProvisional = this.facingProvisional
    clone.lastTurn = this.lastTurn
    clone.lastTurnEnd = this.lastTurnEnd
    if (this.facing != Facing.Forward && facing == Facing.Forward) {
      clone.lastTurn = this.facing
      clone.lastTurnEnd = this.second
    }
    return clone
  }

  get leftHeel() {
    return this.footColumns[Foot.LEFT_HEEL]
  }

  get leftToe() {
    return this.footColumns[Foot.LEFT_TOE]
  }

  get rightHeel() {
    return this.footColumns[Foot.RIGHT_HEEL]
  }

  get rightToe() {
    return this.footColumns[Foot.RIGHT_TOE]
  }

  toKey() {
    return `${this.rowKey}-${this.rowLocalKey()}`
  }

  // toKey() without the row key: equal for two states of the same row exactly when toKey() is
  rowLocalKey() {
    return this.keyWith(this.lastTurn != Facing.Forward ? `~${this.lastTurn}@${this.lastTurnEnd}` : "")
  }

  // rowLocalKey() without the turn memory
  stanceKey() {
    return this.keyWith("")
  }

  private keyWith(turn: string) {
    let movedString = ""
    for (let i = 0; i < FEET.length; i++) {
      if (this.movedFeet.has(FEET[i])) {
        movedString += FEET[i]
      }
    }
    let holdString = ""
    for (let i = 0; i < FEET.length; i++) {
      if (this.holdFeet.has(FEET[i])) {
        holdString += FEET[i]
      }
    }
    let feetString = ""
    for (let i = 1; i < this.footColumns.length; i++) {
      if (this.footColumns[i] !== -1) {
        feetString += this.footColumns[i]
      } else {
        feetString += "."
      }
    }

    let traveledString = ""
    for (let i = 0; i < FEET.length; i++) {
      if (this.traveledFeet.has(FEET[i])) {
        traveledString += FEET[i]
      }
    }

    const hoverString = `${this.hover[Foot.LEFT_HEEL]}${this.hoverPivot[Foot.LEFT_HEEL] ? "p" : ""}${this.hover[Foot.RIGHT_HEEL]}${this.hoverPivot[Foot.RIGHT_HEEL] ? "p" : ""}`

    let releasedString = ""
    for (let i = 0; i < this.released.length; i++) {
      if (this.released[i] !== undefined) releasedString += `~${i}@${this.released[i]}`
    }

    return `${this.action.join("")}-${this.combinedColumns.join("")}-${movedString}-${holdString}-${feetString}-${this.frontFoot}-${this.facing}${this.facingProvisional ? "?" : ""}${turn}-${traveledString}-${hoverString}${releasedString}${this.crossedOntoRoll != -1 ? `x${this.crossedOntoRoll}` : ""}`
  }
}

/** the real (not fake) mines of one beat, in column order */
export interface MineRow {
  beat: number
  second: number
  columns: number[]
}

export interface Row {
  notes: (NotedataEntry | undefined)[]
  holds: (HoldNotedataEntry | undefined)[]
  holdTails: Set<number>
  /** per column with an active roll: the stream step around its head (the
   * shortest gap from the head to the notes before and after it), seconds */
  rollSteps: (number | undefined)[]
  mines: (number | undefined)[]
  fakeMines: (number | undefined)[]
  /** real mines since the previous row, up to and including this row's beat, by beat */
  mineRows: MineRow[]
  second: number
  beat: number
  columns: Foot[]
  overrides: FootOverride[]
  id: string
}

const footMask = (feet: Set<Foot>) => {
  let mask = 0
  for (const foot of feet) mask |= 1 << foot
  return mask
}

/**
 * A total order on the states of one row, the same in every port: it breaks
 * exact ties between paths without depending on the order nodes were created.
 * Zero exactly when the two states have the same key.
 */
export function compareStates(a: ParityState, b: ParityState): number {
  const fields = (s: ParityState) => {
    const out: number[] = []
    for (let i = 0; i < s.action.length; i++) out.push(s.action[i] ?? Foot.NONE)
    for (let i = 0; i < s.combinedColumns.length; i++) out.push(s.combinedColumns[i] ?? Foot.NONE)
    for (let i = 1; i < 5; i++) out.push(s.footColumns[i])
    out.push(footMask(s.movedFeet), footMask(s.holdFeet), s.frontFoot ?? -1)
    out.push(s.facing, s.facingProvisional ? 1 : 0, s.lastTurn)
    out.push(s.lastTurn != Facing.Forward ? s.lastTurnEnd : 0)
    out.push(footMask(s.traveledFeet))
    out.push(s.hover[Foot.LEFT_HEEL], s.hoverPivot[Foot.LEFT_HEEL] ? 1 : 0)
    out.push(s.hover[Foot.RIGHT_HEEL], s.hoverPivot[Foot.RIGHT_HEEL] ? 1 : 0)
    for (let i = 0; i < s.released.length; i++) {
      if (s.released[i] !== undefined) out.push(i, s.released[i]!)
    }
    out.push(s.crossedOntoRoll)
    return out
  }
  const x = fields(a)
  const y = fields(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] != y[i]) return x[i] < y[i] ? -1 : 1
  }
  return x.length - y.length
}
