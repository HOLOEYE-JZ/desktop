param([string]$Exe, [string]$Clsid, [string]$Aumid, [string]$Activate, [string]$Action, [string]$Reply = '')
# A packaged app that isn't running, its toast pressed: registers what the app would have
# registered, fires the activator through COM as the shell does, and reports what started.
$key = "HKCU:\Software\Classes\CLSID\$Clsid\LocalServer32"
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value "`"$Exe`""
try {
  $args = "bulwark:$Action`:" + [uri]::EscapeDataString('{"emailId":"cold-1","accountId":"a1"}')
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Activate -Clsid $Clsid -Aumid $Aumid -Arguments $args -Reply $Reply
  Start-Sleep -Seconds 25
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $name = [IO.Path]::GetFileNameWithoutExtension($Exe)
  $procs = Get-CimInstance Win32_Process -Filter "Name='$name.exe'"
  $main = $procs | Where-Object { $_.CommandLine -notmatch '--type=' }
  "main command line: $($main.CommandLine)"
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $visible = 0
  foreach ($p in $procs) {
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$p.ProcessId)
    $visible += $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond).Count
  }
  "visible top-level windows: $visible"
} finally {
  Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item -Path "HKCU:\Software\Classes\CLSID\$Clsid" -Recurse -Force -ErrorAction SilentlyContinue
}
