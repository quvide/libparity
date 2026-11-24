// Parity generation algorithm
// Original algorithm by Jewel, improved by tillvit, improved further by mjvotaw, improved furtherer by tillvit

import {
  HoldNotedataEntry,
  Notedata,
  NotedataEntry,
  isHoldNote,
} from "./NoteTypes.js"
import { ParityCostCalculator } from "./ParityCost.js"
import {
  Facing,
  FEET,
  Foot,
  FootOverride,
  MineRow,
  OTHER_PART_OF_FOOT,
  ParityState,
  Row,
  compareStates,
} from "./ParityDataTypes.js"
import {
  ParityComputeData,
  ParityDebugData,
  ParityDebugStats,
  ParityDebugUpdateData,
} from "./ParityResultTypes.js"
import { HOLD_RELEASE_WINDOW, REVERSAL_WINDOW, ROLL_RELEASE_WINDOW, SECOND_EPSILON, holdOverrideAt } from "./ParityUtils.js"
import { RowStatAccumulator, calculateRowStats } from "./RowStatCalculator.js"
import { STAGE_LAYOUTS, StageLayout } from "./StageLayouts.js"

const NO_FOOT_COLUMNS = [-1, -1, -1, -1, -1]
const FOOT_PAIRS = [
  [Foot.LEFT_HEEL, Foot.LEFT_TOE],
  [Foot.RIGHT_HEEL, Foot.RIGHT_TOE],
] as const

export class ParityGraphNode {
  // map from ids to costs
  children: Map<string, { [id: string]: number }> = new Map()

  state: ParityState
  key: string

  constructor(state: ParityState, key?: string) {
    this.state = state
    if (key) {
      this.key = key
    } else {
      this.key = state.toKey()
    }
  }
}

export class ParityInternals {
  private readonly costCalc: ParityCostCalculator
  private readonly layout: StageLayout

  private readonly initialRow = {
    notes: [],
    holds: [],
    holdTails: new Set<number>(),
    rollSteps: [],
    mines: [],
    fakeMines: [],
    mineRows: [],
    second: -1,
    beat: -1,
    columns: [],
    overrides: [],
    id: "start",
  }
  private readonly endRow = {
    notes: [],
    holds: [],
    holdTails: new Set<number>(),
    rollSteps: [],
    mines: [],
    fakeMines: [],
    mineRows: [],
    second: -1,
    beat: -1,
    columns: [],
    overrides: [],
    id: "end",
  }

  // Start and end nodes of the graph
  private readonly initialNode: ParityGraphNode
  private readonly endNode: ParityGraphNode

  // Rows are identified by keys (includes beat/second/other data)
  // If two rows have the same key, they are considered the same row
  // Because of this, we can use the key to cache rows (because the calculation is the same)

  // Store cost calculations between two nodes by key
  private cachedEdges = new Map<string, Map<string, { [id: string]: number }>>()

  // Store the lowest cost for each node by key
  // lastDs: row of the path's latest same-foot repeat (doublestep or jack).
  // On an exact tie the path whose repeat comes later wins: feet alternate
  // until that stops making sense, instead of the choice falling to
  // floating-point rounding.
  private cachedLowestCost = new Map<
    string,
    { cost: number; path: string; lastDs?: number }
  >()
  private static readonly TieEpsilon = 1e-6
  private static readonly TurnPruneMargin = 1e-3
  private TurnPruning = true
  // In a bracket phrase where both feet stand on two panels each, a foot
  // re-pressing one of its panels may keep the other part planted (only a
  // heel or toe lifts); the collapsed stance stays available and the search
  // picks by cost.
  private KeepStanceAllCovered = true
  private HoverEnabled = true

  // Slim copy of cachedLowestCost for debug display (cumulative best cost per node)
  getNodeCosts() {
    const costs = new Map<string, number>()
    for (const [key, value] of this.cachedLowestCost) {
      costs.set(key, value.cost)
    }
    return costs
  }

  // Keep track of the size of the edge cache, prune when too large
  edgeCacheSize = 0

  // Cache for foot permutations
  private permuteCache = new Map<string, Foot[][]>()

  // Map of state keys to ParityGraphNodes
  nodeMap = new Map<string, ParityGraphNode>()

  private nEdges = 0

  // The best path found so far
  bestPath?: string[]
  bestPathCost = 0
  bestPathSet?: Set<string>

  debugStats: ParityDebugStats = {
    lastUpdatedRowStart: -1,
    lastUpdatedOldRowEnd: -1,
    lastUpdatedRowEnd: -1,
    rowUpdateTime: 0,
    lastUpdatedNodeStart: -1,
    lastUpdatedNodeEnd: -1,
    nodeUpdateTime: 0,
    createdNodes: 0,
    createdEdges: 0,
    calculatedEdges: 0,
    cachedEdges: 0,
    edgeUpdateTime: 0,
    cachedBestRows: 0,
    pathUpdateTime: 0,
    rowStatsUpdateTime: 0,
  }

  notedataRows: Row[] = []
  nodeRows: { beat: number; nodes: ParityGraphNode[] }[] = []

  constructor(gameType: string) {
    this.notedataRows = []
    this.layout = STAGE_LAYOUTS[gameType]
    if (!this.layout) {
      throw new Error(`Unsupported game type: ${gameType}`)
    }

    this.costCalc = new ParityCostCalculator(gameType)
    const noFeet = new Array(this.layout.columnCount).fill(Foot.NONE)
    const startState = new ParityState(this.initialRow, noFeet, new Array(5).fill(-1))
    startState.combinedColumns = [...noFeet]
    this.initialNode = new ParityGraphNode(startState)
    this.endNode = new ParityGraphNode(
      new ParityState(this.endRow, [], new Array(5).fill(-1))
    )
  }

  compute(
    startBeat: number,
    endBeat: number,
    notedata: Notedata
  ): ParityComputeData | null {
    if (this.layout == undefined) return null
    const updatedRows = this.recalculateRows(startBeat, endBeat, notedata)
    const updatedStates = this.recalculateStates(updatedRows)
    const updatedCosts = this.computeCosts(updatedStates)
    this.computeBestPath(updatedCosts)

    // Prune edge cache if too big
    const shouldPruneEdgeCache = this.edgeCacheSize > this.nEdges * 2
    if (shouldPruneEdgeCache) {
      this.edgeCacheSize = 0
      const newCache = new Map<string, Map<string, { [id: string]: number }>>()
      for (const nodeRow of this.nodeRows) {
        for (const node of nodeRow.nodes) {
          for (const [childKey, costs] of node.children.entries()) {
            let cache = newCache.get(node.key)
            if (!cache) {
              cache = new Map()
              newCache.set(node.key, cache)
            }
            cache.set(childKey, costs)
            this.edgeCacheSize++
          }
        }
      }
      this.cachedEdges = newCache
    }

    if (this.cachedLowestCost.size > this.nodeMap.size * 2) {
      this.cachedLowestCost.clear()
    }

    if (!this.bestPath) {
      return null
    }

    const bestNodes = this.bestPath.map((key, i) => {
      if (i == 0) return this.initialNode
      if (i == this.bestPath!.length - 1) return this.endNode
      return this.nodeMap.get(key)!
    })
    return this.buildResult(bestNodes)
  }

  // Same result as compute() on a fresh instance (see batchSearch);
  // replaces this instance's state.
  computeBatch(
    startBeat: number,
    endBeat: number,
    notedata: Notedata
  ): ParityComputeData | null {
    if (this.layout == undefined) return null
    this.reset()
    this.recalculateRows(startBeat, endBeat, notedata)
    const rows = this.notedataRows
    const bestNodes: ParityGraphNode[] = []
    const cost = this.batchSearch(i => i < rows.length, node => bestNodes.push(node))
    if (cost === null) return null
    bestNodes.forEach((node, i) => this.setPathChildren(node, i))
    this.bestPath = bestNodes.map(node => node.state.toKey())
    this.bestPathCost = cost
    this.bestPathSet = new Set(this.bestPath)
    return this.buildResult(bestNodes)
  }

  // computeBatch's tech and error counts, holding only the rows and states
  // of the traceback window; replaces this instance's state.
  computeBatchCounts(
    startBeat: number,
    endBeat: number,
    notedata: Notedata
  ): { techCounts: number[]; techErrorCounts: number[] } | null {
    if (this.layout == undefined) return null
    this.reset()
    const rows = this.notedataRows
    const [noteStartIdx, noteEndIdx] = this.noteRange(notedata, startBeat, endBeat)
    const builder = this.rowBuilder(notedata, noteStartIdx)
    let next = noteStartIdx
    let finished = false
    const hasRow = (i: number) => {
      while (rows.length <= i && !finished) {
        if (next < noteEndIdx) {
          const row = builder.add(notedata[next++])
          if (row) rows.push(row)
        } else {
          const row = builder.finish()
          if (row) rows.push(row)
          finished = true
        }
      }
      return i < rows.length
    }
    const stats = new RowStatAccumulator(rows, this.layout, false)
    // path index: the start node is 0, a row's node is its row + 1
    let index = 0
    const cost = this.batchSearch(hasRow, node => {
      if (node === this.endNode) return
      this.setPathChildren(node, index)
      stats.push(node)
      // later pushes and setPathChildren read rows index - 1 on
      if (index >= 3) rows[index - 3] = undefined as unknown as Row
      index++
    })
    if (cost === null) return null
    return stats.counts()
  }

  /** rows a committed path node trails the search front by, at least */
  static readonly TracebackRows = 128

  // One forward pass over rows 0.. (while hasRow), keeping per row the best
  // path into each state. Passes the best path's nodes to commit() in order,
  // from the start node to the end node, and returns its cost, or null when
  // no path exists (commit() may have been called by then). hasRow(i) must
  // make rows 0..i available; a node is committed once the two rows after
  // it are.
  //
  // Ties break as in compute(): the later same-foot repeat (lastDs), then
  // the path whose state is lower (compareStates) where the two paths split.
  // The latter is a per-row rank: paths ordered by their parent's rank, then
  // by their own state.
  //
  // Every TracebackRows rows, the path into the current best state is
  // committed up to TracebackRows rows back and the states whose path
  // disagrees there are dropped, so memory stays bounded by the window. This
  // equals the unbounded search unless the best path changes more than
  // TracebackRows rows after the fact.
  private batchSearch(
    hasRow: (rowIndex: number) => boolean,
    commit: (node: ParityGraphNode) => void
  ): number | null {
    type Costs = { [id: string]: number }
    type Slot = {
      node: ParityGraphNode
      row: number
      reached: boolean
      cost: number
      lastDs: number
      rank: number
      parent?: Slot
      expandedBy: number
    }
    const slot = (node: ParityGraphNode, row: number): Slot =>
      ({ node, row, reached: false, cost: 0, lastDs: -1, rank: 0, expandedBy: -1 })
    const relax = (to: Slot, from: Slot, costs: Costs, parentRow: number) => {
      const newCost = from.cost + costs["TOTAL"]
      const lastDs =
        (costs["DOUBLESTEP"] ?? 0) > 0 || (costs["JACK"] ?? 0) > 0
          ? parentRow
          : from.lastDs
      const tie =
        to.reached &&
        Math.abs(newCost - to.cost) < ParityInternals.TieEpsilon &&
        (lastDs > to.lastDs || (lastDs == to.lastDs && from.rank < to.parent!.rank))
      if (!to.reached || newCost < to.cost - ParityInternals.TieEpsilon || tie) {
        to.reached = true
        to.cost = newCost
        to.lastDs = lastDs
        to.parent = from
      }
    }
    const best = (frontier: Slot[], row: number) => {
      const end = slot(this.endNode, row + 1)
      for (const from of frontier) relax(end, from, { TOTAL: 0 }, row)
      return end
    }
    const K = ParityInternals.TracebackRows
    // the first row not committed yet
    let committed = 0
    const commitThrough = (s: Slot) => {
      const nodes: ParityGraphNode[] = []
      for (let x: Slot | undefined = s; x && x.row >= committed; x = x.parent) nodes.push(x.node)
      for (let i = nodes.length - 1; i >= 0; i--) commit(nodes[i])
      committed = s.row + 1
    }

    const start = slot(this.initialNode, -1)
    start.reached = true
    hasRow(1)
    commit(this.initialNode)
    let frontier: Slot[] = [start]
    let expansion = 0
    let rowIndex = 0
    for (; hasRow(rowIndex); rowIndex++) {
      // the cost model looks one row ahead (stepjumps)
      hasRow(rowIndex + 1)
      const rowSlots = new Map<string, Slot>()
      for (const from of frontier) {
        expansion++
        for (const state of this.childStates(from.node.state, rowIndex)) {
          const key = state.rowLocalKey()
          let to = rowSlots.get(key)
          if (!to) {
            to = slot(new ParityGraphNode(state, key), rowIndex)
            rowSlots.set(key, to)
          } else if (to.expandedBy == expansion) {
            continue
          }
          to.expandedBy = expansion
          const costs = this.costCalc.getActionCost(
            from.node.state,
            to.node.state,
            this.notedataRows,
            rowIndex
          )
          relax(to, from, costs, rowIndex - 1)
        }
      }
      frontier = [...rowSlots.values()]
      if (this.TurnPruning) frontier = this.pruneTurnMemory(frontier)
      if (frontier.length == 0) return null
      ;[...frontier]
        .sort((a, b) => a.parent!.rank - b.parent!.rank || compareStates(a.node.state, b.node.state))
        .forEach((s, i) => (s.rank = i))

      if (rowIndex - committed + 1 >= 2 * K) {
        const target = rowIndex - K
        let anchor: Slot = best(frontier, rowIndex).parent!
        while (anchor.row > target) anchor = anchor.parent!
        commitThrough(anchor)
        frontier = frontier.filter(s => {
          let x = s
          while (x.row > target) x = x.parent!
          return x === anchor
        })
        anchor.parent = undefined
      }
    }
    const end = best(frontier, rowIndex - 1)
    commitThrough(end.parent!)
    commit(this.endNode)
    return end.cost
  }

  // The children of a best-path node, as compute() leaves them: the edges
  // from `node` into row `rowIndex` (the node's row + 1) with their costs.
  private setPathChildren(node: ParityGraphNode, rowIndex: number) {
    node.children.clear()
    if (!this.notedataRows[rowIndex]) return
    for (const state of this.childStates(node.state, rowIndex)) {
      const key = state.rowLocalKey()
      if (node.children.has(key)) continue
      node.children.set(
        key,
        this.costCalc.getActionCost(node.state, state, this.notedataRows, rowIndex)
      )
    }
  }

  // computeBatch's divergesFirst for compute()'s "*"-joined key paths
  private divergesFirst(a: string, b: string) {
    const x = a.split("*")
    const y = b.split("*")
    let i = 0
    while (x[i] == y[i]) i++
    return compareStates(this.nodeMap.get(x[i])!.state, this.nodeMap.get(y[i])!.state) < 0
  }

  // Drops a state when a state of the same stance with weaker turn memory
  // (none, or the same turn ending no later) is cheaper by more than
  // TurnPruneMargin: turn memory only adds reversal costs, so the dropped
  // state can never be on the best path.
  private pruneTurnMemory<T extends { node: ParityGraphNode; cost: number }>(slots: T[]): T[] {
    const groups = new Map<string, T[]>()
    for (const s of slots) {
      const key = s.node.state.stanceKey()
      const group = groups.get(key)
      if (group) group.push(s)
      else groups.set(key, [s])
    }
    const weaker = (a: ParityState, b: ParityState) =>
      a.lastTurn == Facing.Forward || (a.lastTurn == b.lastTurn && a.lastTurnEnd <= b.lastTurnEnd)
    const dropped = new Set<T>()
    for (const group of groups.values()) {
      if (group.length < 2) continue
      for (const b of group) {
        if (group.some(a => a !== b && a.cost + ParityInternals.TurnPruneMargin < b.cost && weaker(a.node.state, b.node.state)))
          dropped.add(b)
      }
    }
    return dropped.size ? slots.filter(s => !dropped.has(s)) : slots
  }

  private buildResult(bestNodes: ParityGraphNode[]): ParityComputeData {
    const parityLabels = new Map<string, Foot>()
    const labelRows = new Map<string, number>()

    // Per-hold ownership timeline: which foot covers each hold body over its
    // lifetime, keyed like parityLabels by the head note ("beat-col"). A new
    // entry is appended whenever the owning foot changes at a row
    // (holdswitch takeover, or heel<->toe re-orientation of the same foot).
    // A roll re-tap by the other foot happens between rows: its entry sits
    // halfway, where the FS is labelled.
    // Only holds that actually change hands are emitted; single-owner holds
    // are covered by the head note's parity.foot.
    const holdOwnership = new Map<string, { beat: number; foot: Foot }[]>()

    this.notedataRows.forEach((row, idx) => {
      const bestOption = bestNodes[idx + 1]
      const previous = bestNodes[idx].state.combinedColumns
      bestOption.state.combinedColumns.forEach((foot, col) => {
        if (foot == Foot.NONE) return
        const hold = row.holds[col]
        const rollTakeover =
          idx > 0 &&
          hold?.type == "Roll" &&
          previous[col] != Foot.NONE &&
          previous[col] != foot &&
          previous[col] != OTHER_PART_OF_FOOT[foot]
        // holdTails excluded: an "owner change" on the release row is the
        // foot leaving, not a takeover (a roll re-tapped before it ends is one).
        if (hold !== undefined && (!row.holdTails.has(col) || rollTakeover)) {
          const beat = rollTakeover ? (this.notedataRows[idx - 1].beat + row.beat) / 2 : row.beat
          const key = hold.beat.toFixed(3) + "-" + col
          const timeline = holdOwnership.get(key)
          if (!timeline) {
            // Row construction excludes a hold from row.holds on its head
            // row, so the head owner normally lands here via the head-note
            // branch below; this fallback covers heads outside the rows
            // (e.g. warped heads).
            holdOwnership.set(key, [{ beat: hold.beat, foot }])
          } else if (timeline.at(-1)!.foot != foot) {
            timeline.push({ beat, foot })
          }
        }
        if (!row.notes[col]) return
        parityLabels.set(row.notes[col].beat.toFixed(3) + "-" + col, foot)
        labelRows.set(row.notes[col].beat.toFixed(3) + "-" + col, idx)
        if (isHoldNote(row.notes[col])) {
          holdOwnership.set(row.notes[col].beat.toFixed(3) + "-" + col, [
            { beat: row.beat, foot },
          ])
        }
      })
    })

    // Keep only holds whose owner changes mid-hold
    for (const [key, timeline] of holdOwnership) {
      if (timeline.length < 2) holdOwnership.delete(key)
    }

    // TODO: Potentially optimize by sending only deltas

    const states = bestNodes.map(node => node.state)

    const rowStatsTimeStart = performance.now()

    const rowStats = calculateRowStats(
      bestNodes,
      this.notedataRows,
      this.layout
    )

    this.debugStats.rowStatsUpdateTime = performance.now() - rowStatsTimeStart

    const rowTimestamps = this.notedataRows.map(row => {
      return {
        beat: row.beat,
        second: row.second,
      }
    })

    return {
      parityLabels,
      labelRows,
      holdOwnership,
      states,
      rowTimestamps,
      ...rowStats,
    }
  }

  // Regenerates the rows for the given range of beats.
  recalculateRows(startBeat: number, endBeat: number, notedata: Notedata) {
    const rowTimeStart = performance.now()

    // Remove previous rows in the range
    const range = getRangeInSortedArray(
      this.notedataRows,
      Math.round(startBeat * 48), // prevent rounding errors
      Math.round(endBeat * 48),
      a => Math.round(a.beat * 48)
    )
    const startIdx = range[0]
    let endIdx = range[1]

    const [noteStartIdx, noteEndIdx] = this.noteRange(notedata, startBeat, endBeat)
    const builder = this.rowBuilder(notedata, noteStartIdx)
    const rows: Row[] = []
    for (let i = noteStartIdx; i < noteEndIdx; i++) {
      const row = builder.add(notedata[i])
      if (row) rows.push(row)
    }
    const last = builder.finish()
    if (last) rows.push(last)
    const { mines, fakeMines, mineRows } = builder

    // Update the next row if needed
    if (this.notedataRows[endIdx]) {
      this.notedataRows[endIdx].mines = mines
      this.notedataRows[endIdx].fakeMines = fakeMines
      this.notedataRows[endIdx].mineRows = mineRows
      const oldID = this.notedataRows[endIdx].id
      this.notedataRows[endIdx].id = this.rowToKey(this.notedataRows[endIdx])

      if (oldID != this.notedataRows[endIdx].id) {
        rows.push(this.notedataRows[endIdx])
        endIdx++
      }
    }

    this.debugStats.lastUpdatedRowStart = startIdx
    this.debugStats.lastUpdatedOldRowEnd = endIdx
    this.debugStats.lastUpdatedRowEnd = startIdx + rows.length

    // Clear old node rows

    // not splice(..., ...rows): spreading a marathon's rows overflows the stack
    const after = this.notedataRows.slice(endIdx)
    this.notedataRows.length = startIdx
    for (const row of rows) this.notedataRows.push(row)
    for (const row of after) this.notedataRows.push(row)
    this.debugStats.rowUpdateTime = performance.now() - rowTimeStart

    return {
      startIdx: startIdx,
      newEndIdx: startIdx + rows.length,
      oldEndIdx: endIdx,
    }
  }

  private noteRange(notedata: Notedata, startBeat: number, endBeat: number) {
    return getRangeInSortedArray(
      notedata,
      Math.round(startBeat * 48),
      Math.round(endBeat * 48),
      a => Math.round(a.beat * 48)
    )
  }

  // Builds rows from the notes at notedata[noteStartIdx..] fed to add() in
  // order: add() returns a row once the next row's first note arrives, and
  // finish() the last one. Holds and mines before noteStartIdx carry in.
  // `mines`/`fakeMines` are the mines after the last row, for the row after
  // the range.
  private rowBuilder(notedata: Notedata, noteStartIdx: number) {
    let activeHolds: (HoldNotedataEntry | undefined)[] = []
    let nextMines: (number | undefined)[] = []
    let nextFakeMines: (number | undefined)[] = []
    let mines: (number | undefined)[] = []
    let fakeMines: (number | undefined)[] = []
    let nextMineRows: MineRow[] = []
    let mineRows: MineRow[] = []
    const pushMine = (list: MineRow[], note: NotedataEntry) => {
      const last = list[list.length - 1]
      if (last && this.isSameSecond(last.second, note.second)) last.columns.push(note.col)
      else list.push({ beat: note.beat, second: note.second, columns: [note.col] })
    }

    // Search backwards to populate holds + mines
    let curIdx = noteStartIdx - 1
    const columnStatus = new Array<number>(this.layout.columnCount).fill(0)
    let fulfilledColumns = 0
    while (curIdx >= 0 && fulfilledColumns < columnStatus.length) {
      const note = notedata[curIdx]
      if (note.warped) {
        curIdx--
        continue
      }
      if (columnStatus[note.col] == 1) {
        curIdx--
        continue
      }
      if (note.type == "Mine" && fulfilledColumns == 0) {
        if (note.fake) {
          if (nextFakeMines[note.col] === undefined)
            fakeMines[note.col] = note.second
        } else {
          if (nextMines[note.col] === undefined) mines[note.col] = note.second
          const first = mineRows[0]
          if (first && this.isSameSecond(first.second, note.second)) first.columns.unshift(note.col)
          else mineRows.unshift({ beat: note.beat, second: note.second, columns: [note.col] })
        }
        curIdx--
        continue
      }

      if (note.fake) {
        curIdx--
        continue
      }

      columnStatus[note.col] = 1
      fulfilledColumns++

      if (isHoldNote(note)) {
        activeHolds[note.col] = note
      }

      curIdx--
    }

    let lastColumnSecond: number | null = null
    let lastColumnBeat: number | null = null
    let notes: NotedataEntry[] = []
    let overrides: FootOverride[] = []
    let emitted = 0

    const rollSteps = new Map<HoldNotedataEntry, number>()
    const isStep = (n: NotedataEntry) => !n.warped && !n.fake && n.type != "Mine"
    const rollStep = (hold: HoldNotedataEntry) => {
      let step = rollSteps.get(hold)
      if (step !== undefined) return step
      step = Infinity
      const [start, end] = this.noteRange(notedata, hold.beat, hold.beat)
      for (let i = start - 1; i >= 0; i--) {
        if (!isStep(notedata[i]) || this.isSameSecond(notedata[i].second, hold.second)) continue
        step = hold.second - notedata[i].second
        break
      }
      for (let i = end; i < notedata.length; i++) {
        if (!isStep(notedata[i]) || this.isSameSecond(notedata[i].second, hold.second)) continue
        step = Math.min(step, notedata[i].second - hold.second)
        break
      }
      rollSteps.set(hold, step)
      return step
    }

    const makeRow = (): Row => {
      const row: Row = {
        notes,
        holds: activeHolds.map(hold => {
          if (
            hold === undefined ||
            this.isSameSecond(hold.second, lastColumnSecond) ||
            hold.second > lastColumnSecond!
          )
            return undefined
          return hold
        }),
        holdTails: new Set(
          activeHolds
            .filter(hold => {
              if (hold === undefined) return false
              if (Math.abs(hold.beat + hold.hold - lastColumnBeat!) > 0.0005) {
                return false
              }
              return true
            })
            .map(hold => hold!.col)
        ),
        rollSteps: [],
        mines: nextMines,
        fakeMines: nextFakeMines,
        mineRows: nextMineRows,
        second: lastColumnSecond!,
        beat: lastColumnBeat!,
        columns: [],
        overrides,
        id: "",
      }
      row.holds.forEach((hold, c) => {
        if (hold?.type == "Roll") row.rollSteps[c] = rollStep(hold)
      })
      this.applyHoldOverrides(row)
      row.id = this.rowToKey(row)
      emitted++
      return row
    }

    return {
      get mines() {
        return mines
      },
      get fakeMines() {
        return fakeMines
      },
      get mineRows() {
        return mineRows
      },
      add: (note: NotedataEntry): Row | undefined => {
        if (note.warped) return undefined
        if (note.type == "Mine") {
          if (this.isSameSecond(note.second, lastColumnSecond) && emitted > 0) {
            if (note.fake) {
              nextFakeMines[note.col] = note.second
            } else {
              nextMines[note.col] = note.second
              pushMine(nextMineRows, note)
            }
          } else {
            if (note.fake) {
              fakeMines[note.col] = note.second
            } else {
              mines[note.col] = note.second
              pushMine(mineRows, note)
            }
          }
          return undefined
        }
        if (note.fake) return undefined
        let row: Row | undefined
        if (!this.isSameSecond(lastColumnSecond, note.second)) {
          if (lastColumnSecond != null && lastColumnBeat != null) {
            row = makeRow()
          }
          lastColumnSecond = note.second
          lastColumnBeat = note.beat
          notes = []
          overrides = []
          nextMines = mines
          nextFakeMines = fakeMines
          nextMineRows = mineRows
          mines = []
          fakeMines = []
          mineRows = []
          activeHolds = activeHolds.map(hold => {
            if (
              hold === undefined ||
              Math.round(note.beat * 48) >
                Math.round((hold.beat + hold.hold) * 48)
            )
              return undefined
            return hold
          })
        }
        notes[note.col] = note
        if (note.parity?.override) overrides[note.col] = note.parity?.override
        if (isHoldNote(note)) {
          activeHolds[note.col] = note
        }
        return row
      },
      finish: (): Row | undefined => (notes.length != 0 ? makeRow() : undefined),
    }
  }

  // Regenerates the possible states/nodes given the range of updated rows
  recalculateStates(updatedRows: {
    startIdx: number
    newEndIdx: number
    oldEndIdx: number
  }) {
    this.debugStats.createdNodes = 0
    this.debugStats.createdEdges = 0
    const stateTimeStart = performance.now()

    // Get rid of old node rows
    const removedRows = this.nodeRows.splice(
      updatedRows.startIdx,
      updatedRows.oldEndIdx - updatedRows.startIdx
    )
    removedRows.forEach(row => {
      row.nodes.forEach(node => {
        this.nodeMap.delete(node.key)
        this.nEdges -= node.children.size
      })
    })

    // Previous node must also be affected by new row
    let rowIndex = updatedRows.startIdx ?? 0
    rowIndex -= 1
    this.debugStats.lastUpdatedNodeStart = rowIndex

    while (rowIndex < this.notedataRows.length - 1) {
      let nodes = this.nodeRows[rowIndex]?.nodes ?? [this.initialNode]
      const newNodes = new Set<ParityGraphNode>()

      for (const node of nodes) {
        this.nEdges -= node.children.size
        node.children.clear()
        for (const facingVariantState of this.childStates(node.state, rowIndex + 1)) {
          const newKey = facingVariantState.toKey()
          let newNode = this.nodeMap.get(newKey)
          if (!newNode) {
            newNode = new ParityGraphNode(facingVariantState, newKey)
            this.nodeMap.set(newKey, newNode)
          }
          newNodes.add(newNode)
          this.debugStats.createdEdges += 1
          this.nEdges++
          node.children.set(newNode.key, {})
        }
      }
      const newNodesArray = Array.from(newNodes)
      this.debugStats.createdNodes += newNodesArray.length

      // Stop when we end up with the same nodes as before and we are out of the new range
      if (rowIndex + 1 >= updatedRows.newEndIdx) {
        const curRow = this.nodeRows[rowIndex + 1]

        if (curRow?.nodes.length == newNodes.size) {
          curRow.nodes.sort()
          newNodesArray.sort()
          let same = true
          for (let i = 0; i < curRow.nodes.length; i++) {
            if (curRow.nodes[i].key != newNodesArray[i].key) {
              same = false
              break
            }
          }
          if (same) break
        }
        // Replace the new row
        this.nodeRows[rowIndex + 1] = {
          beat: this.notedataRows[rowIndex + 1].beat,
          nodes: newNodesArray,
        }
      } else {
        // Insert the new row
        this.nodeRows.splice(rowIndex + 1, 0, {
          beat: this.notedataRows[rowIndex + 1].beat,
          nodes: newNodesArray,
        })
      }

      nodes = newNodesArray
      rowIndex++
    }

    this.debugStats.lastUpdatedNodeEnd = rowIndex + 1
    this.debugStats.nodeUpdateTime = performance.now() - stateTimeStart

    return {
      firstUpdatedRow: this.debugStats.lastUpdatedNodeStart,
      lastUpdatedRow: this.debugStats.lastUpdatedNodeEnd,
    }
  }

  // Successor states of `state` on row `rowIndex`, in generation order.
  private childStates(state: ParityState, rowIndex: number): ParityState[] {
    const row = this.notedataRows[rowIndex]
    let permutations = this.getPossibleActions(row)
    if (row.overrides.some(p => p !== undefined)) {
      permutations = this.filterActions(row, permutations, row.overrides)
    }
    const states: ParityState[] = []
    for (const permutation of permutations) {
      const baseState = this.initResultState(state, row, permutation)
      if (!this.applyReleases(state, this.notedataRows[rowIndex - 1], row, baseState, rowIndex == this.notedataRows.length - 1))
        continue
      for (const newState of this.stanceVariants(state, row, baseState)) {
        states.push(newState)
        const crosses = this.layout.crossedFeet(newState)
        if (
          newState.facing != Facing.Forward &&
          !crosses.leftOnRight &&
          !crosses.rightOnLeft
        ) {
          states.push(newState.cloneWithFacing(Facing.Forward))
        }
      }
    }
    if (state.facing == Facing.Forward) {
      for (const s of states) {
        if (s.facing == Facing.Forward) continue
        for (const c of this.layout.sideArrows) {
          if (row.notes[c]?.type != "Roll" || s.action[c] == Foot.NONE) continue
          const left = s.action[c] == Foot.LEFT_HEEL || s.action[c] == Foot.LEFT_TOE
          if (left == this.layout.rightArrows.includes(c)) s.crossedOntoRoll = c
        }
      }
    }
    return states
  }

  // Computes the edges for the nodes within the rows that were updated
  computeCosts(updatedStates: {
    firstUpdatedRow: number
    lastUpdatedRow: number
  }) {
    this.debugStats.calculatedEdges = 0
    this.debugStats.cachedEdges = 0

    const edgeTimeStart = performance.now()

    let rowIndex = updatedStates.firstUpdatedRow - 1
    if (rowIndex < -1) {
      rowIndex = -1
    }
    while (
      rowIndex < this.notedataRows.length - 1 &&
      rowIndex < updatedStates.lastUpdatedRow
    ) {
      const nodes = this.nodeRows[rowIndex]?.nodes ?? [this.initialNode]
      for (const node of nodes) {
        for (const childKey of node.children.keys()) {
          const childNode = this.nodeMap.get(childKey)
          if (!childNode) {
            console.warn("Child node not found for key:", childKey)
            continue
          }
          const childState = childNode.state
          const parentState = node.state

          this.debugStats.calculatedEdges++

          // If the edge is already cached, reuse it
          if (
            this.cachedEdges.has(node.key) &&
            this.cachedEdges.get(node.key)!.has(childKey)
          ) {
            this.debugStats.cachedEdges++
            node.children.set(
              childKey,
              this.cachedEdges.get(node.key)!.get(childKey)!
            )
            continue
          }

          this.edgeCacheSize++
          const costs = this.costCalc.getActionCost(
            parentState,
            childState,
            this.notedataRows,
            rowIndex + 1
          )
          let cache = this.cachedEdges.get(node.key)
          if (!cache) {
            cache = new Map()
            this.cachedEdges.set(node.key, cache)
          }
          cache.set(childKey, costs)

          node.children.set(childKey, costs)
        }
      }
      rowIndex++
    }

    this.debugStats.edgeUpdateTime = performance.now() - edgeTimeStart
    return {
      firstUpdatedCost: Math.max(-1, updatedStates.firstUpdatedRow - 1),
      lastUpdatedCost: updatedStates.lastUpdatedRow,
    }
  }

  // Finds the best path through the graph
  computeBestPath(updatedCosts: {
    firstUpdatedCost: number
    lastUpdatedCost: number
  }) {
    const pathTimeStart = performance.now()

    // we use string for path because list creation is slow
    // a bit jank, but performance!
    this.cachedLowestCost.set(this.initialNode.key, {
      cost: 0,
      path: this.initialNode.key,
    })

    let rowIndex = updatedCosts.firstUpdatedCost
    if (this.cachedLowestCost.size == 1) {
      // Cache cleared
      rowIndex = -1
    }
    this.debugStats.cachedBestRows = updatedCosts.firstUpdatedCost + 1

    // We can reuse the shortest paths up to the first updated edge
    // Unforunately, we can't reuse anything after that (at least i think so)
    const rowNodes = new Map<string, number>()

    while (rowIndex < this.notedataRows.length) {
      let minNode = null
      let minNodeCost = 0
      rowNodes.clear()
      const nodes = this.nodeRows[rowIndex]?.nodes ?? [this.initialNode]
      if (nodes.length == 0) {
        // there are no nodes at this row, can't proceed
        console.log("No nodes at row", rowIndex, this.nodeRows[rowIndex].beat)
        break
      }
      for (const node of nodes) {
        const currentCost = this.cachedLowestCost.get(node.key)?.cost
        if (currentCost === undefined) {
          // how
          console.warn("No cost found for node:", node.key)
          continue
        }

        if (rowIndex == this.notedataRows.length - 1) {
          node.children.set(this.endNode.key, {
            TOTAL: 0,
          })
        }
        for (const [child, costs] of node.children.entries()) {
          const oldCost = rowNodes.get(child)
          const newCost = currentCost + costs["TOTAL"]
          // a same-foot repeat of either kind breaks alternation
          const lastDs =
            (costs["DOUBLESTEP"] ?? 0) > 0 || (costs["JACK"] ?? 0) > 0
              ? rowIndex
              : (this.cachedLowestCost.get(node.key)?.lastDs ?? -1)
          const old = this.cachedLowestCost.get(child)
          const oldLastDs = old?.lastDs ?? -1
          const tie =
            oldCost !== undefined &&
            Math.abs(newCost - oldCost) < ParityInternals.TieEpsilon &&
            (lastDs > oldLastDs ||
              (lastDs == oldLastDs &&
                this.divergesFirst(
                  this.cachedLowestCost.get(node.key)!.path,
                  old!.path.slice(0, old!.path.lastIndexOf("*"))
                )))
          if (
            oldCost === undefined ||
            newCost < oldCost - ParityInternals.TieEpsilon ||
            tie
          ) {
            this.cachedLowestCost.set(child, {
              cost: newCost,
              path: this.cachedLowestCost.get(node.key)!.path + "*" + child,
              lastDs,
            })
            rowNodes.set(child, currentCost + costs["TOTAL"])

            if (minNode === null || rowNodes.get(child)! < minNodeCost) {
              minNode = child
              minNodeCost = rowNodes.get(child)!
            }
          }
        }
        if (rowIndex == this.notedataRows.length - 1) {
          node.children.delete(this.endNode.key)
        }
      }
      // we can't reuse best path (kind of sad because most cases do reuse)
      // if (
      //   minNode &&
      //   this.bestPathSet?.has(minNode) &&
      //   shouldCache == 0 &&
      //   rowIndex >= updatedCosts.lastUpdatedCost
      // ) {
      //   const firstPart =
      //     this.cachedLowestCost.get(minNode)!.path.split("*") ?? []
      //   const endPart = this.bestPath!.slice(
      //     this.bestPath!.indexOf(minNode) + 1
      //   )
      //   this.bestPath = firstPart.concat(endPart)

      //   let cost = this.cachedLowestCost.get(minNode)!.cost
      //   let node = firstPart.at(-1)
      //     ? this.nodeMap.get(firstPart.at(-1)!)!
      //     : this.initialNode
      //   for (let i = 0; i < endPart.length; i++) {
      //     const nextNode = this.nodeMap.get(endPart[i])
      //     if (!nextNode) continue
      //     cost += node.children.get(nextNode.key)?.TOTAL ?? 0
      //     node = nextNode
      //   }

      //   this.bestPathCost = cost

      //   this.debugStats.cachedBestRows += endPart.length - 1

      //   this.bestPathSet = new Set(this.bestPath ?? [])

      //   this.debugStats.pathUpdateTime = performance.now() - pathTimeStart
      //   shouldCache = rowIndex

      //   return
      // }
      rowIndex++
    }

    // this.cachedLowestCost = lowestCosts

    this.bestPath = this.cachedLowestCost.get(this.endNode.key)?.path.split("*")
    this.bestPathCost = this.cachedLowestCost.get(this.endNode.key)?.cost ?? 0

    if (!this.bestPath) {
      console.error("No best path found")
    }

    this.bestPathSet = new Set(this.bestPath ?? [])

    this.debugStats.pathUpdateTime = performance.now() - pathTimeStart
  }

  calculatePermuteColumnKey(row: Row): string {
    let s = ""
    for (let i = 0; i < this.layout.columnCount; i++) {
      if (row.notes[i]) s += i
      else if (row.holds[i]) s += i + "H"
    }
    return s
  }

  getPossibleActions(row: Row): Foot[][] {
    const cacheKey = this.calculatePermuteColumnKey(row)
    let permuteColumns = this.permuteCache.get(cacheKey)
    if (permuteColumns == undefined) {
      permuteColumns = this.generateActions(
        row,
        new Array(this.layout.columnCount).fill(Foot.NONE),
        0
      )
      this.permuteCache.set(cacheKey, permuteColumns)
    }
    return this.permuteCache.get(cacheKey)!
  }

  // Recursively generates all permutations of Foot positions given a Row
  generateActions(row: Row, columns: Foot[], column: number): Foot[][] {
    if (column >= columns.length) {
      let leftHeelIndex = -1
      let leftToeIndex = -1
      let rightHeelIndex = -1
      let rightToeIndex = -1
      for (let i = 0; i < columns.length; i++) {
        if (columns[i] == Foot.NONE) continue
        if (columns[i] == Foot.LEFT_HEEL) leftHeelIndex = i
        if (columns[i] == Foot.LEFT_TOE) leftToeIndex = i
        if (columns[i] == Foot.RIGHT_HEEL) rightHeelIndex = i
        if (columns[i] == Foot.RIGHT_TOE) rightToeIndex = i
      }
      if (
        (leftHeelIndex == -1 && leftToeIndex != -1) ||
        (rightHeelIndex == -1 && rightToeIndex != -1)
      ) {
        return []
      }
      if (leftHeelIndex != -1 && leftToeIndex != -1) {
        if (!this.layout.bracketCheck(leftHeelIndex, leftToeIndex)) return []
      }
      if (rightHeelIndex != -1 && rightToeIndex != -1) {
        if (!this.layout.bracketCheck(rightHeelIndex, rightToeIndex)) return []
      }
      return [columns]
    }
    const permutations = []
    if (row.notes[column] || row.holds[column]) {
      for (const foot of FEET) {
        if (columns.includes(foot)) continue
        const newColumns = [...columns]
        newColumns[column] = foot
        permutations.push(...this.generateActions(row, newColumns, column + 1))
      }
      // a hold body may be released (childStates decides when)
      if (!row.notes[column]) permutations.push(...this.generateActions(row, columns, column + 1))
      return permutations
    }
    return this.generateActions(row, columns, column + 1)
  }

  // Apply overrides to the permuted columns (only use permutations that actually match the overrides)
  filterActions(
    row: Row,
    permuteColumns: Foot[][],
    overrides: FootOverride[]
  ): Foot[][] {
    // Check for invalid overrides
    const counts = new Array(FEET.length + 1).fill(0)
    const footCounts = {
      Left: 0,
      Right: 0,
    }
    for (const foot of overrides) {
      if (typeof foot == "number") {
        counts[foot]++
      } else if (typeof foot == "string") {
        footCounts[foot]++
      }
    }
    for (let i = 1; i < FEET.length; i++) {
      if (counts[i] > 1) {
        console.warn(
          `Could not generate any valid permutations with parity overrides for row at beat ${row.beat}, clearing overrides, as there must be something invalid about it.`
        )
        return permuteColumns
      }
    }
    if (
      footCounts.Left + counts[Foot.LEFT_HEEL] + counts[Foot.LEFT_TOE] > 2 ||
      footCounts.Right + counts[Foot.RIGHT_HEEL] + counts[Foot.RIGHT_TOE] > 2
    ) {
      console.warn(
        `Could not generate any valid permutations with parity overrides for row at beat ${row.beat}, clearing overrides, as there must be something invalid about it.`
      )
      return permuteColumns
    }
    const updatedColumns = permuteColumns.filter(pc => {
      for (let c = 0; c < this.layout.columnCount; c++) {
        const noteOverride = overrides[c]
        if (noteOverride == undefined) continue
        // Check for exact heel/toe overrides
        if (typeof noteOverride == "number" && pc[c] != noteOverride) {
          return false
        }
        if (noteOverride == "Left") {
          if (pc[c] != Foot.LEFT_HEEL && pc[c] != Foot.LEFT_TOE) {
            return false
          }
        } else if (noteOverride == "Right") {
          if (pc[c] != Foot.RIGHT_HEEL && pc[c] != Foot.RIGHT_TOE) {
            return false
          }
        }
      }
      return true
    })

    if (updatedColumns.length == 0) {
      console.warn(
        `Could not generate any valid permutations with parity overrides for row at beat ${row.beat}, clearing overrides, as there must be something invalid about it.`
      )
      return permuteColumns
    }

    return updatedColumns
  }

  // a foot standing on a panel whose mine passed since the last row lifts off
  // it (MD); a foot holding that panel is not affected
  private dodgesMine(initialState: ParityState, row: Row, heel: Foot) {
    return [heel, OTHER_PART_OF_FOOT[heel]].some(part => {
      const col = initialState.footColumns[part]
      return col != -1 && row.mines[col] !== undefined && row.holds[col] === undefined
    })
  }

  // Creates the resulting state after applying the action to the initial state
  initResultState(
    initialState: ParityState,
    row: Row,
    action: Foot[]
  ): ParityState {
    const resultState: ParityState = new ParityState(row, action, NO_FOOT_COLUMNS)

    // Merge initial + result position
    for (let i = 0; i < this.layout.columnCount; i++) {
      resultState.combinedColumns.push(Foot.NONE)
      if (action[i] == undefined || action[i] == Foot.NONE) {
        continue
      }
      resultState.footColumns[action[i]] = i
      resultState.combinedColumns[i] = action[i]
      if (row.holds[i] == undefined) {
        resultState.movedFeet.add(action[i])
      } else if (
        initialState.combinedColumns[i] != action[i] &&
        // TODO: trying to work around engine limitation where toes are only present during brackets
        // this might cause issues later if not made stricter or toes fixed
        initialState.combinedColumns[i] != OTHER_PART_OF_FOOT[action[i]]
      ) {
        resultState.movedFeet.add(action[i])
      }
      if (row.holds[i] != undefined) {
        resultState.holdFeet.add(action[i])
      }
    }
    // A foot holding with one part keeps its other part where the stance
    // left it (a bracket, or the tap that primed it), in the orientation it
    // had: a later tap on that panel is a primed bracket tap, and a step
    // there by the other foot is a footswitch. Dropped once the panel is taken.
    for (const [heel, toe] of FOOT_PAIRS) {
      const hc = resultState.footColumns[heel]
      if (hc == -1 || resultState.footColumns[toe] != -1) continue
      if (row.holds[hc] == undefined) continue
      const ih = initialState.footColumns[heel]
      const it = initialState.footColumns[toe]
      // the free part's panel, if it had one, and whether the other foot took it
      const freeCol = ih == hc ? it : it == hc ? ih : -1
      const taken = freeCol != -1 && resultState.combinedColumns[freeCol] != Foot.NONE
      if (ih == hc && it != -1 && it != hc && !taken) {
        resultState.footColumns[toe] = it
        resultState.combinedColumns[it] = toe
      } else if (it == hc && ih != -1 && ih != hc && !taken) {
        resultState.footColumns[toe] = hc
        resultState.footColumns[heel] = ih
        resultState.combinedColumns[hc] = toe
        resultState.combinedColumns[ih] = heel
        resultState.action[hc] = toe
        resultState.holdFeet.delete(heel)
        resultState.holdFeet.add(toe)
      }
    }
    // Fill in previous position, except for a foot a mine passed under: it
    // lifted off to the center (a ghost step) and is planted nowhere. If another foot took the column this part
    // was on, the part has been displaced: it is lifted, not planted, and
    // keeps no column of record (otherwise it leaves a phantom position that
    // feeds facing/crossover checks with a stance the player is no longer in).
    if (resultState.footColumns[Foot.LEFT_HEEL] == -1 && !this.dodgesMine(initialState, row, Foot.LEFT_HEEL)) {
      for (const part of [Foot.LEFT_HEEL, Foot.LEFT_TOE]) {
        const prevCol = initialState.footColumns[part]
        if (prevCol == -1) continue
        if (resultState.combinedColumns[prevCol] == Foot.NONE) {
          resultState.footColumns[part] = prevCol
          resultState.combinedColumns[prevCol] = part
        }
      }
    }
    if (resultState.footColumns[Foot.RIGHT_HEEL] == -1 && !this.dodgesMine(initialState, row, Foot.RIGHT_HEEL)) {
      for (const part of [Foot.RIGHT_HEEL, Foot.RIGHT_TOE]) {
        const prevCol = initialState.footColumns[part]
        if (prevCol == -1) continue
        if (resultState.combinedColumns[prevCol] == Foot.NONE) {
          resultState.footColumns[part] = prevCol
          resultState.combinedColumns[prevCol] = part
        }
      }
    }
    // Travel bookkeeping: a foot traveled if it pressed a column it wasn't
    // already occupying (re-presses move without traveling).
    for (const [heel, toe] of FOOT_PAIRS) {
      const oldHeel = initialState.footColumns[heel]
      const oldToe = initialState.footColumns[toe]
      for (let c = 0; c < this.layout.columnCount; c++) {
        if (action[c] != heel && action[c] != toe) continue
        if (c != oldHeel && c != oldToe) {
          resultState.traveledFeet.add(heel)
          break
        }
      }
    }

    // Hover (ParityState.hover): a foot standing on one panel remembers the
    // adjacent panel its free part trails over.
    for (const [heel, toe] of FOOT_PAIRS) {
      resultState.hover[heel] = -1
      resultState.hoverPivot[heel] = false
      if (!this.HoverEnabled) continue
      const hc = resultState.footColumns[heel]
      const tc = resultState.footColumns[toe]
      if ((hc == -1) == (tc == -1)) continue
      const b = hc != -1 ? hc : tc
      const free = (c: number) =>
        c != -1 && c != b && resultState.combinedColumns[c] == Foot.NONE
      const ih = initialState.footColumns[heel]
      const it = initialState.footColumns[toe]
      if (resultState.traveledFeet.has(heel)) {
        const from = [ih, it].find(
          a => free(a) && this.layout.bracketCheck(a, b)
        )
        if (from != undefined) resultState.hover[heel] = from
      } else if (free(initialState.hover[heel])) {
        resultState.hover[heel] = initialState.hover[heel]
        resultState.hoverPivot[heel] = initialState.hoverPivot[heel]
      } else if (ih != -1 && it != -1 && row.holds[b] != undefined) {
        // the planted free part was taken this row: the foot re-orients on
        // the hold towards its other neighbour
        for (let c = 0; c < this.layout.columnCount; c++) {
          if (free(c) && this.layout.bracketCheck(c, b)) {
            resultState.hover[heel] = c
            resultState.hoverPivot[heel] = true
            break
          }
        }
      }
    }

    this.orient(initialState, resultState)
    return resultState
  }

  // A hold or roll with no foot on it after this row is released. A new
  // release needs a foot that covered it on the previous row to leave it (a
  // hold not on its tail row; leaving a roll on its tail row is free); a
  // release lasts while its window does. Returns false for
  // a state that is invalid or the duplicate of a covered one.
  private applyReleases(
    initialState: ParityState,
    lastRow: Row | undefined,
    row: Row,
    resultState: ParityState,
    lastOfChart: boolean
  ): boolean {
    // a hold that ends before this row with no foot on it must end within its window
    for (let c = 0; c < initialState.released.length; c++) {
      const since = initialState.released[c]
      const hold = lastRow?.holds[c]
      if (since === undefined || hold === undefined || row.holds[c] === hold) continue
      const end = hold.beat + hold.hold
      const endSecond =
        lastRow!.second + ((end - lastRow!.beat) / (row.beat - lastRow!.beat)) * (row.second - lastRow!.second)
      if (endSecond - since > releaseWindow(hold) + SECOND_EPSILON) return false
    }
    for (let c = 0; c < row.holds.length; c++) {
      const hold = row.holds[c]
      if (hold === undefined) continue
      if (resultState.combinedColumns[c] != Foot.NONE) {
        if (resultState.action[c] == Foot.NONE) return false
        continue
      }
      const since = lastRow?.holds[c] === hold ? initialState.released[c] : undefined
      if (since !== undefined) {
        if (row.second - since > releaseWindow(hold) + SECOND_EPSILON) return false
        resultState.released[c] = since
      } else if (
        initialState.combinedColumns[c] != Foot.NONE &&
        (hold.type == "Roll" || !row.holdTails.has(c)) &&
        hold.second < initialState.second + SECOND_EPSILON
      ) {
        resultState.released[c] = row.second
      } else {
        return false
      }
      // after the last row nobody steps back on: the hold must end within the window (tempo of the last gap)
      if (lastOfChart && lastRow) {
        const end = hold.beat + hold.hold
        const endSecond = row.second + ((end - row.beat) / (row.beat - lastRow.beat)) * (row.second - lastRow.second)
        if (endSecond - resultState.released[c]! > releaseWindow(hold) + SECOND_EPSILON) return false
      }
    }
    return true
  }

  // Alternative result states for a row in a bracket phrase (both feet on two
  // panels each): a foot that re-pressed one of its panels and would collapse
  // to it keeps the other part planted instead, the tap done by whichever
  // part stood there.
  stanceVariants(
    initialState: ParityState,
    row: Row,
    base: ParityState
  ): ParityState[] {
    const variants = [base]
    if (
      !this.KeepStanceAllCovered ||
      initialState.footColumns.slice(1).some(c => c == -1) ||
      Array.from(
        { length: this.layout.columnCount },
        (_, c) => row.notes[c] || (row.holds[c] && !row.holdTails.has(c))
      ).filter(Boolean).length < 3
    )
      return variants
    for (const [heel, toe] of FOOT_PAIRS) {
      const bh = base.footColumns[heel]
      const bt = base.footColumns[toe]
      if ((bh == -1) == (bt == -1)) continue
      const c = bh != -1 ? bh : bt
      if (row.holds[c] != undefined) continue
      const ih = initialState.footColumns[heel]
      const it = initialState.footColumns[toe]
      if (c != ih && c != it) continue
      const d = c == ih ? it : ih
      const partAtC = c == ih ? heel : toe
      const partAtD = c == ih ? toe : heel
      for (const v0 of [...variants]) {
        if (v0.combinedColumns[d] != Foot.NONE || v0.released[d] !== undefined) continue
        const v = v0.cloneWithFacing(v0.facing)
        const pressed = v.action[c]
        v.action[c] = partAtC
        v.combinedColumns[c] = partAtC
        v.combinedColumns[d] = partAtD
        v.footColumns[partAtC] = c
        v.footColumns[partAtD] = d
        if (pressed != partAtC) {
          v.movedFeet.delete(pressed)
          v.movedFeet.add(partAtC)
        }
        v.hover[heel] = -1
        v.hoverPivot[heel] = false
        this.orient(initialState, v)
        variants.push(v)
      }
    }
    return variants
  }

  // Front foot and facing of a result state from its foot positions.
  private orient(initialState: ParityState, resultState: ParityState) {
    const leftPos = this.layout.averagePoint(
      resultState.leftHeel,
      resultState.leftToe
    )
    const rightPos = this.layout.averagePoint(
      resultState.rightHeel,
      resultState.rightToe
    )

    if (leftPos.y > rightPos.y) {
      resultState.frontFoot = Foot.LEFT_HEEL
    } else if (rightPos.y > leftPos.y) {
      resultState.frontFoot = Foot.RIGHT_HEEL
    } else {
      resultState.frontFoot = initialState.frontFoot
    }

    const lifted = (s: ParityState, heel: Foot) =>
      s.footColumns[heel] == -1 && s.footColumns[OTHER_PART_OF_FOOT[heel]] == -1
    const oneLifted =
      lifted(resultState, Foot.LEFT_HEEL) || lifted(resultState, Foot.RIGHT_HEEL)
    const direction = () =>
      resultState.frontFoot == Foot.LEFT_HEEL ? Facing.Right : Facing.Left

    resultState.facing = initialState.facing
    resultState.facingProvisional = false
    if (resultState.facing == Facing.Forward) {
      const { leftOnRight, rightOnLeft } = this.layout.crossedFeet(resultState)

      if (leftOnRight || rightOnLeft) {
        resultState.facing = direction()
        // with a foot in the air the front foot is the previous row's: the
        // direction is a guess until that foot lands
        resultState.facingProvisional = oneLifted
      }
    } else if (initialState.facingProvisional && !oneLifted) {
      // the lifted foot has landed: read the direction from the feet
      const { leftOnRight, rightOnLeft } = this.layout.crossedFeet(resultState)
      resultState.facing = leftOnRight || rightOnLeft ? direction() : Facing.Forward
    } else {
      if (initialState.facingProvisional) resultState.facingProvisional = true
      // force uncross, TODO: is this bulletproof?
      const facingRight = resultState.facing == Facing.Right
      const facingLeft = resultState.facing == Facing.Left

      const leftHeelDown = this.layout.downArrows.includes(
        resultState.footColumns[Foot.LEFT_HEEL]
      )
      const leftHeelUp = this.layout.upArrows.includes(
        resultState.footColumns[Foot.LEFT_HEEL]
      )

      const rightHeelDown = this.layout.downArrows.includes(
        resultState.footColumns[Foot.RIGHT_HEEL]
      )
      const rightHeelUp = this.layout.upArrows.includes(
        resultState.footColumns[Foot.RIGHT_HEEL]
      )

      const leftCrossImpossible = facingLeft && (rightHeelDown || leftHeelUp)
      const rightCrossImpossible = facingRight && (leftHeelDown || rightHeelUp)

      if (rightCrossImpossible || leftCrossImpossible) {
        resultState.facing = Facing.Forward
      }
    }
    resultState.lastTurn = initialState.lastTurn
    resultState.lastTurnEnd = initialState.lastTurnEnd
    if (initialState.facing != Facing.Forward && resultState.facing == Facing.Forward) {
      resultState.lastTurn = initialState.facing
      resultState.lastTurnEnd = resultState.second
    }
    // forgotten once out of the window, so it does not split graph states
    if (resultState.second - resultState.lastTurnEnd >= REVERSAL_WINDOW) {
      resultState.lastTurn = Facing.Forward
      resultState.lastTurnEnd = -Infinity
    }
  }

  // A hold body can carry takeover annotations (parity.holdOverrides): from
  // each annotated beat on, the given foot must cover the hold's column.
  // Feeding them into row.overrides is all the engine needs — held columns
  // are part of every action permutation, so filterActions constrains them
  // like any other override. A note override on the same column (impossible
  // while the hold is active, but cheap to guard) wins.
  private applyHoldOverrides(row: Row) {
    for (let col = 0; col < row.holds.length; col++) {
      const hold = row.holds[col]
      if (hold === undefined || row.overrides[col] !== undefined) continue
      const override = holdOverrideAt(hold, row.beat)
      if (override !== undefined) row.overrides[col] = override
    }
  }

  rowToKey(row: Row): string {
    let noteString = ""
    for (let i = 0; i < this.layout.columnCount; i++) {
      if (row.notes[i]) {
        noteString += i + "|"
      }
    }
    const fakeString = row.fakeMines
      .map((note, col) => {
        if (note === undefined) return "0"
        return col + "|" + note.toFixed(3)
      })
      .join("^")
    const mineString = row.mines
      .map((note, col) => {
        if (note === undefined) return "0"
        return col + "|" + note.toFixed(3)
      })
      .join("^")
    const mineRowString = row.mineRows.map(m => m.second.toFixed(3) + ":" + m.columns.join("")).join("^")
    let holdString = ""
    for (let i = 0; i < this.layout.columnCount; i++) {
      if (row.holdTails.has(i)) {
        holdString += i + "T"
      } else if (row.holds[i] !== undefined) {
        holdString += i + "H"
      }
      if (row.holds[i]?.type == "Roll") holdString += "R" + row.rollSteps[i]!.toFixed(3)
    }
    holdString = holdString.replace(/0+$/, "")
    let overrideString = ""
    for (let i = 0; i < this.layout.columnCount; i++) {
      if (row.overrides[i] !== undefined) {
        overrideString += i + "" + row.overrides[i]
      }
    }
    return `${row.beat.toFixed(3)}-${noteString}-${fakeString}-${mineString}-${mineRowString}-${holdString}-${overrideString}`
  }

  private isSameSecond(
    second1: number | null,
    second2: number | null
  ): boolean {
    if (second1 === null || second2 === null) {
      return false
    }
    return Math.abs(second1 - second2) < SECOND_EPSILON
  }

  setWeights(weights: { [key: string]: number }) {
    this.costCalc.setWeights(weights)
    this.deleteCache()
  }

  getInitialNode() {
    return this.initialNode
  }

  // Full debug snapshot; nodeMap is large
  getDebugData(): ParityDebugData {
    return {
      edgeCacheSize: this.edgeCacheSize,
      nodeCosts: this.getNodeCosts(),
      nodeMap: this.nodeMap,
      bestPath: this.bestPath!,
      bestPathCost: this.bestPathCost,
      bestPathSet: this.bestPathSet!,
      notedataRows: this.notedataRows,
      nodeRows: this.nodeRows,
      stats: this.debugStats,
    }
  }

  // Only the rows and nodes touched by the last compute()
  getDebugUpdateData(): ParityDebugUpdateData {
    return {
      removedRowsStart: this.debugStats.lastUpdatedRowStart,
      removedRowsEnd: this.debugStats.lastUpdatedOldRowEnd,
      newRows: this.notedataRows.slice(
        this.debugStats.lastUpdatedRowStart,
        this.debugStats.lastUpdatedRowEnd
      ),
      newStates: this.nodeRows.slice(
        Math.max(0, this.debugStats.lastUpdatedNodeStart),
        this.debugStats.lastUpdatedNodeEnd
      ),
      bestPath: this.bestPath!,
      bestPathCost: this.bestPathCost,
      bestPathSet: this.bestPathSet!,
      edgeCacheSize: this.edgeCacheSize,
      nodeCosts: this.getNodeCosts(),
      stats: this.debugStats,
    }
  }

  deleteCache() {
    this.cachedEdges.clear()
    this.cachedLowestCost.clear()
    this.edgeCacheSize = 0
    this.permuteCache.clear()
  }

  reset() {
    this.bestPath = undefined
    this.bestPathCost = 0
    this.bestPathSet = undefined
    this.nodeMap.clear()
    this.nEdges = 0
    this.nodeRows = []
    this.notedataRows = []
    this.deleteCache()
  }
}

function releaseWindow(hold: HoldNotedataEntry) {
  return hold.type == "Roll" ? ROLL_RELEASE_WINDOW : HOLD_RELEASE_WINDOW
}

function getRangeInSortedArray<T>(
  array: T[],
  start: number,
  end: number,
  index: (obj: T) => number
) {
  if (array.length == 0) return [0, 0]
  let startIdx = bsearch(array, start, index)
  if (index(array[startIdx]) < start) startIdx++
  while (array[startIdx - 1] && index(array[startIdx - 1]) == start) {
    startIdx--
  }

  let endIdx = bsearch(array, end, index)
  if (index(array[endIdx]) > end) endIdx--
  while (array[endIdx + 1] && index(array[endIdx + 1]) == end) {
    endIdx++
  }

  return [startIdx, endIdx + 1]
}

function bsearch<T>(
  arr: T[],
  value: number,
  property?: (a: T) => number
): number {
  property = property ?? (a => a as number)
  if (arr.length == 0) return -1
  if (value >= property(arr[arr.length - 1])) {
    let mid = arr.length - 1
    while (mid > 0 && property(arr[mid - 1]) == value) mid--
    return mid
  }
  let low = 0,
    high = arr.length
  while (low <= high && low < arr.length) {
    let mid = (low + high) >>> 1
    if (property(arr[mid]) == value) {
      while (mid > 0 && property(arr[mid - 1]) == value) mid--
      return mid
    }
    if (property(arr[mid]) < value) low = mid + 1
    if (property(arr[mid]) > value) high = mid - 1
  }
  return Math.max(0, high)
}
