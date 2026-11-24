#include "FloatSemantics.h"

#include "libparity/ParityUtils.h"

#include <cmath>

namespace parity {

FootOverride holdOverrideAt(const NotedataEntry& hold, double beat) {
  const auto& list = hold.holdOverrides;
  if (list.empty()) return FOOT_OVERRIDE_UNDEFINED;
  FootOverride result = FOOT_OVERRIDE_UNDEFINED;
  for (const auto& entry : list) {
    if (entry.beat > beat + HOLD_OVERRIDE_EPSILON) break;
    if (entry.beat <= hold.beat + HOLD_OVERRIDE_EPSILON) continue;
    result = entry.foot;
  }
  return result;
}

namespace {

struct NoteColumns {
  int cols[MAX_COLUMNS];
  int length = 0;
  bool includes(int c) const {
    for (int i = 0; i < length; i++)
      if (cols[i] == c) return true;
    return false;
  }
};

NoteColumns noteColumns(const Row& row) {
  NoteColumns out;
  for (int c = 0; c < MAX_COLUMNS; c++)
    if (row.notes[c] != nullptr) out.cols[out.length++] = c;
  return out;
}

}  // namespace

bool isStepjump(const Rows& rows, int idx) {
  const Row& jump = rows[idx];
  const NoteColumns panels = noteColumns(jump);
  if (panels.length != 2) return false;
  auto sharesPanel = [&](int i) {
    if (i < 0 || i >= static_cast<int>(rows.size())) return false;
    const Row& row = rows[i];
    if (std::fabs(row.second - jump.second) > StepjumpMaxGap) return false;
    const NoteColumns cols = noteColumns(row);
    return cols.length == 1 && panels.includes(cols.cols[0]);
  };
  return sharesPanel(idx - 1) || sharesPanel(idx + 1);
}

JumpRepress jumpRepress(const ParityState& initialState,
                        const ParityState& resultState, int heel) {
  const int toe = OTHER_PART_OF_FOOT(heel);
  if (!initialState.movedFeet.has(heel) && !initialState.movedFeet.has(toe)) {
    return JumpRepress::None;
  }
  int before[MAX_COLUMNS];
  int beforeLength = 0;
  int now[MAX_COLUMNS];
  int nowLength = 0;
  for (int col = 0; col < resultState.length; col++) {
    const int a = initialState.actionAt(col);
    if ((a == heel || a == toe) && !initialState.holdFeet.has(a))
      before[beforeLength++] = col;
    const int foot = resultState.action[col];
    if ((foot == heel || foot == toe) && !resultState.holdFeet.has(foot))
      now[nowLength++] = col;
  }
  bool shared = false;
  for (int i = 0; i < nowLength && !shared; i++)
    for (int j = 0; j < beforeLength; j++)
      if (now[i] == before[j]) shared = true;
  if (nowLength == 0 || !shared) return JumpRepress::None;
  if (nowLength == beforeLength) {
    bool same = true;
    for (int i = 0; i < nowLength; i++)
      if (now[i] != before[i]) same = false;
    if (same) return JumpRepress::Same;
  }
  return JumpRepress::Subset;
}

bool isPlantedJump(const Row& row, const ParityState& initialState,
                   const ParityState& resultState, double elapsedTime) {
  if (elapsedTime > StepjumpMaxGap || noteColumns(row).length != 2) return false;
  const bool l = jumpRepress(initialState, resultState, Foot::LEFT_HEEL) !=
                 JumpRepress::None;
  const bool r = jumpRepress(initialState, resultState, Foot::RIGHT_HEEL) !=
                 JumpRepress::None;
  return l != r;
}

bool doFeetOverlap(int oldHeel, int oldToe, int newHeel, int newToe) {
  if (oldHeel != -1) {
    if (oldHeel == newHeel || oldHeel == newToe) {
      return true;
    }
  }

  if (oldToe != -1) {
    if (oldToe == newHeel || oldToe == newToe) {
      return true;
    }
  }

  return false;
}

double getPlayerAngle(Pos left, Pos right) {
  const double x1 = right.x - left.x;
  const double y1 = right.y - left.y;
  const double x2 = 1;
  const double y2 = 0;
  const double dot = x1 * x2 + y1 * y2;
  const double det = x1 * y2 - y1 * x2;
  return std::atan2(det, dot);
}

bool mineForcesFootswitch(const PlacementData& data, const Row& row,
                          double elapsedTime) {
  if (!data.leftJack && !data.rightJack) return false;
  if (elapsedTime >= MINE_FOOTSWITCH_MAX_GAP) return false;
  for (int c = 0; c < MAX_COLUMNS; c++)
    if (row.mines[c].has || row.fakeMines[c].has) return true;
  return false;
}

}  // namespace parity
