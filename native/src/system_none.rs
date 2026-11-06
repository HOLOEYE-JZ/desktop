//! macOS and Linux: no registry, no Focus Assist, no drive letters, and main uses each OS's own
//! ways for the rest. The same exports, so the surface doesn't depend on the platform.

use crate::{CodeSignature, DriveLetterMapping, QuietState, RegistryNode};

const UNSUPPORTED: &str = "system:unsupported";

fn unsupported<T>() -> Result<T, String> {
    Err(UNSUPPORTED.to_string())
}

pub fn registry_read(_key: &str, _depth: u32) -> Result<Option<Vec<RegistryNode>>, String> {
    Err("registry:unsupported".to_string())
}

pub fn registry_set_string(_key: &str, _name: Option<&str>, _data: &str) -> Result<(), String> {
    Err("registry:unsupported".to_string())
}

pub fn registry_delete_key(_key: &str) -> Result<bool, String> {
    Err("registry:unsupported".to_string())
}

pub fn registry_delete_value(_key: &str, _name: &str) -> Result<bool, String> {
    Err("registry:unsupported".to_string())
}

pub fn quiet_state() -> QuietState {
    QuietState { profile: 0, notification_state: 0 }
}

pub fn clipboard_write_files(_paths: &[String]) -> Result<(), String> {
    Err("clipboard:unsupported".to_string())
}

pub fn folder_make_private(_path: &str) -> Result<(), String> {
    unsupported()
}

pub fn drive_letters() -> Vec<DriveLetterMapping> {
    vec![]
}

pub fn drive_letter_add(_letter: char, _target: &str) -> Result<(), String> {
    unsupported()
}

pub fn drive_letter_remove(_letter: char) -> Result<(), String> {
    unsupported()
}

pub fn set_pin(_path: &str, _pin: &str) -> Result<(), String> {
    unsupported()
}

pub fn code_signature(_path: &str) -> CodeSignature {
    CodeSignature { status: "unsupported".to_string(), code: String::new(), subject: None }
}
