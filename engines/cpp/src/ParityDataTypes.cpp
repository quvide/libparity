#include "FloatSemantics.h"

#include "libparity/ParityDataTypes.h"

#include <cstring>

namespace parity {

size_t StateKeyHash::operator()(const StateKey& k) const {
  uint64_t t;
  std::memcpy(&t, &k.lastTurnEnd, sizeof t);
  uint64_t h = k.a * 0x9E3779B97F4A7C15ull;
  h ^= (k.b + 0x632BE59BD9B4E019ull) * 0xC2B2AE3D27D4EB4Full;
  h ^= (t + (h << 6) + (h >> 2)) * 0x165667B19E3779F9ull;
  if (k.b >> 46 & 0xFF) {
    for (double r : k.released) {
      std::memcpy(&t, &r, sizeof t);
      h ^= (t + (h << 6) + (h >> 2)) * 0x9E3779B97F4A7C15ull;
    }
  }
  return static_cast<size_t>(h ^ (h >> 29));
}

ParityState::ParityState(double second, double beat, const int8_t* action,
                         int length, const int8_t* columns)
    : length(static_cast<int8_t>(length)), second(second), beat(beat) {
  for (int i = 0; i < length; i++) this->action[i] = action[i];
  for (int i = 0; i < 5; i++) footColumns[i] = columns[i];
}

ParityState ParityState::cloneWithFacing(int facing) const {
  ParityState clone(second, beat, action, length, footColumns);
  std::memcpy(clone.combinedColumns, combinedColumns, sizeof combinedColumns);
  clone.movedFeet = movedFeet;
  clone.holdFeet = holdFeet;
  clone.traveledFeet = traveledFeet;
  std::memcpy(clone.hover, hover, sizeof hover);
  std::memcpy(clone.hoverPivot, hoverPivot, sizeof hoverPivot);
  std::memcpy(clone.released, released, sizeof released);
  clone.crossedOntoRoll = crossedOntoRoll;
  clone.frontFoot = frontFoot;
  clone.facing = static_cast<int8_t>(facing);
  clone.facingProvisional = facingProvisional;
  clone.lastTurn = lastTurn;
  clone.lastTurnEnd = lastTurnEnd;
  if (this->facing != Facing::Forward && facing == Facing::Forward) {
    clone.lastTurn = this->facing;
    clone.lastTurnEnd = second;
  }
  return clone;
}

StateKey ParityState::toKey() const {
  StateKey key;
  for (int i = 0; i < length; i++) {
    key.a |= uint64_t(action[i] & 7) << (i * 3);
    key.a |= uint64_t(combinedColumns[i] & 7) << (24 + i * 3);
  }
  uint64_t b = 0;
  int shift = 0;
  auto put = [&](uint64_t v, int bits) {
    b |= (v & ((uint64_t(1) << bits) - 1)) << shift;
    shift += bits;
  };
  for (int foot : FEET) put(movedFeet.has(foot), 1);
  for (int foot : FEET) put(holdFeet.has(foot), 1);
  for (int i = 1; i < 5; i++) put(uint64_t(footColumns[i] + 1), 4);
  put(uint64_t(frontFoot + 1), 3);
  put(uint64_t(facing + 1), 2);
  put(facingProvisional, 1);
  put(uint64_t(lastTurn + 1), 2);
  for (int foot : FEET) put(traveledFeet.has(foot), 1);
  put(uint64_t(hover[Foot::LEFT_HEEL] + 1), 4);
  put(hoverPivot[Foot::LEFT_HEEL], 1);
  put(uint64_t(hover[Foot::RIGHT_HEEL] + 1), 4);
  put(hoverPivot[Foot::RIGHT_HEEL], 1);
  // bit 46 on: the released mask (StateKeyHash reads it)
  uint64_t releasedMask = 0;
  for (int i = 0; i < MAX_COLUMNS; i++) {
    if (!isReleased(i)) continue;
    releasedMask |= uint64_t(1) << i;
    key.released[i] = released[i] + 0.0;
  }
  put(releasedMask, 8);
  put(uint64_t(crossedOntoRoll + 1), 4);
  key.b = b;
  // `${-0}` == `${0}`; lastTurnEnd is only part of the key while lastTurn is set
  key.lastTurnEnd = lastTurn != Facing::Forward ? lastTurnEnd + 0.0 : 0.0;
  return key;
}

StateKey ParityState::stanceKey() const {
  ParityState s = *this;
  s.lastTurn = Facing::Forward;
  s.lastTurnEnd = -INFINITY;
  return s.toKey();
}

namespace {
int footMask(const FootSet& feet) {
  int mask = 0;
  for (int foot : FEET)
    if (feet.has(foot)) mask |= 1 << foot;
  return mask;
}
}  // namespace

int compareStates(const ParityState& a, const ParityState& b) {
  auto cmp = [](double x, double y) { return x < y ? -1 : x > y ? 1 : 0; };
  int c = 0;
  for (int i = 0; i < a.length && i < b.length && !c; i++) c = cmp(a.action[i], b.action[i]);
  for (int i = 0; i < a.length && i < b.length && !c; i++)
    c = cmp(a.combinedColumns[i], b.combinedColumns[i]);
  if (c) return c;
  if ((c = cmp(a.length, b.length))) return c;
  for (int i = 1; i < 5 && !c; i++) c = cmp(a.footColumns[i], b.footColumns[i]);
  if (c) return c;
  const double fa[] = {double(footMask(a.movedFeet)), double(footMask(a.holdFeet)),
                       double(a.frontFoot), double(a.facing), double(a.facingProvisional),
                       double(a.lastTurn), a.lastTurn != Facing::Forward ? a.lastTurnEnd : 0,
                       double(footMask(a.traveledFeet)), double(a.hover[Foot::LEFT_HEEL]),
                       double(a.hoverPivot[Foot::LEFT_HEEL]), double(a.hover[Foot::RIGHT_HEEL]),
                       double(a.hoverPivot[Foot::RIGHT_HEEL])};
  const double fb[] = {double(footMask(b.movedFeet)), double(footMask(b.holdFeet)),
                       double(b.frontFoot), double(b.facing), double(b.facingProvisional),
                       double(b.lastTurn), b.lastTurn != Facing::Forward ? b.lastTurnEnd : 0,
                       double(footMask(b.traveledFeet)), double(b.hover[Foot::LEFT_HEEL]),
                       double(b.hoverPivot[Foot::LEFT_HEEL]), double(b.hover[Foot::RIGHT_HEEL]),
                       double(b.hoverPivot[Foot::RIGHT_HEEL])};
  for (int i = 0; i < 12 && !c; i++) c = cmp(fa[i], fb[i]);
  if (c) return c;
  // released (column, second) pairs, then crossedOntoRoll
  auto tail = [](const ParityState& s, double* out) {
    int n = 0;
    for (int i = 0; i < MAX_COLUMNS; i++) {
      if (!s.isReleased(i)) continue;
      out[n++] = i;
      out[n++] = s.released[i];
    }
    out[n++] = s.crossedOntoRoll;
    return n;
  };
  double ta[2 * MAX_COLUMNS + 1];
  double tb[2 * MAX_COLUMNS + 1];
  const int na = tail(a, ta);
  const int nb = tail(b, tb);
  for (int i = 0; i < na && i < nb && !c; i++) c = cmp(ta[i], tb[i]);
  if (c) return c;
  return cmp(na, nb);
}

}  // namespace parity
