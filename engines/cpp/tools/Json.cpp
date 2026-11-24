#include "Json.h"

#include <charconv>
#include <cstdlib>
#include <cstring>
#include <stdexcept>

namespace json {

namespace {

class Parser {
 public:
  explicit Parser(std::string_view text) : text(text) {}

  Value parseDocument() {
    Value v = parseValue();
    skipWhitespace();
    if (pos != text.size()) fail("trailing characters");
    return v;
  }

 private:
  std::string_view text;
  size_t pos = 0;

  [[noreturn]] void fail(const char* what) const {
    throw std::runtime_error(std::string("JSON: ") + what + " at " + std::to_string(pos));
  }

  void skipWhitespace() {
    while (pos < text.size() &&
           (text[pos] == ' ' || text[pos] == '\t' || text[pos] == '\n' || text[pos] == '\r'))
      pos++;
  }

  char peek() {
    skipWhitespace();
    if (pos >= text.size()) fail("unexpected end");
    return text[pos];
  }

  void expect(char c) {
    if (peek() != c) fail("unexpected character");
    pos++;
  }

  bool literal(std::string_view word) {
    if (text.substr(pos, word.size()) != word) return false;
    pos += word.size();
    return true;
  }

  Value parseValue() {
    Value v;
    const char c = peek();
    if (c == '{') {
      v.type = Value::Object;
      pos++;
      if (peek() == '}') {
        pos++;
        return v;
      }
      while (true) {
        if (peek() != '"') fail("expected key");
        std::string key = parseString().string;
        expect(':');
        v.object.emplace_back(std::move(key), parseValue());
        if (peek() == ',') {
          pos++;
          continue;
        }
        expect('}');
        return v;
      }
    }
    if (c == '[') {
      v.type = Value::Array;
      pos++;
      if (peek() == ']') {
        pos++;
        return v;
      }
      while (true) {
        v.array.push_back(parseValue());
        if (peek() == ',') {
          pos++;
          continue;
        }
        expect(']');
        return v;
      }
    }
    if (c == '"') return parseString();
    if (literal("true")) {
      v.type = Value::Bool;
      v.boolean = true;
      return v;
    }
    if (literal("false")) {
      v.type = Value::Bool;
      return v;
    }
    if (literal("null")) return v;
    return parseNumber();
  }

  Value parseNumber() {
    Value v;
    v.type = Value::Number;
    const char* begin = text.data() + pos;
    const char* end = text.data() + text.size();
    size_t length = 0;
    while (begin + length < end && std::strchr("+-.0123456789eE", begin[length]) != nullptr)
      length++;
    if (length == 0) fail("bad number");
#if defined(__cpp_lib_to_chars)
    auto res = std::from_chars(begin, begin + length, v.number);
    if (res.ec != std::errc() || res.ptr != begin + length) fail("bad number");
#else
    const std::string token(begin, length);
    char* tokenEnd = nullptr;
    v.number = std::strtod(token.c_str(), &tokenEnd);
    if (tokenEnd != token.c_str() + length) fail("bad number");
#endif
    pos += length;
    return v;
  }

  static void appendUtf8(std::string& out, unsigned cp) {
    if (cp < 0x80) {
      out += static_cast<char>(cp);
    } else if (cp < 0x800) {
      out += static_cast<char>(0xC0 | (cp >> 6));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      out += static_cast<char>(0xE0 | (cp >> 12));
      out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
      out += static_cast<char>(0xF0 | (cp >> 18));
      out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
      out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    }
  }

  unsigned parseHex4() {
    if (pos + 4 > text.size()) fail("bad escape");
    unsigned cp = 0;
    for (int i = 0; i < 4; i++) {
      const char h = text[pos++];
      cp <<= 4;
      if (h >= '0' && h <= '9') cp |= h - '0';
      else if (h >= 'a' && h <= 'f') cp |= h - 'a' + 10;
      else if (h >= 'A' && h <= 'F') cp |= h - 'A' + 10;
      else fail("bad escape");
    }
    return cp;
  }

  Value parseString() {
    Value v;
    v.type = Value::String;
    const size_t start = pos;
    pos++;
    while (true) {
      if (pos >= text.size()) fail("unterminated string");
      const char c = text[pos++];
      if (c == '"') break;
      if (c != '\\') {
        v.string += c;
        continue;
      }
      if (pos >= text.size()) fail("bad escape");
      const char e = text[pos++];
      switch (e) {
        case '"': v.string += '"'; break;
        case '\\': v.string += '\\'; break;
        case '/': v.string += '/'; break;
        case 'b': v.string += '\b'; break;
        case 'f': v.string += '\f'; break;
        case 'n': v.string += '\n'; break;
        case 'r': v.string += '\r'; break;
        case 't': v.string += '\t'; break;
        case 'u': {
          unsigned cp = parseHex4();
          if (cp >= 0xD800 && cp < 0xDC00 && text.substr(pos, 2) == "\\u") {
            const size_t save = pos;
            pos += 2;
            const unsigned lo = parseHex4();
            if (lo >= 0xDC00 && lo < 0xE000)
              cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
            else
              pos = save;
          }
          appendUtf8(v.string, cp);
          break;
        }
        default: fail("bad escape");
      }
    }
    v.raw = text.substr(start, pos - start);
    return v;
  }
};

}  // namespace

Value parse(std::string_view text) { return Parser(text).parseDocument(); }

}  // namespace json
