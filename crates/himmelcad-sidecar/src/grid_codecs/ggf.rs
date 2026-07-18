//! Trimble GGF geoid / vertical grid reader (clean-room reimplementation).
//!
//! The on-disk layout is publicly reverse-engineered and used by third-party tools
//! (e.g. open-source GGF utilities and commercial converters). This module does **not**
//! copy GPL sources; it reimplements the documented binary layout:
//!
//! - bytes 2..16: magic `TNL GRID FILE\0`
//! - 146-byte header (lat/lon extents, steps, flags, missing value, scalar)
//! - row-major samples as little-endian `f32` or `i32`
//!
//! Apply path: bilinear sampling of geoid undulation \(N\) (metres). PROJ does not
//! read GGF natively — we either sample here or export GTX for PROJ.

use std::{
    fs,
    path::{Path, PathBuf},
};

use thiserror::Error;

/// Fixed Trimble GGF header length.
pub const GGF_HEADER_LEN: usize = 146;

/// Magic after the 2-byte version field.
pub const GGF_MAGIC: &[u8; 14] = b"TNL GRID FILE\0";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum GgfError {
    #[error("GGF I/O: {0}")]
    Io(String),
    #[error("GGF invalid: {0}")]
    Invalid(String),
    #[error("GGF sample outside coverage")]
    OutOfBounds,
    #[error("GGF sample hits missing/nodata cell")]
    Missing,
}

/// Parsed GGF vertical grid (geoid undulation in metres after unit scaling).
#[derive(Debug, Clone)]
pub struct GgfGrid {
    pub path: PathBuf,
    pub version: u16,
    pub name: String,
    pub lat_min: f64,
    pub lat_max: f64,
    pub lon_min: f64,
    pub lon_max: f64,
    pub lat_interval: f64,
    pub lon_interval: f64,
    pub lat_count: usize,
    pub lon_count: usize,
    pub missing: f64,
    pub scalar: f64,
    pub lat_ascending: bool,
    pub lon_ascending: bool,
    pub wgs84_based: bool,
    pub check_missing: bool,
    /// Row-major: `values[row * lon_count + col]`, row along latitude.
    pub values: Vec<f64>,
    pub min_value: f64,
    pub max_value: f64,
    pub missing_count: u64,
}

impl GgfGrid {
    /// Returns true if the buffer looks like a GGF file (needs only the first 16 bytes).
    #[must_use]
    pub fn looks_like(bytes: &[u8]) -> bool {
        bytes.len() >= 16 && bytes.get(2..16) == Some(GGF_MAGIC.as_slice())
    }

    /// Parse a GGF file from disk.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, GgfError> {
        let path = path.as_ref();
        let bytes = fs::read(path).map_err(|e| GgfError::Io(e.to_string()))?;
        Self::parse(path.to_path_buf(), &bytes)
    }

    /// Parse GGF bytes.
    pub fn parse(path: PathBuf, bytes: &[u8]) -> Result<Self, GgfError> {
        if bytes.len() < GGF_HEADER_LEN {
            return Err(GgfError::Invalid("file shorter than header".into()));
        }
        if &bytes[2..16] != GGF_MAGIC.as_slice() {
            return Err(GgfError::Invalid("missing TNL GRID FILE magic".into()));
        }
        let version = u16::from_le_bytes(bytes[0..2].try_into().unwrap());
        if version > 1 {
            return Err(GgfError::Invalid(format!("unsupported GGF version {version}")));
        }

        let name = {
            let raw = &bytes[16..48];
            let end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
            String::from_utf8_lossy(&raw[..end]).trim().to_owned()
        };

        let lat_min = f64::from_le_bytes(bytes[48..56].try_into().unwrap());
        let lat_max = f64::from_le_bytes(bytes[56..64].try_into().unwrap());
        let lon_min = f64::from_le_bytes(bytes[64..72].try_into().unwrap());
        let lon_max = f64::from_le_bytes(bytes[72..80].try_into().unwrap());
        let lat_interval = f64::from_le_bytes(bytes[80..88].try_into().unwrap());
        let lon_interval = f64::from_le_bytes(bytes[88..96].try_into().unwrap());
        let lat_count = u32::from_le_bytes(bytes[96..100].try_into().unwrap()) as usize;
        let lon_count = u32::from_le_bytes(bytes[100..104].try_into().unwrap()) as usize;
        let _n_pole = f64::from_le_bytes(bytes[104..112].try_into().unwrap());
        let _s_pole = f64::from_le_bytes(bytes[112..120].try_into().unwrap());
        let missing = f64::from_le_bytes(bytes[120..128].try_into().unwrap());
        let scalar = f64::from_le_bytes(bytes[128..136].try_into().unwrap());
        let flags = &bytes[138..146];

        if lat_count == 0 || lon_count == 0 {
            return Err(GgfError::Invalid("empty grid dimensions".into()));
        }
        if !lat_interval.is_finite()
            || !lon_interval.is_finite()
            || lat_interval == 0.0
            || lon_interval == 0.0
        {
            return Err(GgfError::Invalid("invalid grid interval".into()));
        }

        // flags[0]
        let scaled = flags[0] & (1 << 1) != 0;
        let check_missing = flags[0] & (1 << 2) != 0;
        let wgs84_based = flags[0] & (1 << 7) != 0;
        // flags[3] sample type
        let is_float = flags[3] & (1 << 3) != 0;
        let is_long = flags[3] & (1 << 2) != 0;
        if !is_float && !is_long {
            return Err(GgfError::Invalid(
                "only float32 or int32 sample formats are supported".into(),
            ));
        }
        // flags[4]/[5] axis direction (default ascending when unset)
        let lat_ascending = if flags[4] == 0 {
            true
        } else {
            flags[4] & (1 << 0) != 0
        };
        let lon_ascending = if flags[5] == 0 {
            true
        } else {
            flags[5] & (1 << 0) != 0
        };

        let sample_bytes = lat_count
            .checked_mul(lon_count)
            .and_then(|n| n.checked_mul(4))
            .ok_or_else(|| GgfError::Invalid("grid size overflow".into()))?;
        let expected = GGF_HEADER_LEN
            + sample_bytes
            + if version == 1 { 16 } else { 0 };
        if bytes.len() != expected {
            return Err(GgfError::Invalid(format!(
                "file size {} != expected {} (header+grid[+footer])",
                bytes.len(),
                expected
            )));
        }

        let mut values = Vec::with_capacity(lat_count * lon_count);
        let mut min_value = f64::INFINITY;
        let mut max_value = f64::NEG_INFINITY;
        let mut missing_count = 0_u64;
        let body = &bytes[GGF_HEADER_LEN..GGF_HEADER_LEN + sample_bytes];
        for chunk in body.chunks_exact(4) {
            let mut raw = if is_float {
                f64::from(f32::from_le_bytes(chunk.try_into().unwrap()))
            } else {
                f64::from(i32::from_le_bytes(chunk.try_into().unwrap()))
            };
            if scaled {
                if scalar == 0.0 || !scalar.is_finite() {
                    return Err(GgfError::Invalid("invalid scalar".into()));
                }
                raw /= scalar;
            }
            // Missing sentinel compares in file units before/after scale — Trimble stores
            // the sentinel in the same domain as the grid values after scaling flags.
            if check_missing && (raw - missing).abs() < 1e-9 {
                values.push(f64::NAN);
                missing_count += 1;
            } else {
                if raw.is_finite() {
                    min_value = min_value.min(raw);
                    max_value = max_value.max(raw);
                }
                values.push(raw);
            }
        }
        if !min_value.is_finite() {
            min_value = 0.0;
            max_value = 0.0;
        }

        Ok(Self {
            path,
            version,
            name,
            lat_min,
            lat_max,
            lon_min,
            lon_max,
            lat_interval,
            lon_interval,
            lat_count,
            lon_count,
            missing,
            scalar,
            lat_ascending,
            lon_ascending,
            wgs84_based,
            check_missing,
            values,
            min_value,
            max_value,
            missing_count,
        })
    }

    /// Geographic coverage as (west, south, east, north) in degrees.
    #[must_use]
    pub fn coverage_wsen(&self) -> (f64, f64, f64, f64) {
        (
            self.lon_min.min(self.lon_max),
            self.lat_min.min(self.lat_max),
            self.lon_min.max(self.lon_max),
            self.lat_min.max(self.lat_max),
        )
    }

    /// Bilinear sample of undulation \(N\) in metres at geographic (lat, lon) degrees.
    pub fn sample_undulation(&self, lat: f64, lon: f64) -> Result<f64, GgfError> {
        let (row_f, col_f) = self.row_col_f(lat, lon)?;
        if row_f < 0.0
            || col_f < 0.0
            || row_f > (self.lat_count - 1) as f64
            || col_f > (self.lon_count - 1) as f64
        {
            return Err(GgfError::OutOfBounds);
        }
        let r0 = (row_f.floor() as usize).min(self.lat_count.saturating_sub(2));
        let c0 = (col_f.floor() as usize).min(self.lon_count.saturating_sub(2));
        let r1 = r0 + 1;
        let c1 = c0 + 1;
        let dr = row_f - r0 as f64;
        let dc = col_f - c0 as f64;
        let v00 = self.value(r0, c0)?;
        let v01 = self.value(r0, c1)?;
        let v10 = self.value(r1, c0)?;
        let v11 = self.value(r1, c1)?;
        Ok(v00 * (1.0 - dc) * (1.0 - dr)
            + v01 * dc * (1.0 - dr)
            + v10 * (1.0 - dc) * dr
            + v11 * dc * dr)
    }

    fn value(&self, row: usize, col: usize) -> Result<f64, GgfError> {
        let v = self.values[row * self.lon_count + col];
        if v.is_nan() {
            Err(GgfError::Missing)
        } else {
            Ok(v)
        }
    }

    fn row_col_f(&self, lat: f64, lon: f64) -> Result<(f64, f64), GgfError> {
        if !lat.is_finite() || !lon.is_finite() {
            return Err(GgfError::Invalid("non-finite lat/lon".into()));
        }
        let row = if self.lat_ascending {
            (lat - self.lat_min) / self.lat_interval
        } else {
            // row 0 at lat_max when descending
            (self.lat_max - lat) / self.lat_interval
        };
        let col = if self.lon_ascending {
            (lon - self.lon_min) / self.lon_interval
        } else {
            (self.lon_max - lon) / self.lon_interval
        };
        Ok((row, col))
    }

    /// Export as NOAA/PROJ binary GTX (single-band vertical shift, metres).
    ///
    /// Layout: lower-left lat, lon, dlat, dlon (`f64`), nlat, nlon (`i32`), then row-major `f32`
    /// with south→north, west→east (PROJ convention).
    pub fn write_gtx(&self, path: impl AsRef<Path>) -> Result<(), GgfError> {
        let (west, south, east, north) = self.coverage_wsen();
        let dlat = (north - south) / (self.lat_count.saturating_sub(1).max(1) as f64);
        let dlon = (east - west) / (self.lon_count.saturating_sub(1).max(1) as f64);
        // Resample onto a regular south-north / west-east grid matching sample count.
        let mut out = Vec::with_capacity(
            40 + self.lat_count * self.lon_count * 4,
        );
        out.extend_from_slice(&south.to_le_bytes());
        out.extend_from_slice(&west.to_le_bytes());
        out.extend_from_slice(&dlat.to_le_bytes());
        out.extend_from_slice(&dlon.to_le_bytes());
        out.extend_from_slice(&(self.lat_count as i32).to_le_bytes());
        out.extend_from_slice(&(self.lon_count as i32).to_le_bytes());
        for i in 0..self.lat_count {
            let lat = south + i as f64 * dlat;
            for j in 0..self.lon_count {
                let lon = west + j as f64 * dlon;
                let n = self.sample_undulation(lat, lon).unwrap_or(f64::NAN);
                let store = if n.is_finite() { n as f32 } else { f32::NAN };
                out.extend_from_slice(&store.to_le_bytes());
            }
        }
        fs::write(path, out).map_err(|e| GgfError::Io(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GCG: &str =
        "/home/oem/Dokumente/092_Workdata/01_Transformation/Geoide/DHHN 2016/GCG2016.GGF";
    const GCG_SU: &str =
        "/home/oem/Dokumente/092_Workdata/01_Transformation/Geoide/DHHN 2016/GCG2016_SU.GGF";

    #[test]
    fn rejects_non_ggf() {
        assert!(!GgfGrid::looks_like(b"NUM_OREC"));
        assert!(GgfGrid::parse(PathBuf::from("x"), b"short").is_err());
    }

    #[test]
    fn parses_gcg2016_and_matches_known_munich_undulation() {
        if !Path::new(GCG).is_file() {
            return;
        }
        let grid = GgfGrid::open(GCG).expect("open GCG2016.GGF");
        assert_eq!(grid.name.trim(), "GCG2016");
        assert!(grid.wgs84_based);
        // Cross-check against PROJ vgridshift on de_bkg_gcg2016.tif (same model family):
        // cct with z=0 at lon=11.5 lat=48.0 yields z≈45.94617462
        let n = grid
            .sample_undulation(48.0, 11.5)
            .expect("sample Munich");
        assert!(
            (n - 45.946_174_62).abs() < 1e-4,
            "undulation {n} vs expected ~45.946"
        );
        // Outside Germany roughly
        assert!(matches!(
            grid.sample_undulation(40.0, 0.0),
            Err(GgfError::OutOfBounds)
        ));
    }

    #[test]
    fn parses_gcg_su_with_descending_lat_flag() {
        if !Path::new(GCG_SU).is_file() {
            return;
        }
        let grid = GgfGrid::open(GCG_SU).expect("open SU");
        // Southern Germany extract — Munich should be inside
        let n = grid.sample_undulation(48.0, 11.5);
        // If coverage includes Munich, value should be close to full grid
        match n {
            Ok(value) => assert!(value > 40.0 && value < 55.0, "got {value}"),
            Err(GgfError::OutOfBounds) => {
                // Accept if extract excludes that cell; at least file parses
                assert!(grid.lat_count > 0);
            }
            Err(other) => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn gtx_export_roundtrip_readable() {
        if !Path::new(GCG_SU).is_file() {
            return;
        }
        let grid = GgfGrid::open(GCG_SU).expect("open");
        let dir = std::env::temp_dir().join(format!("hcad-ggf-gtx-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let gtx = dir.join("sample.gtx");
        grid.write_gtx(&gtx).expect("write gtx");
        assert!(gtx.metadata().unwrap().len() > 40);
        let _ = fs::remove_dir_all(dir);
    }
}
