// DrawSweep.java — Java2D candidate renderer for the calibri hunt: load the
// exact TTF, draw a char at a grid of sub-pixel positions (fx = (i%64)/64,
// fy = (i/64)/4 quarter steps) into TYPE_BYTE_GRAY, write PGM for
// grid-compare.mjs (cell anchors 8+ix*24 / 8+iy*24, baseline at anchor+16).
//   javac DrawSweep.java && java DrawSweep font.ttf w 16 out.pgm FM_ON
import java.awt.*;
import java.awt.image.*;
import java.io.*;

public class DrawSweep {
  public static void main(String[] a) throws Exception {
    String fontPath = a[0];
    String ch = a[1];
    float size = Float.parseFloat(a[2]);
    String out = a[3];
    boolean fm = a.length > 4 && a[4].equals("FM_ON");

    Font base = Font.createFont(Font.TRUETYPE_FONT, new File(fontPath));
    Font font = base.deriveFont(size);

    int pitch = 24, nx = 16, ny = 16;
    int W = pitch * nx + 16, H = pitch * ny + 16;
    BufferedImage img = new BufferedImage(W, H, BufferedImage.TYPE_BYTE_GRAY);
    Graphics2D g = img.createGraphics();
    g.setColor(Color.WHITE);
    g.fillRect(0, 0, W, H);
    g.setColor(Color.BLACK);
    g.setFont(font);
    g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
    g.setRenderingHint(RenderingHints.KEY_FRACTIONALMETRICS,
        fm ? RenderingHints.VALUE_FRACTIONALMETRICS_ON : RenderingHints.VALUE_FRACTIONALMETRICS_OFF);

    for (int i = 0; i < 256; i++) {
      int ix = i % nx, iy = i / nx;
      float fx = (i % 64) / 64f;
      float fy = (i / 64) / 4f;
      float x = 8 + ix * pitch + fx;
      float y = 8 + iy * pitch + 16 + fy;   // baseline
      g.drawString(ch, x, y);
    }
    g.dispose();

    byte[] px = ((DataBufferByte) img.getRaster().getDataBuffer()).getData();
    try (FileOutputStream fo = new FileOutputStream(out)) {
      fo.write(("P5\n" + W + " " + H + "\n255\n").getBytes("ASCII"));
      fo.write(px);
    }
    System.out.println("wrote " + out);
  }
}
