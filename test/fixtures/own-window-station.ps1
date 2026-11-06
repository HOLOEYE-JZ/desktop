# Runs a command in a window station of its own, so it has a clipboard of its own: a test that
# writes the clipboard never touches the one of the person at this computer. (A separate desktop
# isn't enough: every desktop of a window station shares its clipboard.) Everything the command
# starts inherits the window station. Output goes to -Log. Prints the clipboard's sequence
# number in this window station before and after, which must be the same.
#
#   powershell -NoProfile -File own-window-station.ps1 -Log C:\path\run.log -Command "node check.cjs"
param(
  [Parameter(Mandatory = $true)][string]$Log,
  [Parameter(Mandatory = $true)][string]$Command,
  [int]$TimeoutSeconds = 120
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OwnStation {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateWindowStation(string name, int flags, uint access, IntPtr attrs);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessWindowStation(IntPtr station);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseWindowStation(IntPtr station);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool GetUserObjectInformation(IntPtr obj, int index, System.Text.StringBuilder info, int length, out int needed);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, int flags, uint access, IntPtr attrs);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr h, uint code);
}
'@

$GENERIC_ALL = [uint32]268435456
# Unnamed: a standard user may not name one. Windows names it after the sign-in session.
$station = [OwnStation]::CreateWindowStation($null, 0, $GENERIC_ALL, [IntPtr]::Zero)
if ($station -eq [IntPtr]::Zero) { throw "CreateWindowStation failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
$UOI_NAME = 2
$text = New-Object System.Text.StringBuilder 256
$needed = 0
if (-not [OwnStation]::GetUserObjectInformation($station, $UOI_NAME, $text, 512, [ref]$needed)) { throw "GetUserObjectInformation failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
$name = $text.ToString()
if ($name -eq 'WinSta0') { throw 'Got the interactive window station' }
$own = [OwnStation]::GetProcessWindowStation()
# A desktop is made in the process's current window station, so switch there for a moment.
if (-not [OwnStation]::SetProcessWindowStation($station)) { throw "SetProcessWindowStation failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
$desktop = [OwnStation]::CreateDesktop('Default', [IntPtr]::Zero, [IntPtr]::Zero, 0, $GENERIC_ALL, [IntPtr]::Zero)
$madeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
[void][OwnStation]::SetProcessWindowStation($own)
if ($desktop -eq [IntPtr]::Zero) { throw "CreateDesktop failed: $madeError" }

# This window station's clipboard, before and after: the test checks it stayed the same.
$before = [OwnStation]::GetClipboardSequenceNumber()
$si = New-Object OwnStation+STARTUPINFO
$si.cb = [Runtime.InteropServices.Marshal]::SizeOf($si)
$si.lpDesktop = "$name\Default"
$pi = New-Object OwnStation+PROCESS_INFORMATION
$line = "cmd.exe /d /s /c `"($Command) > `"$Log`" 2>&1`""
$CREATE_NO_WINDOW = [uint32]0x08000000
if (-not [OwnStation]::CreateProcess($env:ComSpec, $line, [IntPtr]::Zero, [IntPtr]::Zero, $false, $CREATE_NO_WINDOW, [IntPtr]::Zero, (Get-Location).Path, [ref]$si, [ref]$pi)) {
  throw "CreateProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
$WAIT_TIMEOUT = [uint32]258
if ([OwnStation]::WaitForSingleObject($pi.hProcess, [uint32]($TimeoutSeconds * 1000)) -eq $WAIT_TIMEOUT) {
  [void][OwnStation]::TerminateProcess($pi.hProcess, 124)
  [void][OwnStation]::WaitForSingleObject($pi.hProcess, 5000)
}
$code = [uint32]0
[void][OwnStation]::GetExitCodeProcess($pi.hProcess, [ref]$code)
[void][OwnStation]::CloseHandle($pi.hProcess)
[void][OwnStation]::CloseHandle($pi.hThread)
[void][OwnStation]::CloseDesktop($desktop)
[void][OwnStation]::CloseWindowStation($station)
Write-Output "clipboard sequence $before $([OwnStation]::GetClipboardSequenceNumber())"
exit [int]$code
