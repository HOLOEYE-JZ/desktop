//! macOS and Linux: Explorer's status for the drive is Windows only, like the drive.

use crate::{FilesDriveStatus, FilesDriveStatusSeen};

pub type CommandSink = Box<dyn Fn(String) + Send + Sync>;

pub fn serve(_clsid: &str, _icon: &str, _sink: CommandSink) -> Result<bool, String> {
    Ok(false)
}

pub fn stop() {}

pub fn attach(_root_id: &str, _clsid: &str) -> Result<(), String> {
    Err("files:unsupported".to_string())
}

pub fn set(_root: &str, _status: Option<FilesDriveStatus>) {}

pub fn read(_root_id: &str, _wait_ms: u32) -> Result<FilesDriveStatusSeen, String> {
    Err("files:unsupported".to_string())
}
