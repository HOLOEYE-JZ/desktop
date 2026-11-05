# Records what the BulwarkSplash window shows while an installer runs: every change of its
# percent and step (the window's BulwarkSplashPercent and BulwarkSplashStep properties, each
# stored plus one), as "<ms> <percent> <from> <to>" lines in -Out. Watches the windows of
# processes whose name starts with -Name, until -Stop exists or -Seconds pass. Prints "ready"
# once it watches. test/installer-look.spec.ts.
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Stop,
  [int]$Seconds = 300
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SplashWatch {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetPropW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] string name);
  public static List<string> Read(HashSet<uint> pids) {
    var found = new List<string>();
    EnumWindows((h, l) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid)) return true;
      long percent = (long)GetPropW(h, "BulwarkSplashPercent");
      long step = (long)GetPropW(h, "BulwarkSplashStep");
      if (percent > 0) found.Add((percent - 1) + " " + (step > 0 ? ((step - 1) & 0xff) + " " + (((step - 1) >> 8) & 0xff) : "- -"));
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$clock = [Diagnostics.Stopwatch]::StartNew()
$last = ''
$lines = New-Object System.Collections.Generic.List[string]
'ready'
while (-not (Test-Path $Stop) -and $clock.Elapsed.TotalSeconds -lt $Seconds) {
  $pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
  foreach ($p in [Diagnostics.Process]::GetProcesses()) {
    if ($p.ProcessName.StartsWith($Name, [StringComparison]::OrdinalIgnoreCase)) { [void]$pids.Add([uint32]$p.Id) }
  }
  if ($pids.Count -gt 0) {
    foreach ($seen in [SplashWatch]::Read($pids)) {
      if ($seen -ne $last) { $lines.Add("$($clock.ElapsedMilliseconds) $seen"); $last = $seen }
    }
  }
  Start-Sleep -Milliseconds 15
}
$lines | Set-Content -Encoding ASCII $Out
