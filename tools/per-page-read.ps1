# per-page-read.ps1 — timeout-guarded per-page blind-read of one PDF.
# Usage: pwsh tools/per-page-read.ps1 -Pdf NEW/cand-batch/EFTA00316714.pdf -Pages 347 `
#          -Glyphs 'nimbusrom1024+...' -Tol 2 -OutDir NEW/cand-batch_ocr/EFTA00316714-pages
# Resumable: pages with an existing .log are skipped. Pages that exceed
# -TimeoutSec get killed and a .TIMEOUT marker (the grinder-page guard that
# plain blind-read --all lacks; batch-read has it built in, this is the
# standalone equivalent).
param(
  [Parameter(Mandatory)] [string]$Pdf,
  [Parameter(Mandatory)] [int]$Pages,
  [Parameter(Mandatory)] [string]$Glyphs,
  [int]$Tol = 2,
  [int]$TimeoutSec = 45,
  [Parameter(Mandatory)] [string]$OutDir
)
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
New-Item -ItemType Directory -Force $OutDir | Out-Null
for ($p = 1; $p -le $Pages; $p++) {
  $tag = '{0:d4}' -f $p
  $log = Join-Path $OutDir "page-$tag.log"
  if ((Test-Path $log) -or (Test-Path "$log.TIMEOUT")) { continue }
  $args = @('tools/blind-read.mjs', '--pdf', $Pdf, '--page', $p,
    '--palette', '--tol', $Tol, '--glyphs', $Glyphs,
    '--out', (Join-Path $OutDir "page-$tag.txt"))
  $proc = Start-Process node -ArgumentList $args -NoNewWindow -PassThru `
    -RedirectStandardOutput $log -RedirectStandardError (Join-Path $OutDir "page-$tag.err")
  if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
    $proc.Kill()
    $proc.WaitForExit()   # release the redirect handles before renaming
    for ($try = 0; $try -lt 10; $try++) {
      try { Move-Item $log "$log.TIMEOUT" -Force -ErrorAction Stop; break }
      catch { Start-Sleep -Milliseconds 300 }
    }
    Write-Output "p${p}: TIMEOUT (skipped)"
  }
}
# aggregate
$lines = 0; $glyphs = 0; $boxes = 0; $skipped = @()
foreach ($f in Get-ChildItem $OutDir -Filter 'page-*.log') {
  $m = Select-String -Path $f.FullName -Pattern '(\d+) lines, (\d+) glyphs, (\d+) unreadable' | Select-Object -Last 1
  if ($m) {
    $lines += [int]$m.Matches[0].Groups[1].Value
    $glyphs += [int]$m.Matches[0].Groups[2].Value
    $boxes += [int]$m.Matches[0].Groups[3].Value
  }
}
$skipped = (Get-ChildItem $OutDir -Filter '*.TIMEOUT').Count
Write-Output "TOTAL: $lines lines, $glyphs glyphs, $boxes unreadable clusters, $skipped pages timed out"
