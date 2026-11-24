import {
  Foot,
  OTHER_PART_OF_FOOT,
  ParityState,
  PlacementData,
  Row,
  TechCategory,
  TechErrors,
} from "./ParityDataTypes.js"
import { ParityGraphNode } from "./ParityInternals.js"
import { SECOND_EPSILON, getPlayerAngle, isPlantedJump, isStepjump, mineForcesFootswitch } from "./ParityUtils.js"
import { StageLayout } from "./StageLayouts.js"

export function calculateRowStats(
  nodes: ParityGraphNode[],
  rows: Row[],
  layout: StageLayout
) {
  const stats = new RowStatAccumulator(rows, layout, true)
  for (const node of nodes.slice(0, -1)) stats.push(node)
  return stats.result()
}

/**
 * Row stats of a best path fed one node at a time: the start node, then one
 * node per row. When a node is pushed, the previous node's children must be
 * set (the ambiguity checks read them) and the rows from the previous node's
 * row through the row after the pushed one must be present.
 */
export class RowStatAccumulator {
  private readonly techRows: (Set<TechCategory> | undefined)[] = [undefined]
  private readonly mineRows: { beat: number; second: number; techs: Set<TechCategory> }[] = []
  private readonly rollTaps: { beat: number; second: number; col: number; foot: Foot }[] = []
  private readonly techErrors = new Map<number, Set<TechErrors>>()
  private readonly facingRows: number[] = [0]
  private readonly candles = new Map<number, Foot>()
  private readonly techCounts: number[] = []
  private readonly techErrorCounts: number[] = []
  private previous?: ParityGraphNode
  private pushed = 0
  // per column, a hold or roll no foot is on: its note, the row it was released on and the foot that left it
  private readonly releases = new Map<number, { hold: Row["holds"][number]; row: number; foot: Foot }>()

  constructor(
    private readonly rows: Row[],
    private readonly layout: StageLayout,
    private readonly keepRows: boolean
  ) {}

  push(node: ParityGraphNode) {
    if (this.pushed == 1) this.firstRow(this.previous!, node)
    else if (this.pushed > 1) this.pair(this.previous!, node, this.pushed - 2)
    this.previous = node
    this.pushed++
  }

  counts() {
    return { techCounts: this.techCounts, techErrorCounts: this.techErrorCounts }
  }

  result() {
    return {
      techRows: this.techRows,
      mineRows: this.mineRows,
      rollTaps: this.rollTaps,
      techErrors: this.techErrors,
      facingRows: this.facingRows,
      candles: this.candles,
      techCounts: this.techCounts,
      techErrorCounts: this.techErrorCounts,
    }
  }

  // XO on every row a crossed-over foot presses: a part of that foot presses
  // a panel on the far side. LX instead when the foot travelled there while
  // the other foot is already on its own far side (both feet crossed).
  private crossedPress(state: ParityState): TechCategory | undefined {
    const crosses = this.layout.crossedFeet(state)
    const sides = [
      { heel: Foot.LEFT_HEEL, far: this.layout.rightArrows, otherCrossed: crosses.rightOnLeft },
      { heel: Foot.RIGHT_HEEL, far: this.layout.leftArrows, otherCrossed: crosses.leftOnRight },
    ]
    let result: TechCategory | undefined
    for (const { heel, far, otherCrossed } of sides) {
      const pressedFar = [heel, OTHER_PART_OF_FOOT[heel]].some(
        part => state.movedFeet.has(part) && far.includes(state.footColumns[part])
      )
      if (!pressedFar) continue
      if (otherCrossed && state.traveledFeet.has(heel)) return TechCategory.LateralCrossovers
      result = TechCategory.Crossovers
    }
    return result
  }

  // MD: a mine on a panel a foot stands on before the row, and the row does
  // not lift and press that foot anyway
  private isMineDodge(columns: number[], before: ParityState, after: ParityState) {
    return [Foot.LEFT_HEEL, Foot.RIGHT_HEEL].some(heel => {
      const parts = [heel, OTHER_PART_OF_FOOT[heel]]
      return (
        parts.some(part => columns.includes(before.footColumns[part])) &&
        !parts.some(part => after.movedFeet.has(part))
      )
    })
  }

  // HS on an earlier row: the holding foot left there, and the other foot took the hold back now
  private addTech(row: number, tech: TechCategory) {
    this.techCounts[tech] = (this.techCounts[tech] || 0) + 1
    if (!this.keepRows) return
    const techs = (this.techRows[row] ??= new Set())
    techs.add(tech)
  }

  // a tech between two rows (a mine dodge, a roll re-tap), kept with the mine rows
  private addOffRowTech(beat: number, second: number, tech: TechCategory) {
    this.techCounts[tech] = (this.techCounts[tech] || 0) + 1
    if (!this.keepRows) return
    const existing = this.mineRows.find(m => Math.abs(m.second - second) < SECOND_EPSILON)
    if (existing) {
      existing.techs.add(tech)
      return
    }
    let at = this.mineRows.length
    while (at > 0 && this.mineRows[at - 1].second > second) at--
    this.mineRows.splice(at, 0, { beat, second, techs: new Set([tech]) })
  }

  private record(row: number, techs: Set<TechCategory>, errors: Set<TechErrors>) {
    techs.forEach(tech => {
      this.techCounts[tech] = (this.techCounts[tech] || 0) + 1
    })
    errors.forEach(error => {
      this.techErrorCounts[error] = (this.techErrorCounts[error] || 0) + 1
    })
    if (!this.keepRows) return
    if (row == 0) {
      if (techs.size) this.techRows[0] = techs
    } else {
      this.techRows.push(techs.size == 0 ? undefined : techs)
    }
    if (errors.size) this.techErrors.set(row, errors)
  }

  private firstRow(start: ParityGraphNode, node: ParityGraphNode) {
    const rows = this.rows
    const errors = new Set<TechErrors>()
    // Check first row for ambiguous
    if (rows[0].notes.filter(n => n !== undefined).length == 1) {
      const cost =
        start.children.get(node.key)!["TOTAL"] -
        start.children.get(node.key)!["DISTANCE"]
      if (
        Array.from(start.children).some(([child, costs]) => {
          if (child == node.key) return false
          if (costs["TOTAL"] - costs["DISTANCE"] <= cost) {
            return true
          }
          return false
        })
      ) {
        errors.add(TechErrors.Ambiguous)
      }
    }
    // The first row has no previous row, so only its row-local labels apply:
    // a bracket, a jump or a stepjump.
    const data = this.layout.getPlacementData(
      start.state,
      node.state,
      undefined as unknown as Row,
      rows[0]
    )
    const first = new Set<TechCategory>()
    if (data.leftBracket || data.rightBracket) first.add(TechCategory.Brackets)
    if (data.jumped)
      first.add(isStepjump(rows, 0) ? TechCategory.Stepjumps : TechCategory.Jumps)
    this.record(0, first, errors)
  }

  // the stats of row i + 1, from the path nodes of rows i and i + 1
  private pair(initial: ParityGraphNode, current: ParityGraphNode, i: number) {
    const rows = this.rows
    const layout = this.layout
    const initialState = initial.state
    const initialRow = rows[i]
    const currentState = current.state
    const currentRow = rows[i + 1]
    const data = layout.getPlacementData(
      initialState,
      currentState,
      initialRow,
      currentRow
    )

    if (this.keepRows) {
      this.facingRows.push(getPlayerAngle(data.leftPos, data.rightPos))
      for (const { col, foot } of data.rollTaps) {
        this.rollTaps.push({
          beat: (initialRow.beat + currentRow.beat) / 2,
          second: (initialRow.second + currentRow.second) / 2,
          col,
          foot,
        })
      }
    }

    const techs = new Set<TechCategory>()
    const errors = new Set<TechErrors>()

    for (let c = 0; c < currentRow.holds.length; c++) {
      if (currentRow.holds[c] === undefined) continue
      // Skip holds that weren't yet held at the previous row. (The old guard
      // was inverted — `beat < initialState.beat` skipped every hold OLDER
      // than one row, so takeovers of long holds were never annotated HS and
      // fell through to the footswitch check instead.)
      if (currentRow.holds[c]!.beat > data.initialState.beat) continue
      const hold = currentRow.holds[c]!
      const initialFoot = data.initialState.combinedColumns[c]
      const resultFoot = data.resultState.combinedColumns[c]
      if (resultFoot == Foot.NONE) {
        if (initialFoot != Foot.NONE && !currentRow.holdTails.has(c)) this.releases.set(c, { hold, row: i + 1, foot: initialFoot })
        continue
      }
      if (initialFoot == Foot.NONE) {
        const release = this.releases.get(c)
        if (release?.hold === hold && isLeft(release.foot) != isLeft(resultFoot)) this.addTech(release.row, TechCategory.Holdswitch)
        this.releases.delete(c)
        continue
      }
      if (
        initialFoot != resultFoot &&
        initialFoot != OTHER_PART_OF_FOOT[resultFoot]
      ) {
        if (hold.type == "Roll") {
          // labelled like the re-tap were an arrow (minus the jack)
          const beat = (initialRow.beat + currentRow.beat) / 2
          const second = (initialRow.second + currentRow.second) / 2
          const sideswitch = layout.sideArrows.includes(c)
          this.addOffRowTech(beat, second, sideswitch ? TechCategory.Sideswitches : TechCategory.Footswitches)
          if (isLeft(resultFoot) ? layout.rightArrows.includes(c) : layout.leftArrows.includes(c))
            this.addOffRowTech(beat, second, TechCategory.Crossovers)
        } else {
          techs.add(TechCategory.Holdswitch)
        }
      }
    }
    for (const [c, release] of this.releases) {
      if (currentRow.holds[c] !== release.hold) this.releases.delete(c)
    }

    if (!techs.has(TechCategory.Holdswitch) && !data.jumped) {
      if (
        ((data.leftDoubleStep && !data.leftAfterStepjump) ||
          (data.rightDoubleStep && !data.rightAfterStepjump)) &&
        !techs.has(TechCategory.Holdswitch)
      ) {
        techs.add(TechCategory.Doublesteps)

        if (!isDoublestepMarked(data, initialRow, currentRow, layout)) {
          errors.add(TechErrors.UnmarkedDoublestep)
        }
      }

      // Footswitch
      for (const foot of currentState.movedFeet) {
        const col = currentState.footColumns[foot]
        if (initialState.combinedColumns[col] == Foot.NONE) continue
        // taking over a roll's re-tap is labelled between the rows
        if (currentRow.holds[col] !== undefined) continue
        if (
          initialState.combinedColumns[col] == foot ||
          initialState.combinedColumns[col] == OTHER_PART_OF_FOOT[foot]
        )
          continue
        if (layout.sideArrows.includes(col)) {
          techs.add(TechCategory.Sideswitches)
        } else {
          techs.add(TechCategory.Footswitches)
        }
        break
      }
    }

    // TODO: Is this the definition of a KS? Are there any other conditions?
    if (
      techs.has(TechCategory.Footswitches) &&
      techs.has(TechCategory.Doublesteps)
    ) {
      techs.delete(TechCategory.Footswitches)
      techs.delete(TechCategory.Doublesteps)
      techs.add(TechCategory.Kickswitches)
    }

    if (data.leftBracket || data.rightBracket) techs.add(TechCategory.Brackets)

    // Both feet acting simultaneously is a jump; 3-4 note rows are a bracket
    // jump and naturally carry BR and JU together.
    if (data.jumped) techs.add(TechCategory.Jumps)

    // Bracket-tap: one part of a foot taps an adjacent arrow while the other
    // part stays planted on an active hold. Not a bracket flag (that needs
    // both parts non-held), so it gets its own label.
    for (let c = 0; c < currentRow.holds.length; c++) {
      if (currentRow.holds[c] === undefined) continue
      // a hold ending on this row is not tapped against
      if (currentRow.holdTails.has(c)) continue
      const holder = currentState.combinedColumns[c]
      if (holder == Foot.NONE) continue
      const other = OTHER_PART_OF_FOOT[holder]
      const otherCol = currentState.footColumns[other]
      if (
        otherCol != -1 &&
        otherCol != c &&
        currentRow.notes[otherCol] !== undefined &&
        currentState.action[otherCol] == other
      ) {
        techs.add(TechCategory.Brackettaps)
        break
      }
    }

    // Stepjump: a jump whose adjacent single (the row before or after, within
    // StepjumpMaxGap) sits on one of the jump's panels, so that foot stays
    // planted across the jump boundary. The label sits on the jump row in
    // place of JU; the single rows carry nothing.
    if (
      data.jumped &&
      (isStepjump(rows, i + 1) ||
        isPlantedJump(currentRow, initialState, currentState, currentRow.second - initialRow.second))
    ) {
      techs.delete(TechCategory.Jumps)
      techs.add(TechCategory.Stepjumps)
    }

    // A single re-press right after a jump is a jack only for a foot that
    // did not travel into that jump (it re-pressed there too, so this is its
    // third press); a foot that travelled in and re-presses is the planted
    // single of a jump-single stepjump, and a part that was holding the
    // panel through the jump was not pressing it.
    const repeatAfterJump = (heel: Foot) => {
      if (initialState.traveledFeet.has(heel)) return false
      return [...currentState.movedFeet]
        .filter(f => f == heel || f == OTHER_PART_OF_FOOT[heel])
        .some(f => !initialState.holdFeet.has(initialState.combinedColumns[currentState.footColumns[f]]))
    }
    const jackAfterJump =
      (data.leftJack && repeatAfterJump(Foot.LEFT_HEEL)) ||
      (data.rightJack && repeatAfterJump(Foot.RIGHT_HEEL))
    // A repeated jump is JU only; the jump-jack is priced, not labelled.
    if (
      !techs.has(TechCategory.Brackets) &&
      (data.leftJack || data.rightJack) &&
      (!data.previousJumped || jackAfterJump)
    ) {
      techs.add(TechCategory.Jacks)
      if (mineForcesFootswitch(data, currentRow, currentRow.second - initialRow.second)) {
        errors.add(TechErrors.MissedFootswitch)
      }
    }

    const crossed = this.crossedPress(currentState)
    if (crossed !== undefined) techs.add(crossed)

    for (const mines of currentRow.mineRows) {
      if (!this.isMineDodge(mines.columns, initialState, currentState)) continue
      if (Math.abs(mines.second - currentRow.second) < SECOND_EPSILON) {
        techs.add(TechCategory.MineDodges)
        continue
      }
      this.addOffRowTech(mines.beat, mines.second, TechCategory.MineDodges)
    }

    if (isAmbiguous(data, currentRow, initial, current, i)) {
      errors.add(TechErrors.Ambiguous)
    }

    if (
      data.movedLeft &&
      Math.abs(data.previousLeftPos.y - data.leftPos.y) > 1.3
    ) {
      if (this.keepRows) this.candles.set(i + 1, Foot.LEFT_HEEL)
    }

    if (
      data.movedRight &&
      Math.abs(data.previousRightPos.y - data.rightPos.y) > 1.3
    ) {
      if (this.keepRows) this.candles.set(i + 1, Foot.RIGHT_HEEL)
    }

    this.record(i + 1, techs, errors)
  }
}

function isLeft(foot: Foot) {
  return foot == Foot.LEFT_HEEL || foot == Foot.LEFT_TOE
}

function isDoublestepMarked(
  data: PlacementData,
  initialRow: Row,
  currentRow: Row,
  layout: StageLayout
) {
  for (let i = 0; i < layout.layout.length; i++) {
    const hold = initialRow.holds[i]
    // If there is a hold that extends past the last row, we can DS
    if (
      (hold && !initialRow.holdTails.has(i)) ||
      currentRow.holds[i] !== undefined
    ) {
      return true
    }
  }

  if (data.leftDoubleStep) {
    const willHitMine =
      currentRow.mines[data.initialState.footColumns[Foot.LEFT_HEEL]] ||
      currentRow.fakeMines[data.initialState.footColumns[Foot.LEFT_HEEL]] ||
      currentRow.mines[data.initialState.footColumns[Foot.LEFT_TOE]] ||
      currentRow.fakeMines[data.initialState.footColumns[Foot.LEFT_TOE]]
    if (willHitMine) return true
  }
  if (data.rightDoubleStep) {
    const willHitMine =
      currentRow.mines[data.initialState.footColumns[Foot.RIGHT_HEEL]] ||
      currentRow.fakeMines[data.initialState.footColumns[Foot.RIGHT_HEEL]] ||
      currentRow.mines[data.initialState.footColumns[Foot.RIGHT_TOE]] ||
      currentRow.fakeMines[data.initialState.footColumns[Foot.RIGHT_TOE]]
    if (willHitMine) return true
  }
  return false
}

function isAmbiguous(
  data: PlacementData,
  currentRow: Row,
  initial: ParityGraphNode,
  current: ParityGraphNode,
  i: number
) {
  if (
    (!data.previousJumped && i != 0) ||
    currentRow.notes.filter(n => n !== undefined).length != 1
  )
    return false
  const noteIndex = currentRow.notes.findIndex(n => n !== undefined)
  if (
    data.initialState.combinedColumns[noteIndex] ==
      data.resultState.combinedColumns[noteIndex] ||
    data.initialState.combinedColumns[noteIndex] ==
      OTHER_PART_OF_FOOT[data.resultState.combinedColumns[noteIndex]]
  ) {
    return false
  }
  const cost =
    initial.children.get(current.key)!["TOTAL"] -
    initial.children.get(current.key)!["DISTANCE"]
  if (
    Array.from(initial.children).some(([child, costs]) => {
      if (child == current.key) return false
      if (costs["TOTAL"] - costs["DISTANCE"] <= cost) {
        return true
      }
      return false
    })
  ) {
    return true
  }
  return false
}
