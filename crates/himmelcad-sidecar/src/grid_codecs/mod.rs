//! Binary grid / geoid codecs that PROJ does not (or does not fully) cover.
//!
//! Open PROJ-native formats (NTv2 GSB, GTX, GTG) are inspected lightly and applied via `cct`.
//! Proprietary-but-decodable formats (GGF) are parsed here and either sampled natively or
//! exported to GTX for PROJ.

pub mod ggf;

pub use ggf::{GgfError, GgfGrid, GGF_MAGIC};
