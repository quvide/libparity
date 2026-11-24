import { Foot } from "../src/ParityDataTypes"
import { ExpectedFoot, MineRowExpectation, ParsedFixture, RowExpectation } from "./dsl"
import { EngineRow, EngineRun } from "./engine"

export interface RowReport {
  expectation: RowExpectation
  actual: EngineRow
  problems: string[]
  /** columns whose actual foot doesn't match the expectation */
  badCols: number[]
  /** the row's tech tags don't match the expectation */
  badTechs: boolean
  /** engine row landed on a different beat than the fixture line */
  badBeat: boolean
}

export interface MineRowReport {
  expectation: MineRowExpectation
  techs: string[]
  problems: string[]
}

export interface FixtureReport {
  name: string
  rows: RowReport[]
  mineRows: MineRowReport[]
  problems: number
  /** structural failures: wrong feet, beat mismatches — the parity itself */
  footProblems: number
  /** annotation failures: tech tags / tech errors — the notation layer */
  notationProblems: number
  /** harness-level failure (row mismatch etc.), distinct from expectation failures */
  error?: string
}

export function evaluateFixture(
  parsed: ParsedFixture,
  run: EngineRun
): FixtureReport {
  const report: FixtureReport = {
    name: parsed.fixture.name,
    rows: [],
    mineRows: [],
    problems: 0,
    footProblems: 0,
    notationProblems: 0,
  }

  if (run.rows.length !== parsed.rows.length) {
    report.error = `engine produced ${run.rows.length} rows, fixture expects ${parsed.rows.length}`
    report.problems++
    report.footProblems++
    return report
  }

  for (let i = 0; i < parsed.rows.length; i++) {
    const exp = parsed.rows[i]
    const act = run.rows[i]
    const problems: string[] = []
    // notation problems (tech tags / tech errors) are counted separately from
    // foot problems so the runner can report feet-correct fixtures as PARTIAL
    let footProblems = 0
    const badCols: number[] = []
    let badTechs = false
    let badBeat = false

    if (Math.abs(exp.beat - act.beat) > 1e-6) {
      problems.push(`row beat mismatch: expected ${exp.beat}, got ${act.beat}`)
      footProblems++
      badBeat = true
    } else if (!exp.skip) {
      for (let col = 0; col < 4; col++) {
        const want = exp.feet[col]
        if (want === undefined || want === null) continue
        if (act.feet[col] !== want) {
          problems.push(
            `col ${col}: expected ${want} foot, got ${act.feet[col] ?? "-"}`
          )
          footProblems++
          badCols.push(col)
        }
      }
      const wantTechs = [...exp.expectedTechs].sort().join(" ")
      const gotTechs = [...act.techs].sort().join(" ")
      if (wantTechs !== gotTechs) {
        problems.push(
          `techs: expected [${wantTechs || "none"}], got [${gotTechs || "none"}]`
        )
        badTechs = true
      }
    }

    if (!exp.skip && !badBeat) {
      for (const [col, want] of expectedCoverers(parsed, exp.beat)) {
        const got = coverer(run.footColumns[i], col)
        if (got !== want) {
          problems.push(`col ${col} hold: expected ${want ?? "no foot"} on it, got ${got ?? "no foot"}`)
          footProblems++
          badCols.push(col)
        }
      }
    }

    report.rows.push({
      expectation: exp,
      actual: act,
      problems,
      badCols,
      badTechs,
      badBeat,
    })
    report.problems += problems.length
    report.footProblems += footProblems
    report.notationProblems += problems.length - footProblems
  }
  for (const exp of parsed.mineRows) {
    const techs = run.mineRows.find(m => Math.abs(m.beat - exp.beat) < 1e-6)?.techs ?? []
    const want = [...exp.expectedTechs].sort().join(" ")
    const got = techs.join(" ")
    const problems = want === got ? [] : [`mine techs: expected [${want || "none"}], got [${got || "none"}]`]
    report.mineRows.push({ expectation: exp, techs, problems })
    report.problems += problems.length
    report.notationProblems += problems.length
  }
  for (const m of run.mineRows) {
    if (parsed.mineRows.some(e => Math.abs(e.beat - m.beat) < 1e-6)) continue
    report.error = `engine labelled a mine row at beat ${m.beat} the fixture has no mine line for`
    report.problems++
    report.notationProblems++
  }
  return report
}

// Columns whose hold or roll is strictly inside its body at this beat, with the
// foot the fixture expects on it (the latest marker, else the head's letter).
function expectedCoverers(parsed: ParsedFixture, beat: number): [number, ExpectedFoot][] {
  const out: [number, ExpectedFoot][] = []
  for (const head of parsed.notedata) {
    if (head.hold === undefined || !(head.beat < beat - 1e-6 && beat < head.beat + head.hold - 1e-6)) continue
    const markers = parsed.coverage.filter(m => m.head === head && m.beat <= beat + 1e-6)
    const headRow = parsed.rows.find(r => Math.abs(r.beat - head.beat) < 1e-6)
    const want = markers.length ? markers[markers.length - 1].foot : headRow?.feet[head.col]
    if (want === undefined || (want === null && !markers.length)) continue
    out.push([head.col, want])
  }
  return out
}

function coverer(footColumns: number[] | undefined, col: number): ExpectedFoot {
  if (!footColumns) return null
  const left = footColumns[Foot.LEFT_HEEL] === col || footColumns[Foot.LEFT_TOE] === col
  const right = footColumns[Foot.RIGHT_HEEL] === col || footColumns[Foot.RIGHT_TOE] === col
  return left ? "L" : right ? "R" : null
}
