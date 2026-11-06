//! Windows: what main used to ask System32's tools for, done in this process. reg.exe for the
//! registry, PowerShell for Focus Assist and for files on the clipboard, whoami and icacls for
//! a private folder, subst for the Files drive's letter, attrib for a pin. Endpoint protection
//! blocks or flags an app that starts those ("living off the land"), and each one cost a
//! process start. Main checks what it passes before it gets here; these check again.
//!
//! Errors read `registry:<code>` or `system:<code>`, with ` (0x<hresult>)` where Windows gave
//! one: missing, exists, busy, denied, invalid, too-large, unsupported, failed.

use std::ffi::c_void;
use std::mem::size_of;
use std::thread::sleep;
use std::time::Duration;

use windows::core::{w, Error as WinError, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Security::Authorization::{
    SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, NO_MULTIPLE_TRUSTEE, SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_IS_WELL_KNOWN_GROUP, TRUSTEE_TYPE, TRUSTEE_W,
};
use windows::Win32::Security::{
    CreateWellKnownSid, GetTokenInformation, TokenUser, WinLocalSystemSid, ACL, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSID, SECURITY_MAX_SID_SIZE,
    SUB_CONTAINERS_AND_OBJECTS_INHERIT, TOKEN_QUERY, TOKEN_USER,
};
use windows::Win32::Storage::FileSystem::{
    DefineDosDeviceW, GetFileAttributesW, QueryDosDeviceW, SetFileAttributesW, DDD_EXACT_MATCH_ON_REMOVE, DDD_RAW_TARGET_PATH, DDD_REMOVE_DEFINITION, DEFINE_DOS_DEVICE_FLAGS, FILE_ALL_ACCESS,
    FILE_ATTRIBUTE_ARCHIVE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_NOT_CONTENT_INDEXED, FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_PINNED,
    FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_SYSTEM, FILE_ATTRIBUTE_TEMPORARY, FILE_ATTRIBUTE_UNPINNED, FILE_FLAGS_AND_ATTRIBUTES, INVALID_FILE_ATTRIBUTES,
};
use windows::Win32::Security::Cryptography::{CertNameToStrW, CERT_NAME_STR_REVERSE_FLAG, CERT_STRING_TYPE, CERT_X500_NAME_STR, X509_ASN_ENCODING};
use windows::Win32::Security::WinTrust::{
    WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData, WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO, WTD_CACHE_ONLY_URL_RETRIEVAL,
    WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE,
};
use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Registry::*;
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::Win32::UI::Shell::SHQueryUserNotificationState;
use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, HWND_MESSAGE, WINDOW_EX_STYLE, WINDOW_STYLE};

use crate::{CodeSignature, DriveLetterMapping, QuietState, RegistryNode, RegistryValue};

// ─── Errors ──────────────────────────────────────────────────

fn word(code: WIN32_ERROR) -> &'static str {
    match code {
        ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => "missing",
        ERROR_ALREADY_EXISTS | ERROR_FILE_EXISTS => "exists",
        ERROR_ACCESS_DENIED | ERROR_PRIVILEGE_NOT_HELD => "denied",
        ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION | ERROR_BUSY => "busy",
        ERROR_INVALID_NAME | ERROR_BAD_PATHNAME | ERROR_INVALID_PARAMETER | ERROR_FILENAME_EXCED_RANGE => "invalid",
        _ => "failed",
    }
}

fn failed(area: &str, code: WIN32_ERROR) -> String {
    format!("{area}:{} (0x{:08x})", word(code), code.to_hresult().0 as u32)
}

fn from_error(area: &str, error: &WinError) -> String {
    let value = error.code().0 as u32;
    if value & 0xFFFF_0000 == 0x8007_0000 {
        return failed(area, WIN32_ERROR(value & 0xFFFF));
    }
    format!("{area}:failed (0x{value:08x})")
}

/// Long paths need the `\\?\` form for the calls that don't take them otherwise.
fn wide_path(path: &str) -> HSTRING {
    if path.len() >= 240 && !path.starts_with(r"\\") && path.as_bytes().get(1) == Some(&b':') {
        HSTRING::from(format!(r"\\?\{path}"))
    } else {
        HSTRING::from(path)
    }
}

// ─── Registry ────────────────────────────────────────────────

/// More keys than any read here needs: a policy tree has a few dozen.
const MAX_NODES: usize = 10_000;
const MAX_VALUES: usize = 10_000;
const MAX_VALUE_BYTES: u32 = 16 * 1024 * 1024;

struct Key(HKEY);

impl Drop for Key {
    fn drop(&mut self) {
        let _ = unsafe { RegCloseKey(self.0) };
    }
}

/// `HKCU\...` or `HKLM\...` (or their long names): the hive, whether it's HKCU, and the rest.
fn split_key(key: &str) -> Result<(HKEY, bool, &str), String> {
    let (hive, rest) = key.split_once('\\').unwrap_or((key, ""));
    match hive.to_ascii_uppercase().as_str() {
        "HKCU" | "HKEY_CURRENT_USER" => Ok((HKEY_CURRENT_USER, true, rest)),
        "HKLM" | "HKEY_LOCAL_MACHINE" => Ok((HKEY_LOCAL_MACHINE, false, rest)),
        _ => Err("registry:invalid (hive)".to_string()),
    }
}

/// Writes and deletes: only HKCU\Software\<something>, never a hive or Software itself.
fn writable_key(key: &str) -> Result<&str, String> {
    let (_, current_user, rest) = split_key(key)?;
    let mut parts = rest.split('\\');
    let software = parts.next().is_some_and(|part| part.eq_ignore_ascii_case("Software"));
    if !current_user || !software || parts.next().is_none() {
        return Err("registry:invalid (only under HKCU\\Software)".to_string());
    }
    Ok(rest)
}

fn open(parent: HKEY, subkey: &str) -> Result<Option<Key>, WIN32_ERROR> {
    let mut opened = HKEY::default();
    let status = unsafe { RegOpenKeyExW(parent, &HSTRING::from(subkey), None, KEY_READ, &mut opened) };
    match status {
        ERROR_SUCCESS => Ok(Some(Key(opened))),
        ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => Ok(None),
        other => Err(other),
    }
}

/// The text in a string value's bytes: up to the first NUL, as reg.exe shows it.
fn utf16_units(data: &[u8]) -> Vec<u16> {
    data.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect()
}

fn text_of(data: &[u8]) -> String {
    let units = utf16_units(data);
    let end = units.iter().position(|unit| *unit == 0).unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end])
}

/// A REG_MULTI_SZ's strings, without the empty one its double NUL ends with.
fn list_of(data: &[u8]) -> Vec<String> {
    let units = utf16_units(data);
    let mut items: Vec<String> = units.split(|unit| *unit == 0).map(String::from_utf16_lossy).collect();
    while items.last().is_some_and(String::is_empty) {
        items.pop();
    }
    items
}

pub fn value_of(name: String, kind: REG_VALUE_TYPE, data: &[u8]) -> RegistryValue {
    let mut value = RegistryValue { name, kind: String::new(), text: None, list: None, number: None };
    match kind {
        REG_SZ => {
            value.kind = "sz".into();
            value.text = Some(text_of(data));
        }
        REG_EXPAND_SZ => {
            // Not expanded: what's stored, as reg.exe shows it.
            value.kind = "expand_sz".into();
            value.text = Some(text_of(data));
        }
        REG_MULTI_SZ => {
            value.kind = "multi_sz".into();
            value.list = Some(list_of(data));
        }
        REG_DWORD if data.len() == 4 => {
            value.kind = "dword".into();
            value.number = Some(u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as f64);
        }
        REG_QWORD if data.len() == 8 => {
            // Text: a JS number can't hold every 64-bit value exactly.
            let mut bytes = [0u8; 8];
            bytes.copy_from_slice(data);
            value.kind = "qword".into();
            value.text = Some(u64::from_le_bytes(bytes).to_string());
        }
        REG_BINARY => value.kind = "binary".into(),
        REG_NONE => value.kind = "none".into(),
        _ => value.kind = "other".into(),
    }
    value
}

struct KeyInfo {
    subkeys: u32,
    values: u32,
    max_name: u32,
    max_data: u32,
}

fn info(key: &Key) -> Result<KeyInfo, WIN32_ERROR> {
    let (mut subkeys, mut values, mut max_name, mut max_data) = (0u32, 0u32, 0u32, 0u32);
    let status = unsafe { RegQueryInfoKeyW(key.0, None, None, None, Some(&mut subkeys), None, None, Some(&mut values), Some(&mut max_name), Some(&mut max_data), None, None) };
    if status != ERROR_SUCCESS {
        return Err(status);
    }
    Ok(KeyInfo { subkeys, values, max_name, max_data })
}

fn values_of(key: &Key) -> Result<Vec<RegistryValue>, String> {
    let mut found = Vec::new();
    let mut index = 0u32;
    let mut retries = 0;
    loop {
        let facts = info(key).map_err(|code| failed("registry", code))?;
        if facts.values as usize > MAX_VALUES || facts.max_data > MAX_VALUE_BYTES {
            return Err("registry:too-large".to_string());
        }
        let mut name = vec![0u16; facts.max_name as usize + 1];
        let mut data = vec![0u8; facts.max_data as usize + 2];
        let mut name_length = name.len() as u32;
        let mut data_length = data.len() as u32;
        let mut kind = 0u32;
        let status = unsafe { RegEnumValueW(key.0, index, Some(PWSTR(name.as_mut_ptr())), &mut name_length, None, Some(&mut kind), Some(data.as_mut_ptr()), Some(&mut data_length)) };
        match status {
            ERROR_NO_MORE_ITEMS => return Ok(found),
            // Changed since the sizes were read: read them again.
            ERROR_MORE_DATA if retries < 8 => {
                retries += 1;
                continue;
            }
            ERROR_SUCCESS => {
                let name = String::from_utf16_lossy(&name[..name_length as usize]);
                found.push(value_of(name, REG_VALUE_TYPE(kind), &data[..data_length as usize]));
                index += 1;
                retries = 0;
            }
            other => return Err(failed("registry", other)),
        }
    }
}

fn subkeys_of(key: &Key) -> Result<Vec<String>, String> {
    let facts = info(key).map_err(|code| failed("registry", code))?;
    if facts.subkeys as usize > MAX_NODES {
        return Err("registry:too-large".to_string());
    }
    let mut found = Vec::new();
    for index in 0.. {
        // A key's name is at most 255 characters.
        let mut name = [0u16; 256];
        let mut length = name.len() as u32;
        let status = unsafe { RegEnumKeyExW(key.0, index, Some(PWSTR(name.as_mut_ptr())), &mut length, None, None, None, None) };
        match status {
            ERROR_NO_MORE_ITEMS => break,
            ERROR_SUCCESS => found.push(String::from_utf16_lossy(&name[..length as usize])),
            other => return Err(failed("registry", other)),
        }
    }
    Ok(found)
}

fn walk(key: &Key, path: &str, depth: u32, nodes: &mut Vec<RegistryNode>) -> Result<(), String> {
    if nodes.len() >= MAX_NODES {
        return Err("registry:too-large".to_string());
    }
    let values = values_of(key)?;
    let subkeys = subkeys_of(key)?;
    nodes.push(RegistryNode { path: path.to_string(), values, subkeys: subkeys.clone() });
    if depth == 0 {
        return Ok(());
    }
    for name in subkeys {
        // Gone since it was listed: as if it was never there.
        let Some(child) = open(key.0, &name).map_err(|code| failed("registry", code))? else { continue };
        let child_path = if path.is_empty() { name } else { format!(r"{path}\{name}") };
        walk(&child, &child_path, depth - 1, nodes)?;
    }
    Ok(())
}

/// The key and up to `depth` levels below it, or None if it isn't there.
pub fn registry_read(key: &str, depth: u32) -> Result<Option<Vec<RegistryNode>>, String> {
    let (hive, _, subkey) = split_key(key)?;
    let Some(root) = open(hive, subkey).map_err(|code| failed("registry", code))? else { return Ok(None) };
    let mut nodes = Vec::new();
    walk(&root, "", depth, &mut nodes)?;
    Ok(Some(nodes))
}

/// A REG_SZ under HKCU\Software, making the key if it isn't there. None: the key's default value.
pub fn registry_set_string(key: &str, name: Option<&str>, data: &str) -> Result<(), String> {
    let subkey = writable_key(key)?;
    let mut created = HKEY::default();
    let status = unsafe { RegCreateKeyExW(HKEY_CURRENT_USER, &HSTRING::from(subkey), None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, None, &mut created, None) };
    if status != ERROR_SUCCESS {
        return Err(failed("registry", status));
    }
    let created = Key(created);
    let bytes: Vec<u8> = data.encode_utf16().chain(std::iter::once(0)).flat_map(u16::to_le_bytes).collect();
    let name = name.map(HSTRING::from);
    let status = match &name {
        Some(name) => unsafe { RegSetValueExW(created.0, name, None, REG_SZ, Some(&bytes)) },
        None => unsafe { RegSetValueExW(created.0, PCWSTR::null(), None, REG_SZ, Some(&bytes)) },
    };
    if status != ERROR_SUCCESS {
        return Err(failed("registry", status));
    }
    Ok(())
}

/// The key with everything in it. False: it wasn't there.
pub fn registry_delete_key(key: &str) -> Result<bool, String> {
    let subkey = writable_key(key)?;
    match unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, &HSTRING::from(subkey)) } {
        ERROR_SUCCESS => Ok(true),
        ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => Ok(false),
        other => Err(failed("registry", other)),
    }
}

/// One value. False: it, or its key, wasn't there.
pub fn registry_delete_value(key: &str, name: &str) -> Result<bool, String> {
    let subkey = writable_key(key)?;
    match unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, &HSTRING::from(subkey), &HSTRING::from(name)) } {
        ERROR_SUCCESS => Ok(true),
        ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => Ok(false),
        other => Err(failed("registry", other)),
    }
}

// ─── Focus Assist ────────────────────────────────────────────

/// Do Not Disturb's profile, as Windows publishes it in WNF. Not documented: read the way the
/// shell reads it, and 0 (off) whenever Windows doesn't answer.
const WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED: u64 = 0x0D83_063E_A3BF_1C75;

type NtQueryWnfStateData = unsafe extern "system" fn(*const u64, *const c_void, *const c_void, *mut u32, *mut c_void, *mut u32) -> i32;

fn quiet_profile() -> i32 {
    unsafe {
        // ntdll is in every process: no load, and nothing from outside System32.
        let Ok(ntdll) = GetModuleHandleW(w!("ntdll.dll")) else { return 0 };
        let Some(query) = GetProcAddress(ntdll, windows::core::s!("NtQueryWnfStateData")) else { return 0 };
        let query: NtQueryWnfStateData = std::mem::transmute(query);
        let name = WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED;
        let mut stamp = 0u32;
        let mut buffer = [0u8; 4];
        let mut size = buffer.len() as u32;
        let status = query(&name, std::ptr::null(), std::ptr::null(), &mut stamp, buffer.as_mut_ptr() as *mut c_void, &mut size);
        if status < 0 || size != 4 {
            return 0;
        }
        i32::from_le_bytes(buffer)
    }
}

pub fn quiet_state() -> QuietState {
    let notification_state = unsafe { SHQueryUserNotificationState() }.map(|state| state.0).unwrap_or(0);
    QuietState { profile: quiet_profile(), notification_state }
}

// ─── Files on the clipboard ──────────────────────────────────

const CF_HDROP: u32 = 15;
const DROPEFFECT_COPY: u32 = 1;
/// The clipboard is one for the whole session: another program may have it open for a moment.
const OPEN_ATTEMPTS: u32 = 10;
const OPEN_PAUSE: Duration = Duration::from_millis(30);

/// A DROPFILES block (shlobj.h): the header, then each path in UTF-16 with its NUL, then one more.
pub fn drop_files(paths: &[String]) -> Vec<u8> {
    let mut block = Vec::new();
    // pFiles: where the list starts, right after the 20 bytes of header.
    block.extend_from_slice(&20u32.to_le_bytes());
    // pt.x, pt.y, fNC.
    block.extend_from_slice(&[0u8; 12]);
    // fWide.
    block.extend_from_slice(&1u32.to_le_bytes());
    for path in paths {
        block.extend(path.encode_utf16().chain(std::iter::once(0)).flat_map(u16::to_le_bytes));
    }
    block.extend_from_slice(&[0, 0]);
    block
}

/// Hands one format to the clipboard, which owns the memory from then on.
fn put(format: u32, bytes: &[u8]) -> Result<(), WinError> {
    unsafe {
        let memory = GlobalAlloc(GMEM_MOVEABLE, bytes.len())?;
        let target = GlobalLock(memory);
        if target.is_null() {
            let _ = GlobalFree(Some(memory));
            return Err(WinError::from_thread());
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), target as *mut u8, bytes.len());
        let _ = GlobalUnlock(memory);
        if let Err(error) = SetClipboardData(format, Some(HANDLE(memory.0))) {
            let _ = GlobalFree(Some(memory));
            return Err(error);
        }
        Ok(())
    }
}

/// What Explorer pastes: the files themselves (CF_HDROP), as a copy, not a move.
pub fn clipboard_write_files(paths: &[String]) -> Result<(), String> {
    let block = drop_files(paths);
    // A window of our own to own the clipboard, on this thread, gone again when done: with no
    // owner, SetClipboardData may refuse. A message-only window: never shown.
    let owner = unsafe { CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), PCWSTR::null(), WINDOW_STYLE(0), 0, 0, 0, 0, Some(HWND_MESSAGE), None, None, None) }.map_err(|error| from_error("clipboard", &error))?;
    let mut opened = false;
    for attempt in 0..OPEN_ATTEMPTS {
        if unsafe { OpenClipboard(Some(owner)) }.is_ok() {
            opened = true;
            break;
        }
        if attempt + 1 < OPEN_ATTEMPTS {
            sleep(OPEN_PAUSE);
        }
    }
    if !opened {
        let _ = unsafe { DestroyWindow(owner) };
        return Err("clipboard:busy".to_string());
    }
    let written = (|| -> Result<(), WinError> {
        unsafe { EmptyClipboard() }?;
        put(CF_HDROP, &block)?;
        let effect = unsafe { RegisterClipboardFormatW(w!("Preferred DropEffect")) };
        if effect != 0 {
            put(effect, &DROPEFFECT_COPY.to_le_bytes())?;
        }
        Ok(())
    })();
    let _ = unsafe { CloseClipboard() };
    // What's on the clipboard stays when its owner goes: none of it waits to be rendered.
    let _ = unsafe { DestroyWindow(owner) };
    written.map_err(|error| from_error("clipboard", &error))
}

// ─── A folder only this user can open ────────────────────────

struct Token(HANDLE);

impl Drop for Token {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

fn explicit(sid: PSID, kind: TRUSTEE_TYPE) -> EXPLICIT_ACCESS_W {
    EXPLICIT_ACCESS_W {
        grfAccessPermissions: FILE_ALL_ACCESS.0,
        grfAccessMode: SET_ACCESS,
        grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        Trustee: TRUSTEE_W { pMultipleTrustee: std::ptr::null_mut(), MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE, TrusteeForm: TRUSTEE_IS_SID, TrusteeType: kind, ptstrName: PWSTR(sid.0 as *mut u16) },
    }
}

/// Full control for this user and SYSTEM, for the folder and all in it ((OI)(CI)F), and
/// nothing inherited from above: what `icacls /inheritance:r /grant:r` did.
pub fn folder_make_private(path: &str) -> Result<(), String> {
    let fail = |error: WinError| from_error("system", &error);
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(fail)?;
        let token = Token(token);
        let mut length = 0u32;
        let _ = GetTokenInformation(token.0, TokenUser, None, 0, &mut length);
        // u64s, so the TOKEN_USER read out of it is aligned.
        let mut user = vec![0u64; (length as usize).div_ceil(8).max(1)];
        GetTokenInformation(token.0, TokenUser, Some(user.as_mut_ptr() as *mut c_void), (user.len() * 8) as u32, &mut length).map_err(fail)?;
        let user_sid = (*(user.as_ptr() as *const TOKEN_USER)).User.Sid;

        let mut system = [0u64; (SECURITY_MAX_SID_SIZE as usize).div_ceil(8)];
        let mut system_size = (system.len() * 8) as u32;
        let system_sid = PSID(system.as_mut_ptr() as *mut c_void);
        CreateWellKnownSid(WinLocalSystemSid, None, Some(system_sid), &mut system_size).map_err(fail)?;

        let entries = [explicit(user_sid, TRUSTEE_IS_USER), explicit(system_sid, TRUSTEE_IS_WELL_KNOWN_GROUP)];
        let mut acl: *mut ACL = std::ptr::null_mut();
        let status = SetEntriesInAclW(Some(&entries), None, &mut acl);
        if status != ERROR_SUCCESS {
            return Err(failed("system", status));
        }
        let status = SetNamedSecurityInfoW(&wide_path(path), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, None, None, Some(acl), None);
        let _ = LocalFree(Some(HLOCAL(acl as *mut c_void)));
        if status != ERROR_SUCCESS {
            return Err(failed("system", status));
        }
        Ok(())
    }
}

// ─── Drive letters (what subst does) ─────────────────────────

/// What a letter is defined as in this sign-in session: its first target, or None.
fn dos_device(letter: char) -> Option<String> {
    let mut buffer = vec![0u16; 32_768];
    let length = unsafe { QueryDosDeviceW(&HSTRING::from(format!("{letter}:")), Some(&mut buffer)) } as usize;
    if length == 0 {
        return None;
    }
    let end = buffer[..length].iter().position(|unit| *unit == 0).unwrap_or(length);
    Some(String::from_utf16_lossy(&buffer[..end]))
}

/// A mapping to a folder, as subst makes one: `\??\C:\folder`. A disk is `\Device\...`.
fn mapped_folder(device: &str) -> Option<String> {
    let rest = device.strip_prefix(r"\??\")?;
    Some(match rest.strip_prefix(r"UNC\") {
        Some(share) => format!(r"\\{share}"),
        None => rest.to_string(),
    })
}

/// Every letter mapped to a folder, as `subst` lists them.
pub fn drive_letters() -> Vec<DriveLetterMapping> {
    ('A'..='Z').filter_map(|letter| dos_device(letter).and_then(|device| mapped_folder(&device)).map(|target| DriveLetterMapping { letter: letter.to_string(), target })).collect()
}

/// `subst X: <folder>`: refused for a letter that's defined already, or a folder that isn't there.
pub fn drive_letter_add(letter: char, target: &str) -> Result<(), String> {
    if dos_device(letter).is_some() {
        return Err("system:exists".to_string());
    }
    let attributes = unsafe { GetFileAttributesW(&wide_path(target)) };
    if attributes == INVALID_FILE_ATTRIBUTES || attributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0 {
        return Err("system:missing".to_string());
    }
    // Broadcasts the new drive to Explorer, as subst does: no DDD_NO_BROADCAST_SYSTEM.
    unsafe { DefineDosDeviceW(DEFINE_DOS_DEVICE_FLAGS(0), &HSTRING::from(format!("{letter}:")), &HSTRING::from(target)) }.map_err(|error| from_error("system", &error))
}

/// `subst X: /D`: only a mapping to a folder, and only that exact one.
pub fn drive_letter_remove(letter: char) -> Result<(), String> {
    let Some(device) = dos_device(letter) else { return Err("system:missing".to_string()) };
    if mapped_folder(&device).is_none() {
        return Err("system:invalid (not a mapped folder)".to_string());
    }
    let flags = DDD_REMOVE_DEFINITION | DDD_RAW_TARGET_PATH | DDD_EXACT_MATCH_ON_REMOVE;
    unsafe { DefineDosDeviceW(flags, &HSTRING::from(format!("{letter}:")), &HSTRING::from(device)) }.map_err(|error| from_error("system", &error))
}

// ─── "Always keep on this device" ────────────────────────────

/// What SetFileAttributesW takes back. The rest (directory, reparse point, recall) are Windows'.
const SETTABLE: u32 = FILE_ATTRIBUTE_READONLY.0
    | FILE_ATTRIBUTE_HIDDEN.0
    | FILE_ATTRIBUTE_SYSTEM.0
    | FILE_ATTRIBUTE_ARCHIVE.0
    | FILE_ATTRIBUTE_TEMPORARY.0
    | FILE_ATTRIBUTE_OFFLINE.0
    | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED.0
    | FILE_ATTRIBUTE_PINNED.0
    | FILE_ATTRIBUTE_UNPINNED.0;

/// The attributes after a pin change, as `attrib -U +P`, `-P +U` and `-P -U` leave them.
pub fn pinned_attributes(current: u32, pin: &str) -> u32 {
    let both = FILE_ATTRIBUTE_PINNED.0 | FILE_ATTRIBUTE_UNPINNED.0;
    let kept = current & SETTABLE & !both;
    let next = match pin {
        "pinned" => kept | FILE_ATTRIBUTE_PINNED.0,
        "unpinned" => kept | FILE_ATTRIBUTE_UNPINNED.0,
        _ => kept,
    };
    if next == 0 {
        FILE_ATTRIBUTE_NORMAL.0
    } else {
        next
    }
}

/// Sets the pin attributes the shell sets for "Always keep on this device" and "Free up space".
pub fn set_pin(path: &str, pin: &str) -> Result<(), String> {
    let name = wide_path(path);
    let current = unsafe { GetFileAttributesW(&name) };
    if current == INVALID_FILE_ATTRIBUTES {
        return Err(from_error("system", &WinError::from_thread()));
    }
    unsafe { SetFileAttributesW(&name, FILE_FLAGS_AND_ATTRIBUTES(pinned_attributes(current, pin))) }.map_err(|error| from_error("system", &error))
}

// ─── An installer's signature ────────────────────────────────

const TRUST_E_NOSIGNATURE: u32 = 0x800B_0100;
const TRUST_E_SUBJECT_FORM_UNKNOWN: u32 = 0x800B_0003;
const TRUST_E_PROVIDER_UNKNOWN: u32 = 0x800B_0001;

/// What Get-AuthenticodeSignature told electron-updater: `valid` (its Status 0), `unsigned`,
/// or `invalid` for anything else, with Windows' code.
pub fn signature_status(code: u32) -> &'static str {
    match code {
        0 => "valid",
        TRUST_E_NOSIGNATURE | TRUST_E_SUBJECT_FORM_UNKNOWN | TRUST_E_PROVIDER_UNKNOWN => "unsigned",
        _ => "invalid",
    }
}

/// The signer's subject as .NET's X509Certificate.Subject gives it: X.500 names, most specific
/// first (`CN=..., O=..., C=...`), which electron-updater's publisherName check reads.
unsafe fn signer_subject(state: HANDLE) -> Option<String> {
    let provider = WTHelperProvDataFromStateData(state);
    if provider.is_null() {
        return None;
    }
    let signer = WTHelperGetProvSignerFromChain(provider, 0, false, 0);
    if signer.is_null() || (*signer).csCertChain == 0 || (*signer).pasCertChain.is_null() {
        return None;
    }
    let certificate = (*(*signer).pasCertChain).pCert;
    if certificate.is_null() || (*certificate).pCertInfo.is_null() {
        return None;
    }
    let name = &(*(*certificate).pCertInfo).Subject;
    let flags = CERT_STRING_TYPE(CERT_X500_NAME_STR.0 | CERT_NAME_STR_REVERSE_FLAG);
    let length = CertNameToStrW(X509_ASN_ENCODING, name, flags, None) as usize;
    if length <= 1 {
        return None;
    }
    let mut text = vec![0u16; length];
    let written = CertNameToStrW(X509_ASN_ENCODING, name, flags, Some(&mut text)) as usize;
    Some(String::from_utf16_lossy(&text[..written.saturating_sub(1)]))
}

/// A file's embedded Authenticode signature, through WinVerifyTrust: what electron-updater
/// asked PowerShell's Get-AuthenticodeSignature for. No revocation check over the network, as
/// there. The signer's subject even when the signature isn't valid, where Windows has one.
pub fn code_signature(path: &str) -> CodeSignature {
    let name = wide_path(path);
    let mut file = WINTRUST_FILE_INFO { cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32, pcwszFilePath: PCWSTR(name.as_ptr()), ..Default::default() };
    let mut data = WINTRUST_DATA {
        cbStruct: size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 { pFile: &mut file },
        dwStateAction: WTD_STATEACTION_VERIFY,
        dwProvFlags: WTD_CACHE_ONLY_URL_RETRIEVAL,
        ..Default::default()
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    unsafe {
        let code = WinVerifyTrust(INVALID_HANDLE_VALUE_HWND, &mut action, &mut data as *mut WINTRUST_DATA as *mut c_void) as u32;
        let subject = if data.hWVTStateData.is_invalid() { None } else { signer_subject(data.hWVTStateData) };
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        WinVerifyTrust(INVALID_HANDLE_VALUE_HWND, &mut action, &mut data as *mut WINTRUST_DATA as *mut c_void);
        CodeSignature { status: signature_status(code).to_string(), code: format!("0x{code:08x}"), subject }
    }
}

/// WinVerifyTrust's "no window": INVALID_HANDLE_VALUE as an HWND.
const INVALID_HANDLE_VALUE_HWND: HWND = HWND(-1isize as *mut c_void);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_drop_files_block_is_the_header_then_wide_paths() {
        let block = drop_files(&[r"C:\a".to_string(), "C:\\ü".to_string()]);
        assert_eq!(&block[..4], &20u32.to_le_bytes());
        assert_eq!(&block[16..20], &1u32.to_le_bytes());
        let units = utf16_units(&block[20..]);
        let expected: Vec<u16> = "C:\\a\0C:\\ü\0\0".encode_utf16().collect();
        assert_eq!(units, expected);
    }

    #[test]
    fn values_read_as_reg_exe_showed_them() {
        let text: Vec<u8> = "https://müller.de\0".encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(value_of("a".into(), REG_SZ, &text).text.as_deref(), Some("https://müller.de"));
        let cut: Vec<u8> = "one\0two\0".encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(value_of("a".into(), REG_EXPAND_SZ, &cut).text.as_deref(), Some("one"));
        assert_eq!(value_of("a".into(), REG_MULTI_SZ, &cut).list, Some(vec!["one".to_string(), "two".to_string()]));
        assert_eq!(value_of("a".into(), REG_DWORD, &0xFFFF_FFFFu32.to_le_bytes()).number, Some(4_294_967_295.0));
        assert_eq!(value_of("a".into(), REG_DWORD, &[1, 0]).kind, "other");
        assert_eq!(value_of("a".into(), REG_QWORD, &u64::MAX.to_le_bytes()).text.as_deref(), Some("18446744073709551615"));
        assert_eq!(value_of("a".into(), REG_BINARY, &[1]).kind, "binary");
    }

    #[test]
    fn pins_change_only_the_pin_bits() {
        let readonly = FILE_ATTRIBUTE_READONLY.0;
        assert_eq!(pinned_attributes(readonly | FILE_ATTRIBUTE_UNPINNED.0, "pinned"), readonly | FILE_ATTRIBUTE_PINNED.0);
        assert_eq!(pinned_attributes(FILE_ATTRIBUTE_PINNED.0, "unpinned"), FILE_ATTRIBUTE_UNPINNED.0);
        assert_eq!(pinned_attributes(FILE_ATTRIBUTE_PINNED.0 | FILE_ATTRIBUTE_DIRECTORY.0, "unspecified"), FILE_ATTRIBUTE_NORMAL.0);
    }

    #[test]
    fn only_folders_mapped_as_subst_maps_them_count() {
        assert_eq!(mapped_folder(r"\??\C:\Users\x\Files").as_deref(), Some(r"C:\Users\x\Files"));
        assert_eq!(mapped_folder(r"\??\UNC\server\share").as_deref(), Some(r"\\server\share"));
        assert_eq!(mapped_folder(r"\Device\HarddiskVolume3"), None);
    }

    #[test]
    fn writes_stay_under_hkcu_software() {
        assert!(writable_key(r"HKCU\Software\Bulwark").is_ok());
        assert!(writable_key(r"HKCU\Software").is_err());
        assert!(writable_key(r"HKLM\Software\Bulwark").is_err());
        assert!(writable_key(r"HKCU\Environment\x").is_err());
        assert!(split_key(r"HKCR\x").is_err());
    }
}
