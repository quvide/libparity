#pragma once

#include <array>
#include <cstdint>
#include <map>
#include <optional>
#include <vector>

#include "Analysis.h"
#include "ParityDataTypes.h"
#include "ParityInternals.h"
#include "StageLayouts.h"

namespace parity {

struct RowStats {
  // per row, a bit per TechCategory (0: undefined)
  std::vector<uint32_t> techRows;
  std::vector<TechMineRow> mineRows;
  std::vector<RollTap> rollTaps;
  // row -> a bit per TechErrors
  std::map<int, uint32_t> techErrors;
  std::vector<double> facingRows;
  // row -> Foot
  std::map<int, int> candles;
  std::vector<int> techCounts;
  std::vector<int> techErrorCounts;
};

// nodes: the best path, start and end nodes included; the children of every
// node but the last two must be filled.
RowStats calculateRowStats(const std::vector<ParityGraphNode>& nodes, const Rows& rows,
                           const StageLayout& layout);

// Row stats of a best path fed one node at a time: the start node, then one
// node per row. When a node is pushed, the previous node's children must be
// set (the ambiguity checks read them) and the rows from the previous node's
// row through the row after the pushed one must be present. Without
// keepRows only the counts are kept.
class RowStatAccumulator {
 public:
  RowStatAccumulator(const Rows& rows, const StageLayout& layout, bool keepRows);

  void push(ParityGraphNode node);
  TechCounts counts() &&;
  RowStats result() &&;

 private:
  const Rows& rows;
  const StageLayout& layout;
  bool keepRows;
  RowStats stats;
  std::optional<ParityGraphNode> previous;
  int pushed = 0;
  // per column, a hold or roll no foot is on: its note, the row it was
  // released on and the foot that left it
  struct Release {
    const NotedataEntry* hold = nullptr;
    int row = 0;
    int foot = Foot::NONE;
  };
  std::array<Release, MAX_COLUMNS> releases{};

  int crossedPress(const ParityState& state) const;
  static bool isMineDodge(const std::vector<int>& columns, const ParityState& before,
                          const ParityState& after);
  void record(int row, uint32_t techs, uint32_t errors);
  void addTech(int row, int tech);
  void addOffRowTech(double beat, double second, int tech);
  void firstRow(const ParityGraphNode& start, const ParityGraphNode& node);
  void pair(const ParityGraphNode& initial, const ParityGraphNode& current, int i);
};

}  // namespace parity
