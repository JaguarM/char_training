# dump-ggo-outline.ps1 — dump the GDI bytecode-HINTED glyph outlines
# (GGO_NATIVE, 16.16 fixed, y-up, baseline origin) for every char in
# targets/index.json, as base64 blobs in one JSON. The outline is where
# Windows hinting lives; rasterization/AA can then be re-done in JS with
# subpixel phases (which GGO itself cannot do).
#
#   powershell -File tools/dump-ggo-outline.ps1 -Ppem 15
#   powershell -File tools/dump-ggo-outline.ps1 -Ppem 15 -FontFile fonts\TimesNewRomanXP.ttf -OutName xp15
param(
  [int]$Ppem = 15,
  [string]$FontName = "Times New Roman",
  [string]$FontFile = "",       # optional TTF loaded FR_PRIVATE for this process
  [int]$Weight = 400,
  [string]$OutName = ""
)
if (-not $OutName) { $OutName = "ggo$Ppem" }
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root "outlines"
New-Item -ItemType Directory -Force $outDir | Out-Null

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GGO2 {
  [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CreateFontW(
    int h, int w, int esc, int orient, int weight, uint italic, uint underline, uint strikeout,
    uint charset, uint outPrec, uint clipPrec, uint quality, uint pitch, string face);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
  [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] public static extern int AddFontResourceExW(
    string name, uint fl, IntPtr res);
  [StructLayout(LayoutKind.Sequential)] public struct MAT2 { public int m11, m12, m21, m22; }
  [StructLayout(LayoutKind.Sequential)] public struct GLYPHMETRICS {
    public uint gmBlackBoxX, gmBlackBoxY;
    public int gmptGlyphOriginX, gmptGlyphOriginY;
    public short gmCellIncX, gmCellIncY;
  }
  [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] public static extern uint GetGlyphOutlineW(
    IntPtr hdc, uint ch, uint format, out GLYPHMETRICS gm, uint bufSize, byte[] buf, ref MAT2 mat);
  [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] public static extern int GetTextFaceW(
    IntPtr hdc, int count, System.Text.StringBuilder face);
}
'@

if ($FontFile) {
  $ff = Join-Path $root $FontFile
  if (-not (Test-Path $ff)) { $ff = $FontFile }
  $added = [GGO2]::AddFontResourceExW((Resolve-Path $ff), 0x10, [IntPtr]::Zero)  # FR_PRIVATE
  Write-Host "AddFontResourceEx('$ff') -> $added fonts"
}

$GGO_NATIVE = 2
$hdc = [GGO2]::CreateCompatibleDC([IntPtr]::Zero)
$font = [GGO2]::CreateFontW(-$Ppem, 0, 0, 0, $Weight, 0, 0, 0, 0, 0, 0, 4, 0, $FontName)
$old = [GGO2]::SelectObject($hdc, $font)
$sb = New-Object System.Text.StringBuilder 64
[GGO2]::GetTextFaceW($hdc, 64, $sb) | Out-Null
Write-Host "selected face: $($sb.ToString())  ppem $Ppem weight $Weight"

$index = Get-Content (Join-Path $root "targets\index.json") -Raw | ConvertFrom-Json
$mat = New-Object GGO2+MAT2
$mat.m11 = 0x10000; $mat.m22 = 0x10000
$seen = @{}
$glyphs = @()
foreach ($t in $index.targets) {
  $cp = [int]$t.cp
  if ($seen.ContainsKey($cp)) { continue }
  $seen[$cp] = $true
  $gm = New-Object GGO2+GLYPHMETRICS
  $size = [GGO2]::GetGlyphOutlineW($hdc, [uint32]$cp, $GGO_NATIVE, [ref]$gm, 0, $null, [ref]$mat)
  if ($size -eq 0xFFFFFFFF) { Write-Host "cp $cp GGO_NATIVE failed"; continue }
  $buf = New-Object byte[] ([Math]::Max(1, $size))
  if ($size -gt 0) {
    [GGO2]::GetGlyphOutlineW($hdc, [uint32]$cp, $GGO_NATIVE, [ref]$gm, $size, $buf, [ref]$mat) | Out-Null
  }
  $glyphs += [pscustomobject]@{
    cp = $cp; ch = [string][char]$cp
    originX = $gm.gmptGlyphOriginX; originY = $gm.gmptGlyphOriginY
    blackW = $gm.gmBlackBoxX; blackH = $gm.gmBlackBoxY
    cellIncX = [int]$gm.gmCellIncX
    native = if ($size -gt 0) { [Convert]::ToBase64String($buf) } else { "" }
  }
}
[GGO2]::SelectObject($hdc, $old) | Out-Null
[GGO2]::DeleteObject($font) | Out-Null
[GGO2]::DeleteDC($hdc) | Out-Null

$doc = [pscustomobject]@{
  ppem = $Ppem; font = $FontName; fontFile = $FontFile; weight = $Weight
  face = $sb.ToString(); glyphs = $glyphs
}
$path = Join-Path $outDir "$OutName.json"
$doc | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $path
Write-Host "wrote $($glyphs.Count) glyph outlines -> outlines/$OutName.json"
