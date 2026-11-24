import type { FixtureDef } from "../dsl"

// Fidget Dancer (Edit) by Exschwasion, 64-67.75
export default {
  bpm: [150, 175, 200],
  subdivision: 16,
  patterns: {
    "hs": `
      .l..
      ....
      ...R
      L^.. | HS
      .>..
      ....
      L... | JA
      .^.R | HS
      .<..
      ....
      ...R | JA
      L^.. | HS
      .>..
      ....
      L... | JA
      ._.R
    `,
    "bt": `
      .l..
      ....
      ...R
      L... | BT
      ....
      ....
      L... | BT JA
      ...R
      ....
      ....
      ...R | JA
      L... | BT
      ....
      ....
      L... | BT JA
      ._.R
    `,
  },
} satisfies FixtureDef
