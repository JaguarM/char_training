#pragma once
// match.cuh — GPU template matcher interface. All TUs compile under nvcc, so
// cuda_runtime.h is available everywhere.
#include <cuda_runtime.h>

#include <cstdint>
#include <vector>

#include "tpl.hpp"

struct Hit {                     // one accepted template placement
    uint16_t t;                  // template index
    uint16_t x, y;               // bitmap top-left on the page
};

struct MatchStats {
    unsigned nDark = 0;          // dark pixels the page compacted to
    unsigned nHits = 0;
    bool overflow = false;       // hit buffer overflowed (raise --max-hits)
    float msH2D = 0, msDark = 0, msMatch = 0, msD2H = 0;
};

// Persistent GPU state: templates upload once, page buffers grow to the
// largest page seen and are reused.
class GpuMatcher {
public:
    void init(const std::vector<Tpl>& tpls, unsigned maxHits);
    // naive = brute-force position kernel (cross-check / benchmark);
    // default is the dark-pixel-anchored kernel.
    std::vector<Hit> match(const uint8_t* gray, int w, int h, int tol,
                           bool naive, MatchStats& st);
    ~GpuMatcher();

private:
    void ensurePage(size_t n);
    uint8_t* dPage_ = nullptr;   size_t pageCap_ = 0;
    uint32_t* dDark_ = nullptr;
    uint16_t* dInkPos_ = nullptr;
    uint8_t* dInkVal_ = nullptr;
    void* dMeta_ = nullptr;      // TplMeta[] (global mem — no 64KB constant cap)
    Hit* dHits_ = nullptr;
    unsigned* dCounts_ = nullptr; // [0] dark count, [1] hit count
    unsigned maxHits_ = 0;
    int nTpl_ = 0;
    uint8_t darkThresh_ = 0;     // max template anchor value + tol headroom
    cudaEvent_t ev_[4] = {};
};
