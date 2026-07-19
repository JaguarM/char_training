# render-gdip2.ps1 — GDI+ candidate for the calibri hunt: PrivateFontCollection
# (load the exact TTF file, not the installed family), AntiAlias hint
# (unhinted), grid sweep of sub-pixel positions, selectable TextContrast
# (GDI+ text gamma). One PGM grid out; compare with grid-compare.mjs.
#
#   powershell -File tools/attic/render-gdip2.ps1 -FontFile fonts/cand/calibri-jondot.ttf `
#     -Ch w -SizePx 16 -Contrast 4 -Out dwsweep.pgm
param(
  [string]$FontFile = "fonts/cand/calibri-jondot.ttf",
  [string]$Ch = "w",
  [double]$SizePx = 16.0,
  [int]$Contrast = 4,
  [string]$Hint = "AntiAlias",
  [string]$Out = "gdip-sweep.pgm"
)
Add-Type -AssemblyName System.Drawing
$pitch = 24; $nx = 16; $ny = 16      # 256 cells: i = ix + iy*16, phase x = i%64 /64, y = floor(i/64)/4
$W = $pitch * $nx + 16; $H = $pitch * $ny + 16

$pfc = New-Object System.Drawing.Text.PrivateFontCollection
$pfc.AddFontFile((Resolve-Path $FontFile).Path)
$fam = $pfc.Families[0]
Write-Host "family: $($fam.Name)"
$font = New-Object System.Drawing.Font($fam, $SizePx, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

$bmp = New-Object System.Drawing.Bitmap($W, $H)
$bmp.SetResolution(96, 96)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::$Hint
$g.TextContrast = $Contrast
$sf = [System.Drawing.StringFormat]::GenericTypographic

for ($i = 0; $i -lt 256; $i++) {
  $ix = $i % $nx; $iy = [Math]::Floor($i / $nx)
  $fx = ($i % 64) / 64.0
  $fy = [Math]::Floor($i / 64) / 4.0
  $x = 8 + $ix * $pitch + $fx
  $y = 8 + $iy * $pitch + $fy
  $g.DrawString($Ch, $font, [System.Drawing.Brushes]::Black, $x, $y, $sf)
}
$g.Dispose()

$rect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
$bd = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = New-Object byte[] ($W * $H * 4)
[System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0, $bytes, 0, $bytes.Length)
$bmp.UnlockBits($bd); $bmp.Dispose()
$gray = New-Object byte[] ($W * $H)
for ($i = 0; $i -lt $W * $H; $i++) { $gray[$i] = $bytes[$i * 4 + 2] }
$hdr = [Text.Encoding]::ASCII.GetBytes("P5`n$W $H`n255`n")
$outb = New-Object byte[] ($hdr.Length + $gray.Length)
[Array]::Copy($hdr, $outb, $hdr.Length)
[Array]::Copy($gray, 0, $outb, $hdr.Length, $gray.Length)
[IO.File]::WriteAllBytes($Out, $outb)
Write-Host "wrote $Out (pitch $pitch grid ${nx}x${ny}, contrast $Contrast, hint $Hint)"
