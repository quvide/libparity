#pragma once

// Analysis.ts

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "NoteTypes.h"
#include "ParityResultTypes.h"
#include "StageLayouts.h"

namespace parity {

// Bumped whenever the engine's output on the conformance corpus changes.
// Every port declares the same value; consumers store it next to derived data.
constexpr int ENGINE_VERSION = 1;

struct AnalysisRow {
  double beat;
  double second;
  // a bit per TechCategory / TechErrors
  uint32_t techs;
  uint32_t errors;
  // Foot::NONE unless the row is a candle
  int candle;
  // indexed by Foot: the column each part is planted on after this row, -1 when
  // lifted; [Foot::NONE] is -1
  std::array<int, 5> footColumns;
  // atan2(-dy, dx) of left foot -> right foot in stage coordinates; 0 on the first row
  double angle;
};

// a beat with only mines that carries techs
struct AnalysisMineRow {
  double beat;
  double second;
  // a bit per TechCategory
  uint32_t techs;
};

struct AnalysisHoldOwnership {
  // index into the input notes
  std::size_t note;
  std::vector<HoldOwnershipEntry> timeline;
};

struct ParityAnalysis {
  // one per input note, in input order; Foot::NONE for mines, fakes and unassigned notes
  std::vector<int> feet;
  // one per input note: index into rows, -1 when the note has no foot
  std::vector<int> noteRows;
  std::vector<AnalysisRow> rows;
  // mine-only beats that carry techs (MD), by beat; not part of rows or noteRows
  std::vector<AnalysisMineRow> mineRows;
  // where a roll is taken as re-tapped between rows (by the foot taking it
  // over, or the foot staying on it in a stream gap), by beat
  std::vector<RollTap> rollTaps;
  std::vector<AnalysisHoldOwnership> holdOwnership;
  // indexed by TechCategory / TechErrors
  std::vector<int> techCounts;
  std::vector<int> techErrorCounts;
};

// dance-double has a stage layout but is untested, so it is not supported
inline constexpr const char* SUPPORTED_STEPS_TYPES[] = {"dance-single"};

bool isSupportedStepsType(const std::string& stepsType);

// Panel geometry of a supported steps type; nullptr otherwise.
const StageLayout* stageLayout(const std::string& stepsType);

// Whole-chart analysis; nullopt when the steps type is unsupported or no foot
// path exists; empty for a chart without steps. `notes` are sorted by beat,
// then column, and are only read during the call.
std::optional<ParityAnalysis> analyze(const std::string& stepsType, const Notedata& notes);

struct TechCounts {
  // indexed by TechCategory / TechErrors
  std::vector<int> techCounts;
  std::vector<int> techErrorCounts;
};

// analyze()'s techCounts and techErrorCounts alone, in memory bounded by the
// search window instead of chart length; nullopt as for analyze().
std::optional<TechCounts> analyzeCounts(const std::string& stepsType, const Notedata& notes);

// The beat range analyze() computes.
std::pair<double, double> analysisRange(const Notedata& notes);

ParityAnalysis toAnalysis(const Notedata& notes, const ParityComputeData& data);

}  // namespace parity
