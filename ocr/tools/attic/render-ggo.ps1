# render-ggo.ps1 — CANDIDATE RENDERER: Windows GDI GetGlyphOutline
# GGO_GRAY8_BITMAP (hinted TrueType rasterization, 65 coverage levels).
# This is the prime suspect for a Windows-era proprietary viewer: run
# tools/levels.mjs first — if target bytes sit on the 65-level lattice,
# this renderer family is almost certainly it.
#
# GGO has NO subpixel positioning: one raster per (char, ppem). The script
# writes that raster for every phase slot of the char — if only p0 targets
# come out EXACT, the producer adds subpixel phases some other way (e.g.
# whole-pixel pen + its own AA), which is itself a finding.
#
#   powershell -File tools/render-ggo.ps1 -Ppem 15
#   powershell -File tools/render-ggo.ps1 -Ppem 15 -FontName "Times New Roman" -OutName ggo15
#   node tools/check.mjs candidates/ggo15
param(
  [int]$Ppem = 12,
  [string]$FontName = "Courier New",
  [string]$OutName = ""
)
if (-not $OutName) { $OutName = "ggo$Ppem" }
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root "candidates\$OutName"
New-Item -ItemType Directory -Force $outDir | Out-Null

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GGO {
  [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CreateFontW(
    int h, int w, int esc, int orient, int weight, uint italic, uint underline, uint strikeout,
    uint charset, uint outPrec, uint clipPrec, uint quality, uint pitch, string face);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
  [StructLayout(LayoutKind.Sequential)] public struct MAT2 { public int m11, m12, m21, m22; }
  [StructLayout(LayoutKind.Sequential)] public struct GLYPHMETRICS {
    public uint gmBlackBoxX, gmBlackBoxY;
    public int gmptGlyphOriginX, gmptGlyphOriginY;
    public short gmCellIncX, gmCellIncY;
  }
  [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] public static extern uint GetGlyphOutlineW(
    IntPtr hdc, uint ch, uint format, out GLYPHMETRICS gm, uint bufSize, byte[] buf, ref MAT2 mat);
}
'@

$GGO_GRAY8 = 6   # GGO_GRAY8_BITMAP
$hdc = [GGO]::CreateCompatibleDC([IntPtr]::Zero)
# lfHeight < 0 => character height (em) = |lfHeight| px
$font = [GGO]::CreateFontW(-$Ppem, 0, 0, 0, 400, 0, 0, 0, 0, 0, 0, 4, 0, $FontName)
$old = [GGO]::SelectObject($hdc, $font)

$index = Get-Content (Join-Path $root "targets\index.json") -Raw | ConvertFrom-Json
$mat = New-Object GGO+MAT2
$mat.m11 = 0x10000; $mat.m22 = 0x10000   # identity (16.16 fixed)
$done = @{}
$n = 0
foreach ($t in $index.targets) {
  if (-not $done.ContainsKey([int]$t.cp)) {
    $gm = New-Object GGO+GLYPHMETRICS
    $size = [GGO]::GetGlyphOutlineW($hdc, [uint32]$t.cp, $GGO_GRAY8, [ref]$gm, 0, $null, [ref]$mat)
    if ($size -eq 0xFFFFFFFF -or $size -eq 0) { $done[[int]$t.cp] = $null; continue }
    $buf = New-Object byte[] $size
    [GGO]::GetGlyphOutlineW($hdc, [uint32]$t.cp, $GGO_GRAY8, [ref]$gm, $size, $buf, [ref]$mat) | Out-Null
    $w = [int]$gm.gmBlackBoxX; $h = [int]$gm.gmBlackBoxY
    $stride = [int](([int]($w + 3)) -band (-bnot 3))   # rows padded to DWORD
    $gray = New-Object byte[] ($w * $h)
    for ($r = 0; $r -lt $h; $r++) { for ($c = 0; $c -lt $w; $c++) {
      $lvl = $buf[$r * $stride + $c]                    # 0..64 coverage
      $gray[$r * $w + $c] = [byte](255 - [int][Math]::Round($lvl * 255.0 / 64.0))
    }}
    $done[[int]$t.cp] = @{ w = $w; h = $h; gray = $gray }
  }
  $g = $done[[int]$t.cp]
  if ($null -eq $g) { continue }
  $hdr = [Text.Encoding]::ASCII.GetBytes("P5`n$($g.w) $($g.h)`n255`n")
  $out = New-Object byte[] ($hdr.Length + $g.gray.Length)
  [Array]::Copy($hdr, $out, $hdr.Length)
  [Array]::Copy($g.gray, 0, $out, $hdr.Length, $g.gray.Length)
  [IO.File]::WriteAllBytes((Join-Path $outDir "$($t.id).pgm"), $out)
  $n++
}
[GGO]::SelectObject($hdc, $old) | Out-Null
[GGO]::DeleteObject($font) | Out-Null
[GGO]::DeleteDC($hdc) | Out-Null
Write-Host "wrote $n candidates -> candidates/$OutName   (ppem $Ppem, '$FontName')"
Write-Host "score them:  node tools/check.mjs candidates/$OutName"
