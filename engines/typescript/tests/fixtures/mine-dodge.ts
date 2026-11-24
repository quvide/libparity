import type { FixtureDef } from "../dsl"

export default {
  bpm: 150,
  subdivision: 8,
  pattern: `
    L...
    ...R
    ...M | MD
    l...
    ...R
    ...M // not MD due to marking DS
    _.R. | DS
  `,
} satisfies FixtureDef
