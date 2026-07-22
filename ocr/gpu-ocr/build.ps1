# build.ps1 — configure + build Release. Prefers cmake on PATH (falls back to
# the VS-bundled one); if the CMake/VS CUDA integration is broken, -Nvcc
# builds with one direct nvcc call instead.
param([switch]$Nvcc)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not $Nvcc) {
    $cmake = (Get-Command cmake -ErrorAction SilentlyContinue)?.Source
    if (-not $cmake) {
        $cmake = Get-ChildItem "C:\Program Files\Microsoft Visual Studio\*\*\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe" -ErrorAction SilentlyContinue |
            Select-Object -First 1 -ExpandProperty FullName
    }
    if ($cmake) {
        & $cmake -S . -B build -G "Visual Studio 17 2022" -A x64
        if ($LASTEXITCODE -eq 0) {
            & $cmake --build build --config Release
            if ($LASTEXITCODE -eq 0) {
                Copy-Item build\Release\gpu-ocr.exe build\gpu-ocr.exe -Force
                Write-Host "OK -> build\gpu-ocr.exe"
                exit 0
            }
        }
        Write-Warning "CMake build failed; retrying with direct nvcc"
    }
}

$vcvars = Get-ChildItem "C:\Program Files\Microsoft Visual Studio\*\*\VC\Auxiliary\Build\vcvars64.bat" |
    Select-Object -First 1 -ExpandProperty FullName
New-Item -ItemType Directory -Force build | Out-Null
cmd /c "`"$vcvars`" >nul 2>&1 && nvcc -O3 -std=c++20 -arch=sm_120 -Xcompiler `"/O2 /EHsc /utf-8`" src/main.cpp src/assemble.cpp src/match.cu -o build/gpu-ocr.exe"
if ($LASTEXITCODE -eq 0) { Write-Host "OK -> build\gpu-ocr.exe" } else { exit 1 }
