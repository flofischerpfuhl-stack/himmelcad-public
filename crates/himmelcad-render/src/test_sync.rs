use tokio::sync::{Mutex, MutexGuard};

/// Serializes tests that enter native `BasisU` code or create real wgpu devices.
///
/// Both dependencies own process-global native state on some backends. Keeping
/// this lock out of pure tests preserves the normal parallel test runner while
/// preventing those native paths from overlapping.
pub(crate) async fn native_gpu_or_transcoder() -> MutexGuard<'static, ()> {
    static NATIVE_TEST: Mutex<()> = Mutex::const_new(());
    NATIVE_TEST.lock().await
}
