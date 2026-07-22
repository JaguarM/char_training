#pragma once
// assemble.hpp — raw GPU hits → text lines.
#include <string>
#include <vector>

#include "match.cuh"
#include "tpl.hpp"

struct Line {
    int baseline = 0;
    double x0 = 0;               // pen x of the first glyph
    int nGlyphs = 0;
    std::string text;            // UTF-8
};

// spaceAdv: advance of one space in px (used to size gaps into space runs).
std::vector<Line> assemble(const std::vector<Hit>& hits,
                           const std::vector<Tpl>& tpls, double spaceAdv);
