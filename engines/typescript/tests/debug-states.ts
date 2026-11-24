// Print the best-path states + techs for a fixture, row by row.
//   npx tsx tests/debug-states.ts <fixture-name>
import { ParityInternals } from "../src/index"
import {
  FOOT_INFO,
  TECH_INFO,
} from "../src/index"
import type { Notedata } from "../src/index"
import { expandBpms, parseFixture } from "./dsl"
import { FIXTURES } from "./fixtures/index"

// `<fixture-name>@<bpm>` picks a tempo of a multi-bpm fixture (default: first)
const [name, bpmArg] = process.argv[2].split("@")
const fixture = FIXTURES.find(f => f.name === name)
if (!fixture) throw new Error(`no fixture ${name}`)
const variants = expandBpms(fixture)
const variant = bpmArg
  ? variants.find(v => v.bpm === Number(bpmArg))
  : variants[0]
if (!variant) throw new Error(`no ${bpmArg}bpm variant of ${name}`)
const parsed = parseFixture(variant)
const internals = new ParityInternals("dance-single")
const result = internals.compute(-1, parsed.lastBeat + 4, parsed.notedata as Notedata)!

internals.notedataRows.forEach((row, i) => {
  const state = result.states[i + 1]
  const techs = result.techRows[i]
  const fmt = (arr: number[]) => arr.map(f => FOOT_INFO[f]?.code ?? ".").join("")
  console.log(
    `row ${i} beat ${row.beat.toFixed(2)}  action=${fmt(state.action)} ` +
      `combined=${fmt(state.combinedColumns)} ` +
      `moved={${[...state.movedFeet].map(f => FOOT_INFO[f]?.code).join(",")}} ` +
      `holdFeet={${[...state.holdFeet].map(f => FOOT_INFO[f]?.code).join(",")}} ` +
      `holds=[${row.holds.map((h, c) => (h ? c : "")).join("")}] ` +
      `techs=${techs ? [...techs].map(t => TECH_INFO[t].code).join(",") : "-"}`
  )
})
