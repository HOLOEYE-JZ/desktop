param([string]$Aumid, [string]$Tag, [switch]$Clear)
# What Windows holds for this app. Prints the toast's XML, or removes it with -Clear.
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$history = [Windows.UI.Notifications.ToastNotificationManager]::History
if ($Clear) { $history.Clear($Aumid); exit 0 }
foreach ($toast in $history.GetHistory($Aumid)) {
  if ($toast.Tag -eq $Tag) { $toast.Content.GetXml() }
}
