#include "FloatSemantics.h"

#include "libparity/JsCompat.h"

#include <charconv>
#include <cstdio>
#include <cstdlib>

namespace parity {

std::string toFixed3(double x) {
  if (std::isnan(x)) return "NaN";
  if (std::fabs(x) >= 1e21) return jsNumberToString(x);
  const bool neg = x < 0;
  if (neg) x = -x;
  std::string intPart;
  uint64_t frac = 0;
  if (x >= 9007199254740992.0) {
    char buf[32];
    std::snprintf(buf, sizeof buf, "%.0f", x);
    intPart = buf;
  } else {
    int e = 0;
    const double m = std::frexp(x, &e);
    const uint64_t mant = static_cast<uint64_t>(std::ldexp(m, 53));
    const int exp = e - 53;
    uint64_t q;
    if (exp >= 0) {
      q = (mant << exp) * 1000;
    } else {
      const uint64_t prod = mant * 1000;
      const int s = -exp;
      if (s >= 64) {
        q = 0;
      } else {
        q = prod >> s;
        const uint64_t rem = prod & ((uint64_t(1) << s) - 1);
        if (rem >= (uint64_t(1) << (s - 1))) q++;
      }
    }
    intPart = std::to_string(q / 1000);
    frac = q % 1000;
  }
  char fracBuf[8];
  std::snprintf(fracBuf, sizeof fracBuf, ".%03u", static_cast<unsigned>(frac));
  return (neg ? "-" : "") + intPart + fracBuf;
}

std::string jsNumberToString(double x) {
  if (std::isnan(x)) return "NaN";
  if (x == 0) return "0";
  if (std::isinf(x)) return x < 0 ? "-Infinity" : "Infinity";
  if (x < 0) return "-" + jsNumberToString(-x);
  char buf[64];
#if defined(__cpp_lib_to_chars)
  auto res = std::to_chars(buf, buf + sizeof buf, x, std::chars_format::scientific);
  *res.ptr = 0;
#else
  // shortest correctly rounded digits that round-trip; unlike to_chars this
  // can miss a shorter form next to a power of two
  for (int precision = 0; precision <= 16; precision++) {
    std::snprintf(buf, sizeof buf, "%.*e", precision, x);
    if (std::strtod(buf, nullptr) == x) break;
  }
#endif
  std::string digits;
  const char* p = buf;
  for (; *p && *p != 'e'; p++)
    if (*p != '.') digits += *p;
  const int n = std::atoi(p + 1) + 1;
  const int k = static_cast<int>(digits.size());
  if (k <= n && n <= 21) return digits + std::string(n - k, '0');
  if (0 < n && n <= 21) return digits.substr(0, n) + "." + digits.substr(n);
  if (-6 < n && n <= 0) return "0." + std::string(-n, '0') + digits;
  const int e = n - 1;
  std::string out = digits.substr(0, 1);
  if (k > 1) out += "." + digits.substr(1);
  return out + "e" + (e < 0 ? "-" : "+") + std::to_string(e < 0 ? -e : e);
}

}  // namespace parity
