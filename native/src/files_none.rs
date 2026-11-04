//! macOS and Linux: no Files drive this round (a File Provider extension and FUSE are
//! another project). The same exports, so the surface doesn't depend on the platform, and
//! every call answers that it isn't supported.

use crate::{FilesFetchEvent, FilesPlaceholderInfo, FilesPlacement, FilesRegistration, FilesSyncRoot, FilesUpdate};

const UNSUPPORTED: &str = "files:unsupported";

pub type Sink = Box<dyn Fn(FilesFetchEvent) -> bool + Send + Sync>;

fn unsupported<T>() -> Result<T, String> {
    Err(UNSUPPORTED.to_string())
}

pub fn register(_options: &FilesRegistration) -> Result<String, String> {
    unsupported()
}

pub fn unregister(_id: &str) -> Result<(), String> {
    unsupported()
}

pub fn roots() -> Result<Vec<FilesSyncRoot>, String> {
    Ok(vec![])
}

pub fn connect(_path: &str, _sink: Sink) -> Result<String, String> {
    unsupported()
}

pub fn disconnect(_connection: i64) -> Result<(), String> {
    unsupported()
}

pub fn transfer(_connection: i64, _transfer_key: i64, _request_key: i64, _offset: i64, _data: &[u8]) -> Result<(), String> {
    unsupported()
}

pub fn transfer_failed(_connection: i64, _transfer_key: i64, _request_key: i64, _offset: i64, _length: i64, _reason: &str) -> Result<(), String> {
    unsupported()
}

pub fn place(_parent: &str, _entries: &[FilesPlacement]) -> Result<Vec<String>, String> {
    unsupported()
}

pub fn info(_path: &str) -> Result<FilesPlaceholderInfo, String> {
    unsupported()
}

pub fn update(_path: &str, _change: &FilesUpdate) -> Result<(), String> {
    unsupported()
}

pub fn convert(_path: &str, _identity: &str) -> Result<(), String> {
    unsupported()
}

pub fn hydrate(_path: &str) -> Result<(), String> {
    unsupported()
}

pub fn dehydrate(_path: &str) -> Result<(), String> {
    unsupported()
}

pub fn used_drive_letters() -> u32 {
    0
}

pub fn letter_changed(_letter: &str) {}
