# render-wpf.ps1 — CANDIDATE RENDERER: WPF/milcore (the XPS raster path).
# GlyphRun -> DrawingVisual -> RenderTargetBitmap at 96dpi, grayscale text
# AA, Ideal/Display formatting modes. Grid sweep like render-gdip2
# (cell anchors 8+ix*24 / 8+iy*24, baseline at anchor+16, fx=(i%64)/64,
# fy=(i/64)/4). Compare with grid-compare.mjs.
#
#   powershell -File tools/attic/render-wpf.ps1 -FontFile fonts/cand/calibri-jondot.ttf `
#     -Gid 449 -Em 16 -Mode Ideal -Out wpf-w.pgm
param(
  [string]$FontFile = "fonts/cand/calibri-jondot.ttf",
  [int]$Gid = 449,
  [double]$Em = 16.0,
  [ValidateSet("Ideal","Display")] [string]$Mode = "Ideal",
  [string]$Out = "wpf-sweep.pgm"
)
Add-Type -AssemblyName PresentationCore, PresentationFramework, WindowsBase

$uri = New-Object System.Uri ((Resolve-Path $FontFile).Path)
$gtf = New-Object System.Windows.Media.GlyphTypeface $uri
Write-Host "loaded: $($gtf.FamilyNames.Values -join ',') ver $($gtf.VersionStrings.Values -join ',')"

$pitch = 24; $nx = 16; $ny = 16
$W = $pitch * $nx + 16; $H = $pitch * $ny + 16

$dv = New-Object System.Windows.Media.DrawingVisual
[System.Windows.Media.TextOptions]::SetTextRenderingMode($dv, [System.Windows.Media.TextRenderingMode]::Grayscale)
[System.Windows.Media.TextOptions]::SetTextFormattingMode($dv, [System.Windows.Media.TextFormattingMode]::$Mode)
$dc = $dv.RenderOpen()
$dc.DrawRectangle([System.Windows.Media.Brushes]::White, $null, (New-Object System.Windows.Rect 0, 0, $W, $H))

$gidList = New-Object 'System.Collections.Generic.List[uint16]'
$gidList.Add([uint16]$Gid)
$advList = New-Object 'System.Collections.Generic.List[double]'
$advList.Add([double]0)

for ($i = 0; $i -lt 256; $i++) {
  $ix = $i % $nx; $iy = [Math]::Floor($i / $nx)
  $fx = ($i % 64) / 64.0
  $fy = [Math]::Floor($i / 64) / 4.0
  $x = 8 + $ix * $pitch + $fx
  $y = 8 + $iy * $pitch + 16 + $fy
  $origin = New-Object System.Windows.Point $x, $y
  $run = [System.Windows.Media.GlyphRun]::new($gtf, 0, $false, $Em, [float]1.0, $gidList, $origin, $advList, $null, $null, $null, $null, $null, $null)
  $dc.DrawGlyphRun([System.Windows.Media.Brushes]::Black, $run)
}
$dc.Close()

$rtb = New-Object System.Windows.Media.Imaging.RenderTargetBitmap $W, $H, 96, 96, ([System.Windows.Media.PixelFormats]::Pbgra32)
$rtb.Render($dv)
$stride = $W * 4
$bytes = New-Object byte[] ($stride * $H)
$rtb.CopyPixels($bytes, $stride, 0)
$gray = New-Object byte[] ($W * $H)
for ($i = 0; $i -lt $W * $H; $i++) { $gray[$i] = $bytes[$i * 4 + 1] }  # G channel
$hdr = [Text.Encoding]::ASCII.GetBytes("P5`n$W $H`n255`n")
$outb = New-Object byte[] ($hdr.Length + $gray.Length)
[Array]::Copy($hdr, $outb, $hdr.Length)
[Array]::Copy($gray, 0, $outb, $hdr.Length, $gray.Length)
[IO.File]::WriteAllBytes($Out, $outb)
Write-Host "wrote $Out (mode $Mode)"
