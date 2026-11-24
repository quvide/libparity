import type { FixtureDef } from "../dsl"

// Hyperion (Hard) by Exschwasion, 193.5 - 201.5
export default {
  bpm: [120, 135, 150],
  subdivision: 8,
  patterns: {
    "bt": `
      ..Rr | BR
      L...
      ..R. | BT
      .L..
      ....
      ..R. | BT
      L...
      ..R. | BT
      ....
      .L..
      ..R. | BT
      L...
      ....
      ..R. | BT
      .L..
      ..R. | BT
      L.._
    `,
    "ds": `
      ..Rr | BR
      L...
      ..L. | KS
      .L.. | DS
      ....
      ..L. | DS
      L... | DS
      ..L. | DS
      ....
      .L.. | DS
      ..L. | DS
      L... | DS
      ....
      ..L. | DS
      .L.. | DS
      ..L. | DS
      L.._ | DS
    `,
  },
} satisfies FixtureDef
