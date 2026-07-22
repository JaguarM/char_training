#pragma once
// tpl.hpp — TPL1 template loader (written by tools/export-templates.mjs).
//
// A template is one glyph at one subpixel phase, rendered alone on white in
// page space: the full letter image, uncropped. dx/dy place its bitmap
// relative to the integer pen x / baseline y. At load the ink pixels
// (gray < 255) are extracted and sorted darkest-first — the darkest pixel is
// the match anchor and the earliest possible early-exit.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <map>
#include <stdexcept>
#include <string>
#include <tuple>
#include <vector>

struct Tpl {
    uint32_t cp = 0;             // Unicode codepoint
    double adv = 0;              // exact dyadic advance, px
    uint16_t setId = 0;          // index of the --templates file this came
                                 // from (stamped by main; --classify tallies)
    double spaceAdv = 0;         // the OWNING SET's space advance (filled by
                                 // main after load; lines vote per-line so
                                 // mixed-pitch docs get the right gaps)
    uint8_t phx4 = 0, phy2 = 0;  // subpixel phase (x quarters, y halves)
    int16_t dx = 0, dy = 0;      // bitmap top-left relative to (penX, baseline)
    uint16_t w = 0, h = 0;
    std::vector<uint8_t> gray;   // w*h page-space bytes, 255 = no ink
    std::vector<uint16_t> inkPos; // (row<<8)|col, sorted by value darkest-first
    std::vector<uint8_t> inkVal;  // expected page byte per inkPos entry
};

struct TplSet {
    double sizePx = 0;
    double spaceAdv = 0;         // 0 if the set has no space glyph
    std::vector<Tpl> tpls;
    int dupsDropped = 0;
};

// cropW/cropH > 0: crop each bitmap to at most cropW x cropH px, centered on
// the ink centroid — an experiment in dodging the edge pixels contaminated by
// a touching neighbour's antialiasing fringe (at the cost of discrimination).
// cropYOff shifts the window vertically from the centroid position (negative
// = up, toward ascenders; positive = down, toward descenders), clamped.
inline TplSet loadTemplates(const std::string& path, int cropW = 0, int cropH = 0,
                            int cropYOff = 0) {
    FILE* f = fopen(path.c_str(), "rb");
    if (!f) throw std::runtime_error("cannot open " + path);
    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    std::vector<uint8_t> buf(len);
    if (fread(buf.data(), 1, len, f) != (size_t)len) { fclose(f); throw std::runtime_error("short read"); }
    fclose(f);

    size_t p = 0;
    auto need = [&](size_t n) { if (p + n > buf.size()) throw std::runtime_error(path + ": truncated"); };
    auto rdU32 = [&]() { need(4); uint32_t v; memcpy(&v, &buf[p], 4); p += 4; return v; };
    auto rdU16 = [&]() { need(2); uint16_t v; memcpy(&v, &buf[p], 2); p += 2; return v; };
    auto rdI16 = [&]() { need(2); int16_t v; memcpy(&v, &buf[p], 2); p += 2; return v; };
    auto rdU8  = [&]() { need(1); return buf[p++]; };
    auto rdF64 = [&]() { need(8); double v; memcpy(&v, &buf[p], 8); p += 8; return v; };

    if (rdU32() != 0x314C5054) throw std::runtime_error(path + ": bad TPL1 magic");  // 'TPL1'
    if (rdU32() != 1) throw std::runtime_error(path + ": unknown version");
    TplSet set;
    set.sizePx = rdF64();
    set.spaceAdv = rdF64();
    uint32_t n = rdU32();

    // exact duplicates (same pixels at the same placement, from a different
    // phase) would double-report every hit — keep the first only
    std::map<std::tuple<uint32_t, uint16_t, uint16_t, int16_t, int16_t, std::string>, bool> seen;

    for (uint32_t i = 0; i < n; i++) {
        Tpl t;
        t.cp = rdU32();
        t.adv = rdF64();
        t.phx4 = rdU8(); t.phy2 = rdU8();
        t.dx = rdI16(); t.dy = rdI16();
        t.w = rdU16(); t.h = rdU16();
        need((size_t)t.w * t.h);
        t.gray.assign(buf.begin() + p, buf.begin() + p + (size_t)t.w * t.h);
        p += (size_t)t.w * t.h;
        if (t.w > 255 || t.h > 255) throw std::runtime_error("bitmap exceeds u8 packing");

        if (cropW > 0 && cropH > 0) {
            int cw = std::min<int>(t.w, cropW), ch = std::min<int>(t.h, cropH);
            double sw = 0, sx = 0, sy = 0;
            for (int r = 0; r < t.h; r++)
                for (int c = 0; c < t.w; c++) {
                    double wgt = 255 - t.gray[r * t.w + c];
                    sw += wgt; sx += wgt * c; sy += wgt * r;
                }
            int x0 = 0, y0 = 0;
            if (sw > 0) {
                x0 = std::clamp((int)std::lround(sx / sw - (cw - 1) / 2.0), 0, t.w - cw);
                y0 = std::clamp((int)std::lround(sy / sw - (ch - 1) / 2.0) + cropYOff,
                                0, t.h - ch);
            }
            std::vector<uint8_t> g((size_t)cw * ch);
            for (int r = 0; r < ch; r++)
                for (int c = 0; c < cw; c++)
                    g[r * cw + c] = t.gray[(size_t)(y0 + r) * t.w + x0 + c];
            t.gray = std::move(g);
            t.dx += (int16_t)x0; t.dy += (int16_t)y0;
            t.w = (uint16_t)cw; t.h = (uint16_t)ch;
        }

        // cp is part of the key: after cropping, different letters can share a
        // bitmap (stems of i/l/I) — those must both survive, not be "dups"
        auto key = std::make_tuple(t.cp, t.w, t.h, t.dx, t.dy,
            std::string(t.gray.begin(), t.gray.end()));
        if (seen.count(key)) { set.dupsDropped++; continue; }
        seen[key] = true;

        for (int r = 0; r < t.h; r++)
            for (int c = 0; c < t.w; c++)
                if (t.gray[r * t.w + c] < 255) t.inkPos.push_back((uint16_t)((r << 8) | c));
        std::stable_sort(t.inkPos.begin(), t.inkPos.end(), [&](uint16_t a, uint16_t b) {
            return t.gray[(a >> 8) * t.w + (a & 255)] < t.gray[(b >> 8) * t.w + (b & 255)];
        });
        t.inkVal.reserve(t.inkPos.size());
        for (uint16_t q : t.inkPos) t.inkVal.push_back(t.gray[(q >> 8) * t.w + (q & 255)]);
        if (t.inkPos.empty()) continue;                  // nothing to match on
        set.tpls.push_back(std::move(t));
    }
    return set;
}

inline void utf8Append(std::string& s, uint32_t cp) {
    if (cp < 0x80) s += (char)cp;
    else if (cp < 0x800) { s += (char)(0xC0 | (cp >> 6)); s += (char)(0x80 | (cp & 63)); }
    else if (cp < 0x10000) {
        s += (char)(0xE0 | (cp >> 12));
        s += (char)(0x80 | ((cp >> 6) & 63));
        s += (char)(0x80 | (cp & 63));
    } else {
        s += (char)(0xF0 | (cp >> 18));
        s += (char)(0x80 | ((cp >> 12) & 63));
        s += (char)(0x80 | ((cp >> 6) & 63));
        s += (char)(0x80 | (cp & 63));
    }
}
