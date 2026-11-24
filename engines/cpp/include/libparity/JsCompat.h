#pragma once

// JavaScript number semantics the reference relies on.

#include <cmath>
#include <cstdint>
#include <string>

namespace parity {

// Math.PI
constexpr double JS_PI = 3.141592653589793;

// JS `undefined` read from a Foot or column slot (an index past the end of a
// JS array, or -1). Compares unequal to every foot and column.
constexpr int UNDEF = -100;

// Math.round: half rounds toward +Infinity.
inline double jsRound(double x) {
  double r = std::floor(x);
  if (x - r >= 0.5) r += 1;
  return r;
}

// Math.max / Math.min of two numbers: NaN propagates, +0 beats -0.
inline double jsMax(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return NAN;
  if (a == b) return std::signbit(a) ? b : a;
  return a > b ? a : b;
}

inline double jsMin(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return NAN;
  if (a == b) return std::signbit(a) ? a : b;
  return a < b ? a : b;
}

// Number.prototype.toFixed(3): the exact binary value rounded half up.
std::string toFixed3(double x);

// Number.prototype.toString(): shortest round-trip digits, JS layout.
std::string jsNumberToString(double x);

// An optional number, as read from a sparse JS array.
struct OptNum {
  bool has = false;
  double v = 0;
  // `undefined || 0 || NaN` are all falsy
  bool truthy() const { return has && v != 0 && !std::isnan(v); }
};

}  // namespace parity
