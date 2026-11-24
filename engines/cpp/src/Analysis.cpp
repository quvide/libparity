#include "FloatSemantics.h"

#include "libparity/Analysis.h"

#include "libparity/JsCompat.h"
#include "libparity/ParityInternals.h"
#include "libparity/StageLayouts.h"

namespace parity {

bool isSupportedStepsType(const std::string& stepsType) {
  for (const char* supported : SUPPORTED_STEPS_TYPES)
    if (stepsType == supported) return true;
  return false;
}

const StageLayout* stageLayout(const std::string& stepsType) {
  return isSupportedStepsType(stepsType) ? getStageLayout(stepsType) : nullptr;
}

std::pair<double, double> analysisRange(const Notedata& notes) {
  double lastBeat = 0;
  for (const NotedataEntry& n : notes) lastBeat = jsMax(lastBeat, n.beat + (isHoldNote(n) ? n.hold : 0));
  return {-1, lastBeat + 4};
}

std::optional<ParityAnalysis> analyze(const std::string& stepsType, const Notedata& notes) {
  if (!isSupportedStepsType(stepsType)) return std::nullopt;
  const auto [start, end] = analysisRange(notes);
  ParityInternals internals(stepsType);
  const auto data = internals.computeBatch(start, end, notes);
  if (!data) return std::nullopt;
  return toAnalysis(notes, *data);
}

std::optional<TechCounts> analyzeCounts(const std::string& stepsType, const Notedata& notes) {
  if (!isSupportedStepsType(stepsType)) return std::nullopt;
  const auto [start, end] = analysisRange(notes);
  ParityInternals internals(stepsType);
  return internals.computeBatchCounts(start, end, notes);
}

ParityAnalysis toAnalysis(const Notedata& notes, const ParityComputeData& data) {
  ParityAnalysis a;
  a.feet.reserve(notes.size());
  a.noteRows.reserve(notes.size());
  for (std::size_t i = 0; i < notes.size(); i++) {
    const std::string key = toFixed3(notes[i].beat) + "-" + std::to_string(notes[i].col);
    const auto label = data.parityLabels.find(key);
    const int foot = label == data.parityLabels.end() ? Foot::NONE : label->second;
    a.feet.push_back(foot);
    const auto row = data.labelRows.find(key);
    a.noteRows.push_back(foot == Foot::NONE || row == data.labelRows.end() ? -1 : row->second);
    const auto hold = data.holdOwnership.find(key);
    if (hold != data.holdOwnership.end()) a.holdOwnership.push_back({i, hold->second});
  }
  a.rows.reserve(data.rowTimestamps.size());
  for (std::size_t i = 0; i < data.rowTimestamps.size(); i++) {
    const auto errors = data.techErrors.find(static_cast<int>(i));
    const auto candle = data.candles.find(static_cast<int>(i));
    std::array<int, 5> footColumns;
    for (int f = 0; f < 5; f++) footColumns[f] = f == Foot::NONE ? -1 : data.footColumnRows[i][f];
    a.rows.push_back({data.rowTimestamps[i].beat, data.rowTimestamps[i].second,
                      i < data.techRows.size() ? data.techRows[i] : 0,
                      errors == data.techErrors.end() ? 0 : errors->second,
                      candle == data.candles.end() ? Foot::NONE : candle->second, footColumns,
                      i < data.facingRows.size() ? data.facingRows[i] : 0});
  }
  for (const TechMineRow& m : data.mineRows) a.mineRows.push_back({m.beat, m.second, m.techs});
  a.rollTaps = data.rollTaps;
  a.techCounts.assign(TechCategoryCount, 0);
  for (std::size_t i = 0; i < data.techCounts.size() && i < a.techCounts.size(); i++)
    a.techCounts[i] = data.techCounts[i];
  a.techErrorCounts.assign(TechErrorCount, 0);
  for (std::size_t i = 0; i < data.techErrorCounts.size() && i < a.techErrorCounts.size(); i++)
    a.techErrorCounts[i] = data.techErrorCounts[i];
  return a;
}

}  // namespace parity
