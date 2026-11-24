// Mirrors engines/typescript/conformance/describe.ts: the public API's constants and
// edge cases as JSON, compared with the reference by `conformance check-api`.

#include "Describe.h"

#include <initializer_list>
#include <optional>
#include <string>
#include <vector>

#include "libparity/libparity.h"

using namespace parity;

namespace format {

namespace {

const char* const STEPS_TYPE_PROBES[] = {"dance-single", "dance-double", "pump-single", ""};
const char* const EXTRA_CODE_PROBES[] = {"??", ""};

void str(std::string& out, const char* s) {
  out += '"';
  for (; *s; s++) {
    if (*s == '"' || *s == '\\') out += '\\';
    out += *s;
  }
  out += '"';
}

void num(std::string& out, double x) { out += jsNumberToString(x); }

void optional(std::string& out, std::optional<int> v) {
  if (v)
    out += std::to_string(*v);
  else
    out += "null";
}

template <typename T>
void list(std::string& out, const std::vector<T>& values) {
  out += '[';
  for (std::size_t i = 0; i < values.size(); i++) {
    if (i) out += ',';
    num(out, values[i]);
  }
  out += ']';
}

template <std::size_t N>
void table(std::string& out, const CodeInfo (&t)[N]) {
  out += '[';
  for (std::size_t i = 0; i < N; i++) {
    if (i) out += ',';
    out += '[';
    str(out, t[i].code);
    out += ',';
    str(out, t[i].name);
    out += ',';
    str(out, t[i].description);
    out += ']';
  }
  out += ']';
}

template <std::size_t N>
void lookups(std::string& out, const CodeInfo (&t)[N], std::optional<int> (*lookup)(std::string_view)) {
  out += '{';
  bool first = true;
  auto entry = [&](const char* code) {
    if (!first) out += ',';
    first = false;
    str(out, code);
    out += ':';
    optional(out, lookup(code));
  };
  for (const CodeInfo& info : t) entry(info.code);
  for (const char* code : EXTRA_CODE_PROBES) entry(code);
  out += '}';
}

}  // namespace

std::string describe() {
  std::string out = "{\"engineVersion\":";
  out += std::to_string(ENGINE_VERSION);

  out += ",\"supportedStepsTypes\":[";
  bool first = true;
  for (const char* s : SUPPORTED_STEPS_TYPES) {
    if (!first) out += ',';
    first = false;
    str(out, s);
  }

  out += "],\"isSupported\":{";
  first = true;
  for (const char* s : STEPS_TYPE_PROBES) {
    if (!first) out += ',';
    first = false;
    str(out, s);
    out += isSupportedStepsType(s) ? ":true" : ":false";
  }

  out += "},\"footInfo\":";
  table(out, FOOT_INFO);
  out += ",\"techInfo\":";
  table(out, TECH_INFO);
  out += ",\"techErrorInfo\":";
  table(out, TECH_ERROR_INFO);
  out += ",\"footFromCode\":";
  lookups(out, FOOT_INFO, footFromCode);
  out += ",\"techFromCode\":";
  lookups(out, TECH_INFO, techFromCode);
  out += ",\"techErrorFromCode\":";
  lookups(out, TECH_ERROR_INFO, techErrorFromCode);

  out += ",\"stageLayouts\":{";
  first = true;
  for (const char* s : STEPS_TYPE_PROBES) {
    if (!first) out += ',';
    first = false;
    str(out, s);
    out += ':';
    const StageLayout* l = stageLayout(s);
    if (!l) {
      out += "null";
      continue;
    }
    out += "{\"name\":";
    str(out, l->name.c_str());
    out += ",\"columnCount\":";
    out += std::to_string(l->columnCount);
    out += ",\"layout\":[";
    for (std::size_t i = 0; i < l->layout.size(); i++) {
      if (i) out += ',';
      list(out, std::vector<double>{l->layout[i].x, l->layout[i].y, l->layout[i].rotation});
    }
    out += "],\"upArrows\":";
    list(out, l->upArrows);
    out += ",\"downArrows\":";
    list(out, l->downArrows);
    out += ",\"leftArrows\":";
    list(out, l->leftArrows);
    out += ",\"rightArrows\":";
    list(out, l->rightArrows);
    out += ",\"sideArrows\":";
    list(out, l->sideArrows);
    out += '}';
  }

  out += "},\"analyzeUnsupported\":";
  out += analyze("dance-double", {}) ? "false" : "true";
  out += ",\"analyzeEmpty\":";
  const auto empty = analyze("dance-single", {});
  if (!empty) {
    out += "null";
  } else {
    out += "{\"feet\":";
    out += std::to_string(empty->feet.size());
    out += ",\"rows\":";
    out += std::to_string(empty->rows.size());
    out += ",\"techCounts\":";
    list(out, empty->techCounts);
    out += ",\"techErrorCounts\":";
    list(out, empty->techErrorCounts);
    out += '}';
  }
  out += ",\"analyzeCountsUnsupported\":";
  out += analyzeCounts("dance-double", {}) ? "false" : "true";
  out += ",\"analyzeCountsEmpty\":";
  const auto emptyCounts = analyzeCounts("dance-single", {});
  if (!emptyCounts) {
    out += "null";
  } else {
    out += "{\"techCounts\":";
    list(out, emptyCounts->techCounts);
    out += ",\"techErrorCounts\":";
    list(out, emptyCounts->techErrorCounts);
    out += '}';
  }
  out += '}';
  return out;
}

}  // namespace format
