// main.cpp — CLI driver: load templates + PGM pages, GPU-match, assemble
// lines, write text.
//
//   gpu-ocr [--templates data/templates/times_16.tpl]... [--pages data/pages/big]
//           [--page N] [--limit N] [--tol 0] [--crop W H] [--out out/big]
//           [--naive] [--cpu] [--print] [--max-hits N]
#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#endif

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <string>
#include <vector>

#include "assemble.hpp"
#include "match.cuh"
#include "pgm.hpp"
#include "tpl.hpp"

namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;
static float ms(Clock::time_point a, Clock::time_point b) {
    return std::chrono::duration<float, std::milli>(b - a).count();
}

// CPU reference matcher — identical semantics to the GPU kernels (anchor
// check at the darkest ink pixel, then darkest-first early-exit walk;
// template bytes read through the page-law LUT when one exists).
static std::vector<Hit> cpuMatch(const std::vector<Tpl>& tpls, const Image& img, int tol,
                                 const uint8_t* lut) {
    std::vector<Hit> out;
    auto q = [&](uint8_t v) { return lut ? (int)lut[v] : (int)v; };
    for (size_t ti = 0; ti < tpls.size(); ti++) {
        const Tpl& t = tpls[ti];
        int r0 = t.inkPos[0] >> 8, c0 = t.inkPos[0] & 255, v0 = q(t.inkVal[0]);
        for (int y = 0; y + t.h <= img.h; y++)
            for (int x = 0; x + t.w <= img.w; x++) {
                int d0 = (int)img.gray[(size_t)(y + r0) * img.w + x + c0] - v0;
                if (d0 > tol || d0 < -tol) continue;
                bool ok = true;
                for (size_t k = 1; k < t.inkPos.size() && ok; k++) {
                    int p = t.inkPos[k];
                    int d = (int)img.gray[(size_t)(y + (p >> 8)) * img.w + (x + (p & 255))]
                          - q(t.inkVal[k]);
                    if (d > tol || d < -tol) ok = false;
                }
                if (ok) out.push_back({(uint16_t)ti, (uint16_t)x, (uint16_t)y});
            }
    }
    return out;
}

// page-law sidecar (export-pages --palette/--quant): page-NNNN.lut, raw 256
// bytes, applied to TEMPLATE bytes only. Absent file = no law (identity).
static bool loadLut(const fs::path& pgm, uint8_t lut[256]) {
    fs::path p = pgm;
    p.replace_extension(".lut");
    FILE* f = fopen(p.string().c_str(), "rb");
    if (!f) return false;
    bool ok = fread(lut, 1, 256, f) == 256;
    fclose(f);
    if (!ok) fprintf(stderr, "%s: short lut, ignored\n", p.string().c_str());
    return ok;
}

static bool sameHits(std::vector<Hit> a, std::vector<Hit> b) {
    auto key = [](const Hit& h) { return ((uint64_t)h.t << 32) | ((uint64_t)h.y << 16) | h.x; };
    auto cmp = [&](const Hit& x, const Hit& y) { return key(x) < key(y); };
    std::sort(a.begin(), a.end(), cmp);
    std::sort(b.begin(), b.end(), cmp);
    return a.size() == b.size() &&
           std::equal(a.begin(), a.end(), b.begin(),
                      [&](const Hit& x, const Hit& y) { return key(x) == key(y); });
}

int main(int argc, char** argv) {
#ifdef _WIN32
    SetConsoleOutputCP(CP_UTF8);
#endif
    std::vector<std::string> tplFiles;
    std::string pages = "data/pages/big", outDir;
    int page = 0, limit = 0, tol = 0, cropW = 0, cropH = 0, cropYOff = 0;
    bool naive = false, cpu = false, print = false, classify = false;
    unsigned maxHits = 4u << 20;

    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        auto next = [&]() -> std::string {
            if (++i >= argc) { fprintf(stderr, "%s needs a value\n", a.c_str()); exit(1); }
            return argv[i];
        };
        if (a == "--templates") tplFiles.push_back(next());
        else if (a == "--pages") pages = next();
        else if (a == "--page") page = atoi(next().c_str());
        else if (a == "--limit") limit = atoi(next().c_str());
        else if (a == "--tol") tol = atoi(next().c_str());
        else if (a == "--crop") { cropW = atoi(next().c_str()); cropH = atoi(next().c_str()); }
        else if (a == "--crop-yoff") cropYOff = atoi(next().c_str());
        else if (a == "--out") outDir = next();
        else if (a == "--max-hits") maxHits = (unsigned)atoll(next().c_str());
        else if (a == "--naive") naive = true;
        else if (a == "--cpu") cpu = true;
        else if (a == "--print") print = true;
        else if (a == "--classify") classify = true;
        else { fprintf(stderr, "unknown arg %s\n", a.c_str()); return 1; }
    }
    if (tplFiles.empty()) tplFiles.push_back("data/templates/times_16.tpl");

    // ---- templates ----
    std::vector<Tpl> tpls;
    std::vector<std::string> setNames;      // per --templates file, for --classify
    double sizePx = 0, spaceAdv = 0;
    int dups = 0;
    for (const auto& f : tplFiles) {
        std::string stem = fs::path(f).stem().string();
        uint16_t setId = (uint16_t)setNames.size();
        setNames.push_back(stem);
        TplSet s = loadTemplates(f, cropW, cropH, cropYOff);
        for (auto& t : s.tpls) t.setId = setId;
        if (sizePx == 0) { sizePx = s.sizePx; spaceAdv = s.spaceAdv; }
        else if (s.sizePx != sizePx)
            fprintf(stderr, "note: %s sizePx %.3f != %.3f (mixed-size union)\n", f.c_str(), s.sizePx, sizePx);
        if (spaceAdv == 0) spaceAdv = s.spaceAdv;
        // resolve THIS set's space advance and stamp it on its templates —
        // assemble votes per line, so a Courier line in a Times doc gets
        // Courier gaps. Fallbacks: a monospace set's uniform cell IS its
        // space; otherwise em/4 (the Times ratio).
        double sp = s.spaceAdv;
        if (sp <= 0 && !s.tpls.empty()) {
            double mn = 1e18, mx = 0;
            for (const auto& t : s.tpls) { mn = std::min(mn, t.adv); mx = std::max(mx, t.adv); }
            sp = (mx > 0 && mx - mn < 1e-9) ? mx : s.sizePx * 0.25;
        }
        for (auto& t : s.tpls) t.spaceAdv = sp;
        dups += s.dupsDropped;
        tpls.insert(tpls.end(), std::make_move_iterator(s.tpls.begin()),
                    std::make_move_iterator(s.tpls.end()));
    }
    bool spaceFallback = spaceAdv <= 0;
    if (spaceFallback) spaceAdv = sizePx * 0.25;   // Times space = 0.25 em
    size_t inkTotal = 0;
    for (const auto& t : tpls) inkTotal += t.inkPos.size();
    printf("templates: %zu (%d exact duplicates dropped), %zu ink px, sizePx %g, spaceAdv %.4f%s\n",
           tpls.size(), dups, inkTotal, sizePx, spaceAdv, spaceFallback ? " (fallback em/4)" : "");

    // ---- pages ----
    std::vector<fs::path> files;
    if (fs::is_directory(pages)) {
        for (const auto& e : fs::directory_iterator(pages))
            if (e.path().extension() == ".pgm") files.push_back(e.path());
        std::sort(files.begin(), files.end());
    } else {
        files.push_back(pages);
    }
    auto pageNo = [](const fs::path& p) {
        std::string s = p.stem().string(), d;
        for (char c : s) if (isdigit((unsigned char)c)) d += c;
        return d.empty() ? 0 : atoi(d.c_str());
    };
    if (page > 0) {
        std::erase_if(files, [&](const fs::path& p) { return pageNo(p) != page; });
        if (files.empty()) { fprintf(stderr, "page %d not found in %s\n", page, pages.c_str()); return 1; }
    }
    if (limit > 0 && (int)files.size() > limit) files.resize(limit);
    if (outDir.empty())
        outDir = (fs::path("out") / fs::path(pages).filename()).string();
    fs::create_directories(outDir);

    // ---- match ----
    GpuMatcher matcher;
    matcher.init(tpls, maxHits);

    // all.txt only on full runs — a --page debug run must not clobber it
    FILE* all = files.size() > 1
        ? fopen((fs::path(outDir) / "all.txt").string().c_str(), "wb") : nullptr;
    double totIo = 0, totH2D = 0, totDark = 0, totMatch = 0, totD2H = 0, totAsm = 0;
    long long totHits = 0, totGlyphs = 0, totLines = 0;
    auto wall0 = Clock::now();

    long long lutPages = 0;
    for (const auto& f : files) {
        auto t0 = Clock::now();
        Image img = loadPgm(f.string());
        uint8_t lutBuf[256];
        bool hasLut = loadLut(f, lutBuf);
        if (hasLut) lutPages++;
        auto t1 = Clock::now();

        MatchStats st;
        std::vector<Hit> hits = matcher.match(img.gray.data(), img.w, img.h, tol, naive, st,
                                              hasLut ? lutBuf : nullptr);
        if (st.overflow)
            fprintf(stderr, "%s: hit buffer overflow (%u), results truncated — raise --max-hits\n",
                    f.filename().string().c_str(), maxHits);

        if (cpu) {
            std::vector<Hit> ref = cpuMatch(tpls, img, tol, hasLut ? lutBuf : nullptr);
            printf("  cpu check: %zu cpu vs %zu gpu — %s\n", ref.size(), hits.size(),
                   sameHits(ref, hits) ? "IDENTICAL" : "MISMATCH");
        }

        auto t2 = Clock::now();
        std::vector<Line> lines = assemble(hits, tpls, spaceAdv);
        auto t3 = Clock::now();

        // --classify: per-SET raw hit + assembled-glyph tallies, one JSON
        // line per page on stdout. Raw hits say "these exact pixels exist";
        // assembled glyphs say "and they won their pen position". JS scores.
        if (classify) {
            std::vector<long long> hitsBySet(setNames.size(), 0), glyphsBySet(setNames.size(), 0);
            for (const Hit& h : hits) hitsBySet[tpls[h.t].setId]++;
            for (const Line& L : lines)
                for (uint16_t s : L.glyphSets) glyphsBySet[s]++;
            std::string js = "CLASSIFY {\"page\":" + std::to_string(pageNo(f)) + ",\"sets\":{";
            for (size_t s = 0; s < setNames.size(); s++) {
                if (s) js += ",";
                js += "\"" + setNames[s] + "\":[" + std::to_string(glyphsBySet[s]) + "," +
                      std::to_string(hitsBySet[s]) + "]";
            }
            js += "}}";
            printf("%s\n", js.c_str());
        }

        std::string text;
        int glyphs = 0;
        for (const auto& L : lines) { text += L.text; text += '\n'; glyphs += L.nGlyphs; }
        int pno = pageNo(f);
        char name[64];
        snprintf(name, sizeof name, "page-%04d.txt", pno);
        FILE* fo = fopen((fs::path(outDir) / name).string().c_str(), "wb");
        fwrite(text.data(), 1, text.size(), fo);
        fclose(fo);
        if (all) {
            fprintf(all, "=== page %d ===\n", pno);
            fwrite(text.data(), 1, text.size(), all);
        }
        if (print) fwrite(text.data(), 1, text.size(), stdout);

        printf("page %04d  %3zu lines %5d glyphs %6u hits  dark %6u  "
               "io %5.1f  h2d %4.2f  dark %4.2f  match %5.2f  d2h %4.2f  asm %5.1f ms\n",
               pno, lines.size(), glyphs, st.nHits, st.nDark,
               ms(t0, t1), st.msH2D, st.msDark, st.msMatch, st.msD2H, ms(t2, t3));
        totIo += ms(t0, t1); totH2D += st.msH2D; totDark += st.msDark;
        totMatch += st.msMatch; totD2H += st.msD2H; totAsm += ms(t2, t3);
        totHits += st.nHits; totGlyphs += glyphs; totLines += (long long)lines.size();
    }
    if (all) fclose(all);

    float wall = ms(wall0, Clock::now());
    if (lutPages)
        printf("(page-law LUT applied on %lld of %zu pages)\n", lutPages, files.size());
    printf("\n%zu pages: %lld lines, %lld glyphs, %lld hits — %.2f s wall (%.1f ms/page)\n",
           files.size(), totLines, totGlyphs, totHits, wall / 1000.0, wall / files.size());
    printf("  io %.0f  h2d %.0f  darklist %.0f  match %.0f  d2h %.0f  assemble %.0f ms\n",
           totIo, totH2D, totDark, totMatch, totD2H, totAsm);
    printf("  text in %s\n", outDir.c_str());
    return 0;
}
