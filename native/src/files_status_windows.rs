//! Windows 11: the Files drive's storage and sync state in Explorer, the way OneDrive shows
//! "x GB of y GB used" and whether it's up to date. Explorer reads the CLSID in the sync root's
//! `StorageProviderStatusUISourceFactory` value, creates that class out of process
//! (CLSCTX_LOCAL_SERVER) and asks it for an IStorageProviderStatusUISource per sync root.
//!
//! The class object lives in this process while the app runs: `serve` registers it with COM
//! from a thread of its own in the multithreaded apartment, so calls from Explorer don't wait
//! for the JS thread. No CLSID goes into the registry for it: COM finds a class object a
//! running process registered without one (seen on Windows 11 25H2, in
//! test/files-drive-status.spec.ts). With the app closed Explorer finds nobody and shows no
//! status, which is true: the drive doesn't sync then.
//!
//! What it shows comes from main (`set`), already translated by the page. `read` is the other
//! side, what Explorer does, for the tests and for checking a machine by hand.

use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use windows::core::{implement, IInspectable, IUnknown, Interface, Ref, Result as WinResult, GUID, HSTRING};
use windows::Foundation::{TypedEventHandler, Uri};
use windows::Storage::Provider::{
    IStorageProviderStatusUISource, IStorageProviderStatusUISourceFactory, IStorageProviderStatusUISourceFactory_Impl, IStorageProviderStatusUISource_Impl,
    IStorageProviderUICommand, IStorageProviderUICommand_Impl, StorageProviderMoreInfoUI, StorageProviderQuotaUI, StorageProviderState, StorageProviderStatusUI,
    StorageProviderUICommandState,
};
use windows::Win32::Foundation::{CLASS_E_NOAGGREGATION, E_INVALIDARG, ERROR_SUCCESS, E_UNEXPECTED};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoRegisterClassObject, CoRevokeClassObject, CoUninitialize, IClassFactory, IClassFactory_Impl, CLSCTX_LOCAL_SERVER,
    COINIT_MULTITHREADED, REGCLS_MULTIPLEUSE,
};
use windows::Win32::System::Registry::{RegSetKeyValueW, HKEY_LOCAL_MACHINE, REG_SZ};

use crate::{FilesDriveStatus, FilesDriveStatusSeen};

/// Where Windows keeps the sync roots: the factory's CLSID goes in the root's own key, which
/// Windows deletes with the registration.
const SYNC_ROOT_MANAGER: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\SyncRootManager";
const FACTORY_VALUE: &str = "StorageProviderStatusUISourceFactory";

pub type CommandSink = Box<dyn Fn(String) + Send + Sync>;

// ─── What main said, per sync root ───────────────────────────

struct Subscriber {
    token: i64,
    root: String,
    handler: TypedEventHandler<IStorageProviderStatusUISource, IInspectable>,
}

// The handler is Explorer's, reached through a COM proxy that marshals each call itself.
unsafe impl Send for Subscriber {}

#[derive(Default)]
struct Shared {
    status: HashMap<String, FilesDriveStatus>,
    subscribers: Vec<Subscriber>,
    next_token: i64,
    icon: Option<String>,
    sink: Option<CommandSink>,
}

static SHARED: Mutex<Option<Shared>> = Mutex::new(None);

fn shared() -> MutexGuard<'static, Option<Shared>> {
    SHARED.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn with_shared<T>(work: impl FnOnce(&mut Shared) -> T) -> T {
    let mut guard = shared();
    work(guard.get_or_insert_with(Shared::default))
}

/// The page's states as Windows has them.
pub fn state_of(state: &str) -> Option<StorageProviderState> {
    Some(match state {
        "synced" => StorageProviderState::InSync,
        "syncing" => StorageProviderState::Syncing,
        "paused" => StorageProviderState::Paused,
        "offline" => StorageProviderState::Offline,
        "error" => StorageProviderState::Error,
        _ => return None,
    })
}

fn state_name(state: StorageProviderState) -> &'static str {
    match state {
        StorageProviderState::InSync => "synced",
        StorageProviderState::Syncing => "syncing",
        StorageProviderState::Paused => "paused",
        StorageProviderState::Offline => "offline",
        StorageProviderState::Error => "error",
        StorageProviderState::Warning => "warning",
        _ => "unknown",
    }
}

// ─── The objects Explorer talks to ───────────────────────────

fn icon_uri() -> WinResult<Uri> {
    let icon = with_shared(|shared| shared.icon.clone()).ok_or_else(|| windows::core::Error::from(E_UNEXPECTED))?;
    Uri::CreateUri(&HSTRING::from(icon))
}

fn build(root: &str) -> WinResult<StorageProviderStatusUI> {
    let Some(status) = with_shared(|shared| shared.status.get(root).cloned()) else {
        // Nothing said yet for this root: the page hasn't run a pass. No guess.
        return Err(E_UNEXPECTED.into());
    };
    let state = state_of(&status.state).ok_or_else(|| windows::core::Error::from(E_INVALIDARG))?;
    let ui = StorageProviderStatusUI::new()?;
    ui.SetProviderState(state)?;
    ui.SetProviderStateLabel(&HSTRING::from(&status.label))?;
    if let Ok(icon) = icon_uri() {
        ui.SetProviderStateIcon(&icon)?;
    }
    let command: IStorageProviderUICommand = OpenSettings { root: root.to_string(), label: status.label.clone(), detail: status.detail.clone() }.into();
    ui.SetSyncStatusCommand(&command)?;
    if let Some(quota) = &status.quota {
        let bar = StorageProviderQuotaUI::new()?;
        bar.SetQuotaUsedInBytes(quota.used.max(0.0) as u64)?;
        // No limit: the bar stays empty and the label says what's used.
        bar.SetQuotaTotalInBytes(quota.total.filter(|total| *total > 0.0).map(|total| total as u64).unwrap_or(u64::MAX))?;
        bar.SetQuotaUsedLabel(&HSTRING::from(&quota.label))?;
        ui.SetQuotaUI(&bar)?;
    }
    // Nearly full, or full: a line of its own in the flyout. QuotaUsedColor would colour the bar,
    // but an IReference<Color> can't leave this process: Windows has no proxy for it
    // (REGDB_E_IIDNOTREG in Explorer's place, seen with filesDriveStatusRead).
    if let Some(notice) = status.notice.as_ref().filter(|notice| !notice.is_empty()) {
        let more = StorageProviderMoreInfoUI::new()?;
        more.SetMessage(&HSTRING::from(notice))?;
        ui.SetMoreInfoUI(&more)?;
    }
    Ok(ui)
}

#[implement(IClassFactory)]
struct Factory;

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(&self, outer: Ref<IUnknown>, iid: *const GUID, object: *mut *mut std::ffi::c_void) -> WinResult<()> {
        if !object.is_null() {
            unsafe { *object = std::ptr::null_mut() };
        }
        if outer.is_some() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        let factory: IStorageProviderStatusUISourceFactory = SourceFactory.into();
        unsafe { factory.query(iid, object).ok() }
    }

    fn LockServer(&self, _lock: windows::core::BOOL) -> WinResult<()> {
        Ok(())
    }
}

#[implement(IStorageProviderStatusUISourceFactory)]
struct SourceFactory;

impl IStorageProviderStatusUISourceFactory_Impl for SourceFactory_Impl {
    fn GetStatusUISource(&self, sync_root_id: &HSTRING) -> WinResult<IStorageProviderStatusUISource> {
        let root = sync_root_id.to_string_lossy();
        // Only roots main told about: another provider's id gets nothing from here.
        if !with_shared(|shared| shared.status.contains_key(&root)) {
            return Err(E_INVALIDARG.into());
        }
        Ok(Source { root }.into())
    }
}

#[implement(IStorageProviderStatusUISource)]
struct Source {
    root: String,
}

impl IStorageProviderStatusUISource_Impl for Source_Impl {
    fn GetStatusUI(&self) -> WinResult<StorageProviderStatusUI> {
        build(&self.root)
    }

    fn StatusUIChanged(&self, handler: Ref<TypedEventHandler<IStorageProviderStatusUISource, IInspectable>>) -> WinResult<i64> {
        let handler = handler.ok()?.clone();
        Ok(with_shared(|shared| {
            shared.next_token += 1;
            let token = shared.next_token;
            shared.subscribers.push(Subscriber { token, root: self.root.clone(), handler });
            token
        }))
    }

    fn RemoveStatusUIChanged(&self, token: i64) -> WinResult<()> {
        with_shared(|shared| shared.subscribers.retain(|subscriber| subscriber.token != token));
        Ok(())
    }
}

/// The line under the state in Explorer's flyout. Opens Settings > Files on this computer.
#[implement(IStorageProviderUICommand)]
struct OpenSettings {
    root: String,
    label: String,
    detail: String,
}

impl IStorageProviderUICommand_Impl for OpenSettings_Impl {
    fn Label(&self) -> WinResult<HSTRING> {
        Ok(HSTRING::from(&self.label))
    }

    fn Description(&self) -> WinResult<HSTRING> {
        Ok(HSTRING::from(&self.detail))
    }

    fn Icon(&self) -> WinResult<Uri> {
        icon_uri()
    }

    fn State(&self) -> WinResult<StorageProviderUICommandState> {
        Ok(StorageProviderUICommandState::Enabled)
    }

    fn Invoke(&self) -> WinResult<()> {
        // To main on the JS thread, without waiting: Explorer's call returns at once.
        with_shared(|shared| {
            if let Some(sink) = &shared.sink {
                sink(self.root.clone());
            }
        });
        Ok(())
    }
}

// ─── The COM thread ──────────────────────────────────────────

enum Command {
    Changed(String),
    Stop,
}

struct Server {
    clsid: GUID,
    commands: Sender<Command>,
    thread: Option<JoinHandle<()>>,
}

static SERVER: Mutex<Option<Server>> = Mutex::new(None);

fn server() -> MutexGuard<'static, Option<Server>> {
    SERVER.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn parse_clsid(text: &str) -> Option<GUID> {
    let inner = text.strip_prefix('{').and_then(|rest| rest.strip_suffix('}')).unwrap_or(text);
    let parts: Vec<&str> = inner.split('-').collect();
    let lengths = [8, 4, 4, 4, 12];
    if parts.len() != 5 || parts.iter().zip(lengths).any(|(part, length)| part.len() != length || !part.chars().all(|c| c.is_ascii_hexdigit())) {
        return None;
    }
    Some(GUID::from_u128(u128::from_str_radix(&parts.concat(), 16).ok()?))
}

fn clsid_text(clsid: &GUID) -> String {
    format!("{{{clsid:?}}}")
}

fn run(clsid: GUID, commands: Receiver<Command>, started: Sender<Result<bool, String>>) {
    let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if initialized.is_err() {
        let _ = started.send(Err(format!("files:failed (0x{:08x})", initialized.0 as u32)));
        return;
    }
    // Windows before the status UI (CloudFilesContract 7): nothing to serve, nothing breaks.
    if StorageProviderStatusUI::new().is_err() || StorageProviderQuotaUI::new().is_err() {
        let _ = started.send(Ok(false));
        unsafe { CoUninitialize() };
        return;
    }
    let factory: IClassFactory = Factory.into();
    let cookie = match unsafe { CoRegisterClassObject(&clsid, &factory, CLSCTX_LOCAL_SERVER, REGCLS_MULTIPLEUSE) } {
        Ok(cookie) => cookie,
        Err(error) => {
            let _ = started.send(Err(format!("files:failed (0x{:08x})", error.code().0 as u32)));
            unsafe { CoUninitialize() };
            return;
        }
    };
    let _ = started.send(Ok(true));
    while let Ok(command) = commands.recv() {
        match command {
            Command::Changed(root) => {
                let handlers: Vec<_> = with_shared(|shared| shared.subscribers.iter().filter(|subscriber| subscriber.root == root).map(|subscriber| subscriber.handler.clone()).collect());
                if handlers.is_empty() {
                    continue;
                }
                let source: IStorageProviderStatusUISource = Source { root: root.clone() }.into();
                for handler in handlers {
                    // An Explorer window that closed answers with an error: it's gone, nothing to do.
                    let _ = handler.Invoke(&source, None);
                }
            }
            Command::Stop => break,
        }
    }
    let _ = unsafe { CoRevokeClassObject(cookie) };
    with_shared(|shared| shared.subscribers.clear());
    unsafe { CoUninitialize() };
}

/// Registers the class object for `clsid` in this process. Ok(false): this Windows has no
/// status UI. Serving another CLSID stops the first.
pub fn serve(clsid: &str, icon: &str, sink: CommandSink) -> Result<bool, String> {
    let clsid = parse_clsid(clsid).ok_or_else(|| "files:invalid (clsid)".to_string())?;
    with_shared(|shared| {
        shared.icon = Some(icon.to_string());
        shared.sink = Some(sink);
    });
    {
        let guard = server();
        if guard.as_ref().is_some_and(|running| running.clsid == clsid) {
            return Ok(true);
        }
    }
    stop();
    let (commands, receiver) = channel();
    let (started, answer) = channel();
    let thread = thread::Builder::new().name("files-status".into()).spawn(move || run(clsid, receiver, started)).map_err(|_| "files:failed (thread)".to_string())?;
    match answer.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(true)) => {
            *server() = Some(Server { clsid, commands, thread: Some(thread) });
            Ok(true)
        }
        Ok(Ok(false)) => {
            let _ = thread.join();
            Ok(false)
        }
        Ok(Err(error)) => {
            let _ = thread.join();
            Err(error)
        }
        Err(_) => Err("files:timeout (0x800705b4)".to_string()),
    }
}

/// Revokes the class object. Explorer windows still showing the status keep what they have.
pub fn stop() {
    let running = server().take();
    if let Some(mut running) = running {
        let _ = running.commands.send(Command::Stop);
        if let Some(thread) = running.thread.take() {
            let _ = thread.join();
        }
    }
}

/// What Explorer shows for a sync root from now on; None forgets it.
pub fn set(root: &str, status: Option<FilesDriveStatus>) {
    with_shared(|shared| match status {
        Some(status) => {
            shared.status.insert(root.to_string(), status);
        }
        None => {
            shared.status.remove(root);
            shared.subscribers.retain(|subscriber| subscriber.root != root);
        }
    });
    if let Some(running) = server().as_ref() {
        let _ = running.commands.send(Command::Changed(root.to_string()));
    }
}

/// Points the sync root's registration at the class. Called right after registering it,
/// since registering again writes the key anew.
pub fn attach(root_id: &str, clsid: &str) -> Result<(), String> {
    let clsid = parse_clsid(clsid).ok_or_else(|| "files:invalid (clsid)".to_string())?;
    let value: Vec<u16> = clsid_text(&clsid).encode_utf16().chain(Some(0)).collect();
    let status = unsafe {
        RegSetKeyValueW(
            HKEY_LOCAL_MACHINE,
            &HSTRING::from(format!(r"{SYNC_ROOT_MANAGER}\{root_id}")),
            &HSTRING::from(FACTORY_VALUE),
            REG_SZ.0,
            Some(value.as_ptr() as *const std::ffi::c_void),
            (value.len() * 2) as u32,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!("files:failed (0x{:08x})", status.to_hresult().0 as u32));
    }
    Ok(())
}

// ─── Explorer's side, for tests and checks ───────────────────

fn read_text(root_id: &str) -> Option<String> {
    use windows::Win32::System::Registry::{RegGetValueW, RRF_RT_REG_SZ};
    let (key, value) = (HSTRING::from(format!(r"{SYNC_ROOT_MANAGER}\{root_id}")), HSTRING::from(FACTORY_VALUE));
    let mut buffer = [0u16; 64];
    let mut size = (buffer.len() * 2) as u32;
    let status = unsafe { RegGetValueW(HKEY_LOCAL_MACHINE, &key, &value, RRF_RT_REG_SZ, None, Some(buffer.as_mut_ptr() as *mut std::ffi::c_void), Some(&mut size)) };
    if status != ERROR_SUCCESS {
        return None;
    }
    let end = buffer.iter().position(|unit| *unit == 0).unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..end]))
}

fn seen(ui: &StorageProviderStatusUI, changed: bool) -> WinResult<FilesDriveStatusSeen> {
    let command = ui.SyncStatusCommand().ok();
    let quota = ui.QuotaUI().ok();
    Ok(FilesDriveStatusSeen {
        state: state_name(ui.ProviderState()?).to_string(),
        label: ui.ProviderStateLabel()?.to_string_lossy(),
        detail: command.as_ref().and_then(|command| command.Description().ok()).map(|text| text.to_string_lossy()).unwrap_or_default(),
        quota_used: quota.as_ref().and_then(|quota| quota.QuotaUsedInBytes().ok()).map(|value| value as f64),
        quota_total: quota.as_ref().and_then(|quota| quota.QuotaTotalInBytes().ok()).filter(|value| *value != u64::MAX).map(|value| value as f64),
        quota_label: quota.as_ref().and_then(|quota| quota.QuotaUsedLabel().ok()).map(|text| text.to_string_lossy()),
        notice: ui.MoreInfoUI().ok().and_then(|more| more.Message().ok()).map(|text| text.to_string_lossy()),
        changed,
    })
}

/// What Explorer gets for a sync root: the factory named in its registration, created out of
/// process, its source's status. With `wait_ms`, waits that long for StatusUIChanged and
/// answers the status after it. Errors: `missing` (no factory registered for the root),
/// `unsupported` (nobody serves it), `failed`.
pub fn read(root_id: &str, wait_ms: u32) -> Result<FilesDriveStatusSeen, String> {
    let fail = |error: windows::core::Error| format!("files:failed (0x{:08x})", error.code().0 as u32);
    let clsid = read_text(root_id).and_then(|text| parse_clsid(&text)).ok_or_else(|| "files:missing (0x80070002)".to_string())?;
    let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let result = (|| {
        let factory: IStorageProviderStatusUISourceFactory =
            unsafe { CoCreateInstance(&clsid, None, CLSCTX_LOCAL_SERVER) }.map_err(|error| format!("files:unsupported (0x{:08x})", error.code().0 as u32))?;
        let source = factory.GetStatusUISource(&HSTRING::from(root_id)).map_err(fail)?;
        let first = source.GetStatusUI().map_err(fail)?;
        if wait_ms == 0 {
            return seen(&first, false).map_err(fail);
        }
        let (told, heard) = channel::<()>();
        let told = Mutex::new(told);
        let handler = TypedEventHandler::<IStorageProviderStatusUISource, IInspectable>::new(move |_, _| {
            let _ = told.lock().map(|told| told.send(()));
            Ok(())
        });
        let token = source.StatusUIChanged(&handler).map_err(fail)?;
        let deadline = Instant::now() + Duration::from_millis(wait_ms as u64);
        let changed = match heard.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(()) => true,
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => false,
        };
        let _ = source.RemoveStatusUIChanged(token);
        if changed {
            seen(&source.GetStatusUI().map_err(fail)?, true).map_err(fail)
        } else {
            seen(&first, false).map_err(fail)
        }
    })();
    if initialized.is_ok() {
        unsafe { CoUninitialize() };
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states_map_both_ways() {
        for name in ["synced", "syncing", "paused", "offline", "error"] {
            assert_eq!(state_name(state_of(name).unwrap()), name);
        }
        assert!(state_of("idle").is_none());
        assert!(state_of("").is_none());
    }

    #[test]
    fn clsids_parse_with_or_without_braces() {
        let text = "{0E7A5F31-6B42-4C8E-9D17-3A2B5C4D6E70}";
        let clsid = parse_clsid(text).unwrap();
        assert_eq!(clsid_text(&clsid), text);
        assert_eq!(parse_clsid(&text[1..text.len() - 1]), Some(clsid));
        assert!(parse_clsid("{0E7A5F31-6B42-4C8E-9D17-3A2B5C4D6E7}").is_none());
        assert!(parse_clsid("not a guid").is_none());
    }
}
