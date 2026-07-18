use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Content-addressable object hash. SHA-256, hex-encoded.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(transparent)]
pub struct ObjectHash(pub String);

impl ObjectHash {
    #[must_use]
    pub fn of_bytes(bytes: &[u8]) -> Self {
        let mut h = Sha256::new();
        h.update(bytes);
        Self(hex::encode(h.finalize()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
