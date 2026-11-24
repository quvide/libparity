# the cmake minimum and C++17 (cxx_std_17 below) are listed in run.py's dependencies(); keep in sync
cmake_minimum_required(VERSION 3.14)
project(libparity CXX)

if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
  set(LIBPARITY_TOP_LEVEL ON)
else()
  set(LIBPARITY_TOP_LEVEL OFF)
endif()

if(LIBPARITY_TOP_LEVEL AND NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_library(libparity STATIC
  src/Analysis.cpp
  src/JsCompat.cpp
  src/ParityDataTypes.cpp
  src/ParityUtils.cpp
  src/StageLayouts.cpp
  src/ParityCost.cpp
  src/ParityInternals.cpp
  src/RowStatCalculator.cpp
)
add_library(libparity::libparity ALIAS libparity)
set_target_properties(libparity PROPERTIES OUTPUT_NAME parity)
target_compile_features(libparity PUBLIC cxx_std_17)
target_include_directories(libparity
  PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include
  PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)

# src/FloatSemantics.h also turns contraction off; the flags cover compilers
# that ignore its pragmas.
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(libparity PRIVATE -Wall -Wextra -ffp-contract=off -fno-fast-math)
elseif(MSVC)
  target_compile_options(libparity PRIVATE /W4 /fp:precise)
endif()

option(LIBPARITY_BUILD_CONFORM "Build the conformance port executable" ${LIBPARITY_TOP_LEVEL})
if(LIBPARITY_BUILD_CONFORM)
  find_package(Threads REQUIRED)
  add_executable(parity-conform tools/main.cpp tools/Format.cpp tools/Describe.cpp tools/Json.cpp)
  target_link_libraries(parity-conform PRIVATE libparity Threads::Threads)
  if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(parity-conform PRIVATE -Wall -Wextra -ffp-contract=off)
  endif()
endif()
