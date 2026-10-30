use serde::Deserialize;
use std::io::{self, Read};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request { op: String, account: String, value: Option<String>, store: Option<String> }
pub fn run() -> Result<i32, Box<dyn std::error::Error>> {
    let mut input = String::new(); io::stdin().take(16384).read_to_string(&mut input)?;
    let request: Request = serde_json::from_str(&input)?;
    if !["set", "get", "clear"].contains(&request.op.as_str()) || request.account.len() > 256 || !request.account.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || ".:-".contains(c)) { return Err("invalid credential request".into()); }
    #[cfg(target_os = "macos")] let result = local::execute(&request)?;
    #[cfg(windows)] let result = windows::execute(&request)?;
    #[cfg(not(any(target_os = "macos", windows)))] let result: Option<String> = return Err("credentials unavailable".into());
    println!("{}", serde_json::json!({"value": result})); Ok(0)
}
#[cfg(target_os = "macos")]
mod local {
    use super::Request;
    use serde_json::{Map, Value};
    use std::{fs::{self, OpenOptions}, io::{self, Write}, os::unix::fs::{OpenOptionsExt, PermissionsExt}, path::Path, time::{SystemTime, UNIX_EPOCH}};
    pub fn execute(r: &Request) -> Result<Option<String>, Box<dyn std::error::Error>> {
        let path = Path::new(r.store.as_deref().ok_or("credential store path required")?);
        if !path.is_absolute() { return Err("credential store path must be absolute".into()); }
        let parent = path.parent().ok_or("credential store path has no parent")?;
        fs::create_dir_all(parent)?; fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
        let lock = OpenOptions::new().create(true).read(true).write(true).mode(0o600).open(path.with_extension("lock"))?;
        lock.lock()?;
        let mut entries: Map<String, Value> = match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Map::new(),
            Err(error) => return Err(error.into()),
        };
        let result = match r.op.as_str() {
            "get" => entries.get(&r.account).and_then(Value::as_str).map(str::to_owned),
            "clear" => { entries.remove(&r.account); None }
            "set" => {
                let value = r.value.as_ref().ok_or("missing secret")?;
                if value.len() > 4096 { return Err("secret too large".into()); }
                entries.insert(r.account.clone(), Value::String(value.clone())); None
            }
            _ => unreachable!(),
        };
        if r.op != "get" {
            if entries.is_empty() {
                match fs::remove_file(path) { Ok(()) => {}, Err(error) if error.kind() == io::ErrorKind::NotFound => {}, Err(error) => return Err(error.into()) }
            } else {
                let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
                let temporary = path.with_extension(format!("{}-{stamp}.tmp", std::process::id()));
                let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temporary)?;
                file.write_all(&serde_json::to_vec(&entries)?)?; file.sync_all()?;
                fs::rename(&temporary, path)?; fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
            }
        }
        Ok(result)
    }
}
#[cfg(windows)]
mod windows {
    use super::Request;
    use windows_sys::Win32::{Foundation::*, Security::Credentials::*};
    use std::{ptr::null_mut, mem::zeroed};
    pub fn execute(r: &Request) -> Result<Option<String>, Box<dyn std::error::Error>> { unsafe {
        let mut target: Vec<u16> = ("Commerce.Plugins/".to_string() + &r.account).encode_utf16().chain([0]).collect();
        if r.op == "get" { let mut credential = null_mut(); if CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) == 0 { if GetLastError() == ERROR_NOT_FOUND { return Ok(None); } return Err(std::io::Error::last_os_error().into()); }
            let bytes = std::slice::from_raw_parts((*credential).CredentialBlob, (*credential).CredentialBlobSize as usize).to_vec(); CredFree(credential as *const _); return Ok(Some(String::from_utf8(bytes)?)); }
        if r.op == "clear" { if CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) == 0 && GetLastError() != ERROR_NOT_FOUND { return Err(std::io::Error::last_os_error().into()); } return Ok(None); }
        let value = r.value.as_ref().ok_or("missing secret")?; if value.len() > 4096 { return Err("secret too large".into()); }
        let mut credential: CREDENTIALW = zeroed(); credential.Type = CRED_TYPE_GENERIC; credential.TargetName = target.as_mut_ptr(); credential.CredentialBlobSize = value.len() as u32; credential.CredentialBlob = value.as_ptr() as *mut u8; credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
        if CredWriteW(&credential, 0) == 0 { return Err(std::io::Error::last_os_error().into()); } Ok(None)
    } }
}
