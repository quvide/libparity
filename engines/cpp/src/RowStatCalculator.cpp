#include "FloatSemantics.h"

#include "libparity/RowStatCalculator.h"

#include <algorithm>
#include <cmath>
#include <iterator>
#include <utility>

#include "libparity/ParityCost.h"
#include "libparity/ParityInternals.h"
#include "libparity/ParityUtils.h"

namespace parity {

namespace {

bool has(uint32_t set, int value) { return (set >> value) & 1; }

bool isLeft(int foot) { return foot == Foot::LEFT_HEEL || foot == Foot::LEFT_TOE; }

int countNotes(const Row& row) {
  int count = 0;
  for (const NotedataEntry* n : row.notes)
    if (n != nullptr) count++;
  return count;
}

bool isDoublestepMarked(const PlacementData& data, const Row& initialRow,
                        const Row& currentRow, const StageLayout& layout) {
  for (int i = 0; i < static_cast<int>(layout.layout.size()); i++) {
    const NotedataEntry* hold = initialRow.holds[i];
    // If there is a hold that extends past the last row, we can DS
    if ((hold && !initialRow.hasHoldTail(i)) || currentRow.holds[i] != nullptr) {
      return true;
    }
  }

  const ParityState& init = *data.initialState;
  if (data.leftDoubleStep) {
    const bool willHitMine =
        currentRow.mineAt(init.footColumns[Foot::LEFT_HEEL]).truthy() ||
        currentRow.fakeMineAt(init.footColumns[Foot::LEFT_HEEL]).truthy() ||
        currentRow.mineAt(init.footColumns[Foot::LEFT_TOE]).truthy() ||
        currentRow.fakeMineAt(init.footColumns[Foot::LEFT_TOE]).truthy();
    if (willHitMine) return true;
  }
  if (data.rightDoubleStep) {
    const bool willHitMine =
        currentRow.mineAt(init.footColumns[Foot::RIGHT_HEEL]).truthy() ||
        currentRow.fakeMineAt(init.footColumns[Foot::RIGHT_HEEL]).truthy() ||
        currentRow.mineAt(init.footColumns[Foot::RIGHT_TOE]).truthy() ||
        currentRow.fakeMineAt(init.footColumns[Foot::RIGHT_TOE]).truthy();
    if (willHitMine) return true;
  }
  return false;
}

// Is another child of `from` at most as costly (without DISTANCE) as `to`?
bool cheaperAlternative(const ParityGraphNode& from, const ParityGraphNode& to) {
  const ActionCosts& chosen = *from.child(to.key);
  const double cost = chosen[COST_TOTAL] - chosen[COST_DISTANCE];
  for (const auto& [child, costs] : from.children) {
    if (child == to.key) continue;
    if (costs[COST_TOTAL] - costs[COST_DISTANCE] <= cost) {
      return true;
    }
  }
  return false;
}

bool isAmbiguous(const PlacementData& data, const Row& currentRow,
                 const ParityGraphNode& initial, const ParityGraphNode& current, int i) {
  if ((!data.previousJumped && i != 0) || countNotes(currentRow) != 1) return false;
  int noteIndex = -1;
  for (int c = 0; c < MAX_COLUMNS; c++)
    if (currentRow.notes[c] != nullptr) {
      noteIndex = c;
      break;
    }
  const int initialFoot = data.initialState->combinedAt(noteIndex);
  const int resultFoot = data.resultState->combinedAt(noteIndex);
  if (initialFoot == resultFoot || initialFoot == OTHER_PART_OF_FOOT(resultFoot)) {
    return false;
  }
  return cheaperAlternative(initial, current);
}

}  // namespace

RowStats calculateRowStats(const std::vector<ParityGraphNode>& nodes, const Rows& rows,
                           const StageLayout& layout) {
  RowStatAccumulator stats(rows, layout, true);
  for (std::size_t i = 0; i + 1 < nodes.size(); i++) stats.push(nodes[i]);
  return std::move(stats).result();
}

RowStatAccumulator::RowStatAccumulator(const Rows& rows, const StageLayout& layout,
                                       bool keepRows)
    : rows(rows), layout(layout), keepRows(keepRows) {
  stats.techRows.push_back(0);
  stats.facingRows.push_back(0);
  stats.techCounts.assign(TechCategoryCount, 0);
  stats.techErrorCounts.assign(TechErrorCount, 0);
}

void RowStatAccumulator::push(ParityGraphNode node) {
  if (pushed == 1)
    firstRow(*previous, node);
  else if (pushed > 1)
    pair(*previous, node, pushed - 2);
  previous = std::move(node);
  pushed++;
}

TechCounts RowStatAccumulator::counts() && {
  return {std::move(stats.techCounts), std::move(stats.techErrorCounts)};
}

RowStats RowStatAccumulator::result() && { return std::move(stats); }

// XO on every row a crossed-over foot presses: a part of that foot presses
// a panel on the far side. LX instead when the foot travelled there while
// the other foot is already on its own far side (both feet crossed).
int RowStatAccumulator::crossedPress(const ParityState& state) const {
  auto crosses = layout.crossedFeet(state);
  struct Side {
    int heel;
    const std::vector<int>* far;
    bool otherCrossed;
  };
  const Side sides[2] = {
      {Foot::LEFT_HEEL, &layout.rightArrows, crosses.rightOnLeft},
      {Foot::RIGHT_HEEL, &layout.leftArrows, crosses.leftOnRight},
  };
  int result = -1;
  for (const Side& side : sides) {
    bool pressedFar = false;
    for (int part : {side.heel, OTHER_PART_OF_FOOT(side.heel)}) {
      int col = state.footColumns[part];
      if (state.movedFeet.has(part) &&
          std::find(side.far->begin(), side.far->end(), col) != side.far->end())
        pressedFar = true;
    }
    if (!pressedFar) continue;
    if (side.otherCrossed && state.traveledFeet.has(side.heel)) return LateralCrossovers;
    result = Crossovers;
  }
  return result;
}

// MD: a mine on a panel a foot stands on before the row, and the row does
// not lift and press that foot anyway
bool RowStatAccumulator::isMineDodge(const std::vector<int>& columns, const ParityState& before,
                                     const ParityState& after) {
  for (int heel : {Foot::LEFT_HEEL, Foot::RIGHT_HEEL}) {
    const int parts[2] = {heel, OTHER_PART_OF_FOOT(heel)};
    bool stood = false;
    bool moved = false;
    for (int part : parts) {
      if (std::find(columns.begin(), columns.end(), before.footColumns[part]) != columns.end())
        stood = true;
      if (after.movedFeet.has(part)) moved = true;
    }
    if (stood && !moved) return true;
  }
  return false;
}

void RowStatAccumulator::record(int row, uint32_t techs, uint32_t errors) {
  for (int tech = 0; tech < TechCategoryCount; tech++)
    if (has(techs, tech)) stats.techCounts[tech]++;
  for (int error = 0; error < TechErrorCount; error++)
    if (has(errors, error)) stats.techErrorCounts[error]++;
  if (!keepRows) return;
  if (row == 0) {
    if (techs) stats.techRows[0] = techs;
  } else {
    stats.techRows.push_back(techs);
  }
  if (errors) stats.techErrors[row] = errors;
}

// HS on an earlier row: the holding foot left there, and the other foot took the hold back now
void RowStatAccumulator::addTech(int row, int tech) {
  stats.techCounts[tech]++;
  if (!keepRows) return;
  stats.techRows[row] |= 1u << tech;
}

// a tech between two rows (a mine dodge, a roll re-tap), kept with the mine rows
void RowStatAccumulator::addOffRowTech(double beat, double second, int tech) {
  stats.techCounts[tech]++;
  if (!keepRows) return;
  for (TechMineRow& m : stats.mineRows) {
    if (std::fabs(m.second - second) < SECOND_EPSILON) {
      m.techs |= 1u << tech;
      return;
    }
  }
  auto at = stats.mineRows.end();
  while (at != stats.mineRows.begin() && std::prev(at)->second > second) --at;
  stats.mineRows.insert(at, {beat, second, 1u << tech});
}

void RowStatAccumulator::firstRow(const ParityGraphNode& start, const ParityGraphNode& node) {
  uint32_t errors = 0;
  // Check first row for ambiguous
  if (countNotes(rows[0]) == 1 && cheaperAlternative(start, node)) errors |= 1u << Ambiguous;
  // The first row has no previous row, so only its row-local labels apply:
  // a bracket, a jump or a stepjump.
  const PlacementData data = layout.getPlacementData(start.state, node.state, nullptr, rows[0]);
  uint32_t first = 0;
  if (data.leftBracket || data.rightBracket) first |= 1u << Brackets;
  if (data.jumped) first |= 1u << (isStepjump(rows, 0) ? Stepjumps : Jumps);
  record(0, first, errors);
}

// the stats of row i + 1, from the path nodes of rows i and i + 1
void RowStatAccumulator::pair(const ParityGraphNode& initial, const ParityGraphNode& current,
                              int i) {
  const ParityState& initialState = initial.state;
  const Row& initialRow = rows[i];
  const ParityState& currentState = current.state;
  const Row& currentRow = rows[i + 1];

  const PlacementData data =
      layout.getPlacementData(initialState, currentState, &initialRow, currentRow);

  if (keepRows) {
    stats.facingRows.push_back(getPlayerAngle(data.leftPos, data.rightPos));
    for (int t = 0; t < data.rollTapCount; t++) {
      stats.rollTaps.push_back({(initialRow.beat + currentRow.beat) / 2,
                                (initialRow.second + currentRow.second) / 2,
                                data.rollTaps[t].col, data.rollTaps[t].foot});
    }
  }

  uint32_t techs = 0;
  uint32_t errors = 0;

  for (int c = 0; c < MAX_COLUMNS; c++) {
    if (currentRow.holds[c] == nullptr) continue;
    // Skip holds that weren't yet held at the previous row.
    if (currentRow.holds[c]->beat > data.initialState->beat) continue;
    const NotedataEntry* hold = currentRow.holds[c];
    const int initialFoot = data.initialState->combinedAt(c);
    const int resultFoot = data.resultState->combinedAt(c);
    if (resultFoot == Foot::NONE) {
      if (initialFoot != Foot::NONE && !currentRow.hasHoldTail(c))
        releases[c] = {hold, i + 1, initialFoot};
      continue;
    }
    if (initialFoot == Foot::NONE) {
      const Release& release = releases[c];
      if (release.hold == hold && isLeft(release.foot) != isLeft(resultFoot))
        addTech(release.row, Holdswitch);
      releases[c] = {};
      continue;
    }
    if (initialFoot != resultFoot && initialFoot != OTHER_PART_OF_FOOT(resultFoot)) {
      if (hold->type == NoteType::Roll) {
        // labelled like the re-tap were an arrow (minus the jack)
        const double beat = (initialRow.beat + currentRow.beat) / 2;
        const double second = (initialRow.second + currentRow.second) / 2;
        const bool sideswitch = includes(layout.sideArrows, c);
        addOffRowTech(beat, second, sideswitch ? Sideswitches : Footswitches);
        if (isLeft(resultFoot) ? includes(layout.rightArrows, c) : includes(layout.leftArrows, c))
          addOffRowTech(beat, second, Crossovers);
      } else {
        techs |= 1u << Holdswitch;
      }
    }
  }
  for (int c = 0; c < MAX_COLUMNS; c++) {
    if (releases[c].hold != nullptr && currentRow.holds[c] != releases[c].hold) releases[c] = {};
  }

  if (!has(techs, Holdswitch) && !data.jumped) {
    if (((data.leftDoubleStep && !data.leftAfterStepjump) ||
         (data.rightDoubleStep && !data.rightAfterStepjump)) &&
        !has(techs, Holdswitch)) {
      techs |= 1u << Doublesteps;

      if (!isDoublestepMarked(data, initialRow, currentRow, layout)) {
        errors |= 1u << UnmarkedDoublestep;
      }
    }

    // Footswitch
    for (int foot : currentState.movedFeet) {
      const int col = currentState.footColumn(foot);
      if (initialState.combinedAt(col) == Foot::NONE) continue;
      // taking over a roll's re-tap is labelled between the rows
      if (currentRow.holdAt(col) != nullptr) continue;
      if (initialState.combinedAt(col) == foot ||
          initialState.combinedAt(col) == OTHER_PART_OF_FOOT(foot))
        continue;
      if (includes(layout.sideArrows, col)) {
        techs |= 1u << Sideswitches;
      } else {
        techs |= 1u << Footswitches;
      }
      break;
    }
  }

  if (has(techs, Footswitches) && has(techs, Doublesteps)) {
    techs &= ~(1u << Footswitches);
    techs &= ~(1u << Doublesteps);
    techs |= 1u << Kickswitches;
  }

  if (data.leftBracket || data.rightBracket) techs |= 1u << Brackets;

  // Both feet acting simultaneously is a jump.
  if (data.jumped) techs |= 1u << Jumps;

  // Bracket-tap: one part of a foot taps an adjacent arrow while the other
  // part stays planted on an active hold.
  for (int c = 0; c < MAX_COLUMNS; c++) {
    if (currentRow.holds[c] == nullptr) continue;
    // a hold ending on this row is not tapped against
    if (currentRow.hasHoldTail(c)) continue;
    const int holder = currentState.combinedAt(c);
    if (holder == Foot::NONE) continue;
    const int other = OTHER_PART_OF_FOOT(holder);
    const int otherCol = currentState.footColumn(other);
    if (otherCol != -1 && otherCol != c && currentRow.noteAt(otherCol) != nullptr &&
        currentState.actionAt(otherCol) == other) {
      techs |= 1u << Brackettaps;
      break;
    }
  }

  // Stepjump: the label sits on the jump row in place of JU.
  if (data.jumped &&
      (isStepjump(rows, i + 1) ||
       isPlantedJump(currentRow, initialState, currentState,
                     currentRow.second - initialRow.second))) {
    techs &= ~(1u << Jumps);
    techs |= 1u << Stepjumps;
  }

  // A single re-press right after a jump is a jack only for a foot that
  // did not travel into that jump.
  auto repeatAfterJump = [&](int heel) {
    if (initialState.traveledFeet.has(heel)) return false;
    for (int f : currentState.movedFeet) {
      if (f != heel && f != OTHER_PART_OF_FOOT(heel)) continue;
      if (!initialState.holdFeet.has(
              initialState.combinedAt(currentState.footColumn(f))))
        return true;
    }
    return false;
  };
  const bool jackAfterJump = (data.leftJack && repeatAfterJump(Foot::LEFT_HEEL)) ||
                             (data.rightJack && repeatAfterJump(Foot::RIGHT_HEEL));
  // A repeated jump is JU only; the jump-jack is priced, not labelled.
  if (!has(techs, Brackets) && (data.leftJack || data.rightJack) &&
      (!data.previousJumped || jackAfterJump)) {
    techs |= 1u << Jacks;
    if (mineForcesFootswitch(data, currentRow, currentRow.second - initialRow.second)) {
      errors |= 1u << MissedFootswitch;
    }
  }

  int crossed = crossedPress(currentState);
  if (crossed >= 0) techs |= 1u << crossed;

  for (const MineRow& mines : currentRow.mineRows) {
    if (!isMineDodge(mines.columns, initialState, currentState)) continue;
    if (std::fabs(mines.second - currentRow.second) < SECOND_EPSILON) {
      techs |= 1u << MineDodges;
      continue;
    }
    addOffRowTech(mines.beat, mines.second, MineDodges);
  }

  if (isAmbiguous(data, currentRow, initial, current, i)) {
    errors |= 1u << Ambiguous;
  }

  if (data.movedLeft && std::fabs(data.previousLeftPos.y - data.leftPos.y) > 1.3) {
    if (keepRows) stats.candles[i + 1] = Foot::LEFT_HEEL;
  }

  if (data.movedRight && std::fabs(data.previousRightPos.y - data.rightPos.y) > 1.3) {
    if (keepRows) stats.candles[i + 1] = Foot::RIGHT_HEEL;
  }

  record(i + 1, techs, errors);
}

}  // namespace parity
