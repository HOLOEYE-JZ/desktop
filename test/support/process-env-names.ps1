# The names in another process's environment block, read from its PEB. Never a value.
param([int]$TargetPid)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ProcessEnvNames {
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, IntPtr[] info, int len, out int ret);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint a, bool i, int p);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr b, byte[] o, IntPtr s, out IntPtr r);
  static long Pointer(IntPtr h, long at) {
    var bytes = new byte[8]; IntPtr read;
    if (!ReadProcessMemory(h, new IntPtr(at), bytes, new IntPtr(8), out read)) throw new Exception("read " + Marshal.GetLastWin32Error());
    return BitConverter.ToInt64(bytes, 0);
  }
  public static string[] Of(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) throw new Exception("open " + Marshal.GetLastWin32Error());
    var info = new IntPtr[6]; int ret;
    int status = NtQueryInformationProcess(h, 0, info, 48, out ret);
    if (status != 0) throw new Exception("query " + status);
    long parameters = Pointer(h, info[1].ToInt64() + 0x20);
    long block = Pointer(h, parameters + 0x80);
    long size = Pointer(h, parameters + 0x3F0);
    var bytes = new byte[size]; IntPtr read;
    if (!ReadProcessMemory(h, new IntPtr(block), bytes, new IntPtr(size), out read)) throw new Exception("block " + Marshal.GetLastWin32Error());
    var names = new List<string>();
    foreach (var entry in Encoding.Unicode.GetString(bytes).Split('\0')) {
      if (entry.Length == 0) continue;
      int equals = entry.IndexOf('=', 1);
      if (equals > 0) names.Add(entry.Substring(0, equals));
    }
    return names.ToArray();
  }
}
'@
[ProcessEnvNames]::Of($TargetPid)
