import { isHoldNote } from "./NoteTypes.js"
import {
  DEFAULT_WEIGHTS,
  Facing,
  Foot,
  OTHER_PART_OF_FOOT,
  ParityState,
  PlacementData,
  Row,
} from "./ParityDataTypes.js"
import { REVERSAL_WINDOW, getPlayerAngle, isPlantedJump, isStepjump, jumpRepress, mineForcesFootswitch } from "./ParityUtils.js"

import { STAGE_LAYOUTS, StageLayout } from "./StageLayouts.js"

export class ParityCostCalculator {
  private readonly layout: StageLayout

  private WEIGHTS: { [key: string]: number }

  constructor(
    type: string,
    weights: { [key: string]: number } | undefined = undefined
  ) {
    this.layout = STAGE_LAYOUTS[type]
    if (weights != undefined) {
      this.WEIGHTS = { ...weights }
    } else {
      this.WEIGHTS = { ...DEFAULT_WEIGHTS }
    }
  }

  setWeights(newWeights: { [key: string]: number }) {
    this.WEIGHTS = { ...this.WEIGHTS, ...newWeights }
  }

  getActionCost(
    initialState: ParityState,
    resultState: ParityState,
    rows: Row[],
    rowIndex: number
  ): { [id: string]: number } {
    const lastRow = rows[rowIndex - 1]
    const row = rows[rowIndex]
    let elapsedTime = resultState.second - initialState.second
    if (rowIndex == 0) {
      elapsedTime = 1
    }

    const costs: { [id: string]: number } = {}

    // Calculate some data beforehand
    const placementData = this.layout.getPlacementData(
      initialState,
      resultState,
      lastRow,
      row
    )

    // Mine weighting

    costs["MINE"] = this.calcMineCosts(placementData, row)

    costs["HOLDSWITCH"] = this.calcHoldSwitchCosts(placementData, row)
    costs["HOLD_RELEASE"] = this.calcHoldReleaseCost(placementData, row)

    costs["BRACKETTAP"] = this.calcBracketTapCost(placementData, elapsedTime)

    costs["OTHER"] = this.calcStartCrossover(placementData, rowIndex)

    costs["BRACKETJACK"] = this.calcBracketJackCost(placementData)

    costs["XO_BR"] = this.calcXOBRCost(placementData)

    costs["XO_ENTRY"] = this.calcXOTransitionCost(placementData)
    costs["ROTATION_TWIST"] = this.calcRotationTwistCost(placementData)
    costs["XO_REVERSAL"] = this.calcReversalCost(placementData)
    costs["XO_STAY"] = this.calcXOStayCost(placementData)

    costs["DOUBLESTEP"] = this.calcDoublestepCost(
      placementData,
      lastRow,
      row,
      elapsedTime
    )

    // TODO: Jumps should have a default weight
    costs["JUMP"] = this.calcJumpCost(placementData, elapsedTime)

    costs["TWISTED_FOOT"] = this.calcTwistedFoot(placementData)

    costs["SPIN"] = this.calcSpinCost(placementData)

    costs["HOLDPART_FOOTSWITCH"] = this.calcHoldPartFootswitchCost(placementData, row, elapsedTime)
    costs["FOOTSWITCH"] = this.calcSlowFootswitchCost(
      placementData,
      row,
      elapsedTime
    )

    costs["SIDESWITCH"] = this.calcSideswitchCost(placementData, row)
    if (costs["SIDESWITCH"] > 0) {
      costs["XO_STAY"] = 0
      costs["XO_ENTRY"] = 0
    }
    costs["XO_ROLL_RESOLVED"] = this.calcXORollResolvedCost(placementData, row)

    // add penalty if jacked

    costs["MISSED_FOOTSWITCH"] = this.calcMissedFootswitchCost(
      placementData,
      row,
      elapsedTime
    )

    // To do: small weighting for swapping heel with toe or toe with heel (both add up)

    // To do: huge weighting for having foot direction opposite of eachother (can't twist one leg 180 degrees)

    costs["JACK"] = this.calcJackCost(placementData, row, elapsedTime, isStepjump(rows, rowIndex))

    costs["DISTANCE"] = this.calcDistanceCost(placementData, elapsedTime, rows, rowIndex)

    costs["CROWDED_BRACKET"] = this.calcCrowdedBracketCost(placementData, elapsedTime)

    let totalCost = 0
    for (const c in costs) {
      totalCost += costs[c]
    }
    costs["TOTAL"] = totalCost
    return costs
  }

  // Does the left foot in resultPlacement overlap the right foot in initialPlacement?
  doesLeftFootOverlapRight(data: PlacementData): boolean {
    if (data.resultState.rightHeel == -1) return false
    if (
      data.resultState.rightHeel == data.resultState.leftHeel ||
      data.resultState.rightHeel == data.resultState.leftToe
    ) {
      return true
    }
    if (data.resultState.rightToe == -1) return false
    if (
      data.resultState.rightToe == data.resultState.leftHeel ||
      data.resultState.rightToe == data.resultState.leftToe
    ) {
      return true
    }

    return false
  }

  // Does the right foot in resultPlacement overlap the left foot in initialPlacement?
  doesRightFootOverlapLeft(data: PlacementData): boolean {
    if (data.resultState.leftHeel == -1) return false
    if (
      data.resultState.leftHeel == data.resultState.rightHeel ||
      data.resultState.leftHeel == data.resultState.rightToe
    ) {
      return true
    }
    if (data.resultState.leftToe == -1) return false
    if (
      data.resultState.leftToe == data.resultState.rightHeel ||
      data.resultState.leftToe == data.resultState.rightToe
    ) {
      return true
    }

    return false
  }

  // breakout all of the function costs

  // A foot pressing a panel whose mine passed since the last row is MINE; a
  // foot that stood on it and does not act lifts off to the center (MD, a
  // ghost step) and pays MINE_DODGE.
  calcMineCosts(data: PlacementData, row: Row) {
    let cost = 0
    for (let i = 0; i < this.layout.layout.length; i++) {
      if (row.mines[i] === undefined) continue
      if (data.resultState.combinedColumns[i] != Foot.NONE) return this.WEIGHTS.MINE
      const stood = data.initialState.combinedColumns[i]
      if (stood == Foot.NONE || row.holds[i] !== undefined) continue
      const parts = [stood, OTHER_PART_OF_FOOT[stood]]
      if (!parts.some(p => data.resultState.movedFeet.has(p))) cost = this.WEIGHTS.MINE_DODGE
    }
    return cost
  }

  // A foot leaving a hold or roll it covered, so no foot is on it for a while.
  calcHoldReleaseCost(data: PlacementData, row: Row) {
    let cost = 0
    for (let c = 0; c < row.holds.length; c++) {
      if (row.holds[c] === undefined) continue
      if (data.resultState.combinedColumns[c] != Foot.NONE || row.holdTails.has(c)) continue
      if (data.initialState.released[c] === undefined) cost += this.WEIGHTS.HOLD_RELEASE
    }
    return cost
  }

  calcHoldSwitchCosts(data: PlacementData, row: Row) {
    let cost = 0

    for (let c = 0; c < row.holds.length; c++) {
      if (row.holds[c] === undefined) continue
      // Skip holds not yet held at the previous row. (Old guard was inverted:
      // `beat <` skipped every hold older than one row, making takeovers of
      // long holds cost nothing.)
      if (row.holds[c]!.beat > data.initialState.beat) continue
      const initialFoot = data.initialState.combinedColumns[c]
      const resultFoot = data.resultState.combinedColumns[c]
      // a release and the step back on are priced by calcHoldReleaseCost
      if (initialFoot == Foot.NONE || resultFoot == Foot.NONE) continue
      if (
        initialFoot != resultFoot &&
        initialFoot != OTHER_PART_OF_FOOT[resultFoot]
      ) {
        // a roll is re-tapped anyway: the other foot taking the re-tap is cheap
        if (row.holds[c]!.type == "Roll") {
          cost += this.WEIGHTS.ROLLSWITCH
          continue
        }
        const tempcost =
          this.WEIGHTS.HOLDSWITCH *
          (data.resultState.footColumns[initialFoot] == -1
            ? 1
            : Math.sqrt(
                this.layout.getDistanceSq(
                  c,
                  data.resultState.footColumns[initialFoot]
                )
              ))
        // const tempcost2 =
        //   this.WEIGHTS.HOLDSWITCH *
        //   (data.initialState.footColumns[resultFoot] == -1
        //     ? 1
        //     : Math.sqrt(
        //         this.layout.getDistanceSq(
        //           c,
        //           data.resultState.footColumns[resultFoot]
        //         )
        //       ))
        cost += tempcost
      }
    }

    return cost
  }

  // Bracket-tap price by how the foot was oriented before the tap: the free
  // part stood on the tapped panel (planted), hovered over it after the foot
  // moved from there (trail), or pointed at the hold's other neighbour and
  // rolls on the hold (pivot). No orientation costs in full. Admissible ranges
  // on the 2026-10-30 suite: planted 0.15-0.25, trail 0.265-0.294, pivot
  // 0.25-0.4; each value sits mid-range. BracketTapJackWindow 0 keeps the
  // upstream 1/t penalty on a tap right after the foot moved; a softened
  // max(1, w/t) broke two charts.
  private PrimedBracketTapFactor = 0.2
  private TrailPrimedBracketTapFactor = 0.28
  private PivotBracketTapFactor = 0.35
  private SwitchBracketTapFactor = 1
  private PivotFromHover = true
  private BracketTapJackWindow = 0

  calcBracketTapCost(data: PlacementData, elapsedTime: number) {
    let cost = 0
    const r = data.resultState
    for (const [heel, toe] of [
      [Foot.LEFT_HEEL, Foot.LEFT_TOE],
      [Foot.RIGHT_HEEL, Foot.RIGHT_TOE],
    ] as const) {
      if (r.footColumns[heel] == -1 || r.footColumns[toe] == -1) continue
      if (r.holdFeet.has(heel) == r.holdFeet.has(toe)) continue
      const free = r.holdFeet.has(heel) ? toe : heel
      const tapCol = r.footColumns[free]
      if (r.action[tapCol] != free) continue
      // Tapping again right after the foot moved is a jack of the bracket:
      // inside a jump for any movement of the foot (the other foot moves at
      // the same time, so weight can't shift onto the holding part), and
      // solo when a foot already split over two panels rocks from the part
      // that just tapped onto the other. A solo re-tap of a part that moved
      // is a plain jack, priced by calcJackCost only. A foot that stood on
      // one panel is always its heel, so the split condition keeps the solo
      // case heel/toe neutral.
      let jackPenalty = 1
      const init = data.initialState
      const moved = init.movedFeet
      const footMoved = moved.has(heel) || moved.has(toe)
      const rocking =
        init.footColumns[heel] != -1 &&
        init.footColumns[toe] != -1 &&
        !moved.has(free) &&
        moved.has(OTHER_PART_OF_FOOT[free])
      if ((data.jumped && footMoved) || (!data.jumped && rocking))
        jackPenalty =
          this.BracketTapJackWindow > 0
            ? Math.max(1, this.BracketTapJackWindow / elapsedTime)
            : 1 / elapsedTime
      const holdCol = r.footColumns[OTHER_PART_OF_FOOT[free]]
      const oriented = [
        init.footColumns[heel],
        init.footColumns[toe],
        this.PivotFromHover ? init.hover[heel] : -1,
      ].filter(c => c != -1 && c != holdCol && this.layout.bracketCheck(c, holdCol))
      const planted = init.footColumns[heel] == tapCol || init.footColumns[toe] == tapCol
      const trailed = init.hover[heel] == tapCol && !init.hoverPivot[heel]
      // the other foot stands on the tapped panel: a footswitch done with a
      // free part, which can't have been primed over an occupied panel
      const otherHeel = heel == Foot.LEFT_HEEL ? Foot.RIGHT_HEEL : Foot.LEFT_HEEL
      const switched = [otherHeel, OTHER_PART_OF_FOOT[otherHeel]].some(
        f => init.footColumns[f] == tapCol
      )
      const factor = switched
        ? this.SwitchBracketTapFactor
        : planted
          ? this.PrimedBracketTapFactor
          : trailed
            ? this.TrailPrimedBracketTapFactor
            : oriented.length
              ? this.PivotBracketTapFactor
              : 1
      cost += this.WEIGHTS.BRACKETTAP * jackPenalty * factor
    }
    return cost
  }

  calcStartCrossover(data: PlacementData, rowIndex: number) {
    // Don't start the chart crossed over
    if (data.rightPos.x < data.leftPos.x && rowIndex == 0) {
      return this.WEIGHTS.START_XO
    }
    return 0
  }

  calcBracketJackCost(data: PlacementData) {
    if (data.jumped) return 0
    // Only a true re-strike is a bracket jack: the jack flag fires on any
    // part-overlap (doFeetOverlap), but a foot landing on a column it wasn't
    // occupying has traveled (re-orientation, e.g. heel->toe on one panel
    // while the other part reaches a new panel), which is not a jack demand.
    const feet = [
      [data.leftJack, data.leftBracket, Foot.LEFT_HEEL, Foot.LEFT_TOE],
      [data.rightJack, data.rightBracket, Foot.RIGHT_HEEL, Foot.RIGHT_TOE],
    ] as const
    for (const [jack, bracket, heel, toe] of feet) {
      if (!jack || !bracket) continue
      const oldCols = new Set([
        data.initialState.footColumns[heel],
        data.initialState.footColumns[toe],
      ])
      const newCols = [
        data.resultState.footColumns[heel],
        data.resultState.footColumns[toe],
      ]
      if (newCols.every(c => c == -1 || oldCols.has(c))) {
        return this.WEIGHTS.BRACKETJACK
      }
    }
    return 0
  }

  calcXOBRCost(data: PlacementData) {
    let cost = 0
    const isCrossedOver = data.resultState.facing != Facing.Forward
    // Only penalize brackets that establish a NEW crossed stance — the prior
    // exists to stop the solver inventing crossed brackets from neutral
    // states. Bracketing as a continuation of an already-committed crossover
    // is legitimate tech and shouldn't be re-taxed.
    const wasCrossedOver = data.initialState.facing != Facing.Forward
    if (wasCrossedOver) return 0
    if (data.leftBracket && isCrossedOver) {
      cost += this.WEIGHTS.XO_BR
    }
    if (data.rightBracket && isCrossedOver) {
      cost += this.WEIGHTS.XO_BR
    }
    return cost
  }

  private isFootLifted(state: ParityState, heel: Foot) {
    return (
      state.footColumns[heel] == -1 &&
      state.footColumns[OTHER_PART_OF_FOOT[heel]] == -1
    )
  }

  calcXOTransitionCost(data: PlacementData) {
    const wasCrossedOver = data.initialState.facing != Facing.Forward
    const isCrossedOver = data.resultState.facing != Facing.Forward
    if (!wasCrossedOver && isCrossedOver) {
      return this.WEIGHTS.XO_ENTRY
    }
    return 0
  }

  // A sideswitch that starts a cross does not rotate the body; the body
  // must already face the new way on the note before it. If a rotation the
  // other way ended within REVERSAL_WINDOW of the sideswitch, there was no
  // time for that (caffeine-salad 223.25: right over left ended at 222.25,
  // left onto R at 223.25). Checked on the row where the sideswitch's
  // provisional direction settles, since only then is the direction known.
  calcReversalCost(data: PlacementData) {
    const init = data.initialState
    const res = data.resultState
    if (!init.facingProvisional || res.facing == Facing.Forward) return 0
    if (init.lastTurn == Facing.Forward || init.lastTurn == res.facing) return 0
    if (init.second - init.lastTurnEnd >= REVERSAL_WINDOW) return 0
    return this.WEIGHTS.TWISTED_FOOT
  }

  // A crossover onto a roll head that the other foot takes over on the next
  // row, uncrossing, reads like a crossover resolved by a sideswitch: the
  // entry paid on the row before is given back.
  calcXORollResolvedCost(data: PlacementData, row: Row) {
    const c = data.initialState.crossedOntoRoll
    if (c == -1 || data.resultState.facing != Facing.Forward) return 0
    // the same roll, not a new note on its panel
    if (row.notes[c] || row.holds[c]?.beat != data.initialState.beat) return 0
    const before = data.initialState.combinedColumns[c]
    const after = data.resultState.combinedColumns[c]
    if (after == Foot.NONE || after == before || after == OTHER_PART_OF_FOOT[before]) return 0
    return -this.WEIGHTS.XO_ENTRY
  }

  calcXOStayCost(data: PlacementData) {
    if (data.resultState.facing != Facing.Forward) {
      return this.WEIGHTS.XO_STAY
    }
    return 0
  }

  // The base weight prices a doublestep across a 250 ms gap; faster ones scale up on a 1/t curve like jacks.
  // TODO: Does it make sense for costs to share a time constant?
  private DoublestepBaseTime = 0.25
  private CrossedDoublestepFactor = 2
  private JackDoublestepFactor = 2
  // A doublestep under a hold is free only at or above this gap (8ths below
  // 200 BPM); faster runs under a hold are what the holding foot's bracket
  // taps replace.
  private HoldDoublestepFreeTime = 0.15

  calcDoublestepCost(
    data: PlacementData,
    lastRow: Row,
    row: Row,
    elapsedTime: number
  ) {
    if (data.leftDoubleStep || data.rightDoubleStep) {
      // Check if we are allowed to DS

      for (let i = 0; i < this.layout.layout.length; i++) {
        const hold = lastRow.holds[i]
        // A hold legitimizes the DS only if it predates the DS window (was
        // already active at the previous row and extends past it). A hold
        // that STARTED at the previous row is part of the same interpretation
        // — the pin may be self-inflicted (e.g. a phantom jump pressing the
        // hold head instead of bracketing), so it earns no carve-out.
        // ...and only at a comfortable speed: a fast doublestep run under a
        // hold is what players avoid by bracket-tapping with the holding foot.
        if (hold && !lastRow.holdTails.has(i) && elapsedTime >= this.HoldDoublestepFreeTime) {
          return 0
        }
      }

      if (data.leftDoubleStep) {
        const willHitMine =
          row.mines[data.initialState.footColumns[Foot.LEFT_HEEL]] ||
          row.fakeMines[data.initialState.footColumns[Foot.LEFT_HEEL]] ||
          row.mines[data.initialState.footColumns[Foot.LEFT_TOE]] ||
          row.fakeMines[data.initialState.footColumns[Foot.LEFT_TOE]]
        if (willHitMine) return 0
      }
      if (data.rightDoubleStep) {
        const willHitMine =
          row.mines[data.initialState.footColumns[Foot.RIGHT_HEEL]] ||
          row.fakeMines[data.initialState.footColumns[Foot.RIGHT_HEEL]] ||
          row.mines[data.initialState.footColumns[Foot.RIGHT_TOE]] ||
          row.fakeMines[data.initialState.footColumns[Foot.RIGHT_TOE]]
        if (willHitMine) return 0
      }

      // 1. full weight at or above the base time span
      // 2. slower doublesteps don't get cheaper
      // 3. faster ones ramp up on the 1/t curve
      // 4. a doublestep that lands crossed (into or within a cross) is dearer
      //    than one facing forward: uncrossing by alternation is the natural
      //    move there (crossover-twice).
      const crossed = data.resultState.facing != Facing.Forward ? this.CrossedDoublestepFactor : 1
      // 5. a doublestep by a foot that has just jacked (its previous action
      //    was a re-press, not a travel) is that foot's third action in a
      //    row: R, R, U (caffeine-salad 223.75). Not after a jump, where the
      //    re-press was a planted stepjump foot.
      const init = data.initialState
      const heel = data.leftDoubleStep ? Foot.LEFT_HEEL : Foot.RIGHT_HEEL
      const afterJack =
        !data.previousJumped &&
        (init.movedFeet.has(heel) || init.movedFeet.has(OTHER_PART_OF_FOOT[heel])) &&
        !init.traveledFeet.has(heel)
      return (
        this.WEIGHTS.DOUBLESTEP *
        Math.max(1, this.DoublestepBaseTime / elapsedTime) *
        crossed *
        (afterJack ? this.JackDoublestepFactor : 1)
      )
    }
    return 0
  }

  calcJumpCost(data: PlacementData, elapsedTime: number) {
    if (!data.jumped) return 0

    // don't apply this cost for stepjumps
    // TODO: proper stepjumps
    if (
      !data.resultState.traveledFeet.has(Foot.LEFT_HEEL) ||
      !data.resultState.traveledFeet.has(Foot.RIGHT_HEEL)
    ) {
      return 0
    }

    return (
      this.WEIGHTS.JUMP * Math.max(1, this.DoublestepBaseTime / elapsedTime)
    )
  }

  private slowBracketThreshold = 0.15
  private slowBracketCap = 0.5
  calcSlowBracketCost(data: PlacementData, row: Row, elapsedTime: number) {
    // Slow-bracket exists to prefer jumps on ambiguous slow note pairs. From
    // an already-crossed stance that ambiguity doesn't exist: the jump
    // alternative is a crossover-unwinding jump (blocked by XO_JUMP), so a
    // bracket there is intended tech, not a hallucination candidate.
    const wasCrossedOver = data.initialState.facing != Facing.Forward
    if (wasCrossedOver) return 0
    if (
      elapsedTime > this.slowBracketThreshold &&
      (data.leftBracket || data.rightBracket) &&
      !data.jumped
    ) {
      // Hold-anchored brackets are unambiguous: a part pressing a hold head
      // (or sitting on an active hold) pins the bracket as intended tech, so
      // the "prefer jumps on slow pairs" prior doesn't apply (Finding 3 row
      // 79 / VIBE beats 48 and 176).
      const result = data.resultState
      const bracketParts: Foot[] = []
      if (data.leftBracket) bracketParts.push(Foot.LEFT_HEEL, Foot.LEFT_TOE)
      if (data.rightBracket) bracketParts.push(Foot.RIGHT_HEEL, Foot.RIGHT_TOE)
      for (const part of bracketParts) {
        const col = result.footColumns[part]
        if (col == -1) continue
        const note = row.notes[col]
        if (
          row.holds[col] !== undefined ||
          (note !== undefined && isHoldNote(note))
        ) {
          return 0
        }
      }
      return (
        Math.min(this.slowBracketCap, elapsedTime - this.slowBracketThreshold) *
        this.WEIGHTS.SLOW_BRACKET
      )
    }
    return 0
  }

  // Does this placement result in one of the feet being twisted around?
  // This should probably be getting filtered out as an invalid positioning before we
  // even get here, but :shrug:
  calcTwistedFoot(data: PlacementData) {
    // old check, ideally we never do a xobr with the toes facing backward
    // const crossedOver = data.rightPos.x < data.leftPos.x
    const rightBackwards =
      data.resultState.rightHeel != -1 && data.resultState.rightToe != -1
        ? this.layout.layout[data.resultState.rightToe].y <
          this.layout.layout[data.resultState.rightHeel].y
        : false

    const leftBackwards =
      data.resultState.leftHeel != -1 && data.resultState.leftToe != -1
        ? this.layout.layout[data.resultState.leftToe].y <
          this.layout.layout[data.resultState.leftHeel].y
        : false

    // TODO: Definitely doesn't work for doubles
    // if left heel is or was D, R can't do LU bracket
    const leftDownAndRightLU =
      this.layout.downArrows.includes(
        data.initialState.footColumns[Foot.LEFT_HEEL]
      ) &&
      this.layout.upArrows.includes(
        data.resultState.footColumns[Foot.RIGHT_TOE]
      ) &&
      this.layout.leftArrows.includes(
        data.resultState.footColumns[Foot.RIGHT_HEEL]
      )
    // if right heel is or was D, L can't do RU bracket
    const rightDownAndLeftRU =
      this.layout.downArrows.includes(
        data.initialState.footColumns[Foot.RIGHT_HEEL]
      ) &&
      this.layout.upArrows.includes(
        data.resultState.footColumns[Foot.LEFT_TOE]
      ) &&
      this.layout.rightArrows.includes(
        data.resultState.footColumns[Foot.LEFT_HEEL]
      )
    // if left foot is or was U, R can't have toe on L
    const leftUpAndRightLeft =
      (this.layout.upArrows.includes(
        data.initialState.footColumns[Foot.LEFT_HEEL]
      ) ||
        this.layout.upArrows.includes(
          data.initialState.footColumns[Foot.LEFT_TOE]
        )) &&
      this.layout.leftArrows.includes(
        data.resultState.footColumns[Foot.RIGHT_TOE]
      )
    // if right foot is or was U, L can't have toe on R
    const rightUpAndLeftRight =
      (this.layout.upArrows.includes(
        data.initialState.footColumns[Foot.RIGHT_HEEL]
      ) ||
        this.layout.upArrows.includes(
          data.initialState.footColumns[Foot.RIGHT_TOE]
        )) &&
      this.layout.rightArrows.includes(
        data.resultState.footColumns[Foot.LEFT_TOE]
      )
    const twistedShin =
      leftDownAndRightLU ||
      rightDownAndLeftRU ||
      leftUpAndRightLeft ||
      rightUpAndLeftRight

    // TODO: separate to different unnatural facing/bracket cost?
    const unnaturalFacingRight =
      data.initialState.facing == Facing.Right &&
      ((this.layout.downArrows.includes(
        data.resultState.footColumns[Foot.LEFT_HEEL]
      ) &&
        this.layout.leftArrows.includes(
          data.resultState.footColumns[Foot.LEFT_TOE]
        )) ||
        (this.layout.rightArrows.includes(
          data.resultState.footColumns[Foot.RIGHT_HEEL]
        ) &&
          this.layout.upArrows.includes(
            data.resultState.footColumns[Foot.RIGHT_TOE]
          )) ||
        // would face backwards
        (this.layout.leftArrows.includes(
          data.resultState.footColumns[Foot.RIGHT_HEEL]
        ) &&
          this.layout.downArrows.includes(
            data.resultState.footColumns[Foot.LEFT_HEEL]
          )))
    const unnaturalFacingLeft =
      data.initialState.facing == Facing.Left &&
      ((this.layout.downArrows.includes(
        data.resultState.footColumns[Foot.RIGHT_HEEL]
      ) &&
        this.layout.rightArrows.includes(
          data.resultState.footColumns[Foot.RIGHT_TOE]
        )) ||
        (this.layout.leftArrows.includes(
          data.resultState.footColumns[Foot.LEFT_HEEL]
        ) &&
          this.layout.upArrows.includes(
            data.resultState.footColumns[Foot.LEFT_TOE]
          )) ||
        // would face backwards
        (this.layout.rightArrows.includes(
          data.resultState.footColumns[Foot.LEFT_HEEL]
        ) &&
          this.layout.downArrows.includes(
            data.resultState.footColumns[Foot.RIGHT_HEEL]
          )))
    // a provisional facing (chosen with a foot in the air) cannot be
    // contradicted: the landing foot decides it
    const facingTwistBracket =
      !data.initialState.facingProvisional && (unnaturalFacingRight || unnaturalFacingLeft)

    if (rightBackwards || leftBackwards || twistedShin || facingTwistBracket) {
      return this.WEIGHTS.TWISTED_FOOT
    }
    return 0
  }

  calcSpinCost(data: PlacementData) {
    let cost = 0

    // Body rotation is indeterminate when a foot is lifted: its position
    // defaults to pad center, producing degenerate ±90° pseudo-angles that
    // pass the gates below and fake a spin.
    if (
      this.isFootLifted(data.initialState, Foot.LEFT_HEEL) ||
      this.isFootLifted(data.initialState, Foot.RIGHT_HEEL) ||
      this.isFootLifted(data.resultState, Foot.LEFT_HEEL) ||
      this.isFootLifted(data.resultState, Foot.RIGHT_HEEL)
    ) {
      return 0
    }

    let prevAngle = getPlayerAngle(data.previousLeftPos, data.previousRightPos)

    let angle = getPlayerAngle(data.leftPos, data.rightPos)

    if (Math.abs(angle) < Math.PI / 2 || Math.abs(prevAngle) < Math.PI / 2) {
      return 0
    }

    if (angle < 0) angle += Math.PI * 2
    if (prevAngle < 0) prevAngle += Math.PI * 2

    // prevent facing backwards but not turning causing a spin
    if (angle == prevAngle) return 0

    // If we cross the 180 deg line, that's a spin
    if (
      ((prevAngle <= Math.PI && angle >= Math.PI) ||
        (prevAngle >= Math.PI && angle <= Math.PI)) &&
      data.initialState.frontFoot != data.resultState.frontFoot
    ) {
      cost += this.WEIGHTS.SPIN
    }

    return cost
  }

  // Free at stream speed, then a ramp capped at the old 0.4 s peak and never
  // dropping back to zero: a slow repeat is a jack unless the context pays
  // for the switch.
  private SlowFootswitchThreshold = 0.18

  private SlowFootswitchCap = 162.5
  calcSlowFootswitchCost(data: PlacementData, row: Row, elapsedTime: number) {
    if (elapsedTime < this.SlowFootswitchThreshold) return 0
    if (data.jumped) return 0

    // footswitching has no penalty if there's a mine nearby
    if (
      row.mines.some(x => x !== undefined) ||
      row.fakeMines.some(x => x !== undefined)
    ) {
      return 0
    }

    let cost = 0

    for (const foot of data.resultState.movedFeet) {
      const col = data.resultState.footColumns[foot]
      if (data.initialState.combinedColumns[col] == Foot.NONE) continue
      // A hold takeover is not a footswitch — HOLDSWITCH prices it.
      if (row.holds[col] !== undefined) continue
      if (
        data.initialState.combinedColumns[col] == foot ||
        data.initialState.combinedColumns[col] == OTHER_PART_OF_FOOT[foot]
      )
        continue
      cost += Math.min(
        ((elapsedTime - this.SlowFootswitchThreshold) / elapsedTime) *
          this.WEIGHTS.FOOTSWITCH,
        this.SlowFootswitchCap
      )
    }

    return cost
  }

  // A fast footswitch onto the panel where a holding foot's free part has
  // just tapped (on the previous row) displaces a part that is still
  // pressing; it would otherwise re-tap, a plain jack. Charged flat
  // on top of the slow-footswitch taper. A part that tapped two rows back
  // has had time to lift (xxxx-girl 185: toe on U since 0.39 s).
  private HoldPartFootswitchFactor = 0.4
  private HoldPartFootswitchMaxTime = 0.3
  calcHoldPartFootswitchCost(data: PlacementData, row: Row, elapsedTime: number) {
    if (data.jumped || elapsedTime >= this.HoldPartFootswitchMaxTime) return 0
    const init = data.initialState
    let cost = 0
    for (const foot of data.resultState.movedFeet) {
      const col = data.resultState.footColumns[foot]
      if (row.holds[col] !== undefined) continue
      const was = init.combinedColumns[col]
      if (was == Foot.NONE || was == foot || was == OTHER_PART_OF_FOOT[foot]) continue
      const justTapped = init.movedFeet.has(was)
      const partnerCol = init.footColumns[OTHER_PART_OF_FOOT[was]]
      if (justTapped && partnerCol != -1 && partnerCol != col && row.holds[partnerCol] !== undefined) {
        cost += this.WEIGHTS.FOOTSWITCH * this.HoldPartFootswitchFactor
      }
    }
    return cost
  }

  calcSideswitchCost(data: PlacementData, row: Row) {
    let cost = 0
    if (data.jumped) return 0

    // TODO: Are direct SS without a prior XO natural or not?
    // A sideswitch in a rotated body is a front or back step in the player's
    // frame (gasoline 72-76 stays rotated right through three of them), so
    // the persistent facing, not the feet's x-order, decides the discount.
    const wasCrossedOver = data.initialState.facing != Facing.Forward
    const minedRow =
      row.mines.some(x => x !== undefined) ||
      row.fakeMines.some(x => x !== undefined)
    const switchScale = wasCrossedOver || minedRow ? 0.25 : 1

    this.layout.sideArrows.forEach(col => {
      if (data.resultState.action[col] == Foot.NONE) return
      if (data.initialState.combinedColumns[col] == Foot.NONE) return
      if (
        data.initialState.combinedColumns[col] ==
          data.resultState.action[col] ||
        data.initialState.combinedColumns[col] ==
          OTHER_PART_OF_FOOT[data.resultState.action[col]]
      )
        return
      cost += this.WEIGHTS.SIDESWITCH * switchScale
    })

    return cost
  }

  // Un-rotating (the persistent facing drops back to Forward because a foot
  // landed on the side it cannot reach while turned) with the feet crossed in
  // the old rotated frame: the left foot ends up on the player's right of
  // the right foot. todo-sideswitch: rotated right, left in front on R, right
  // steps to U (the player's left) and the engine faced forward for free.
  calcRotationTwistCost(data: PlacementData) {
    const init = data.initialState
    const res = data.resultState
    if (init.facing == Facing.Forward || res.facing != Facing.Forward) return 0
    if (init.facingProvisional) return 0
    if (this.isFootLifted(res, Foot.LEFT_HEEL) || this.isFootLifted(res, Foot.RIGHT_HEEL)) return 0
    const lateral = (p: { x: number; y: number }) => (init.facing == Facing.Right ? p.y : -p.y)
    return lateral(data.leftPos) < lateral(data.rightPos) - 1e-6 ? this.WEIGHTS.TWISTED_FOOT : 0
  }

  calcMissedFootswitchCost(data: PlacementData, row: Row, elapsedTime: number) {
    return mineForcesFootswitch(data, row, elapsedTime) ? this.WEIGHTS.MISSED_FOOTSWITCH : 0
  }

  // Jacks are hard to do the faster they are.
  // Notes with an elapsed time less than this will incur a penalty
  // 0.125 = 16th note at 120bpm
  private JackMaxElapsedTime = 0.4
  private StepjumpJackFactor = 0.75

  // Single 1/t curve anchored at 0.4 s. The old curve anchored at 0.125 s
  // plunged to ~0 just below its threshold (a 16th jack at 128 bpm cost less
  // than a flat 8th surcharge) and slower repeats were entirely free. The
  // 4/15 coefficient matches the old pricing at 0.1 s, so fast-minijack
  // conventions are preserved; 128 bpm now prices 16th ~128, 8th ~38, and
  // repeats taper to free by 0.4 s.
  calcJackCost(data: PlacementData, row: Row, elapsedTime: number, stepjump = false) {
    // A same-foot repeat is never entirely free: small fixed base at any
    // speed (kept below a switching foot's travel cost so slow repeats don't
    // flip to hallucinated switches), plus the speed curve under the window.
    const jackCost =
      this.WEIGHTS.JACK * 0.125 +
      (elapsedTime < this.JackMaxElapsedTime
        ? (1 / elapsedTime - 1 / this.JackMaxElapsedTime) *
          this.WEIGHTS.JACK *
          (4 / 15)
        : 0)
    let cost = 0
    // At jack speeds a same-panel repeat is a real minijack even right after
    // a jump — the post-jump exemption only makes sense at comfortable speeds
    // where the repeat is unavoidable-but-easy.
    if (data.leftJack || data.rightJack) {
      cost += jackCost
    }
    // "Jump-jacks": a foot re-stepping a panel it is already on as part of a
    // jump, right after that foot moved, is a minijack for that foot; being
    // part of a jump shouldn't exempt it (charged per re-stepping foot).
    // On a stepjump (see isStepjump) the planted foot's re-press is the
    // pattern itself: charged at a fraction of a minijack, so that a bracket
    // or a crossed jump that avoids the re-press can still win when the rows
    // after it reward that.
    if (data.jumped) {
      const planted = stepjump || isPlantedJump(row, data.initialState, data.resultState, elapsedTime)
      const f = planted ? this.StepjumpJackFactor : 1
      for (const heel of [Foot.LEFT_HEEL, Foot.RIGHT_HEEL]) {
        const kind = jumpRepress(data.initialState, data.resultState, heel)
        if (kind == "same") cost += jackCost * f
        else if (kind == "subset") cost += jackCost * this.StepjumpJackFactor
      }
    }
    return cost
  }

  private CandleFactor = 1.0

  calcDistanceCost(data: PlacementData, elapsedTime: number, rows: Row[] = [], rowIndex = 0) {
    let cost = 0
    const lastRow = rows[rowIndex - 1]
    const rowBefore = rows[rowIndex - 2]

    // To do: weighting for moving a foot a far distance in a fast time
    for (const foot of [Foot.LEFT_HEEL, Foot.RIGHT_HEEL]) {
      // either part: a bracket tap by the toe travels like one by the heel
      if (
        !data.resultState.movedFeet.has(foot) &&
        !data.resultState.movedFeet.has(OTHER_PART_OF_FOOT[foot])
      )
        continue

      const initialPosition =
        foot == Foot.LEFT_HEEL ? data.previousLeftPos : data.previousRightPos

      const resultPosition =
        foot == Foot.LEFT_HEEL ? data.leftPos : data.rightPos

      // If we're bracketing something, and the previous position + new position had an overlap,
      // then we don't need to worry about it, we're not actually moving
      // the foot very far
      const isBracketing =
        foot == Foot.LEFT_HEEL ? data.leftBracket : data.rightBracket
      if (isBracketing) {
        const initialHeel = data.initialState.footColumns[foot]
        const initialToe =
          data.initialState.footColumns[OTHER_PART_OF_FOOT[foot]]

        const resultHeel = data.resultState.footColumns[foot]
        let resultToe = data.resultState.footColumns[OTHER_PART_OF_FOOT[foot]]
        if (resultToe == -1) resultToe = resultHeel

        if (initialHeel != -1) {
          if (initialHeel == resultHeel || initialHeel == resultToe) {
            // continue
          }
        }

        if (initialToe != -1) {
          if (initialToe == resultHeel || initialToe == resultToe) {
            // continue
          }
        }
      }

      // DISTANCE prices required velocity. A foot that did not move on the
      // previous row has had at least the previous row gap to travel as
      // well, so charge its velocity over the wider window instead of
      // pretending the whole move happened within one row gap.
      let footTime = elapsedTime
      if (
        !data.initialState.movedFeet.has(foot) &&
        !data.initialState.movedFeet.has(OTHER_PART_OF_FOOT[foot])
      ) {
        footTime *= 2
      }
      // A foot that took over a roll re-tapped it halfway through the last
      // row gap, so it has been free to leave since then.
      else if (lastRow && rowBefore) {
        const c = data.initialState.footColumns[foot]
        if (
          data.initialState.movedFeet.has(foot) &&
          c != -1 &&
          lastRow.holds[c]?.type == "Roll" &&
          !lastRow.notes[c]
        ) {
          footTime += (lastRow.second - rowBefore.second) / 2
        }
      }

      if (data.previousJumped && !data.jumped && elapsedTime < 0.25) {
        footTime = Math.pow(footTime, 1.5)
      }

      // A candle (one foot across the pad centre, D<->U or L<->R) is more
      // than its length: the foot passes over the centre and lands reversed.
      const travel = Math.sqrt(
        this.layout.getDistanceSqPoints(initialPosition, resultPosition)
      )
      const dist =
        (travel * (travel >= 2 - 1e-6 ? this.CandleFactor : 1) * this.WEIGHTS.DISTANCE) /
        footTime
      // if (isBracketing) {
      //   dist = dist * 0.2
      // }

      cost += dist
    }
    return cost
  }

  // A bracket onto a panel the other foot has settled on (it stood there
  // without acting on the previous row) displaces that foot for no reason:
  // both feet already cover the pair, so a light jump needs no travel.
  // A bracket footswitch in a stream (the other foot arrived on the panel
  // the row before, or the pair comes fast) is not charged.
  private CrowdedBracketMinTime = 0.3
  calcCrowdedBracketCost(data: PlacementData, elapsedTime: number) {
    if (data.jumped || elapsedTime < this.CrowdedBracketMinTime) return 0
    const init = data.initialState
    const res = data.resultState
    const settledOn = (heel: Foot, toe: Foot, cols: number[]) =>
      [init.footColumns[heel], init.footColumns[toe]].some(c => c != -1 && cols.includes(c))
    if (
      data.leftBracket &&
      !data.previousMovedRight &&
      settledOn(Foot.RIGHT_HEEL, Foot.RIGHT_TOE, [res.leftHeel, res.leftToe])
    ) {
      return this.WEIGHTS.CROWDED_BRACKET
    }
    if (
      data.rightBracket &&
      !data.previousMovedLeft &&
      settledOn(Foot.LEFT_HEEL, Foot.LEFT_TOE, [res.rightHeel, res.rightToe])
    ) {
      return this.WEIGHTS.CROWDED_BRACKET
    }
    return 0
  }
}
