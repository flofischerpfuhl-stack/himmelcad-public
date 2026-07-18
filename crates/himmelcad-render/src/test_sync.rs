use std::sync::{Mutex, MutexGuard};

/// Serializes tests that enter native BasisU code or create real wgpu devices.
///
/// Both dependencies own process-global native state on some backends. Keeping
/// this lock out of pure tests preserves the normal parallel test runner while
/// preventing those native paths from overlapping. A previous test panic must
/// not poison every later native test, so recovery deliberately keeps the
/// protected resource usable.
pub(crate) fn native_gpu_or_transcoder() -> MutexGuard<'static, ()> {
    static NATIVE_TEST: Mutex<()> = Mutex::new(());
    NATIVE_TEST
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
