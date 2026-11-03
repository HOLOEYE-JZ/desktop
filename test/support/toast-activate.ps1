param([string]$Clsid, [string]$Aumid, [string]$Arguments, [string]$Reply = '')
# Does what the Windows shell does when someone presses a toast button: creates the app's
# toast activator through COM and calls INotificationActivationCallback::Activate.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct NOTIFICATION_USER_INPUT_DATA { [MarshalAs(UnmanagedType.LPWStr)] public string Key; [MarshalAs(UnmanagedType.LPWStr)] public string Value; }
[ComImport, Guid("53E31837-6600-4A81-9395-75CFFE746F94"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface INotificationActivationCallback {
  void Activate([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string invokedArgs,
    [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 3)] NOTIFICATION_USER_INPUT_DATA[] data, uint count);
}
public static class Toast {
  public static void Fire(string clsid, string aumid, string args, string reply) {
    var type = Type.GetTypeFromCLSID(new Guid(clsid));
    var instance = Activator.CreateInstance(type);
    var callback = (INotificationActivationCallback)instance;
    var data = string.IsNullOrEmpty(reply) ? new NOTIFICATION_USER_INPUT_DATA[0] : new[] { new NOTIFICATION_USER_INPUT_DATA { Key = "reply", Value = reply } };
    callback.Activate(aumid, args, data, (uint)data.Length);
    Marshal.ReleaseComObject(instance);
  }
}
'@
try { [Toast]::Fire($Clsid, $Aumid, $Arguments, $Reply); 'activated' } catch { "failed: $($_.Exception.Message)"; exit 1 }
