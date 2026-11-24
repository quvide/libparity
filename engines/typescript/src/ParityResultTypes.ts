import {
  Foot,
  ParityState,
  Row,
  TechCategory,
  TechErrors,
} from "./ParityDataTypes.js"
import { ParityGraphNode } from "./ParityInternals.js"

export interface ParityComputeData {
  parityLabels: Map<string, Foot>
  /** row index of each parityLabels entry */
  labelRows: Map<string, number>
  /** hold-body ownership timelines keyed by head note "beat-col"; only
   * present for holds whose covering foot changes mid-hold */
  holdOwnership: Map<string, { beat: number; foot: Foot }[]>
  states: ParityState[]
  rowTimestamps: { beat: number; second: number }[]
  techRows: (Set<TechCategory> | undefined)[]
  /** mine-only beats that carry techs, by beat */
  mineRows: { beat: number; second: number; techs: Set<TechCategory> }[]
  /** where the engine takes a roll as re-tapped between rows, by beat */
  rollTaps: { beat: number; second: number; col: number; foot: Foot }[]
  techErrors: Map<number, Set<TechErrors>>
  techCounts: number[]
  techErrorCounts: number[]
  facingRows: number[]
  candles: Map<number, Foot>
}

export type ParityDebugUpdateData = {
  nodeCosts: Map<string, number>
  removedRowsStart: number
  removedRowsEnd: number
  newRows: Row[]
  newStates: {
    beat: number
    nodes: ParityGraphNode[]
  }[]

  bestPath: string[]
  bestPathCost: number
  bestPathSet: Set<string>
  edgeCacheSize: number
  stats: ParityDebugStats
}

export type ParityDebugData = {
  nodeCosts: Map<string, number>
  edgeCacheSize: number
  nodeMap: Map<string, ParityGraphNode>
  bestPath: string[]
  bestPathCost: number
  bestPathSet: Set<string>
  notedataRows: Row[]
  nodeRows: { beat: number; nodes: ParityGraphNode[] }[]
  stats: ParityDebugStats
}

export type ParityDebugStats = {
  lastUpdatedRowStart: number
  lastUpdatedOldRowEnd: number
  lastUpdatedRowEnd: number
  rowUpdateTime: number
  lastUpdatedNodeStart: number
  lastUpdatedNodeEnd: number
  nodeUpdateTime: number
  createdNodes: number
  createdEdges: number
  calculatedEdges: number
  cachedEdges: number
  edgeUpdateTime: number
  cachedBestRows: number
  pathUpdateTime: number
  rowStatsUpdateTime: number
}
