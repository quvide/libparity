#pragma once

// Included first by every source file. Costs must match the reference's IEEE
// double arithmetic exactly, so floating-point contraction (FMA) stays off even
// when a consumer compiles these sources with its own flags.
#if defined(__clang__)
#pragma clang fp contract(off)
#elif defined(__GNUC__)
#pragma GCC optimize("fp-contract=off")
#elif defined(_MSC_VER)
#pragma fp_contract(off)
#endif
