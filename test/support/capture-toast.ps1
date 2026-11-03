param([string]$Out)
# The corner of the primary screen where Windows shows a toast. Only that corner: this
# runs on someone's desktop.
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$width = 460
$height = 260
$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($area.Right - $width, $area.Bottom - $height, 0, 0, $bitmap.Size)
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
