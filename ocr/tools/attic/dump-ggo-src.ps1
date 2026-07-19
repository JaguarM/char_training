# dump-ggo-src.ps1 — dump RAW GDI GetGlyphOutline rasters (per char, one
# file per codepoint) as source material for a resample stage. Unlike
# render-ggo.ps1 (which writes per-target candidates), this writes
# srcglyphs/<name>/<cp>.pgm plus a metrics line per glyph — the inputs a
# stretch/rerender pipeline would have consumed.
#
#   powershell -File tools/dump-ggo-src.ps1 -Ppem 10 -Format GRAY8
#   powershell -File tools/dump-ggo-src.ps1 -Ppem 10 -Format GRAY4 -OutName ggo10g4
param(
  [int]$Ppem = 10,
  [string]$FontName = "Courier New",
  [ValidateSet("GRAY8","GRAY4")] [string]$Format = "GRAY8",
  [int]$Weight = 400,
  [string]$OutName = ""
)
if (-not $OutName) { $OutName = "ggo$Ppem" + $(if ($Format -eq "GRAY4") { "g4" } else { "" }) }
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root "srcglyphs\$OutName"
New-Item -ItemType Directory -Force $outDir | Out-Null

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GGOS {
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

$fmt = if ($Format -eq "GRAY4") { 5 } else { 6 }   # GGO_GRAY4_BITMAP=5, GGO_GRAY8_BITMAP=6
$maxLvl = if ($Format -eq "GRAY4") { 16.0 } else { 64.0 }
$hdc = [GGOS]::CreateCompatibleDC([IntPtr]::Zero)
$font = [GGOS]::CreateFontW(-$Ppem, 0, 0, 0, $Weight, 0, 0, 0, 0, 0, 0, 4, 0, $FontName)
$old = [GGOS]::SelectObject($hdc, $font)

$index = Get-Content (Join-Path $root "targets\index.json") -Raw | ConvertFrom-Json
$mat = New-Object GGOS+MAT2
$mat.m11 = 0x10000; $mat.m22 = 0x10000
$seen = @{}
$meta = @()
$n = 0
foreach ($t in $index.targets) {
  $cp = [int]$t.cp
  if ($seen.ContainsKey($cp)) { continue }
  $seen[$cp] = $true
  $gm = New-Object GGOS+GLYPHMETRICS
  $size = [GGOS]::GetGlyphOutlineW($hdc, [uint32]$cp, $fmt, [ref]$gm, 0, $null, [ref]$mat)
  if ($size -eq 0xFFFFFFFF -or $size -eq 0) { continue }
  $buf = New-Object byte[] $size
  [GGOS]::GetGlyphOutlineW($hdc, [uint32]$cp, $fmt, [ref]$gm, $size, $buf, [ref]$mat) | Out-Null
  $w = [int]$gm.gmBlackBoxX; $h = [int]$gm.gmBlackBoxY
  $stride = [int](([int]($w + 3)) -band (-bnot 3))
  $gray = New-Object byte[] ($w * $h)
  for ($r = 0; $r -lt $h; $r++) { for ($c = 0; $c -lt $w; $c++) {
    $lvl = $buf[$r * $stride + $c]
    $gray[$r * $w + $c] = [byte](255 - [int][Math]::Round($lvl * 255.0 / $maxLvl))
  }}
  $hdr = [Text.Encoding]::ASCII.GetBytes("P5`n$w $h`n255`n")
  $out = New-Object byte[] ($hdr.Length + $gray.Length)
  [Array]::Copy($hdr, $out, $hdr.Length)
  [Array]::Copy($gray, 0, $out, $hdr.Length, $gray.Length)
  [IO.File]::WriteAllBytes((Join-Path $outDir "$cp.pgm"), $out)
  $meta += [pscustomobject]@{ cp = $cp; originX = $gm.gmptGlyphOriginX; originY = $gm.gmptGlyphOriginY; cellIncX = [int]$gm.gmCellIncX; w = $w; h = $h }
  $n++
}
[GGOS]::SelectObject($hdc, $old) | Out-Null
[GGOS]::DeleteObject($font) | Out-Null
[GGOS]::DeleteDC($hdc) | Out-Null
$meta | ConvertTo-Json | Set-Content (Join-Path $outDir "meta.json")
Write-Host "wrote $n source glyphs -> srcglyphs/$OutName (ppem $Ppem, $Format, '$FontName')"
