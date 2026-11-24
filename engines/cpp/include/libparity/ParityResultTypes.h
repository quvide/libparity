#pragma once

#include <array>
#include <cstdint>
#include <map>
#include <string>
#include <unordered_map>
#include <vector>

#include "ParityDataTypes.h"

namespace parity {

struct HoldOwnershipEntry {
  double beat;
  int foot;
};

struct RowTimestamp {
  double beat;
  double second;
};

struct TechMineRow {
  double beat;
  double second;
  // a bit per TechCategory
  uint32_t techs;
};

// a roll taken as re-tapped between two rows, at their midpoint
struct RollTap {
  double beat;
  double second;
  int col;
  int foot;
};

struct ParityComputeData {
  // keyed toFixed3(beat) + "-" + col
  std::unordered_map<std::string, int> parityLabels;
  // row index of each parityLabels entry
  std::unordered_map<std::string, int> labelRows;
  // hold-body ownership timelines keyed by head note "beat-col"; only
  // present for holds whose covering foot changes mid-hold
  std::unordered_map<std::string, std::vector<HoldOwnershipEntry>> holdOwnership;
  std::vector<RowTimestamp> rowTimestamps;
  // per row, a bit per TechCategory (0: undefined)
  std::vector<uint32_t> techRows;
  // mine-only beats that carry techs, by beat
  std::vector<TechMineRow> mineRows;
  // where the engine takes a roll as re-tapped between rows, by beat
  std::vector<RollTap> rollTaps;
  // row -> a bit per TechErrors
  std::map<int, uint32_t> techErrors;
  // indexed by TechCategory / TechErrors; 0 where the JS array has a hole
  std::vector<int> techCounts;
  std::vector<int> techErrorCounts;
  std::vector<double> facingRows;
  // per row, indexed by Foot: states[row + 1].footColumns in the TS source
  std::vector<std::array<int8_t, 5>> footColumnRows;
  // row -> Foot
  std::map<int, int> candles;
};

}  // namespace parity
