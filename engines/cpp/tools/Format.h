#pragma once

// Port of conformance/format.ts: case JSON in, result JSON out.

#include <string>
#include <string_view>

namespace format {

// One case line -> one result line (no trailing newline). Throws on a
// malformed case.
std::string computeReference(std::string_view caseLine);

// analyzeCounts() as a result with only id, noPath, counts and errorCounts
std::string computeCounts(std::string_view caseLine);

// {"id", "error"} for a case that could not be computed
std::string errorResult(std::string_view caseLine, const std::string& message);

}  // namespace format
