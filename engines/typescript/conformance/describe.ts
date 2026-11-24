import {
  ENGINE_VERSION,
  FOOT_INFO,
  SUPPORTED_STEPS_TYPES,
  TECH_ERROR_INFO,
  TECH_INFO,
  analyze,
  analyzeCounts,
  footFromCode,
  isSupportedStepsType,
  stageLayout,
  techErrorFromCode,
  techFromCode,
} from "../src/index"
import type { CodeInfo } from "../src/index"

// The public API's constants and edge cases (API.md), probed the same way in
// every engine; ports print theirs with --describe and must match exactly.

export const STEPS_TYPE_PROBES = ["dance-single", "dance-double", "pump-single", ""]
export const EXTRA_CODE_PROBES = ["??", ""]

const table = (t: readonly CodeInfo[]) => t.map(i => [i.code, i.name, i.description])

function lookups(t: readonly CodeInfo[], lookup: (code: string) => number | null) {
  const out: Record<string, number | null> = {}
  for (const code of [...t.map(i => i.code), ...EXTRA_CODE_PROBES]) out[code] = lookup(code)
  return out
}

export function describe() {
  const layouts: Record<string, unknown> = {}
  for (const stepsType of STEPS_TYPE_PROBES) {
    const l = stageLayout(stepsType)
    layouts[stepsType] = l && {
      name: l.name,
      columnCount: l.columnCount,
      layout: l.layout.map(p => [p.x, p.y, p.rotation]),
      upArrows: l.upArrows,
      downArrows: l.downArrows,
      leftArrows: l.leftArrows,
      rightArrows: l.rightArrows,
      sideArrows: l.sideArrows,
    }
  }
  const empty = analyze("dance-single", [])
  return {
    engineVersion: ENGINE_VERSION,
    supportedStepsTypes: [...SUPPORTED_STEPS_TYPES],
    isSupported: Object.fromEntries(STEPS_TYPE_PROBES.map(s => [s, isSupportedStepsType(s)])),
    footInfo: table(FOOT_INFO),
    techInfo: table(TECH_INFO),
    techErrorInfo: table(TECH_ERROR_INFO),
    footFromCode: lookups(FOOT_INFO, footFromCode),
    techFromCode: lookups(TECH_INFO, techFromCode),
    techErrorFromCode: lookups(TECH_ERROR_INFO, techErrorFromCode),
    stageLayouts: layouts,
    analyzeUnsupported: analyze("dance-double", []) === null,
    analyzeEmpty: empty && {
      feet: empty.feet.length,
      rows: empty.rows.length,
      techCounts: empty.techCounts,
      techErrorCounts: empty.techErrorCounts,
    },
    analyzeCountsUnsupported: analyzeCounts("dance-double", []) === null,
    analyzeCountsEmpty: analyzeCounts("dance-single", []),
  }
}

/** paths where `got` differs from `ref` */
export function compareDescriptions(ref: unknown, got: unknown, at = ""): string[] {
  if (ref === got) return []
  if (typeof ref !== "object" || typeof got !== "object" || ref === null || got === null) {
    return [`${at || "/"}: ${JSON.stringify(got)}, expected ${JSON.stringify(ref)}`]
  }
  if (Array.isArray(ref) !== Array.isArray(got)) return [`${at || "/"}: type differs`]
  const keys = [...new Set([...Object.keys(ref), ...Object.keys(got)])]
  return keys.flatMap(k =>
    compareDescriptions((ref as Record<string, unknown>)[k], (got as Record<string, unknown>)[k], `${at}/${k}`)
  )
}
