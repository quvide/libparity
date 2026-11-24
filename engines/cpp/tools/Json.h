#pragma once

// Minimal JSON reader for the conformance cases.

#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace json {

struct Value {
  enum Type { Null, Bool, Number, String, Array, Object };
  Type type = Null;
  bool boolean = false;
  double number = 0;
  std::string string;
  // the source text of a string, quotes and escapes included
  std::string_view raw;
  std::vector<Value> array;
  std::vector<std::pair<std::string, Value>> object;

  const Value* get(std::string_view key) const {
    for (const auto& [k, v] : object)
      if (k == key) return &v;
    return nullptr;
  }
};

// Throws std::runtime_error on malformed input.
Value parse(std::string_view text);

}  // namespace json
