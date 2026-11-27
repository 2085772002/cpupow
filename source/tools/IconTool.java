import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import java.io.File;
import java.io.FileOutputStream;

/* 说明：有界图标提取在界面渲染进程外执行；每批复用一个系统上下文，仅完整图片通过原子替换发布，探针不会读到半成品。 */
public class IconTool {
    private static final int EDGE = 96;
    private static boolean validPackage(String p) {
        return p != null && p.length() < 256 && p.matches("[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)+");
    }
    private static boolean cached(File out) {
        if (!out.isFile() || out.length() <= 0 || out.length() > 262144) return false;
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(out.getPath(), o);
        return o.outWidth > 0 && o.outWidth <= EDGE && o.outHeight > 0 && o.outHeight <= EDGE;
    }
    private static void extract(PackageManager pm, String pkg, File out) throws Exception {
        if (!validPackage(pkg)) throw new IllegalArgumentException("invalid package");
        File parent = out.getAbsoluteFile().getParentFile();
        if (parent == null || (!parent.isDirectory() && !parent.mkdirs()))
            throw new IllegalStateException("icon directory unavailable");
        if (cached(out)) { System.out.println("OK " + pkg + " " + out.length()); return; }
        ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
        Drawable d = ai.loadIcon(pm);
        int w = Math.max(1, d.getIntrinsicWidth()), h = Math.max(1, d.getIntrinsicHeight());
        /* 说明：位图尺寸使用固定上限，防止资源报告异常巨大尺寸。 */
        double scale = Math.min(1.0, (double) EDGE / Math.max(w, h));
        w = Math.max(1, (int)(w * scale)); h = Math.max(1, (int)(h * scale));
        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        File tmp = null;
        try {
            Canvas canvas = new Canvas(bmp);
            d.setBounds(0, 0, w, h); d.draw(canvas);
            tmp = File.createTempFile("cpupow-icon-", ".part", parent);
            try (FileOutputStream stream = new FileOutputStream(tmp)) {
                if (!bmp.compress(Bitmap.CompressFormat.PNG, 100, stream))
                    throw new IllegalStateException("PNG encoding failed");
                stream.flush(); stream.getFD().sync();
            }
            if (!tmp.setReadable(true, false) || !tmp.renameTo(out))
                throw new IllegalStateException("atomic icon publish failed");
            System.out.println("OK " + pkg + " " + out.length());
        } finally {
            bmp.recycle();
            if (tmp != null && tmp.exists()) tmp.delete();
        }
    }
    public static void main(String[] args) {
        boolean batch = args.length >= 3 && "--batch".equals(args[0]);
        if ((!batch && args.length != 2) || (batch && args.length > 6)) {
            System.err.println("usage: IconTool <pkg> <out.png> | --batch <dir> <pkg> [up to 4]");
            System.exit(2); return;
        }
        int failures = 0;
        try {
            android.os.Looper.prepareMainLooper();
            Class<?> atCls = Class.forName("android.app.ActivityThread");
            Object at = atCls.getMethod("systemMain").invoke(null);
            Context ctx = (Context) atCls.getMethod("getSystemContext").invoke(at);
            PackageManager pm = ctx.getPackageManager();
            int start = batch ? 2 : 0, end = batch ? args.length : 1;
            for (int i = start; i < end; i++) {
                String pkg = args[i];
                try {
                    if (!validPackage(pkg)) throw new IllegalArgumentException("invalid package");
                    extract(pm, pkg, batch ? new File(args[1], pkg + ".png") : new File(args[1]));
                } catch (Throwable error) {
                    failures++;
                    System.err.println("ERR " + pkg + " " + error.getClass().getSimpleName());
                }
            }
        } catch (Throwable error) {
            System.err.println("ERR context " + error.getClass().getSimpleName()); failures++;
        }
        /* 说明：应用启动器可能保留系统绑定线程，完成后显式退出。 */
        /* 说明：即使图片全部写入成功，短任务也必须结束。 */
        System.exit(failures == 0 ? 0 : 1);
    }
}
