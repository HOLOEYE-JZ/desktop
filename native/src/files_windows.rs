//! Windows: the Files drive, through the Cloud Files API. A sync root registered with
//! StorageProviderSyncRootManager (so Explorer lists it in its navigation pane), and the
//! placeholder calls of cldapi. What to place, fetch and keep is main's and the page's to
//! decide: this only does what it's told, on paths main has already checked.
//!
//! Errors read `files:<code> (0x<hresult>)`, with the codes main maps to the bridge's
//! FilesError: missing, exists, busy, denied, name, full, changed, pinned, not-placeholder,
//! outside, cancelled, unsupported, timeout, failed.

use std::ffi::c_void;
use std::mem::{offset_of, size_of};
use std::sync::Mutex;
use std::thread::sleep;
use std::time::{Duration, Instant};

use windows::core::{Error as WinError, HRESULT, HSTRING, PWSTR};
use windows::Storage::Provider::{
    StorageProviderHardlinkPolicy, StorageProviderHydrationPolicy, StorageProviderHydrationPolicyModifier, StorageProviderInSyncPolicy,
    StorageProviderPopulationPolicy, StorageProviderSyncRootInfo, StorageProviderSyncRootManager,
};
use windows::Storage::StorageFolder;
use windows::Win32::Foundation::*;
use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
use windows::Win32::Storage::CloudFilters::*;
use windows::Win32::Storage::FileSystem::*;
use windows::Win32::System::Registry::{RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ, RRF_NOEXPAND, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_UPDATEITEM, SHCNF_PATHW};
use windows_future::{AsyncStatus, IAsyncOperation};

use crate::{FilesFetchEvent, FilesPlaceholderInfo, FilesPlacement, FilesRegistration, FilesSyncRoot, FilesUpdate};

// ─── Errors ──────────────────────────────────────────────────

fn win32_code(error: &WinError) -> Option<u32> {
    let value = error.code().0 as u32;
    (value & 0xFFFF_0000 == 0x8007_0000).then_some(value & 0xFFFF)
}

fn code_of(error: &WinError) -> &'static str {
    let Some(code) = win32_code(error) else {
        return if error.code() == E_INVALIDARG { "name" } else { "failed" };
    };
    let any = |list: &[WIN32_ERROR]| list.iter().any(|known| known.0 == code);
    if any(&[ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND]) {
        "missing"
    } else if any(&[ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS]) {
        "exists"
    } else if any(&[ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION, ERROR_CLOUD_FILE_IN_USE, ERROR_OPLOCK_NOT_GRANTED, ERROR_CLOUD_FILE_PROPERTY_LOCK_CONFLICT]) {
        "busy"
    } else if any(&[ERROR_ACCESS_DENIED, ERROR_CLOUD_FILE_ACCESS_DENIED, ERROR_WRITE_PROTECT, ERROR_CLOUD_FILE_READ_ONLY_VOLUME]) {
        "denied"
    } else if any(&[ERROR_INVALID_NAME, ERROR_BAD_PATHNAME, ERROR_FILENAME_EXCED_RANGE, ERROR_DIRECTORY]) {
        "name"
    } else if any(&[ERROR_DISK_FULL, ERROR_HANDLE_DISK_FULL]) {
        "full"
    } else if any(&[ERROR_CLOUD_FILE_NOT_IN_SYNC]) {
        "changed"
    } else if any(&[ERROR_CLOUD_FILE_PINNED, ERROR_CLOUD_FILE_DEHYDRATION_DISALLOWED]) {
        "pinned"
    } else if any(&[ERROR_NOT_A_CLOUD_FILE]) {
        "not-placeholder"
    } else if any(&[ERROR_CLOUD_FILE_NOT_UNDER_SYNC_ROOT]) {
        "outside"
    } else if any(&[ERROR_CLOUD_FILE_REQUEST_CANCELED, ERROR_CLOUD_FILE_REQUEST_ABORTED]) {
        "cancelled"
    } else if any(&[ERROR_CLOUD_FILE_NOT_SUPPORTED, ERROR_NOT_SUPPORTED]) {
        "unsupported"
    } else if any(&[ERROR_TIMEOUT, ERROR_CLOUD_FILE_REQUEST_TIMEOUT]) {
        "timeout"
    } else {
        "failed"
    }
}

fn thrown(error: WinError) -> String {
    format!("files:{} (0x{:08x})", code_of(&error), error.code().0 as u32)
}

fn timeout() -> WinError {
    WinError::from(ERROR_TIMEOUT.to_hresult())
}

// ─── Paths and handles ───────────────────────────────────────

/// Long paths need the `\\?\` form for the calls that don't take them otherwise. Main only
/// ever passes absolute drive paths.
fn wide(path: &str) -> HSTRING {
    if path.len() >= 240 && !path.starts_with(r"\\") && path.as_bytes().get(1) == Some(&b':') {
        HSTRING::from(format!(r"\\?\{path}"))
    } else {
        HSTRING::from(path)
    }
}

struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

/// A handle cldapi hands out: it breaks when another program opens the file, rather than
/// keeping that program out.
struct Protected(HANDLE);

impl Drop for Protected {
    fn drop(&mut self) {
        unsafe { CfCloseHandle(self.0) };
    }
}

impl Protected {
    fn open(path: &str) -> Result<Self, WinError> {
        unsafe { CfOpenFileWithOplock(&wide(path), CF_OPEN_FILE_FLAG_EXCLUSIVE | CF_OPEN_FILE_FLAG_WRITE_ACCESS) }.map(Protected)
    }

    /// Runs `work` on the Win32 handle while it's referenced. Another program opening the
    /// file breaks the oplock, and then this answers busy.
    fn with<T>(&self, work: impl FnOnce(HANDLE) -> Result<T, WinError>) -> Result<T, WinError> {
        if !unsafe { CfReferenceProtectedHandle(self.0) } {
            return Err(WinError::from(ERROR_SHARING_VIOLATION.to_hresult()));
        }
        let result = work(unsafe { CfGetWin32HandleFromProtectedHandle(self.0) });
        unsafe { CfReleaseProtectedHandle(self.0) };
        result
    }
}

fn set_pin(path: &str, pin: CF_PIN_STATE) -> Result<(), WinError> {
    let handle = unsafe { CreateFileW(&wide(path), FILE_READ_ATTRIBUTES.0 | FILE_WRITE_ATTRIBUTES.0, SHARE_ALL, None, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, None) }.map(Handle)?;
    unsafe { CfSetPinState(handle.0, pin, CF_SET_PIN_FLAG_NONE, None) }
}

const SHARE_ALL: FILE_SHARE_MODE = FILE_SHARE_MODE(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0);

/// Opening for attributes doesn't fetch anything, on a placeholder or elsewhere.
fn open_for_attributes(path: &str) -> Result<Handle, WinError> {
    unsafe { CreateFileW(&wide(path), FILE_READ_ATTRIBUTES.0, SHARE_ALL, None, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, None) }.map(Handle)
}

fn file_info<T: Default>(handle: HANDLE, class: FILE_INFO_BY_HANDLE_CLASS) -> Result<T, WinError> {
    let mut value = T::default();
    unsafe { GetFileInformationByHandleEx(handle, class, &mut value as *mut T as *mut c_void, size_of::<T>() as u32) }?;
    Ok(value)
}

/// Milliseconds since 1970 to a FILETIME count.
fn filetime(ms: f64) -> i64 {
    ((ms.round() as i64) + 11_644_473_600_000) * 10_000
}

// ─── The user's SID, for the sync root's id ──────────────────

fn user_sid() -> Result<String, WinError> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)?;
        let token = Handle(token);
        let mut length = 0u32;
        let _ = GetTokenInformation(token.0, TokenUser, None, 0, &mut length);
        // u64s, so the TOKEN_USER read out of it is aligned.
        let mut buffer = vec![0u64; (length as usize).div_ceil(8).max(1)];
        GetTokenInformation(token.0, TokenUser, Some(buffer.as_mut_ptr() as *mut c_void), (buffer.len() * 8) as u32, &mut length)?;
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let mut text = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut text)?;
        let sid = text.to_string().unwrap_or_default();
        let _ = LocalFree(Some(HLOCAL(text.0 as *mut c_void)));
        Ok(sid)
    }
}

// ─── Registration ────────────────────────────────────────────

const POLL: Duration = Duration::from_millis(20);
const FOLDER_TIMEOUT: Duration = Duration::from_secs(30);

fn wait<T>(op: &IAsyncOperation<T>, limit: Duration) -> Result<T, WinError>
where
    T: windows_core::RuntimeType + 'static,
{
    let deadline = Instant::now() + limit;
    loop {
        match op.Status()? {
            AsyncStatus::Started => {
                if Instant::now() >= deadline {
                    let _ = op.Cancel();
                    return Err(timeout());
                }
                sleep(POLL);
            }
            AsyncStatus::Completed => return op.GetResults(),
            AsyncStatus::Canceled => return Err(timeout()),
            _ => return Err(op.ErrorCode()?.into()),
        }
    }
}

pub fn register(options: &FilesRegistration) -> Result<String, String> {
    let sid = user_sid().map_err(thrown)?;
    let id = format!("{}!{}!{}", options.provider, sid, options.account);
    let run = || -> Result<(), WinError> {
        let folder: StorageFolder = wait(&StorageFolder::GetFolderFromPathAsync(&HSTRING::from(options.path.as_str()))?, FOLDER_TIMEOUT)?;
        let info = StorageProviderSyncRootInfo::new()?;
        info.SetId(&HSTRING::from(id.as_str()))?;
        info.SetPath(&folder)?;
        info.SetDisplayNameResource(&HSTRING::from(options.display_name.as_str()))?;
        info.SetIconResource(&HSTRING::from(options.icon.as_str()))?;
        info.SetVersion(&HSTRING::from(options.version.as_str()))?;
        // Full: a program that opens a file gets it whole, the way it was on the server.
        // Progressive would hand out the first bytes early, and a fetch that fails halfway
        // would leave that program with half a file it already read.
        info.SetHydrationPolicy(StorageProviderHydrationPolicy::Full)?;
        info.SetHydrationPolicyModifier(StorageProviderHydrationPolicyModifier::None)?;
        // The page places every placeholder itself: no folder asks for its contents.
        info.SetPopulationPolicy(StorageProviderPopulationPolicy::AlwaysFull)?;
        info.SetInSyncPolicy(
            StorageProviderInSyncPolicy::FileLastWriteTime
                | StorageProviderInSyncPolicy::FileReadOnlyAttribute
                | StorageProviderInSyncPolicy::FileHiddenAttribute
                | StorageProviderInSyncPolicy::FileSystemAttribute,
        )?;
        info.SetHardlinkPolicy(StorageProviderHardlinkPolicy::None)?;
        info.SetShowSiblingsAsGroup(false)?;
        // "Always keep on this device" and "Free up space".
        info.SetAllowPinning(true)?;
        StorageProviderSyncRootManager::Register(&info)
    };
    run().map_err(thrown)?;
    Ok(id)
}

pub fn unregister(id: &str) -> Result<(), String> {
    StorageProviderSyncRootManager::Unregister(&HSTRING::from(id)).map_err(thrown)
}

/// Where Windows keeps every sync root of every user on this machine. Read here because
/// GetCurrentSyncRoots lists only a packaged app's own, and an app that isn't packaged has none.
const SYNC_ROOT_MANAGER: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\SyncRootManager";

struct Key(HKEY);

impl Drop for Key {
    fn drop(&mut self) {
        let _ = unsafe { RegCloseKey(self.0) };
    }
}

fn registry_text(key: HKEY, subkey: &str, value: &str) -> Option<String> {
    let (subkey, value) = (HSTRING::from(subkey), HSTRING::from(value));
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND;
    let mut size = 0u32;
    if unsafe { RegGetValueW(key, &subkey, &value, flags, None, None, Some(&mut size)) } != ERROR_SUCCESS {
        return None;
    }
    let mut buffer = vec![0u16; (size as usize).div_ceil(2) + 1];
    let mut size = (buffer.len() * 2) as u32;
    if unsafe { RegGetValueW(key, &subkey, &value, flags, None, Some(buffer.as_mut_ptr() as *mut c_void), Some(&mut size)) } != ERROR_SUCCESS {
        return None;
    }
    let end = buffer.iter().position(|unit| *unit == 0).unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..end]))
}

/// This user's sync roots, every provider's, with the folder each is on.
pub fn roots() -> Result<Vec<FilesSyncRoot>, String> {
    let sid = user_sid().map_err(thrown)?;
    let mut opened = HKEY::default();
    let status = unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, &HSTRING::from(SYNC_ROOT_MANAGER), None, KEY_READ, &mut opened) };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(vec![]);
    }
    if status != ERROR_SUCCESS {
        return Err(thrown(WinError::from(status.to_hresult())));
    }
    let manager = Key(opened);
    let marker = format!("!{sid}!");
    let mut found = Vec::new();
    for index in 0.. {
        let mut name = [0u16; 512];
        let mut length = name.len() as u32;
        let status = unsafe { RegEnumKeyExW(manager.0, index, Some(PWSTR(name.as_mut_ptr())), &mut length, None, None, None, None) };
        if status == ERROR_NO_MORE_ITEMS {
            break;
        }
        if status != ERROR_SUCCESS {
            continue;
        }
        let id = String::from_utf16_lossy(&name[..length as usize]);
        if !id.contains(&marker) {
            continue;
        }
        found.push(FilesSyncRoot {
            path: registry_text(manager.0, &format!(r"{id}\UserSyncRoots"), &sid).unwrap_or_default(),
            display_name: registry_text(manager.0, &id, "DisplayNameResource").unwrap_or_default(),
            icon: registry_text(manager.0, &id, "IconResource").unwrap_or_default(),
            id,
        });
    }
    Ok(found)
}

// ─── Connection and callbacks ────────────────────────────────

pub type Sink = Box<dyn Fn(FilesFetchEvent) -> bool + Send + Sync>;

/// What a connection's callbacks reach. Leaked on purpose, a few bytes per connect: a
/// callback already running when the connection goes must never find it freed. Disconnecting
/// empties it, which releases the JS function.
struct Context {
    sink: Mutex<Option<Sink>>,
}

static CONTEXTS: Mutex<Vec<(i64, &'static Context)>> = Mutex::new(Vec::new());

static CALLBACKS: [CF_CALLBACK_REGISTRATION; 3] = [
    CF_CALLBACK_REGISTRATION { Type: CF_CALLBACK_TYPE_FETCH_DATA, Callback: Some(on_fetch_data) },
    CF_CALLBACK_REGISTRATION { Type: CF_CALLBACK_TYPE_CANCEL_FETCH_DATA, Callback: Some(on_cancel_fetch_data) },
    CF_CALLBACK_REGISTRATION { Type: CF_CALLBACK_TYPE_NONE, Callback: None },
];

fn text_at(pointer: windows::core::PCWSTR) -> String {
    if pointer.is_null() {
        String::new()
    } else {
        unsafe { pointer.to_string() }.unwrap_or_default()
    }
}

fn identity_of(info: &CF_CALLBACK_INFO) -> String {
    if info.FileIdentity.is_null() || info.FileIdentityLength == 0 {
        return String::new();
    }
    let bytes = unsafe { std::slice::from_raw_parts(info.FileIdentity as *const u8, info.FileIdentityLength as usize) };
    String::from_utf8_lossy(bytes).into_owned()
}

fn event_of(kind: &str, info: &CF_CALLBACK_INFO, offset: i64, length: i64) -> FilesFetchEvent {
    let pid = if info.ProcessInfo.is_null() { 0 } else { unsafe { (*info.ProcessInfo).ProcessId } };
    FilesFetchEvent {
        kind: kind.to_string(),
        connection: info.ConnectionKey.0.to_string(),
        transfer_key: info.TransferKey.to_string(),
        request_key: info.RequestKey.to_string(),
        // With CF_CONNECT_FLAG_REQUIRE_FULL_FILE_PATH: the path below the volume.
        path: format!("{}{}", text_at(info.VolumeDosName), text_at(info.NormalizedPath)),
        identity: identity_of(info),
        offset: offset as f64,
        length: length as f64,
        total: info.FileSize as f64,
        pid,
    }
}

fn deliver(info: &CF_CALLBACK_INFO, event: FilesFetchEvent) -> bool {
    if info.CallbackContext.is_null() {
        return false;
    }
    let context = unsafe { &*(info.CallbackContext as *const Context) };
    let Ok(sink) = context.sink.lock() else { return false };
    sink.as_ref().is_some_and(|sink| sink(event))
}

unsafe extern "system" fn on_fetch_data(info: *const CF_CALLBACK_INFO, parameters: *const CF_CALLBACK_PARAMETERS) {
    if info.is_null() || parameters.is_null() {
        return;
    }
    let info = unsafe { &*info };
    let fetch = unsafe { (*parameters).Anonymous.FetchData };
    let event = event_of("fetch", info, fetch.RequiredFileOffset, fetch.RequiredLength);
    // Nobody listening: say so at once, rather than leave the program that opened it waiting.
    if !deliver(info, event) {
        let _ = transfer_raw(info.ConnectionKey.0, info.TransferKey, info.RequestKey, fetch.RequiredFileOffset, fetch.RequiredLength, None, STATUS_CLOUD_FILE_PROVIDER_NOT_RUNNING);
    }
}

unsafe extern "system" fn on_cancel_fetch_data(info: *const CF_CALLBACK_INFO, parameters: *const CF_CALLBACK_PARAMETERS) {
    if info.is_null() || parameters.is_null() {
        return;
    }
    let info = unsafe { &*info };
    let cancel = unsafe { (*parameters).Anonymous.Cancel.Anonymous.FetchData };
    deliver(info, event_of("cancel", info, cancel.FileOffset, cancel.Length));
}

pub fn connect(path: &str, sink: Sink) -> Result<String, String> {
    let context: &'static Context = Box::leak(Box::new(Context { sink: Mutex::new(Some(sink)) }));
    let key = unsafe {
        CfConnectSyncRoot(
            &HSTRING::from(path),
            CALLBACKS.as_ptr(),
            Some(context as *const Context as *const c_void),
            // Main itself never fetches by reading a file: only an explicit hydrate does.
            CF_CONNECT_FLAG_REQUIRE_PROCESS_INFO | CF_CONNECT_FLAG_REQUIRE_FULL_FILE_PATH | CF_CONNECT_FLAG_BLOCK_SELF_IMPLICIT_HYDRATION,
        )
    };
    match key {
        Ok(key) => {
            if let Ok(mut list) = CONTEXTS.lock() {
                list.push((key.0, context));
            }
            Ok(key.0.to_string())
        }
        Err(error) => {
            if let Ok(mut sink) = context.sink.lock() {
                sink.take();
            }
            Err(thrown(error))
        }
    }
}

pub fn disconnect(connection: i64) -> Result<(), String> {
    let result = unsafe { CfDisconnectSyncRoot(CF_CONNECTION_KEY(connection)) }.map_err(thrown);
    if let Ok(mut list) = CONTEXTS.lock() {
        list.retain(|(key, context)| {
            if *key != connection {
                return true;
            }
            if let Ok(mut sink) = context.sink.lock() {
                sink.take();
            }
            false
        });
    }
    result
}

// ─── Transfers ───────────────────────────────────────────────

fn transfer_raw(connection: i64, transfer_key: i64, request_key: i64, offset: i64, length: i64, data: Option<&[u8]>, status: NTSTATUS) -> Result<(), WinError> {
    let info = CF_OPERATION_INFO {
        StructSize: size_of::<CF_OPERATION_INFO>() as u32,
        Type: CF_OPERATION_TYPE_TRANSFER_DATA,
        ConnectionKey: CF_CONNECTION_KEY(connection),
        TransferKey: transfer_key,
        RequestKey: request_key,
        ..Default::default()
    };
    let mut parameters = CF_OPERATION_PARAMETERS {
        ParamSize: (offset_of!(CF_OPERATION_PARAMETERS, Anonymous) + size_of::<CF_OPERATION_PARAMETERS_0_0>()) as u32,
        ..Default::default()
    };
    parameters.Anonymous.TransferData = CF_OPERATION_PARAMETERS_0_0 {
        Flags: CF_OPERATION_TRANSFER_DATA_FLAG_NONE,
        CompletionStatus: status,
        Buffer: data.map_or(std::ptr::null(), |bytes| bytes.as_ptr() as *const c_void),
        Offset: offset,
        Length: length,
    };
    unsafe { CfExecute(&info, &mut parameters) }
}

/// Bytes for a fetch. The offset is 4 KB aligned, and so is the length unless it ends the file.
pub fn transfer(connection: i64, transfer_key: i64, request_key: i64, offset: i64, data: &[u8]) -> Result<(), String> {
    transfer_raw(connection, transfer_key, request_key, offset, data.len() as i64, Some(data), STATUS_SUCCESS).map_err(thrown)
}

/// Tells Windows a fetch won't come: the program that opened the file gets an error now.
pub fn transfer_failed(connection: i64, transfer_key: i64, request_key: i64, offset: i64, length: i64, reason: &str) -> Result<(), String> {
    let status = match reason {
        "offline" => STATUS_CLOUD_FILE_NETWORK_UNAVAILABLE,
        "denied" => STATUS_CLOUD_FILE_ACCESS_DENIED,
        "timeout" => STATUS_CLOUD_FILE_REQUEST_TIMEOUT,
        "not-running" => STATUS_CLOUD_FILE_PROVIDER_NOT_RUNNING,
        _ => STATUS_CLOUD_FILE_UNSUCCESSFUL,
    };
    transfer_raw(connection, transfer_key, request_key, offset, length, None, status).map_err(thrown)
}

// ─── Placeholders ────────────────────────────────────────────

/// One answer per entry, `""` for placed. The parent must exist.
pub fn place(parent: &str, entries: &[FilesPlacement]) -> Result<Vec<String>, String> {
    let names: Vec<HSTRING> = entries.iter().map(|entry| HSTRING::from(entry.name.as_str())).collect();
    // E_ABORT until the call says otherwise: an entry it never reached isn't placed.
    let pending = HRESULT(E_ABORT.0);
    let mut infos: Vec<CF_PLACEHOLDER_CREATE_INFO> = entries
        .iter()
        .zip(&names)
        .map(|(entry, name)| {
            let time = filetime(entry.mtime_ms);
            CF_PLACEHOLDER_CREATE_INFO {
                RelativeFileName: windows::core::PCWSTR(name.as_ptr()),
                FsMetadata: CF_FS_METADATA {
                    BasicInfo: FILE_BASIC_INFO {
                        CreationTime: time,
                        LastAccessTime: time,
                        LastWriteTime: time,
                        ChangeTime: time,
                        FileAttributes: if entry.directory { FILE_ATTRIBUTE_DIRECTORY.0 } else { FILE_ATTRIBUTE_NORMAL.0 },
                    },
                    FileSize: if entry.directory { 0 } else { entry.size as i64 },
                },
                FileIdentity: entry.identity.as_ptr() as *const c_void,
                FileIdentityLength: entry.identity.len() as u32,
                Flags: if entry.directory {
                    CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC | CF_PLACEHOLDER_CREATE_FLAG_DISABLE_ON_DEMAND_POPULATION
                } else {
                    CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC
                },
                Result: pending,
                CreateUsn: 0,
            }
        })
        .collect();
    let mut processed = 0u32;
    let overall = unsafe { CfCreatePlaceholders(&wide(parent), &mut infos, CF_CREATE_FLAG_NONE, Some(&mut processed)) };
    Ok(infos
        .iter()
        .map(|info| {
            if info.Result.is_ok() {
                String::new()
            } else if info.Result == pending {
                match &overall {
                    Err(error) => code_of(error).to_string(),
                    Ok(()) => "failed".to_string(),
                }
            } else {
                code_of(&WinError::from(info.Result)).to_string()
            }
        })
        .collect())
}

const STANDARD_INFO_SIZE: usize = size_of::<CF_PLACEHOLDER_STANDARD_INFO>() + CF_PLACEHOLDER_MAX_FILE_IDENTITY_LENGTH as usize;

fn standard_info(handle: HANDLE) -> Result<(CF_PLACEHOLDER_STANDARD_INFO, Vec<u8>), WinError> {
    let mut buffer = vec![0u64; STANDARD_INFO_SIZE.div_ceil(8)];
    let mut returned = 0u32;
    unsafe { CfGetPlaceholderInfo(handle, CF_PLACEHOLDER_INFO_STANDARD, buffer.as_mut_ptr() as *mut c_void, (buffer.len() * 8) as u32, Some(&mut returned)) }?;
    let info = unsafe { *(buffer.as_ptr() as *const CF_PLACEHOLDER_STANDARD_INFO) };
    let start = offset_of!(CF_PLACEHOLDER_STANDARD_INFO, FileIdentity);
    let length = (info.FileIdentityLength as usize).min(CF_PLACEHOLDER_MAX_FILE_IDENTITY_LENGTH as usize);
    let bytes = unsafe { std::slice::from_raw_parts((buffer.as_ptr() as *const u8).add(start), length) }.to_vec();
    Ok((info, bytes))
}

fn pin_name(pin: CF_PIN_STATE) -> &'static str {
    match pin {
        CF_PIN_STATE_PINNED => "pinned",
        CF_PIN_STATE_UNPINNED => "unpinned",
        _ => "unspecified",
    }
}

/// What a file or folder under a sync root is now, without fetching anything.
pub fn info(path: &str) -> Result<FilesPlaceholderInfo, String> {
    let run = || -> Result<FilesPlaceholderInfo, WinError> {
        let handle = open_for_attributes(path)?;
        let tag: FILE_ATTRIBUTE_TAG_INFO = file_info(handle.0, FileAttributeTagInfo)?;
        let standard: FILE_STANDARD_INFO = file_info(handle.0, FileStandardInfo)?;
        let state = unsafe { CfGetPlaceholderStateFromFileInfo(&tag as *const FILE_ATTRIBUTE_TAG_INFO as *const c_void, FileAttributeTagInfo) };
        let placeholder = state != CF_PLACEHOLDER_STATE_INVALID && state.0 & CF_PLACEHOLDER_STATE_PLACEHOLDER.0 != 0;
        let directory = standard.Directory;
        let mut result = FilesPlaceholderInfo {
            placeholder,
            directory,
            identity: None,
            in_sync: false,
            hydrated: true,
            partial: false,
            pin: "unspecified".to_string(),
            size: if directory { 0.0 } else { standard.EndOfFile as f64 },
            on_disk: if directory { 0.0 } else { standard.EndOfFile as f64 },
        };
        // The pin attributes are there on anything under a sync root, placeholder or not.
        if tag.FileAttributes & FILE_ATTRIBUTE_PINNED.0 != 0 {
            result.pin = "pinned".to_string();
        } else if tag.FileAttributes & FILE_ATTRIBUTE_UNPINNED.0 != 0 {
            result.pin = "unpinned".to_string();
        }
        if !placeholder {
            return Ok(result);
        }
        let partial = state.0 & CF_PLACEHOLDER_STATE_PARTIAL.0 != 0;
        result.in_sync = state.0 & CF_PLACEHOLDER_STATE_IN_SYNC.0 != 0;
        result.hydrated = directory || !partial;
        let (standard_info, identity) = standard_info(handle.0)?;
        // PARTIALLY_ON_DISK stays set on a file freed down to nothing: the size says it.
        result.partial = !result.hydrated && standard_info.OnDiskDataSize > 0;
        result.pin = pin_name(standard_info.PinState).to_string();
        result.on_disk = if directory { 0.0 } else { standard_info.OnDiskDataSize as f64 };
        if !identity.is_empty() {
            result.identity = Some(String::from_utf8_lossy(&identity).into_owned());
        }
        Ok(result)
    };
    run().map_err(thrown)
}

pub fn update(path: &str, change: &FilesUpdate) -> Result<(), String> {
    let run = || -> Result<(), WinError> {
        // A pinned file can't be dehydrated: unpinned for the update and pinned again after,
        // and main fetches the new content. Through a handle of its own, since changing the
        // attribute would break the oplock of the one below.
        let repin = change.dehydrate && info(path).is_ok_and(|now| !now.directory && now.pin == "pinned");
        if repin {
            set_pin(path, CF_PIN_STATE_UNSPECIFIED)?;
        }
        let file = Protected::open(path)?;
        let result = file.with(|handle| {
            let basic: FILE_BASIC_INFO = file_info(handle, FileBasicInfo)?;
            let standard: FILE_STANDARD_INFO = file_info(handle, FileStandardInfo)?;
            let mut metadata = CF_FS_METADATA { BasicInfo: basic, FileSize: if standard.Directory { 0 } else { standard.EndOfFile } };
            if let Some(ms) = change.mtime_ms {
                metadata.BasicInfo.LastWriteTime = filetime(ms);
                metadata.BasicInfo.ChangeTime = filetime(ms);
            }
            if let (Some(size), false) = (change.size, standard.Directory) {
                metadata.FileSize = size as i64;
            }
            let mut flags = CF_UPDATE_FLAG_NONE;
            if change.verify_in_sync {
                flags |= CF_UPDATE_FLAG_VERIFY_IN_SYNC;
            }
            if change.mark_in_sync {
                flags |= CF_UPDATE_FLAG_MARK_IN_SYNC;
            }
            if change.dehydrate && !standard.Directory {
                flags |= CF_UPDATE_FLAG_DEHYDRATE;
            }
            let identity = change.identity.as_deref().map(str::as_bytes);
            unsafe {
                CfUpdatePlaceholder(
                    handle,
                    Some(&metadata),
                    identity.map(|bytes| bytes.as_ptr() as *const c_void),
                    identity.map_or(0, |bytes| bytes.len() as u32),
                    None,
                    flags,
                    None,
                    None,
                )
            }
        });
        drop(file);
        if repin {
            let _ = set_pin(path, CF_PIN_STATE_PINNED);
        }
        result
    };
    run().map_err(thrown)
}

/// Something made here, after its upload: a placeholder with this identity, in sync. One that
/// is a placeholder already gets the identity and the mark.
pub fn convert(path: &str, identity: &str) -> Result<(), String> {
    let run = || -> Result<(), WinError> {
        let file = Protected::open(path)?;
        file.with(|handle| {
            let tag: FILE_ATTRIBUTE_TAG_INFO = file_info(handle, FileAttributeTagInfo)?;
            let state = unsafe { CfGetPlaceholderStateFromFileInfo(&tag as *const FILE_ATTRIBUTE_TAG_INFO as *const c_void, FileAttributeTagInfo) };
            let bytes = identity.as_bytes();
            if state != CF_PLACEHOLDER_STATE_INVALID && state.0 & CF_PLACEHOLDER_STATE_PLACEHOLDER.0 != 0 {
                unsafe { CfUpdatePlaceholder(handle, None, Some(bytes.as_ptr() as *const c_void), bytes.len() as u32, None, CF_UPDATE_FLAG_MARK_IN_SYNC, None, None) }
            } else {
                unsafe { CfConvertToPlaceholder(handle, Some(bytes.as_ptr() as *const c_void), bytes.len() as u32, CF_CONVERT_FLAG_MARK_IN_SYNC, None, None) }
            }
        })
    };
    run().map_err(thrown)
}

/// Fetches the whole file through this process's own FETCH_DATA callback. Blocks until it's
/// on disk, so never on the JS thread, which has to answer that callback.
pub fn hydrate(path: &str) -> Result<(), String> {
    let run = || -> Result<(), WinError> {
        let handle = unsafe { CreateFileW(&wide(path), FILE_GENERIC_READ.0, SHARE_ALL, None, OPEN_EXISTING, FILE_FLAGS_AND_ATTRIBUTES(0), None) }.map(Handle)?;
        unsafe { CfHydratePlaceholder(handle.0, 0, -1, CF_HYDRATE_FLAG_NONE, None) }
    };
    run().map_err(thrown)
}

pub fn dehydrate(path: &str) -> Result<(), String> {
    let run = || -> Result<(), WinError> {
        let file = Protected::open(path)?;
        file.with(|handle| unsafe { CfDehydratePlaceholder(handle, 0, -1, CF_DEHYDRATE_FLAG_NONE, None) })
    };
    run().map_err(thrown)
}

/// Drive letters in use, A as bit 0.
pub fn used_drive_letters() -> u32 {
    unsafe { GetLogicalDrives() }
}

/// The drive's item in "This PC" is read again: its name and icon.
pub fn letter_changed(letter: &str) {
    let root = HSTRING::from(format!("{letter}:\\"));
    unsafe { SHChangeNotify(SHCNE_UPDATEITEM, SHCNF_PATHW, Some(root.as_ptr() as *const c_void), None) };
}
