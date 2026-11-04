"""Reads every keyboard layout Windows ships from its DLL and says which keys type something
with Ctrl+Alt (AltGr) and Ctrl+Alt+Shift, for test/fixtures/keyboard-layouts.json. Loads the
DLLs only to call KbdLayerDescriptor; it installs nothing and changes no input setting.

    python test/support/keyboard-layouts.py test/fixtures/keyboard-layouts.json
"""
import ctypes
import json
import os
import sys
import winreg
from ctypes import wintypes

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.LoadLibraryW.restype = wintypes.HMODULE
k32.LoadLibraryW.argtypes = [wintypes.LPCWSTR]
k32.GetProcAddress.restype = ctypes.c_void_p
k32.GetProcAddress.argtypes = [wintypes.HMODULE, wintypes.LPCSTR]
k32.FreeLibrary.argtypes = [wintypes.HMODULE]

NONE, DEAD, LGTR = 0xF000, 0xF001, 0xF002
SHIFT, CTRL, ALT = 1, 2, 4
INVALID = 0x0F
VK_PACKET_MARK = 0xFF


def u8(a):
    return ctypes.c_ubyte.from_address(a).value


def u16(a):
    return ctypes.c_ushort.from_address(a).value


def ptr(a):
    return ctypes.c_void_p.from_address(a).value or 0


def layouts():
    out = {}
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Keyboard Layouts") as root:
        for index in range(winreg.QueryInfoKey(root)[0]):
            klid = winreg.EnumKey(root, index)
            with winreg.OpenKey(root, klid) as key:
                try:
                    dll = winreg.QueryValueEx(key, "Layout File")[0]
                    text = winreg.QueryValueEx(key, "Layout Text")[0]
                except OSError:
                    continue
                out[klid.lower()] = (dll, text)
    return out


def read_table(dll):
    module = k32.LoadLibraryW(dll)
    if not module:
        return None
    try:
        address = k32.GetProcAddress(module, b"KbdLayerDescriptor")
        if not address:
            return None
        tables = ctypes.CFUNCTYPE(ctypes.c_void_p)(address)()
        modifiers = ptr(tables)
        table_list = ptr(tables + 8)
        max_mod = u16(modifiers + 8)
        columns = [u8(modifiers + 10 + i) for i in range(max_mod + 1)]
        col = lambda bits: columns[bits] if bits <= max_mod and columns[bits] != INVALID else None
        wanted = {"ctrl_alt": col(CTRL | ALT), "ctrl_alt_shift": col(CTRL | ALT | SHIFT)}
        result = {name: {} for name in wanted}
        at = table_list
        while True:
            chars = ptr(at)
            if not chars:
                break
            n = u8(at + 8)
            size = u8(at + 9)
            row = chars
            while True:
                vk = u8(row)
                if vk == 0:
                    break
                if vk != VK_PACKET_MARK:
                    name = chr(vk) if 0x30 <= vk <= 0x39 or 0x41 <= vk <= 0x5A else f"vk{vk:02x}"
                    if name:
                        for mod, column in wanted.items():
                            if column is None or column >= n:
                                continue
                            ch = u16(row + 2 + 2 * column)
                            if ch == NONE:
                                continue
                            if ch == DEAD:
                                result[mod][name] = "dead"
                            elif ch == LGTR:
                                result[mod][name] = "ligature"
                            elif ch >= 0x20:
                                result[mod][name] = chr(ch)
                row += size
            at += 16
        return result
    finally:
        k32.FreeLibrary(module)


def keys(mapping):
    """Letters and digits as one string, then any other virtual key by its code."""
    plain = "".join(sorted(k for k in mapping if len(k) == 1))
    return plain + "".join(f" {k}" for k in sorted(mapping) if len(k) > 1)


def main():
    system = os.path.join(os.environ["WINDIR"], "System32")
    out = {}
    for klid, (dll, text) in sorted(layouts().items()):
        path = os.path.join(system, dll)
        table = read_table(path) if os.path.exists(path) else None
        if table is None:
            sys.exit(f"{dll} could not be read")
        out[klid] = {"name": text, "file": dll.lower(), "ctrlAlt": keys(table["ctrl_alt"]), "ctrlAltShift": keys(table["ctrl_alt_shift"])}
    with open(sys.argv[1], "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, ensure_ascii=False, indent=0)
        f.write("\n")
    print(f"{len(out)} layouts")


main()
