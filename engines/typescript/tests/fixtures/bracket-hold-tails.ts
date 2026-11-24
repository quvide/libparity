import type { FixtureDef } from "../dsl"

// Regression test fixture for heel / toe tracking
// From XHAOS JUDGE by Valex, beats 164 - 168
export default {
  bpm: 200,
  subdivision: 8,
  pattern: `
    ..rr | BR
    ll__ | BR
    __rr | BR
    ll__ | BR
    __rr | BR
    L.__
    .r.r | BR
    ....
    L_._
  `,
} satisfies FixtureDef
