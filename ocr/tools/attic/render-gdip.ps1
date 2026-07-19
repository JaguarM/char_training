# render-gdip.ps1 — CANDIDATE RENDERER: GDI+ DrawString (System.Drawing).
# Hints: AntiAlias (unhinted-ish, soft) or AntiAliasGridFit (hinted + AA).
# GDI+ supports fractional positions, so the ¼-px phase slots are honored.
#
#   powershell -File tools/render-gdip.ps1 -SizePx 14.6667 -Hint AntiAliasGridFit
#   node tools/check.mjs candidates/gdip-AntiAliasGridFit
param(
  [double]$SizePx = 12.3613,
  [string]$FontName = "Courier New",
  [ValidateSet("AntiAlias","AntiAliasGridFit","SingleBitPerPixelGridFit")]
  [string]$Hint = "AntiAliasGridFit",
  [string]$OutName = ""
)
if (-not $OutName) { $OutName = "gdip-$Hint" }
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root "candidates\$OutName"
New-Item -ItemType Directory -Force $outDir | Out-Null

$index = Get-Content (Join-Path $root "targets\index.json") -Raw | ConvertFrom-Json
$W = 48; $H = 48
$font = New-Object System.Drawing.Font($FontName, $SizePx, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$sf = [System.Drawing.StringFormat]::GenericTypographic
$n = 0
foreach ($t in $index.targets) {
  $bmp = New-Object System.Drawing.Bitmap($W, $H)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::White)
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::$Hint
  $g.DrawString([string][char][int]$t.cp, $font, [System.Drawing.Brushes]::Black, (10 + [double]$t.phx), 10, $sf)
  $g.Dispose()
  $rect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
  $bd = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bytes = New-Object byte[] ($W * $H * 4)
  [System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0, $bytes, 0, $bytes.Length)
  $bmp.UnlockBits($bd); $bmp.Dispose()
  $gray = New-Object byte[] ($W * $H)
  for ($i = 0; $i -lt $W * $H; $i++) { $gray[$i] = $bytes[$i * 4 + 2] }
  $hdr = [Text.Encoding]::ASCII.GetBytes("P5`n$W $H`n255`n")
  $out = New-Object byte[] ($hdr.Length + $gray.Length)
  [Array]::Copy($hdr, $out, $hdr.Length)
  [Array]::Copy($gray, 0, $out, $hdr.Length, $gray.Length)
  [IO.File]::WriteAllBytes((Join-Path $outDir "$($t.id).pgm"), $out)
  $n++
}
Write-Host "wrote $n candidates -> candidates/$OutName   (size $SizePx px, hint $Hint, '$FontName')"
Write-Host "score them:  node tools/check.mjs candidates/$OutName"
