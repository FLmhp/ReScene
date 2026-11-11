//! Desktop shell: hosts the shared workbench and caches scene artifacts locally.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tauri::Manager;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const CACHE_DIR: &str = "artifacts";
const HASH_BUFFER: usize = 64 * 1024;
static NEXT_PART: AtomicU64 = AtomicU64::new(0);

fn cache_path(
    app: &tauri::AppHandle,
    reconstruction_id: &str,
    extension: &str,
    sha256: &str,
    size: u64,
) -> Result<PathBuf, String> {
    let id_hash = format!("{:x}", Sha256::digest(reconstruction_id.as_bytes()));
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join(CACHE_DIR);
    Ok(directory.join(format!("{id_hash}-{sha256}-{size}.{extension}")))
}

async fn verified(path: &Path, sha256: &str, size: u64) -> bool {
    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(_) => return false,
    };
    if file.metadata().await.map(|metadata| metadata.len()).ok() != Some(size) {
        return false;
    }
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; HASH_BUFFER];
    loop {
        match file.read(&mut buffer).await {
            Ok(0) => break,
            Ok(count) => hash.update(&buffer[..count]),
            Err(_) => return false,
        }
    }
    format!("{:x}", hash.finalize()) == sha256
}

fn https_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.url().scheme() != "https" || attempt.previous().len() >= 10 {
                attempt.error("unsafe or excessive artifact redirect")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|error| error.to_string())
}

async fn stream_to_file(
    response: reqwest::Response,
    partial: &Path,
    sha256: &str,
    size: u64,
) -> Result<(), String> {
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(partial)
        .await
        .map_err(|error| error.to_string())?;
    let mut stream = response.bytes_stream();
    let mut hash = Sha256::new();
    let mut received = 0u64;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|error| error.to_string())?;
        received = received
            .checked_add(bytes.len() as u64)
            .ok_or("artifact too large")?;
        if received > size {
            return Err("artifact size mismatch".into());
        }
        file.write_all(&bytes)
            .await
            .map_err(|error| error.to_string())?;
        hash.update(bytes);
    }
    if received != size || format!("{:x}", hash.finalize()) != sha256 {
        return Err("artifact checksum or size mismatch".into());
    }
    file.flush().await.map_err(|error| error.to_string())?;
    file.sync_all().await.map_err(|error| error.to_string())?;
    Ok(())
}

/// Return only a size- and SHA-256-verified artifact, published atomically.
#[tauri::command]
async fn cache_artifact(
    app: tauri::AppHandle,
    url: String,
    reconstruction_id: String,
    kind: String,
    sha256: String,
    size: u64,
) -> Result<String, String> {
    let sha256 = sha256.to_ascii_lowercase();
    let extension = match kind.to_ascii_lowercase().as_str() {
        "spz" => "spz",
        "ply" => "ply",
        _ => return Err("unsupported artifact kind".into()),
    };
    if reconstruction_id.is_empty()
        || sha256.len() != 64
        || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        || size == 0
    {
        return Err("invalid artifact identity".into());
    }
    let parsed = reqwest::Url::parse(&url).map_err(|error| error.to_string())?;
    if parsed.scheme() != "https" {
        return Err("only https artifacts can be cached".into());
    }
    let target = cache_path(&app, &reconstruction_id, extension, &sha256, size)?;
    if verified(&target, &sha256, size).await {
        return Ok(target.to_string_lossy().into_owned());
    }
    let parent = target.parent().ok_or("invalid cache directory")?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| error.to_string())?;
    let response = https_client()?
        .get(parsed)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("download failed with {}", response.status()));
    }
    let partial = parent.join(format!(
        ".{}-{}-{}.part",
        std::process::id(),
        NEXT_PART.fetch_add(1, Ordering::Relaxed),
        sha256
    ));
    // A previous crash can leave a stale file with a reused process ID.
    if tokio::fs::metadata(&partial).await.is_ok() {
        tokio::fs::remove_file(&partial)
            .await
            .map_err(|error| error.to_string())?;
    }
    if let Err(error) = stream_to_file(response, &partial, &sha256, size).await {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(error);
    }
    if verified(&target, &sha256, size).await {
        let _ = tokio::fs::remove_file(&partial).await;
        return Ok(target.to_string_lossy().into_owned());
    }
    // Windows cannot replace an existing file. A competing successful download
    // is reusable; otherwise discard the corrupt entry before publication.
    if tokio::fs::metadata(&target).await.is_ok() {
        if let Err(error) = tokio::fs::remove_file(&target).await {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(error.to_string());
        }
    }
    match tokio::fs::rename(&partial, &target).await {
        Ok(()) => Ok(target.to_string_lossy().into_owned()),
        Err(error) => {
            let _ = tokio::fs::remove_file(&partial).await;
            if verified(&target, &sha256, size).await {
                Ok(target.to_string_lossy().into_owned())
            } else {
                Err(error.to_string())
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![cache_artifact])
        .run(tauri::generate_context!())
        .expect("failed to start the ReScene desktop shell");
}
