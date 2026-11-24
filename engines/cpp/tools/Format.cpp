#include "Format.h"

#include <stdexcept>

#include "Json.h"
#include "libparity/libparity.h"

using namespace parity;

namespace format {

namespace {


const json::Value& need(const json::Value& object, const char* key) {
  const json::Value* v = object.get(key);
  if (!v) throw std::runtime_error(std::string("missing field: ") + key);
  return *v;
}

double number(const json::Value& v, const char* what) {
  if (v.type != json::Value::Number) throw std::runtime_error(std::string("expected a number: ") + what);
  return v.number;
}

FootOverride footOverride(const json::Value& v) {
  if (v.type == json::Value::String) {
    if (v.string == "Left") return FOOT_OVERRIDE_LEFT;
    if (v.string == "Right") return FOOT_OVERRIDE_RIGHT;
  } else if (v.type == json::Value::Number && v.number >= 0 && v.number <= 4 &&
             v.number == static_cast<int>(v.number)) {
    return static_cast<FootOverride>(v.number);
  }
  throw std::runtime_error("bad foot override");
}

NoteType noteType(const std::string& type) {
  if (type == "Tap") return NoteType::Tap;
  if (type == "Mine") return NoteType::Mine;
  if (type == "Lift") return NoteType::Lift;
  if (type == "Fake") return NoteType::Fake;
  if (type == "Hold") return NoteType::Hold;
  if (type == "Roll") return NoteType::Roll;
  throw std::runtime_error("unknown note type: " + type);
}

void toNotedata(const json::Value& notes, int columnCount, Notedata& notedata) {
  if (notes.type != json::Value::Array) throw std::runtime_error("notes: expected an array");
  notedata.reserve(notes.array.size());
  for (const json::Value& n : notes.array) {
    NotedataEntry e;
    e.beat = number(need(n, "beat"), "beat");
    const double col = number(need(n, "col"), "col");
    if (!(col >= 0 && col < columnCount) || col != static_cast<int>(col))
      throw std::runtime_error("col out of range");
    e.col = static_cast<int>(col);
    e.type = noteType(need(n, "type").string);
    e.second = number(need(n, "second"), "second");
    const json::Value* hold = n.get("hold");
    const json::Value* warped = n.get("warped");
    const json::Value* fake = n.get("fake");
    e.warped = warped && warped->boolean;
    e.fake = fake && fake->boolean;
    if (const json::Value* o = n.get("override")) e.override = footOverride(*o);
    if (const json::Value* list = n.get("holdOverrides")) {
      for (const json::Value& entry : list->array)
        e.holdOverrides.push_back({number(need(entry, "beat"), "holdOverrides.beat"),
                                   footOverride(need(entry, "foot"))});
    }
    if (isHoldNote(e)) e.hold = hold ? number(*hold, "hold") : 0;
    notedata.push_back(std::move(e));
  }
}

void appendNumber(std::string& out, double x) { out += jsNumberToString(x); }

void appendCounts(std::string& out, const std::vector<int>& counts,
                  const CodeInfo* names) {
  out += '{';
  bool first = true;
  for (size_t i = 0; i < counts.size(); i++) {
    if (!counts[i]) continue;
    if (!first) out += ',';
    first = false;
    out += '"';
    out += names[i].code;
    out += "\":";
    out += std::to_string(counts[i]);
  }
  out += '}';
}

}  // namespace

std::string computeReference(std::string_view caseLine) {
  const json::Value c = json::parse(caseLine);
  const json::Value* id = c.get("id");
  const json::Value* stepsType = c.get("stepsType");
  const json::Value* notes = c.get("notes");
  if (!id || !stepsType || !notes) throw std::runtime_error("case: missing field");

  const StageLayout* layout = stageLayout(stepsType->string);
  if (!layout) throw std::runtime_error("unsupported steps type: " + stepsType->string);
  Notedata notedata;
  toNotedata(*notes, layout->columnCount, notedata);
  const auto a = analyze(stepsType->string, notedata);

  std::string out = "{\"id\":";
  out += id->raw;
  if (!a) {
    out += ",\"noPath\":true,\"feet\":\"\",\"rowCount\":0,\"rows\":[],\"mineRows\":[],"
           "\"holdOwnership\":[],\"candles\":[],\"stance\":\"\",\"angleChecksum\":0,"
           "\"counts\":{},\"errorCounts\":{}}";
    return out;
  }

  out += ",\"feet\":\"";
  for (const int foot : a->feet) out += FOOT_INFO[foot].code;
  out += "\",\"rowCount\":";
  out += std::to_string(a->rows.size());

  out += ",\"rows\":[";
  bool firstRow = true;
  for (const AnalysisRow& row : a->rows) {
    if (!row.techs && !row.errors) continue;
    if (!firstRow) out += ',';
    firstRow = false;
    out += '[';
    appendNumber(out, row.beat);
    out += ",[";
    bool first = true;
    for (int t = 0; t < TechCategoryCount; t++) {
      if (!(row.techs >> t & 1)) continue;
      if (!first) out += ',';
      first = false;
      out += '"';
      out += TECH_INFO[t].code;
      out += '"';
    }
    out += "],[";
    first = true;
    for (int e = 0; e < TechErrorCount; e++) {
      if (!(row.errors >> e & 1)) continue;
      if (!first) out += ',';
      first = false;
      out += '"';
      out += TECH_ERROR_INFO[e].code;
      out += '"';
    }
    out += "]]";
  }

  out += "],\"mineRows\":[";
  bool firstMineRow = true;
  for (const AnalysisMineRow& row : a->mineRows) {
    if (!firstMineRow) out += ',';
    firstMineRow = false;
    out += '[';
    appendNumber(out, row.beat);
    out += ",[";
    bool first = true;
    for (int t = 0; t < TechCategoryCount; t++) {
      if (!(row.techs >> t & 1)) continue;
      if (!first) out += ',';
      first = false;
      out += '"';
      out += TECH_INFO[t].code;
      out += '"';
    }
    out += "]]";
  }

  out += "],\"holdOwnership\":[";
  bool firstHold = true;
  for (const AnalysisHoldOwnership& hold : a->holdOwnership) {
    if (!firstHold) out += ',';
    firstHold = false;
    out += '[';
    out += std::to_string(hold.note);
    out += ",[";
    bool first = true;
    for (const HoldOwnershipEntry& t : hold.timeline) {
      if (!first) out += ',';
      first = false;
      out += '[';
      appendNumber(out, t.beat);
      out += ",\"";
      out += FOOT_INFO[t.foot].code;
      out += "\"]";
    }
    out += "]]";
  }

  out += "],\"candles\":[";
  bool firstCandle = true;
  for (const AnalysisRow& row : a->rows) {
    if (row.candle == Foot::NONE) continue;
    if (!firstCandle) out += ',';
    firstCandle = false;
    out += '[';
    appendNumber(out, row.beat);
    out += ",\"";
    out += FOOT_INFO[row.candle].code;
    out += "\"]";
  }

  out += "],\"stance\":\"";
  for (const AnalysisRow& row : a->rows)
    for (int f = 1; f < 5; f++)
      out += row.footColumns[f] < 0 ? '.' : "0123456789abcdefghijklmnopqrstuvwxyz"[row.footColumns[f]];
  double angleChecksum = 0;
  for (std::size_t i = 0; i < a->rows.size(); i++)
    angleChecksum += static_cast<double>(i + 1) * a->rows[i].angle;
  out += "\",\"angleChecksum\":";
  appendNumber(out, angleChecksum);
  out += ",\"counts\":";
  appendCounts(out, a->techCounts, TECH_INFO);
  out += ",\"errorCounts\":";
  appendCounts(out, a->techErrorCounts, TECH_ERROR_INFO);
  out += '}';
  return out;
}

std::string computeCounts(std::string_view caseLine) {
  const json::Value c = json::parse(caseLine);
  const json::Value* id = c.get("id");
  const json::Value* stepsType = c.get("stepsType");
  const json::Value* notes = c.get("notes");
  if (!id || !stepsType || !notes) throw std::runtime_error("case: missing field");

  const StageLayout* layout = stageLayout(stepsType->string);
  if (!layout) throw std::runtime_error("unsupported steps type: " + stepsType->string);
  Notedata notedata;
  toNotedata(*notes, layout->columnCount, notedata);
  const auto counts = analyzeCounts(stepsType->string, notedata);

  std::string out = "{\"id\":";
  out += id->raw;
  if (!counts) {
    out += ",\"noPath\":true,\"counts\":{},\"errorCounts\":{}}";
    return out;
  }
  out += ",\"counts\":";
  appendCounts(out, counts->techCounts, TECH_INFO);
  out += ",\"errorCounts\":";
  appendCounts(out, counts->techErrorCounts, TECH_ERROR_INFO);
  out += '}';
  return out;
}

std::string errorResult(std::string_view caseLine, const std::string& message) {
  std::string id = "null";
  try {
    const json::Value c = json::parse(caseLine);
    if (const json::Value* v = c.get("id")) id = std::string(v->raw);
  } catch (...) {
  }
  std::string escaped;
  for (char ch : message) {
    if (ch == '"' || ch == '\\') escaped += '\\';
    if (static_cast<unsigned char>(ch) < 0x20) continue;
    escaped += ch;
  }
  return "{\"id\":" + id + ",\"error\":\"" + escaped + "\"}";
}

}  // namespace format
