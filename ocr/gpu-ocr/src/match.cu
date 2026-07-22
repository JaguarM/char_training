// match.cu — the pixel-perfect template matcher, GPU side.
//
// Two kernels:
//   darkListKernel   compacts the page's non-white pixels (< darkThresh) into
//                    a flat index list. Text pages are ~97% white, so this
//                    shrinks the search space ~30x.
//   matchDarkKernel  one thread per (dark pixel, template): the template is
//                    anchored at its DARKEST ink pixel — if that pixel of the
//                    page matches (|Δ| ≤ tol), walk the remaining ink pixels
//                    darkest-first and early-exit on the first mismatch. A
//                    placement is reported exactly once (its anchor maps to
//                    exactly one dark-list entry). Only ink pixels compare —
//                    white template pixels are don't-care, which is what the
//                    careful manual cropping used to approximate.
//   matchAllKernel   the honest brute force (every position × template),
//                    kept for cross-checking and benchmark bragging.
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>

#include "match.cuh"

#define CUDA_CHECK(call)                                                     \
    do {                                                                     \
        cudaError_t e_ = (call);                                             \
        if (e_ != cudaSuccess) {                                             \
            fprintf(stderr, "CUDA error %s at %s:%d: %s\n",                  \
                    cudaGetErrorName(e_), __FILE__, __LINE__,                \
                    cudaGetErrorString(e_));                                 \
            exit(1);                                                         \
        }                                                                    \
    } while (0)

struct TplMeta {                 // per-template GPU metadata (global memory —
    uint16_t w, h;               // the kernel reads it once per block, so the
    uint32_t inkOff, inkCnt;     // old 64KB __constant__ cap bought nothing)
};
// grid.y/z carries the template index — the only remaining roster ceiling
constexpr int MAX_TPL = 65535;

__global__ void darkListKernel(const uint8_t* __restrict__ page, int n,
                               uint8_t thresh, uint32_t* __restrict__ list,
                               unsigned* count) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n && page[i] < thresh) list[atomicAdd(count, 1u)] = (uint32_t)i;
}

__global__ void matchDarkKernel(const uint8_t* __restrict__ page, int W, int H,
                                const uint32_t* __restrict__ dark, unsigned nDark,
                                const TplMeta* __restrict__ meta,
                                const uint16_t* __restrict__ inkPos,
                                const uint8_t* __restrict__ inkVal, int tol,
                                Hit* hits, unsigned* hitCount, unsigned maxHits) {
    unsigned di = blockIdx.x * blockDim.x + threadIdx.x;
    if (di >= nDark) return;
    int t = blockIdx.y;
    TplMeta m = meta[t];
    const uint16_t* pos = inkPos + m.inkOff;
    const uint8_t* val = inkVal + m.inkOff;

    uint32_t pix = dark[di];
    int px = pix % W, py = pix / W;
    int p0 = pos[0];
    int x = px - (p0 & 255), y = py - (p0 >> 8);
    if (x < 0 || y < 0 || x + m.w > W || y + m.h > H) return;

    for (uint32_t k = 0; k < m.inkCnt; k++) {
        int p = pos[k];
        int d = (int)page[(y + (p >> 8)) * W + (x + (p & 255))] - (int)val[k];
        if (d > tol || d < -tol) return;
    }
    unsigned i = atomicAdd(hitCount, 1u);
    if (i < maxHits) hits[i] = Hit{(uint16_t)t, (uint16_t)x, (uint16_t)y};
}

__global__ void matchAllKernel(const uint8_t* __restrict__ page, int W, int H,
                               const TplMeta* __restrict__ meta,
                               const uint16_t* __restrict__ inkPos,
                               const uint8_t* __restrict__ inkVal, int tol,
                               Hit* hits, unsigned* hitCount, unsigned maxHits) {
    int t = blockIdx.z;
    TplMeta m = meta[t];
    int x = blockIdx.x * blockDim.x + threadIdx.x;
    int y = blockIdx.y * blockDim.y + threadIdx.y;
    if (x + m.w > W || y + m.h > H) return;
    const uint16_t* pos = inkPos + m.inkOff;
    const uint8_t* val = inkVal + m.inkOff;
    for (uint32_t k = 0; k < m.inkCnt; k++) {
        int p = pos[k];
        int d = (int)page[(y + (p >> 8)) * W + (x + (p & 255))] - (int)val[k];
        if (d > tol || d < -tol) return;
    }
    unsigned i = atomicAdd(hitCount, 1u);
    if (i < maxHits) hits[i] = Hit{(uint16_t)t, (uint16_t)x, (uint16_t)y};
}

void GpuMatcher::init(const std::vector<Tpl>& tpls, unsigned maxHits) {
    nTpl_ = (int)tpls.size();
    maxHits_ = maxHits;
    if (nTpl_ > MAX_TPL) { fprintf(stderr, "too many templates (%d > %d)\n", nTpl_, MAX_TPL); exit(1); }

    std::vector<TplMeta> meta(nTpl_);
    std::vector<uint16_t> inkPos;
    std::vector<uint8_t> inkVal;
    int maxAnchor = 0;
    for (int i = 0; i < nTpl_; i++) {
        const Tpl& t = tpls[i];
        meta[i] = {t.w, t.h, (uint32_t)inkPos.size(), (uint32_t)t.inkPos.size()};
        inkPos.insert(inkPos.end(), t.inkPos.begin(), t.inkPos.end());
        inkVal.insert(inkVal.end(), t.inkVal.begin(), t.inkVal.end());
        if (t.inkVal[0] > maxAnchor) maxAnchor = t.inkVal[0];
    }
    darkThresh_ = (uint8_t)std::min(255, maxAnchor + 1);  // +tol added at match time

    CUDA_CHECK(cudaMalloc(&dMeta_, meta.size() * sizeof(TplMeta)));
    CUDA_CHECK(cudaMemcpy(dMeta_, meta.data(), meta.size() * sizeof(TplMeta), cudaMemcpyHostToDevice));
    CUDA_CHECK(cudaMalloc(&dInkPos_, inkPos.size() * sizeof(uint16_t)));
    CUDA_CHECK(cudaMalloc(&dInkVal_, inkVal.size()));
    CUDA_CHECK(cudaMemcpy(dInkPos_, inkPos.data(), inkPos.size() * sizeof(uint16_t), cudaMemcpyHostToDevice));
    CUDA_CHECK(cudaMemcpy(dInkVal_, inkVal.data(), inkVal.size(), cudaMemcpyHostToDevice));
    CUDA_CHECK(cudaMalloc(&dHits_, (size_t)maxHits_ * sizeof(Hit)));
    CUDA_CHECK(cudaMalloc(&dCounts_, 2 * sizeof(unsigned)));
    for (auto& e : ev_) CUDA_CHECK(cudaEventCreate(&e));
}

void GpuMatcher::ensurePage(size_t n) {
    if (n <= pageCap_) return;
    if (dPage_) { cudaFree(dPage_); cudaFree(dDark_); }
    CUDA_CHECK(cudaMalloc(&dPage_, n));
    CUDA_CHECK(cudaMalloc(&dDark_, n * sizeof(uint32_t)));
    pageCap_ = n;
}

std::vector<Hit> GpuMatcher::match(const uint8_t* gray, int w, int h, int tol,
                                   bool naive, MatchStats& st) {
    size_t n = (size_t)w * h;
    ensurePage(n);

    CUDA_CHECK(cudaEventRecord(ev_[0]));
    CUDA_CHECK(cudaMemcpy(dPage_, gray, n, cudaMemcpyHostToDevice));
    CUDA_CHECK(cudaMemset(dCounts_, 0, 2 * sizeof(unsigned)));
    CUDA_CHECK(cudaEventRecord(ev_[1]));

    unsigned counts[2] = {0, 0};
    if (naive) {
        CUDA_CHECK(cudaEventRecord(ev_[2]));
        dim3 block(32, 8);
        dim3 grid((w + block.x - 1) / block.x, (h + block.y - 1) / block.y, nTpl_);
        matchAllKernel<<<grid, block>>>(dPage_, w, h, (const TplMeta*)dMeta_,
                                        dInkPos_, dInkVal_, tol,
                                        dHits_, dCounts_ + 1, maxHits_);
        CUDA_CHECK(cudaEventRecord(ev_[3]));
    } else {
        int thresh = std::min(255, (int)darkThresh_ + tol);
        darkListKernel<<<(int)((n + 255) / 256), 256>>>(dPage_, (int)n, (uint8_t)thresh,
                                                        dDark_, dCounts_);
        CUDA_CHECK(cudaEventRecord(ev_[2]));
        CUDA_CHECK(cudaMemcpy(counts, dCounts_, sizeof(unsigned), cudaMemcpyDeviceToHost));
        st.nDark = counts[0];
        if (counts[0]) {
            dim3 grid((counts[0] + 255) / 256, nTpl_);
            matchDarkKernel<<<grid, 256>>>(dPage_, w, h, dDark_, counts[0],
                                           (const TplMeta*)dMeta_,
                                           dInkPos_, dInkVal_, tol,
                                           dHits_, dCounts_ + 1, maxHits_);
        }
        CUDA_CHECK(cudaEventRecord(ev_[3]));
    }

    CUDA_CHECK(cudaMemcpy(counts, dCounts_, 2 * sizeof(unsigned), cudaMemcpyDeviceToHost));
    unsigned nHits = counts[1];
    st.overflow = nHits > maxHits_;
    if (st.overflow) nHits = maxHits_;
    st.nHits = nHits;

    std::vector<Hit> hits(nHits);
    auto t0 = std::chrono::steady_clock::now();
    if (nHits)
        CUDA_CHECK(cudaMemcpy(hits.data(), dHits_, (size_t)nHits * sizeof(Hit), cudaMemcpyDeviceToHost));
    st.msD2H = std::chrono::duration<float, std::milli>(std::chrono::steady_clock::now() - t0).count();

    CUDA_CHECK(cudaEventSynchronize(ev_[3]));
    CUDA_CHECK(cudaEventElapsedTime(&st.msH2D, ev_[0], ev_[1]));
    CUDA_CHECK(cudaEventElapsedTime(&st.msDark, ev_[1], ev_[2]));
    CUDA_CHECK(cudaEventElapsedTime(&st.msMatch, ev_[2], ev_[3]));
    return hits;
}

GpuMatcher::~GpuMatcher() {
    for (auto& e : ev_) if (e) cudaEventDestroy(e);
    cudaFree(dPage_); cudaFree(dDark_); cudaFree(dInkPos_);
    cudaFree(dInkVal_); cudaFree(dMeta_); cudaFree(dHits_); cudaFree(dCounts_);
}
