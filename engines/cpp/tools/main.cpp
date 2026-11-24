// Port protocol (CONFORMANCE.md): cases as NDJSON on stdin, one result
// line per case on stdout, in completion order. `--counts` computes
// analyzeCounts() instead; `--describe` prints the public API description
// instead (Describe.cpp).

#include <atomic>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "Describe.h"
#include "Format.h"

namespace {

void usage() {
  std::fprintf(stderr,
               "usage: parity-conform [-j N] [--counts] | parity-conform --describe\n"
               "  reads cases (NDJSON) on stdin, writes results on stdout\n");
}

}  // namespace

int main(int argc, char** argv) {
  unsigned jobs = std::thread::hardware_concurrency();
  bool counts = false;
  for (int i = 1; i < argc; i++) {
    if (std::strcmp(argv[i], "--describe") == 0) {
      std::cout << format::describe() << '\n';
      return 0;
    }
    if (std::strcmp(argv[i], "--counts") == 0) {
      counts = true;
    } else if ((std::strcmp(argv[i], "-j") == 0 || std::strcmp(argv[i], "--jobs") == 0) &&
        i + 1 < argc) {
      jobs = static_cast<unsigned>(std::atoi(argv[++i]));
    } else {
      usage();
      return 2;
    }
  }
  if (jobs == 0) jobs = 1;

  std::ios::sync_with_stdio(false);
  const size_t maxQueued = jobs * 4;
  std::mutex queueMutex;
  std::condition_variable queueChanged;
  std::deque<std::string> queue;
  bool done = false;
  std::mutex outMutex;
  std::atomic<int> failures{0};

  auto worker = [&]() {
    while (true) {
      std::string line;
      {
        std::unique_lock<std::mutex> lock(queueMutex);
        queueChanged.wait(lock, [&] { return !queue.empty() || done; });
        if (queue.empty()) return;
        line = std::move(queue.front());
        queue.pop_front();
      }
      queueChanged.notify_all();
      std::string result;
      try {
        result = counts ? format::computeCounts(line) : format::computeReference(line);
      } catch (const std::exception& e) {
        failures++;
        std::fprintf(stderr, "case failed: %s\n", e.what());
        result = format::errorResult(line, e.what());
      }
      result += '\n';
      std::lock_guard<std::mutex> lock(outMutex);
      std::fwrite(result.data(), 1, result.size(), stdout);
    }
  };

  std::vector<std::thread> threads;
  for (unsigned i = 0; i < jobs; i++) threads.emplace_back(worker);

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    std::unique_lock<std::mutex> lock(queueMutex);
    queueChanged.wait(lock, [&] { return queue.size() < maxQueued; });
    queue.push_back(std::move(line));
    lock.unlock();
    queueChanged.notify_all();
  }
  {
    std::lock_guard<std::mutex> lock(queueMutex);
    done = true;
  }
  queueChanged.notify_all();
  for (auto& t : threads) t.join();
  std::fflush(stdout);
  return failures ? 1 : 0;
}
