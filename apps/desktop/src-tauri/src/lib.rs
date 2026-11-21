//! Desktop shell: hosts the shared workbench and caches scene artifacts locally.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tauri::Manager;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const CACHE_DIR: &str = "artifacts";
const HASH_BUFFER: usize = 64 * 1024;
static NEXT_PART: AtomicU64 = AtomicU64::new(0);
static CACHE_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();

// The registry mutex is held only for lookup/removal, never across an await.
// Drop also removes cancelled waiters, so abandoned requests cannot leak keys.
struct CacheLock {
    target: PathBuf,
    entry: Arc<tokio::sync::Mutex<()>>,
}

impl CacheLock {
    fn new(target: &Path) -> Self {
        let mut locks = CACHE_LOCKS.get_or_init(Default::default).lock().unwrap();
        let entry = locks.entry(target.to_owned()).or_default().clone();
        Self {
            target: target.to_owned(),
            entry,
        }
    }
}

impl Drop for CacheLock {
    fn drop(&mut self) {
        let mut locks = CACHE_LOCKS.get_or_init(Default::default).lock().unwrap();
        if Arc::strong_count(&self.entry) == 2 {
            locks.remove(&self.target);
        }
    }
}

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
    let expected_hash = &sha256;
    cache_with_download(target, &sha256, size, |partial| async move {
        let response = https_client()?
            .get(parsed)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("download failed with {}", response.status()));
        }
        stream_to_file(response, &partial, expected_hash, size).await
    })
    .await
}

async fn cache_with_download<F, Fut>(
    target: PathBuf,
    sha256: &str,
    size: u64,
    download: F,
) -> Result<String, String>
where
    F: FnOnce(PathBuf) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let lock = CacheLock::new(&target);
    let _guard = lock.entry.lock().await;
    if verified(&target, sha256, size).await {
        return Ok(target.to_string_lossy().into_owned());
    }
    let parent = target.parent().ok_or("invalid cache directory")?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| error.to_string())?;
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
    if let Err(error) = download(partial.clone()).await {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(error);
    }
    if verified(&target, sha256, size).await {
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
            if verified(&target, sha256, size).await {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use tokio::sync::oneshot;

    fn fixture() -> (PathBuf, String) {
        let dir = std::env::temp_dir().join(format!(
            "rescene-cache-test-{}-{}",
            std::process::id(),
            NEXT_PART.fetch_add(1, Ordering::Relaxed)
        ));
        (dir, format!("{:x}", Sha256::digest(b"complete")))
    }

    #[test]
    fn same_key_reuses_published_file_and_retries_failure() {
        tauri::async_runtime::block_on(async {
            let (dir, hash) = fixture();
            let target = dir.join("scene.spz");
            let calls = AtomicUsize::new(0);
            let (started_tx, started_rx) = oneshot::channel();
            let (release_tx, release_rx) = oneshot::channel();
            let first = cache_with_download(target.clone(), &hash, 8, |partial| async {
                calls.fetch_add(1, Ordering::SeqCst);
                started_tx.send(()).unwrap();
                release_rx.await.unwrap();
                tokio::fs::write(partial, b"complete")
                    .await
                    .map_err(|e| e.to_string())
            });
            let second = async {
                started_rx.await.unwrap();
                let request = cache_with_download(target.clone(), &hash, 8, |partial| async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    tokio::fs::write(partial, b"complete")
                        .await
                        .map_err(|e| e.to_string())
                });
                let release = async {
                    release_tx.send(()).unwrap();
                };
                let (result, ()) = futures_util::join!(request, release);
                result
            };
            let (a, b) = futures_util::join!(first, second);
            assert_eq!(a.unwrap(), b.unwrap());
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert_eq!(tokio::fs::read(&target).await.unwrap(), b"complete");
            let open_file = tokio::fs::File::open(&target).await.unwrap();
            let cached = cache_with_download(target.clone(), &hash, 8, |_| async {
                Err("cached artifact should not be downloaded".into())
            })
            .await;
            assert!(cached.is_ok());
            drop(open_file);
            // A corrupt historical entry is replaced; an interrupted download is cleaned up.
            tokio::fs::write(&target, b"broken").await.unwrap();
            let failed = cache_with_download(target.clone(), &hash, 8, |partial| async move {
                tokio::fs::write(partial, b"partial").await.unwrap();
                Err("network failure".into())
            })
            .await;
            assert!(failed.is_err());
            let mut entries = tokio::fs::read_dir(&dir).await.unwrap();
            assert_eq!(entries.next_entry().await.unwrap().unwrap().path(), target);
            assert!(entries.next_entry().await.unwrap().is_none());
            let retry = cache_with_download(target.clone(), &hash, 8, |partial| async move {
                tokio::fs::write(partial, b"complete")
                    .await
                    .map_err(|e| e.to_string())
            })
            .await;
            assert!(retry.is_ok());
            assert_eq!(tokio::fs::read(&target).await.unwrap(), b"complete");
            tokio::fs::remove_dir_all(dir).await.unwrap();
        });
    }

    #[test]
    fn waiting_request_retries_failed_download() {
        tauri::async_runtime::block_on(async {
            let (dir, hash) = fixture();
            let target = dir.join("scene");
            let (started_tx, started_rx) = oneshot::channel();
            let (release_tx, release_rx) = oneshot::channel();
            let first = cache_with_download(target.clone(), &hash, 8, |partial| async move {
                tokio::fs::write(partial, b"partial").await.unwrap();
                started_tx.send(()).unwrap();
                release_rx.await.unwrap();
                Err("network failure".into())
            });
            let second = async {
                started_rx.await.unwrap();
                let retry = cache_with_download(target.clone(), &hash, 8, |partial| async move {
                    tokio::fs::write(partial, b"complete")
                        .await
                        .map_err(|e| e.to_string())
                });
                let release = async {
                    release_tx.send(()).unwrap();
                };
                futures_util::join!(retry, release).0
            };
            let (failed, succeeded) = futures_util::join!(first, second);
            assert!(failed.is_err());
            assert!(succeeded.is_ok());
            assert_eq!(tokio::fs::read(&target).await.unwrap(), b"complete");
            let mut entries = tokio::fs::read_dir(&dir).await.unwrap();
            assert!(entries.next_entry().await.unwrap().is_some());
            assert!(entries.next_entry().await.unwrap().is_none());
            tokio::fs::remove_dir_all(dir).await.unwrap();
        });
    }

    #[test]
    fn distinct_keys_download_concurrently() {
        tauri::async_runtime::block_on(async {
            let (dir, hash) = fixture();
            let (started_tx, started_rx) = oneshot::channel();
            let (release_tx, release_rx) = oneshot::channel();
            let first = cache_with_download(dir.join("first"), &hash, 8, |partial| async move {
                started_tx.send(()).unwrap();
                release_rx.await.unwrap();
                tokio::fs::write(partial, b"complete")
                    .await
                    .map_err(|e| e.to_string())
            });
            let second = async {
                started_rx.await.unwrap();
                cache_with_download(dir.join("second"), &hash, 8, |partial| async move {
                    release_tx.send(()).unwrap();
                    tokio::fs::write(partial, b"complete")
                        .await
                        .map_err(|e| e.to_string())
                })
                .await
            };
            let (a, b) = futures_util::join!(first, second);
            assert!(a.is_ok() && b.is_ok());
            tokio::fs::remove_dir_all(dir).await.unwrap();
        });
    }
}
