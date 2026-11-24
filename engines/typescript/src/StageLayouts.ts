import {
  Foot,
  OTHER_PART_OF_FOOT,
  ParityState,
  PlacementData,
  Row,
} from "./ParityDataTypes.js"
import { doFeetOverlap } from "./ParityUtils.js"

export interface StagePoint {
  x: number
  y: number
  rotation: number
}

const JUMP_EITHER_PART = true

// relative slack when comparing a row gap with twice a roll's stream step
const STREAM_GAP_TOLERANCE = 0.05

export class StageLayout {
  name: string
  layout: StagePoint[]
  columnCount: number
  upArrows: number[]
  downArrows: number[]
  sideArrows: number[]
  leftArrows: number[]
  rightArrows: number[]
  constructor(
    name: string,
    layout: StagePoint[],
    upArrows: number[],
    downArrows: number[],
    sideArrows: number[]
  ) {
    this.name = name
    this.layout = layout
    this.columnCount = layout.length
    this.upArrows = upArrows
    this.downArrows = downArrows
    this.sideArrows = sideArrows

    // TODO: Doesn't work for doubles
    this.leftArrows = this.sideArrows.filter(col => this.layout[col].x < 0)
    this.rightArrows = this.sideArrows.filter(col => this.layout[col].x > 0)
  }

  crossedFeet(state: ParityState): {
    leftOnRight: boolean
    rightOnLeft: boolean
  } {
    const leftOnRight = [Foot.LEFT_HEEL, Foot.LEFT_TOE].some(foot =>
      this.rightArrows.includes(state.footColumns[foot])
    )

    const rightOnLeft = [Foot.RIGHT_HEEL, Foot.RIGHT_TOE].some(foot =>
      this.leftArrows.includes(state.footColumns[foot])
    )

    return { leftOnRight, rightOnLeft }
  }

  // Returns the cosine of the angle made between the player's
  // left and right feet and the x-axis.
  // This value can inform us on the degree of turning, but
  // not which way the player is turned
  getFacingDirectionCosine(leftIndex: number, rightIndex: number) {
    if (leftIndex == rightIndex) return 0
    let dx = this.layout[rightIndex].x - this.layout[leftIndex].x
    const dy = this.layout[rightIndex].y - this.layout[leftIndex].y

    const distance = Math.sqrt(dx * dx + dy * dy)
    dx /= distance
    return dx
  }

  getYDifference(leftIndex: number, rightIndex: number) {
    if (leftIndex == rightIndex) return 0
    const dx = this.layout[rightIndex].x - this.layout[leftIndex].x
    let dy = this.layout[rightIndex].y - this.layout[leftIndex].y

    const distance = Math.sqrt(dx * dx + dy * dy)
    dy /= distance

    const negative = dy <= 0

    dy = Math.pow(dy, 4)

    if (negative) dy = -dy

    return dy
  }

  averagePoint(leftIndex: number, rightIndex: number) {
    if (leftIndex == -1 && rightIndex == -1) return { x: 0, y: 0 }
    if (leftIndex == -1) return this.layout[rightIndex]
    if (rightIndex == -1) return this.layout[leftIndex]
    return {
      x: (this.layout[leftIndex].x + this.layout[rightIndex].x) / 2,
      y: (this.layout[leftIndex].y + this.layout[rightIndex].y) / 2,
    }
  }

  getDistanceSq(leftIndex: number, rightIndex: number) {
    const p1 = this.layout[leftIndex]
    const p2 = this.layout[rightIndex]
    return (p1.y - p2.y) * (p1.y - p2.y) + (p1.x - p2.x) * (p1.x - p2.x)
  }

  getDistanceSqPoints(
    p1: { x: number; y: number },
    p2: { x: number; y: number }
  ) {
    return (p1.y - p2.y) * (p1.y - p2.y) + (p1.x - p2.x) * (p1.x - p2.x)
  }

  bracketCheck(column1: number, column2: number) {
    return this.getDistanceSq(column1, column2) <= 2
  }

  getPlayerAngle(leftIndex: number, rightIndex: number) {
    const left = this.layout[leftIndex]
    const right = this.layout[rightIndex]
    const x1 = right.x - left.x
    const y1 = right.y - left.y
    const x2 = 1
    const y2 = 0
    const dot = x1 * x2 + y1 * y2
    const det = x1 * y2 - y1 * x2
    return Math.atan2(det, dot)
  }

  getPlacementData(
    initialState: ParityState,
    resultState: ParityState,
    lastRow: Row,
    row: Row
  ): PlacementData {
    const previousNonHeldFeet = []
    const nonHeldFeet = []

    for (let i = 0; i < this.layout.length; i++) {
      if (
        lastRow &&
        lastRow.holds[i] === undefined &&
        initialState.action[i] != Foot.NONE
      ) {
        previousNonHeldFeet[initialState.action[i]] = true
      }

      if (row.holds[i] === undefined && resultState.action[i] != Foot.NONE) {
        nonHeldFeet[resultState.action[i]] = true
      }
    }

    const previousMovedLeft =
      previousNonHeldFeet[Foot.LEFT_HEEL] || previousNonHeldFeet[Foot.LEFT_TOE]
    const previousMovedRight =
      previousNonHeldFeet[Foot.RIGHT_HEEL] ||
      previousNonHeldFeet[Foot.RIGHT_TOE]

    const movedLeft = nonHeldFeet[Foot.LEFT_HEEL] || nonHeldFeet[Foot.LEFT_TOE]
    const movedRight =
      nonHeldFeet[Foot.RIGHT_HEEL] || nonHeldFeet[Foot.RIGHT_TOE]

    const leftBracket =
      nonHeldFeet[Foot.LEFT_HEEL] && nonHeldFeet[Foot.LEFT_TOE]
    const rightBracket =
      nonHeldFeet[Foot.RIGHT_HEEL] && nonHeldFeet[Foot.RIGHT_TOE]

    const previousJumped = JUMP_EITHER_PART
      ? previousMovedLeft && previousMovedRight
      : previousNonHeldFeet[Foot.LEFT_HEEL] && previousNonHeldFeet[Foot.RIGHT_HEEL]

    const jumped = JUMP_EITHER_PART
      ? movedLeft && movedRight
      : nonHeldFeet[Foot.LEFT_HEEL] && nonHeldFeet[Foot.RIGHT_HEEL]

    const leftTraveled = resultState.traveledFeet.has(Foot.LEFT_HEEL)
    const rightTraveled = resultState.traveledFeet.has(Foot.RIGHT_HEEL)

    const leftJack =
      !jumped &&
      doFeetOverlap(
        initialState.leftHeel,
        initialState.leftToe,
        resultState.leftHeel,
        resultState.leftToe
      ) &&
      previousMovedLeft &&
      movedLeft &&
      !leftTraveled
    const rightJack =
      !jumped &&
      doFeetOverlap(
        initialState.rightHeel,
        initialState.rightToe,
        resultState.rightHeel,
        resultState.rightToe
      ) &&
      previousMovedRight &&
      movedRight &&
      !rightTraveled

    const previousRealJump =
      previousJumped &&
      initialState.traveledFeet.has(Foot.LEFT_HEEL) &&
      initialState.traveledFeet.has(Foot.RIGHT_HEEL)

    // A roll re-tapped between rows acts like an arrow on its panel: the
    // re-tapping foot acted in between, so the other foot moving now
    // alternates with it. The foot that took the roll over re-tapped it; the
    // foot that stays on it only when the gap is a hole in the stream the
    // roll started in (twice its step), since a roll can also stand for a
    // short hold.
    const gap = lastRow ? row.second - lastRow.second : 0
    const streamGap = (step: number | undefined) =>
      step !== undefined && Math.abs(gap - 2 * step) <= STREAM_GAP_TOLERANCE * gap
    let leftRetapped = false
    let rightRetapped = false
    const rollTaps: { col: number; foot: Foot }[] = []
    for (let i = 0; i < this.layout.length; i++) {
      const hold = row.holds[i]
      if (hold?.type != "Roll" || hold.beat > initialState.beat) continue
      const before = initialState.combinedColumns[i]
      if (before == Foot.NONE) continue
      const after = resultState.combinedColumns[i]
      const stayed = after == Foot.NONE || after == before || after == OTHER_PART_OF_FOOT[before]
      if (stayed && !streamGap(row.rollSteps[i])) continue
      const tapper = stayed ? before : after
      rollTaps.push({ col: i, foot: tapper })
      if (tapper == Foot.LEFT_HEEL || tapper == Foot.LEFT_TOE) leftRetapped = true
      else rightRetapped = true
    }

    const leftDoubleStep =
      !rightRetapped &&
      previousMovedLeft &&
      movedLeft &&
      leftTraveled &&
      !jumped &&
      !leftJack &&
      !previousRealJump
    const rightDoubleStep =
      !leftRetapped &&
      previousMovedRight &&
      movedRight &&
      rightTraveled &&
      !jumped &&
      !rightJack &&
      !previousRealJump
    // The planted foot of a stepjump moving next: the mover made the last
    // move, so the row is not labelled a doublestep (RowStatCalculator);
    // the cost still charges it.
    const leftAfterStepjump = previousJumped && initialState.traveledFeet.has(Foot.RIGHT_HEEL) && !initialState.traveledFeet.has(Foot.LEFT_HEEL)
    const rightAfterStepjump = previousJumped && initialState.traveledFeet.has(Foot.LEFT_HEEL) && !initialState.traveledFeet.has(Foot.RIGHT_HEEL)

    // Traveling into a jump whose partner only re-pressed, right after this
    // foot moved: the phantom jump doesn't excuse the consecutive travel.
    // Charged by DS_JUMP (lower than DOUBLESTEP — full weight here caused
    // hallucinated dodges, see findings round 6g).
    // const leftJumpedDS =
    //   jumped &&
    //   previousMovedLeft &&
    //   leftTraveled &&
    //   !rightTraveled
    // const rightJumpedDS =
    //   jumped &&
    //   previousMovedRight &&
    //   rightTraveled &&
    //   !leftTraveled

    const previousLeftPos = this.footPosition(initialState, Foot.LEFT_HEEL)
    const previousRightPos = this.footPosition(initialState, Foot.RIGHT_HEEL)

    const leftPos = this.footPosition(resultState, Foot.LEFT_HEEL)
    const rightPos = this.footPosition(resultState, Foot.RIGHT_HEEL)

    return {
      previousLeftPos,
      previousRightPos,
      leftPos,
      rightPos,
      movedLeft,
      movedRight,
      previousMovedLeft,
      previousMovedRight,
      leftBracket,
      rightBracket,
      previousJumped,
      jumped,
      leftJack,
      rightJack,
      leftDoubleStep,
      rightDoubleStep,
      rollTaps,
      leftAfterStepjump,
      rightAfterStepjump,
      // leftJumpedDS,
      // rightJumpedDS,
      initialState,
      resultState,
    }
  }

  // offset hovering (-1) y by 0.5 depending on frontFoot
  footPosition(state: ParityState, heel: Foot): { x: number; y: number } {
    const heelCol = state.footColumns[heel]
    const toeCol = state.footColumns[OTHER_PART_OF_FOOT[heel]]
    if (heelCol != -1 || toeCol != -1) {
      return this.averagePoint(heelCol, toeCol)
    }
    if (state.frontFoot == null) {
      return { x: 0, y: 0 }
    }
    const sign = state.frontFoot == heel ? 1 : -1
    return { x: 0, y: 0.5 * sign }
  }
}

export const STAGE_LAYOUTS: { [id: string]: StageLayout } = {
  "dance-single": new StageLayout(
    "dance-single",
    [
      { x: -1, y: 0, rotation: 0 }, // Left
      { x: 0, y: -1, rotation: (Math.PI / 2) * 3 }, // Down
      { x: 0, y: 1, rotation: Math.PI / 2 }, // Up
      { x: 1, y: 0, rotation: Math.PI }, // Right
    ],
    [2],
    [1],
    [0, 3]
  ),
  "dance-double": new StageLayout(
    "dance-double",
    [
      { x: -2.5, y: 0, rotation: 0 }, // P1 Left
      { x: -1.5, y: -1, rotation: (Math.PI / 2) * 3 }, // P1 Down
      { x: -1.5, y: 1, rotation: Math.PI / 2 }, // P1 Up
      { x: -0.5, y: 0, rotation: Math.PI }, // P1 Right

      { x: 0.5, y: 0, rotation: 0 }, // P2 Left
      { x: 1.5, y: -1, rotation: (Math.PI / 2) * 3 }, // P2 Down
      { x: 1.5, y: 1, rotation: Math.PI / 2 }, // P2 Up
      { x: 2.5, y: 0, rotation: Math.PI }, // P2 Right
    ],
    [2, 6],
    [1, 5],
    [0, 3, 4, 7]
  ),
}
