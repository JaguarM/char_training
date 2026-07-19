# render-dwrite.ps1 — CANDIDATE RENDERER: DirectWrite glyph-run analysis,
# natural (unhinted-x) modes, grayscale alpha textures. DWrite quantizes
# subpixel x to 1/4 px in natural modes — matches the calibri doc's phase
# lattice. Dumps alpha textures for every phase/mode for node-side compare.
#
#   powershell -File tools/attic/render-dwrite.ps1 -Font fonts/cand/calibri-jondot.ttf `
#     -Gid 449 -Em 16 -Out dw-w.txt
param(
  [string]$Font = "fonts/cand/calibri-jondot.ttf",
  [int]$Gid = 449,
  [double]$Em = 16.0,
  [string]$Out = "dw.txt"
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

[StructLayout(LayoutKind.Sequential)]
public struct DWRECT { public int left, top, right, bottom; }

[ComImport, Guid("b859ee5a-d838-4b5b-a2e8-1adc7d93db48"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDWriteFactory {
  void _GetSystemFontCollection();
  void _CreateCustomFontCollection();
  void _RegisterFontCollectionLoader();
  void _UnregisterFontCollectionLoader();
  [PreserveSig] int CreateFontFileReference([MarshalAs(UnmanagedType.LPWStr)] string filePath, IntPtr lastWriteTime, out IntPtr fontFile);
  void _CreateCustomFontFileReference();
  [PreserveSig] int CreateFontFace(int faceType, uint numberOfFiles, [MarshalAs(UnmanagedType.LPArray)] IntPtr[] fontFiles, uint faceIndex, int simulationFlags, out IntPtr fontFace);
  void _CreateRenderingParams();
  void _CreateMonitorRenderingParams();
  void _CreateCustomRenderingParams();
  void _RegisterFontFileLoader();
  void _UnregisterFontFileLoader();
  void _CreateTextFormat();
  void _CreateTypography();
  void _GetGdiInterop();
  void _CreateTextLayout();
  void _CreateGdiCompatibleTextLayout();
  void _CreateEllipsisTrimmingSign();
  void _CreateTextAnalyzer();
  void _CreateNumberSubstitution();
  [PreserveSig] int CreateGlyphRunAnalysis(IntPtr glyphRun, float pixelsPerDip, IntPtr transform, int renderingMode, int measuringMode, float baselineOriginX, float baselineOriginY, out IntPtr analysis);
}

[ComImport, Guid("7d97dbf7-e085-42d4-81e3-6a883bded118"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDWriteGlyphRunAnalysis {
  [PreserveSig] int GetAlphaTextureBounds(int textureType, out DWRECT bounds);
  [PreserveSig] int CreateAlphaTexture(int textureType, ref DWRECT bounds, [MarshalAs(UnmanagedType.LPArray)] byte[] alphaValues, uint bufferSize);
  [PreserveSig] int GetAlphaBlendParams(IntPtr renderingParams, out float gamma, out float enhancedContrast, out float clearTypeLevel);
}

public static class DW {
  [DllImport("dwrite.dll")] public static extern int DWriteCreateFactory(int factoryType, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object factory);

  public static string Run(string fontPath, ushort gid, float em, int[] modes, int steps) {
    var iid = new Guid("b859ee5a-d838-4b5b-a2e8-1adc7d93db48");
    object fobj;
    int hr = DWriteCreateFactory(0, ref iid, out fobj);
    if (hr != 0) return "ERR factory " + hr.ToString("x");
    var fac = (IDWriteFactory)fobj;
    IntPtr fontFile;
    hr = fac.CreateFontFileReference(System.IO.Path.GetFullPath(fontPath), IntPtr.Zero, out fontFile);
    if (hr != 0) return "ERR fontfile " + hr.ToString("x");
    IntPtr face;
    hr = fac.CreateFontFace(1 /*TRUETYPE*/, 1, new IntPtr[] { fontFile }, 0, 0, out face);
    if (hr != 0) {
      hr = fac.CreateFontFace(0 /*CFF*/, 1, new IntPtr[] { fontFile }, 0, 0, out face);
      if (hr != 0) return "ERR fontface " + hr.ToString("x");
    }

    var sb = new StringBuilder();
    // unmanaged glyph run
    IntPtr run = Marshal.AllocHGlobal(48);
    IntPtr pGid = Marshal.AllocHGlobal(2);
    Marshal.WriteInt16(pGid, (short)gid);
    IntPtr pAdv = Marshal.AllocHGlobal(4);
    Marshal.Copy(new float[] { 0f }, 0, pAdv, 1);
    Marshal.WriteIntPtr(run, 0, face);
    Marshal.Copy(new float[] { em }, 0, new IntPtr(run.ToInt64() + 8), 1);
    Marshal.WriteInt32(run, 12, 1);
    Marshal.WriteIntPtr(run, 16, pGid);
    Marshal.WriteIntPtr(run, 24, pAdv);
    Marshal.WriteIntPtr(run, 32, IntPtr.Zero);
    Marshal.WriteInt32(run, 40, 0);
    Marshal.WriteInt32(run, 44, 0);

    foreach (int mode in modes) {
      for (int i = 0; i < steps; i++) {
        float ox = 20f + (float)i / steps;
        IntPtr pa;
        hr = fac.CreateGlyphRunAnalysis(run, 1.0f, IntPtr.Zero, mode, 0 /*MEASURING_NATURAL*/, ox, 20f, out pa);
        if (hr != 0) { sb.AppendLine("mode " + mode + " i " + i + " ERR analysis " + hr.ToString("x")); continue; }
        var ana = (IDWriteGlyphRunAnalysis)Marshal.GetObjectForIUnknown(pa);
        foreach (int tex in new int[] { 0, 1 }) {
          DWRECT b;
          hr = ana.GetAlphaTextureBounds(tex, out b);
          if (hr != 0) { sb.AppendLine("mode " + mode + " i " + i + " tex " + tex + " ERR bounds " + hr.ToString("x")); continue; }
          int w = b.right - b.left, h = b.bottom - b.top;
          if (w <= 0 || h <= 0) { sb.AppendLine("mode " + mode + " i " + i + " tex " + tex + " EMPTY"); continue; }
          int bpp = tex == 1 ? 3 : 1;
          var buf = new byte[w * h * bpp];
          hr = ana.CreateAlphaTexture(tex, ref b, buf, (uint)buf.Length);
          if (hr != 0) { sb.AppendLine("mode " + mode + " i " + i + " tex " + tex + " ERR tex " + hr.ToString("x")); continue; }
          sb.Append("mode " + mode + " i " + i + " tex " + tex + " rect " + b.left + " " + b.top + " " + w + " " + h + " data ");
          sb.AppendLine(Convert.ToBase64String(buf));
        }
        Marshal.ReleaseComObject(ana);
        Marshal.Release(pa);
      }
    }
    Marshal.FreeHGlobal(run); Marshal.FreeHGlobal(pGid); Marshal.FreeHGlobal(pAdv);
    return sb.ToString();
  }
}
'@

$modes = @(2, 3, 4)   # NATURAL, NATURAL_SYMMETRIC, GDI_NATURAL
$res = [DW]::Run($Font, $Gid, $Em, $modes, 64)
Set-Content -Path $Out -Value $res -Encoding ascii
Write-Host "wrote $Out ($((Get-Item $Out).Length) bytes)"
