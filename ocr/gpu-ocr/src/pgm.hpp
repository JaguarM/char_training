#pragma once
// pgm.hpp — binary PGM (P5, maxval 255) loader; the page format
// tools/export-pages.mjs writes.
#include <cstdint>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

struct Image {
    int w = 0, h = 0;
    std::vector<uint8_t> gray;   // row-major, 255 = white
};

inline Image loadPgm(const std::string& path) {
    FILE* f = fopen(path.c_str(), "rb");
    if (!f) throw std::runtime_error("cannot open " + path);
    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    std::vector<uint8_t> buf(len);
    if (fread(buf.data(), 1, len, f) != (size_t)len) { fclose(f); throw std::runtime_error("short read " + path); }
    fclose(f);

    size_t p = 0;
    auto token = [&]() -> std::string {
        while (p < buf.size()) {
            if (buf[p] == '#') { while (p < buf.size() && buf[p] != '\n') p++; }
            else if (isspace(buf[p])) p++;
            else break;
        }
        std::string t;
        while (p < buf.size() && !isspace(buf[p])) t += (char)buf[p++];
        return t;
    };
    if (token() != "P5") throw std::runtime_error(path + ": not P5");
    Image img;
    img.w = std::stoi(token());
    img.h = std::stoi(token());
    int maxval = std::stoi(token());
    if (maxval != 255) throw std::runtime_error(path + ": maxval != 255");
    p++;                                   // single whitespace after maxval
    if (buf.size() - p < (size_t)img.w * img.h) throw std::runtime_error(path + ": truncated");
    img.gray.assign(buf.begin() + p, buf.begin() + p + (size_t)img.w * img.h);
    return img;
}
