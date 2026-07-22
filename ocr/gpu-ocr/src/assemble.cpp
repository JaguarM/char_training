// assemble.cpp — turn the hit soup into text, embracing the known problems.
//
// Geometry: a hit places a template bitmap at (x, y); the template's (dx, dy)
// recover the pen: baseline = y − dy, penX = x − dx + phx4/4. Corpus physics
// (char_training docs/MISSING_LETTER.md): layout pens advance by the exact
// dyadic advances — no kerning — so greedy left-to-right resolution stepping
// by advances is principled, not a hack.
//
// The problems, by design: overlapping candidates at one pen are settled by
// "most ink wins" (an 'm' beats the 'r' inside it); a template that happens
// to byte-match inside another letter on a DIFFERENT baseline becomes its own
// phantom line; unmatched ink is silently absent (no □ certificate here —
// that is the blind reader's job, not this project's).
#include "assemble.hpp"

#include <algorithm>
#include <cmath>
#include <map>

namespace {
struct G {
    double pen, adv, sp;
    uint32_t cp, ink;
    uint16_t set;
};
}

std::vector<Line> assemble(const std::vector<Hit>& hits,
                           const std::vector<Tpl>& tpls, double spaceAdv) {
    std::map<int, std::vector<G>> byBase;
    for (const Hit& h : hits) {
        const Tpl& t = tpls[h.t];
        int baseline = (int)h.y - t.dy;
        double pen = (double)h.x - t.dx + t.phx4 / 4.0;
        byBase[baseline].push_back({pen, t.adv, t.spaceAdv, t.cp, (uint32_t)t.inkPos.size(), t.setId});
    }

    // Adjacent-baseline merge: TNR16's two y-phase records often carry the
    // IDENTICAL bitmap with dy differing by 1, so every glyph also hits one
    // baseline over and the whole line appears twice, 1 px apart. Real lines
    // are a dozen+ px apart, so runs of baselines 1 px apart are one line;
    // the pen-cluster resolution below then collapses the duplicates. The
    // line reports the baseline the majority voted for.
    struct Grp { int label; size_t labelCount; int runEnd; std::vector<G> v; };
    std::vector<Grp> groups;
    for (auto& [baseline, v] : byBase) {
        if (!groups.empty() && baseline <= groups.back().runEnd + 1) {
            Grp& g = groups.back();
            if (v.size() > g.labelCount) { g.label = baseline; g.labelCount = v.size(); }
            g.runEnd = baseline;
            g.v.insert(g.v.end(), v.begin(), v.end());
        } else {
            groups.push_back({baseline, v.size(), baseline, std::move(v)});
        }
    }

    std::vector<Line> lines;
    for (auto& grp : groups) {
        int baseline = grp.label;
        auto& v = grp.v;
        // per-line space advance: the line's dominant set wins — a Courier
        // line in a mixed doc must not inherit Times gaps (fallback: caller's)
        double lineSpace = spaceAdv;
        {
            std::map<double, size_t> vote;
            for (const G& g : v) if (g.sp > 0) vote[g.sp]++;
            size_t best = 0;
            for (const auto& [sp, cnt] : vote)
                if (cnt > best) { best = cnt; lineSpace = sp; }
        }
        std::sort(v.begin(), v.end(), [](const G& a, const G& b) {
            if (a.pen != b.pen) return a.pen < b.pen;
            if (a.ink != b.ink) return a.ink > b.ink;
            return a.cp < b.cp;
        });

        Line line;
        line.baseline = baseline;
        double prevEnd = 0;
        size_t i = 0;
        while (i < v.size()) {
            // candidates clustered at (nearly) the same pen: most ink wins
            size_t best = i;
            for (size_t j = i; j < v.size() && v[j].pen < v[i].pen + 0.75; j++)
                if (v[j].ink > v[best].ink ||
                    (v[j].ink == v[best].ink && v[j].adv > v[best].adv))
                    best = j;
            const G& g = v[best];

            if (line.nGlyphs == 0) {
                line.x0 = g.pen;
            } else {
                double gap = g.pen - prevEnd;
                if (gap > 0.45 * lineSpace) {
                    int nsp = std::max(1, (int)std::floor(gap / lineSpace + 0.5));
                    line.text.append(nsp, ' ');
                }
            }
            utf8Append(line.text, g.cp);
            line.nGlyphs++;
            line.glyphSets.push_back(g.set);
            prevEnd = g.pen + g.adv;

            // everything starting inside the accepted glyph's advance is spent
            double cutoff = g.pen + g.adv - 0.51;
            while (i < v.size() && v[i].pen < cutoff) i++;
        }
        lines.push_back(std::move(line));
    }

    std::sort(lines.begin(), lines.end(),
              [](const Line& a, const Line& b) { return a.baseline < b.baseline; });
    return lines;
}
