//! Shared image and capture contracts that break the capture/image module cycle.

use serde::{Deserialize, Serialize};

/// Photo containers accepted by the PhotoLab discovery stage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PhotoFormat {
    Jpeg,
    Tiff,
    Dng,
    Png,
    Heic,
    Heif,
    Avif,
    CanonCr3,
    FujifilmRaf,
    PhaseOneIiq,
}
