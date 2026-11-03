param([string]$Out, [int]$W = 900, [int]$H = 700)
# The bottom right of the primary screen, with layered windows, into a PNG.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace ShotApi -Name D -MemberDefinition @'
[DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int sx, int sy, int op);
[DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr w);
[DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr w, IntPtr d);
'@
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hd = $g.GetHdc()
$sd = [ShotApi.D]::GetDC([IntPtr]::Zero)
[void][ShotApi.D]::BitBlt($hd, 0, 0, $b.Width, $b.Height, $sd, 0, 0, (0x00CC0020 -bor 0x40000000))
[void][ShotApi.D]::ReleaseDC([IntPtr]::Zero, $sd)
$g.ReleaseHdc($hd)
$crop = $bmp.Clone((New-Object System.Drawing.Rectangle ($b.Width - $W), ($b.Height - $H), $W, $H), $bmp.PixelFormat)
$crop.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
