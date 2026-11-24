import type { CaseNote, CountsResult, Result, Row } from "./format"

const json = JSON.stringify

function compareFeet(ref: string, got: string, notes?: CaseNote[]): string | undefined {
  if (ref === got) return
  if (ref.length !== got.length) return `feet: ${got.length} notes, expected ${ref.length}`
  let first = -1
  let count = 0
  for (let i = 0; i < ref.length; i++) {
    if (ref[i] === got[i]) continue
    if (first < 0) first = i
    count++
  }
  const note = notes?.[first]
  const where = note ? `beat ${note.beat} col ${note.col}` : `note ${first}`
  return `feet: ${count} notes differ, first at ${where}: ${got[first]}, expected ${ref[first]}`
}

function compareStance(ref: string, got: string): string | undefined {
  if (ref === got) return
  if (ref === undefined) return "stance: missing from the reference (regenerate it)"
  if (got === undefined) return "stance: missing"
  let first = 0
  while (first < ref.length && ref[first] === got[first]) first++
  const row = Math.floor(first / 4)
  const at = (s: string) => s.slice(row * 4, row * 4 + 4) || "-"
  return `stance differs from row ${row}: ${at(got)}, expected ${at(ref)}`
}

function compareRows(ref: Row[], got: Row[]): string | undefined {
  const label = (row?: Row) => (row ? [...row[1], ...row[2].map(e => `!${e}`)].join(" ") : "-")
  const byBeat = (rows: Row[]) => new Map(rows.map(r => [r[0], r]))
  const refRows = byBeat(ref)
  const gotRows = byBeat(got)
  const beats = [...new Set([...refRows.keys(), ...gotRows.keys()])].sort((a, b) => a - b)
  const differing = beats.filter(b => label(refRows.get(b)) !== label(gotRows.get(b)))
  if (!differing.length) return
  const b = differing[0]
  return `rows: ${differing.length} differ, first at beat ${b}: ${label(gotRows.get(b))}, expected ${label(refRows.get(b))}`
}

function compareCounts(field: string, ref: Record<string, number>, got: Record<string, number>) {
  const keys = [...new Set([...Object.keys(ref), ...Object.keys(got)])].sort()
  const deltas = keys
    .filter(k => (ref[k] ?? 0) !== (got[k] ?? 0))
    .map(k => `${k} ${got[k] ?? 0}/${ref[k] ?? 0}`)
  if (deltas.length) return `${field} (got/expected): ${deltas.join(", ")}`
}

export function compareResults(ref: Result, got: Result, notes?: CaseNote[]): string[] {
  if (!!ref.noPath !== !!got.noPath) {
    return [ref.noPath ? "found a path, expected none" : "no path, expected one"]
  }
  return [
    compareFeet(ref.feet, got.feet, notes),
    ref.rowCount !== got.rowCount ? `rowCount: ${got.rowCount}, expected ${ref.rowCount}` : undefined,
    compareRows(ref.rows, got.rows),
    json(ref.mineRows) !== json(got.mineRows) ? "mineRows differ" : undefined,
    json(ref.holdOwnership) !== json(got.holdOwnership) ? "holdOwnership differs" : undefined,
    json(ref.candles) !== json(got.candles) ? "candles differ" : undefined,
    compareStance(ref.stance, got.stance),
    ref.angleChecksum !== got.angleChecksum
      ? `angleChecksum: ${got.angleChecksum}, expected ${ref.angleChecksum}`
      : undefined,
    compareCounts("counts", ref.counts, got.counts),
    compareCounts("errorCounts", ref.errorCounts, got.errorCounts),
  ].filter((d): d is string => d !== undefined)
}

export function compareCountResults(ref: CountsResult, got: CountsResult): string[] {
  if (!!ref.noPath !== !!got.noPath) {
    return [ref.noPath ? "found a path, expected none" : "no path, expected one"]
  }
  return [
    compareCounts("counts", ref.counts, got.counts),
    compareCounts("errorCounts", ref.errorCounts, got.errorCounts),
  ].filter((d): d is string => d !== undefined)
}
