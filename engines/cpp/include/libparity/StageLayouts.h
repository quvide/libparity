#pragma once

#include <string>
#include <vector>

#include "ParityDataTypes.h"

namespace parity {

struct StagePoint {
  double x;
  double y;
  double rotation;
};

// Array.prototype.includes on a column list
inline bool includes(const std::vector<int>& list, int value) {
  for (int v : list)
    if (v == value) return true;
  return false;
}

class StageLayout {
 public:
  std::string name;
  std::vector<StagePoint> layout;
  int columnCount;
  std::vector<int> upArrows;
  std::vector<int> downArrows;
  std::vector<int> sideArrows;
  std::vector<int> leftArrows;
  std::vector<int> rightArrows;

  StageLayout(std::string name, std::vector<StagePoint> layout,
              std::vector<int> upArrows, std::vector<int> downArrows,
              std::vector<int> sideArrows);

  struct CrossedFeet {
    bool leftOnRight;
    bool rightOnLeft;
  };
  CrossedFeet crossedFeet(const ParityState& state) const;

  Pos averagePoint(int leftIndex, int rightIndex) const;
  double getDistanceSq(int leftIndex, int rightIndex) const;
  double getDistanceSqPoints(Pos p1, Pos p2) const;
  bool bracketCheck(int column1, int column2) const;

  PlacementData getPlacementData(const ParityState& initialState,
                                 const ParityState& resultState,
                                 const Row* lastRow, const Row& row) const;

  // offset hovering (-1) y by 0.5 depending on frontFoot
  Pos footPosition(const ParityState& state, int heel) const;
};

// STAGE_LAYOUTS[id], or nullptr
const StageLayout* getStageLayout(const std::string& id);

}  // namespace parity
