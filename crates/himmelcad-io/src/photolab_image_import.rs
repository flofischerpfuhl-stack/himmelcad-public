//! Recursive, non-fatal Photolab image discovery and metadata import.

use std::{
    collections::HashMap,
    fs::{self, File},
    io::{self, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use himmelcad_core::{
    hash::ObjectHash,
    photolab_capture::{CaptureCapabilityInventory, CaptureDecodeSupport},
    photolab_images::{
        CaptureTime, CaptureTimeReference, DiscoveredPhoto, DjiAttitudeDegrees,
        DjiBrownConradyCalibration, DjiCalibrationProvenance, DjiRtkMetadata, DjiXmpMetadata,
        ExifGpsPosition, ExifOrientation, ExifPhotoMetadata, ImageDimensions, ImageImportWarning,
        ImageImportWarningCode, ImportedHeight, PhotoFormat, PhotoImportBatch, PhotoMetadata,
    },
};
use nom_exif::{EntryValue, Exif, ExifDateTime, ExifTag, MediaParser, MediaSource};
use sha2::{Digest, Sha256};

const HASH_BUFFER_BYTES: usize = 64 * 1024;
const MAX_JPEG_XMP_SCAN_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TOTAL_XMP_PAYLOAD_BYTES: usize = 512 * 1024;
const MAX_EXIF_ENTRY_WARNINGS: usize = 16;
const XMP_HEADER: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";

/// Supported source discovered before hashing and metadata parsing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhotoImportCandidate {
    pub path: PathBuf,
    pub format: PhotoFormat,
}

/// Discovery result keeps path problems local instead of aborting a batch.
#[derive(Debug, Default)]
pub struct PhotoDiscovery {
    pub candidates: Vec<PhotoImportCandidate>,
    pub warnings: Vec<ImageImportWarning>,
}

/// Recursively discovers supported photos without following symbolic links.
#[must_use]
pub fn discover_photo_files(inputs: &[PathBuf]) -> PhotoDiscovery {
    let mut cancelled = || false;
    let mut progress = |_: usize, _: usize| {};
    discover_photo_files_with_progress(inputs, &mut cancelled, &mut progress)
        .expect("discovery without cancellation must complete")
}

fn discover_photo_files_with_progress<C, P>(
    inputs: &[PathBuf],
    cancelled: &mut C,
    progress: &mut P,
) -> Option<PhotoDiscovery>
where
    C: FnMut() -> bool,
    P: FnMut(usize, usize),
{
    let mut discovery = PhotoDiscovery::default();
    let mut folder_count = 0_usize;
    for input in inputs {
        if !discover_path(
            input,
            &mut discovery,
            &mut folder_count,
            cancelled,
            progress,
        ) {
            return None;
        }
    }
    discovery.candidates.sort_by(|left, right| {
        left.path
            .as_os_str()
            .cmp(right.path.as_os_str())
            .then_with(|| format_rank(left.format).cmp(&format_rank(right.format)))
    });
    Some(discovery)
}

/// Discovers, hashes and parses all supported photos. Individual failures become warnings.
#[must_use]
pub fn import_photo_files(inputs: &[PathBuf]) -> PhotoImportBatch {
    import_photo_files_with_progress(inputs, || false, |_, _| {})
        .expect("a photo import without cancellation cannot be cancelled")
}

/// Discovers, hashes and parses supported photos while reporting real per-file
/// progress and checking for cooperative cancellation between files.
///
/// `None` is returned only after `cancelled` reports true. Callers must discard
/// the partial in-memory batch in that case; no project state is modified here.
pub fn import_photo_files_with_progress<C, P>(
    inputs: &[PathBuf],
    cancelled: C,
    progress: P,
) -> Option<PhotoImportBatch>
where
    C: FnMut() -> bool,
    P: FnMut(f64, &str),
{
    let capabilities = CaptureCapabilityInventory::portable_defaults();
    import_photo_files_with_capabilities_and_progress(inputs, &capabilities, cancelled, progress)
}

/// Same discovery path with one frozen host capability snapshot.
pub fn import_photo_files_with_capabilities_and_progress<C, P>(
    inputs: &[PathBuf],
    capabilities: &CaptureCapabilityInventory,
    mut cancelled: C,
    mut progress: P,
) -> Option<PhotoImportBatch>
where
    C: FnMut() -> bool,
    P: FnMut(f64, &str),
{
    progress(0.01, "Scanning folders · 0 images found");
    let discovery = discover_photo_files_with_progress(
        inputs,
        &mut cancelled,
        &mut |image_count, folder_count| {
            progress(
                0.01,
                &format!("Scanning folders · {image_count} images found · {folder_count} folders"),
            );
        },
    )?;
    let mut batch = PhotoImportBatch {
        photos: Vec::with_capacity(discovery.candidates.len()),
        warnings: discovery.warnings,
    };
    let mut first_path_by_hash = HashMap::<ObjectHash, String>::new();
    let mut exif_parser = MediaParser::new();

    let total = discovery.candidates.len();
    progress(0.05, &format!("Found {total} supported image file(s)"));
    for (index, candidate) in discovery.candidates.into_iter().enumerate() {
        if cancelled() {
            return None;
        }
        let source_path = path_string(&candidate.path);
        let filename = candidate
            .path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&source_path)
            .to_owned();
        progress(
            0.05 + 0.9 * index as f64 / total.max(1) as f64,
            &format!("Reading image {} of {total}: {filename}", index + 1),
        );
        let item_start = 0.05 + 0.9 * index as f64 / total.max(1) as f64;
        let item_span = 0.9 / total.max(1) as f64;
        let (sha256, byte_size) = match streaming_sha256_with_cancel(
            &candidate.path,
            &mut cancelled,
            |completed, bytes| {
                let local = if bytes == 0 {
                    1.0
                } else {
                    completed as f64 / bytes as f64
                };
                progress(
                    item_start + item_span * local.clamp(0.0, 1.0) * 0.8,
                    &format!(
                        "Hashing image {} of {total}: {filename} · {:.0}%",
                        index + 1,
                        local * 100.0
                    ),
                );
            },
        ) {
            Ok(Some(result)) => result,
            Ok(None) => return None,
            Err(error) => {
                batch.warnings.push(warning(
                    &candidate.path,
                    ImageImportWarningCode::FileReadFailed,
                    format!("failed to hash photo: {error}"),
                ));
                continue;
            }
        };

        progress(
            item_start + item_span * 0.82,
            &format!("Reading metadata {} of {total}: {filename}", index + 1),
        );

        let duplicate_of = first_path_by_hash.get(&sha256).cloned();
        if let Some(original) = duplicate_of.as_ref() {
            batch.warnings.push(warning(
                &candidate.path,
                ImageImportWarningCode::DuplicateContent,
                format!("photo content duplicates '{original}'"),
            ));
        } else {
            first_path_by_hash.insert(sha256.clone(), source_path.clone());
        }

        let exif = parse_exif_metadata(&candidate.path, &mut exif_parser, &mut batch.warnings);
        let dji_xmp = if candidate.format == PhotoFormat::Jpeg {
            parse_dji_xmp_from_jpeg(&candidate.path, exif.dimensions, &mut batch.warnings)
        } else {
            DjiXmpMetadata::default()
        };

        let capture_source = PhotoMetadata {
            exif: exif.clone(),
            dji_xmp: dji_xmp.clone(),
        }
        .capture_source_profile();
        let position_prior = PhotoMetadata {
            exif: exif.clone(),
            dji_xmp: dji_xmp.clone(),
        }
        .position_prior();
        let decoder_capability = capabilities.decoder(candidate.format).cloned();
        if decoder_capability.as_ref().is_none_or(|capability| {
            matches!(capability.support, CaptureDecodeSupport::Unsupported { .. })
        }) {
            batch.warnings.push(warning(
                &candidate.path,
                ImageImportWarningCode::DecoderUnavailable,
                format!(
                    "{:?} source was preserved, but no compatible decoder/transcoder is available",
                    candidate.format
                ),
            ));
        }
        batch.photos.push(DiscoveredPhoto {
            source_path,
            format: candidate.format,
            byte_size,
            sha256,
            metadata: PhotoMetadata { exif, dji_xmp },
            capture_source,
            decoder_capability,
            position_prior,
            derived_provenance: None,
            duplicate_of,
        });
        progress(
            0.05 + 0.9 * (index + 1) as f64 / total.max(1) as f64,
            &format!("Validated image {} of {total}: {filename}", index + 1),
        );
    }

    if cancelled() {
        None
    } else {
        progress(1.0, &format!("Validated {total} image file(s)"));
        Some(batch)
    }
}

fn discover_path<C, P>(
    path: &Path,
    discovery: &mut PhotoDiscovery,
    folder_count: &mut usize,
    cancelled: &mut C,
    progress: &mut P,
) -> bool
where
    C: FnMut() -> bool,
    P: FnMut(usize, usize),
{
    if cancelled() {
        return false;
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            discovery.warnings.push(warning(
                path,
                ImageImportWarningCode::PathUnavailable,
                format!("cannot inspect input path: {error}"),
            ));
            return true;
        }
    };

    if metadata.file_type().is_symlink() {
        discovery.warnings.push(warning(
            path,
            ImageImportWarningCode::SymlinkSkipped,
            "symbolic links are not followed during photo discovery".to_owned(),
        ));
        return true;
    }
    if metadata.is_dir() {
        *folder_count = folder_count.saturating_add(1);
        progress(discovery.candidates.len(), *folder_count);
        let entries = match fs::read_dir(path) {
            Ok(entries) => entries,
            Err(error) => {
                discovery.warnings.push(warning(
                    path,
                    ImageImportWarningCode::DirectoryReadFailed,
                    format!("cannot read directory: {error}"),
                ));
                return true;
            }
        };
        let mut paths = Vec::new();
        for entry in entries {
            if cancelled() {
                return false;
            }
            match entry {
                Ok(entry) => paths.push(entry.path()),
                Err(error) => discovery.warnings.push(warning(
                    path,
                    ImageImportWarningCode::DirectoryReadFailed,
                    format!("cannot inspect directory entry: {error}"),
                )),
            }
        }
        paths.sort();
        for child in paths {
            if !discover_path(&child, discovery, folder_count, cancelled, progress) {
                return false;
            }
        }
        return true;
    }
    if !metadata.is_file() {
        return true;
    }

    match photo_format(path) {
        Some(format) => {
            discovery.candidates.push(PhotoImportCandidate {
                path: path.to_path_buf(),
                format,
            });
            progress(discovery.candidates.len(), *folder_count);
        }
        None => discovery.warnings.push(warning(
            path,
            ImageImportWarningCode::UnsupportedFormat,
            "file extension is not a supported photo format".to_owned(),
        )),
    }
    true
}

fn photo_format(path: &Path) -> Option<PhotoFormat> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "jpg" | "jpeg" => Some(PhotoFormat::Jpeg),
        "tif" | "tiff" => Some(PhotoFormat::Tiff),
        "dng" => Some(PhotoFormat::Dng),
        "png" => Some(PhotoFormat::Png),
        "heic" => Some(PhotoFormat::Heic),
        "heif" => Some(PhotoFormat::Heif),
        "avif" => Some(PhotoFormat::Avif),
        "cr3" => Some(PhotoFormat::CanonCr3),
        "raf" => Some(PhotoFormat::FujifilmRaf),
        "iiq" => Some(PhotoFormat::PhaseOneIiq),
        _ => None,
    }
}

const fn format_rank(format: PhotoFormat) -> u8 {
    match format {
        PhotoFormat::Jpeg => 0,
        PhotoFormat::Tiff => 1,
        PhotoFormat::Dng => 2,
        PhotoFormat::Png => 3,
        PhotoFormat::Heic => 4,
        PhotoFormat::Heif => 5,
        PhotoFormat::Avif => 6,
        PhotoFormat::CanonCr3 => 7,
        PhotoFormat::FujifilmRaf => 8,
        PhotoFormat::PhaseOneIiq => 9,
    }
}

fn streaming_sha256_with_cancel<C, P>(
    path: &Path,
    cancelled: &mut C,
    mut progress: P,
) -> io::Result<Option<(ObjectHash, u64)>>
where
    C: FnMut() -> bool,
    P: FnMut(u64, u64),
{
    let total_bytes = path.metadata()?.len();
    let mut reader = BufReader::with_capacity(HASH_BUFFER_BYTES, File::open(path)?);
    let mut digest = Sha256::new();
    let mut byte_size = 0_u64;
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES].into_boxed_slice();
    loop {
        if cancelled() {
            return Ok(None);
        }
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        byte_size = byte_size.saturating_add(read as u64);
        progress(byte_size, total_bytes);
    }
    Ok(Some((
        ObjectHash(hex::encode(digest.finalize())),
        byte_size,
    )))
}

fn warning(path: &Path, code: ImageImportWarningCode, message: String) -> ImageImportWarning {
    ImageImportWarning {
        source_path: path_string(path),
        code,
        message,
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn parse_exif_metadata(
    path: &Path,
    parser: &mut MediaParser,
    warnings: &mut Vec<ImageImportWarning>,
) -> ExifPhotoMetadata {
    let source = match MediaSource::open(path) {
        Ok(source) => source,
        Err(error) => {
            warnings.push(warning(
                path,
                ImageImportWarningCode::ExifParseFailed,
                format!("cannot open photo for EXIF parsing: {error}"),
            ));
            return ExifPhotoMetadata::default();
        }
    };
    let exif: Exif = match parser.parse_exif(source) {
        Ok(iter) => iter.into(),
        Err(error) => {
            warnings.push(warning(
                path,
                ImageImportWarningCode::ExifParseFailed,
                format!("EXIF metadata unavailable or malformed: {error}"),
            ));
            return ExifPhotoMetadata::default();
        }
    };

    for (ifd, tag, error) in exif.errors().iter().take(MAX_EXIF_ENTRY_WARNINGS) {
        warnings.push(warning(
            path,
            ImageImportWarningCode::ExifEntryInvalid,
            format!(
                "invalid EXIF entry {tag} in IFD {}: {error}",
                ifd.as_usize()
            ),
        ));
    }
    if exif.errors().len() > MAX_EXIF_ENTRY_WARNINGS {
        warnings.push(warning(
            path,
            ImageImportWarningCode::ExifEntryInvalid,
            format!(
                "{} additional invalid EXIF entries were suppressed",
                exif.errors().len() - MAX_EXIF_ENTRY_WARNINGS
            ),
        ));
    }

    let make = exif_text(&exif, ExifTag::Make);
    let model = exif_text(&exif, ExifTag::Model);
    let lens_model = exif_text(&exif, ExifTag::LensModel);
    let focal_length_mm =
        finite_positive(exif_value(&exif, ExifTag::FocalLength).and_then(EntryValue::try_as_float));
    let width =
        exif_u32(&exif, ExifTag::ExifImageWidth).or_else(|| exif_u32(&exif, ExifTag::ImageWidth));
    let height =
        exif_u32(&exif, ExifTag::ExifImageHeight).or_else(|| exif_u32(&exif, ExifTag::ImageHeight));
    let dimensions = match (width, height) {
        (Some(width_pixels), Some(height_pixels)) if width_pixels > 0 && height_pixels > 0 => {
            Some(ImageDimensions {
                width_pixels,
                height_pixels,
            })
        }
        _ => None,
    };
    let orientation = exif_value(&exif, ExifTag::Orientation)
        .and_then(EntryValue::try_as_integer)
        .and_then(|value| u16::try_from(value).ok())
        .and_then(ExifOrientation::from_exif_value);
    let captured_at = [
        ExifTag::DateTimeOriginal,
        ExifTag::CreateDate,
        ExifTag::ModifyDate,
    ]
    .into_iter()
    .find_map(|tag| exif_value(&exif, tag).and_then(EntryValue::as_datetime))
    .map(capture_time);
    let gps = parse_exif_gps(&exif, path, warnings);

    ExifPhotoMetadata {
        make,
        model,
        lens_model,
        focal_length_mm,
        dimensions,
        orientation,
        captured_at,
        gps,
    }
}

fn exif_value(exif: &Exif, tag: ExifTag) -> Option<&EntryValue> {
    exif.get(tag).or_else(|| {
        exif.iter()
            .find(|entry| entry.tag.tag() == Some(tag))
            .map(|entry| entry.value)
    })
}

fn exif_text(exif: &Exif, tag: ExifTag) -> Option<String> {
    exif_value(exif, tag)
        .and_then(EntryValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn exif_u32(exif: &Exif, tag: ExifTag) -> Option<u32> {
    exif_value(exif, tag)
        .and_then(EntryValue::try_as_integer)
        .and_then(|value| u32::try_from(value).ok())
}

fn finite_positive(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite() && *value > 0.0)
}

fn capture_time(value: ExifDateTime) -> CaptureTime {
    match value {
        ExifDateTime::Aware(value) => CaptureTime {
            value: value.to_rfc3339(),
            reference: CaptureTimeReference::EmbeddedUtcOffset,
        },
        ExifDateTime::Naive(value) => CaptureTime {
            value: value.format("%Y-%m-%d %H:%M:%S").to_string(),
            reference: CaptureTimeReference::UnknownLocalTime,
        },
    }
}

fn parse_exif_gps(
    exif: &Exif,
    path: &Path,
    warnings: &mut Vec<ImageImportWarning>,
) -> Option<ExifGpsPosition> {
    let has_latitude = exif_value(exif, ExifTag::GPSLatitude).is_some();
    let has_longitude = exif_value(exif, ExifTag::GPSLongitude).is_some();
    if !has_latitude || !has_longitude {
        return None;
    }
    let gps = exif.gps_info()?;
    let latitude_degrees = gps.latitude_decimal()?;
    let longitude_degrees = gps.longitude_decimal()?;
    if !latitude_degrees.is_finite()
        || !longitude_degrees.is_finite()
        || !(-90.0..=90.0).contains(&latitude_degrees)
        || !(-180.0..=180.0).contains(&longitude_degrees)
    {
        warnings.push(warning(
            path,
            ImageImportWarningCode::MetadataValueInvalid,
            "EXIF GPS latitude or longitude is outside its valid range".to_owned(),
        ));
        return None;
    }
    let altitude = gps
        .altitude_meters()
        .filter(|value| value.is_finite())
        .map(ImportedHeight::unknown_reference);

    Some(ExifGpsPosition {
        latitude_degrees,
        longitude_degrees,
        altitude,
    })
}

fn parse_dji_xmp_from_jpeg(
    path: &Path,
    dimensions: Option<ImageDimensions>,
    warnings: &mut Vec<ImageImportWarning>,
) -> DjiXmpMetadata {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) => {
            warnings.push(warning(
                path,
                ImageImportWarningCode::FileReadFailed,
                format!("cannot open JPEG for XMP scan: {error}"),
            ));
            return DjiXmpMetadata::default();
        }
    };
    let mut reader = BufReader::new(file);
    let mut soi = [0_u8; 2];
    if reader.read_exact(&mut soi).is_err() || soi != [0xff, 0xd8] {
        warnings.push(warning(
            path,
            ImageImportWarningCode::XmpMalformed,
            "JPEG does not start with a valid SOI marker".to_owned(),
        ));
        return DjiXmpMetadata::default();
    }

    scan_dji_xmp_segments(&mut reader, path, dimensions, warnings)
}

fn scan_dji_xmp_segments(
    reader: &mut (impl Read + Seek),
    path: &Path,
    dimensions: Option<ImageDimensions>,
    warnings: &mut Vec<ImageImportWarning>,
) -> DjiXmpMetadata {
    let mut metadata = DjiXmpMetadata::default();
    let mut total_xmp_bytes = 0_usize;
    loop {
        let position = match reader.stream_position() {
            Ok(position) => position,
            Err(error) => {
                warnings.push(warning(
                    path,
                    ImageImportWarningCode::XmpMalformed,
                    format!("cannot determine JPEG scan position: {error}"),
                ));
                break;
            }
        };
        if position >= MAX_JPEG_XMP_SCAN_BYTES {
            warnings.push(warning(
                path,
                ImageImportWarningCode::XmpScanLimitReached,
                "JPEG XMP scan stopped at the fixed 8 MiB safety limit".to_owned(),
            ));
            break;
        }

        let marker = {
            let mut limited = Read::take(Read::by_ref(reader), MAX_JPEG_XMP_SCAN_BYTES - position);
            read_jpeg_marker(&mut limited)
        };
        let Some(marker) = marker else {
            if reader
                .stream_position()
                .is_ok_and(|position| position >= MAX_JPEG_XMP_SCAN_BYTES)
            {
                warnings.push(warning(
                    path,
                    ImageImportWarningCode::XmpScanLimitReached,
                    "JPEG marker scan reached the fixed 8 MiB safety limit".to_owned(),
                ));
            }
            break;
        };
        if marker == 0xda || marker == 0xd9 {
            break;
        }
        if marker == 0xd8 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let mut length_bytes = [0_u8; 2];
        if reader.read_exact(&mut length_bytes).is_err() {
            warnings.push(warning(
                path,
                ImageImportWarningCode::XmpMalformed,
                "truncated JPEG marker length during XMP scan".to_owned(),
            ));
            break;
        }
        let segment_length = u16::from_be_bytes(length_bytes);
        if segment_length < 2 {
            warnings.push(warning(
                path,
                ImageImportWarningCode::XmpMalformed,
                "invalid JPEG segment length during XMP scan".to_owned(),
            ));
            break;
        }
        let payload_length = usize::from(segment_length - 2);
        let projected_position = reader
            .stream_position()
            .unwrap_or(MAX_JPEG_XMP_SCAN_BYTES)
            .saturating_add(payload_length as u64);
        if projected_position > MAX_JPEG_XMP_SCAN_BYTES {
            warnings.push(warning(
                path,
                ImageImportWarningCode::XmpScanLimitReached,
                "JPEG segment crosses the fixed XMP scan limit".to_owned(),
            ));
            break;
        }

        if !process_jpeg_segment(
            reader,
            marker,
            segment_length,
            JpegXmpSegmentContext {
                total_xmp_bytes: &mut total_xmp_bytes,
                path,
                metadata: &mut metadata,
                dimensions,
                warnings,
            },
        ) {
            break;
        }
    }

    metadata
}

struct JpegXmpSegmentContext<'a> {
    total_xmp_bytes: &'a mut usize,
    path: &'a Path,
    metadata: &'a mut DjiXmpMetadata,
    dimensions: Option<ImageDimensions>,
    warnings: &'a mut Vec<ImageImportWarning>,
}

fn process_jpeg_segment(
    reader: &mut (impl Read + Seek),
    marker: u8,
    segment_length: u16,
    context: JpegXmpSegmentContext<'_>,
) -> bool {
    let payload_length = usize::from(segment_length - 2);
    if marker != 0xe1 {
        if reader
            .seek(SeekFrom::Current(i64::from(segment_length - 2)))
            .is_ok()
        {
            return true;
        }
        context.warnings.push(warning(
            context.path,
            ImageImportWarningCode::XmpMalformed,
            "cannot skip JPEG segment during XMP scan".to_owned(),
        ));
        return false;
    }

    if context.total_xmp_bytes.saturating_add(payload_length) > MAX_TOTAL_XMP_PAYLOAD_BYTES {
        context.warnings.push(warning(
            context.path,
            ImageImportWarningCode::XmpScanLimitReached,
            "cumulative APP1 payload exceeds the fixed 512 KiB safety limit".to_owned(),
        ));
        return false;
    }
    let mut payload = vec![0_u8; payload_length];
    if reader.read_exact(&mut payload).is_err() {
        context.warnings.push(warning(
            context.path,
            ImageImportWarningCode::XmpMalformed,
            "truncated JPEG APP1 payload".to_owned(),
        ));
        return false;
    }
    if is_xmp_payload(&payload) {
        *context.total_xmp_bytes += payload.len();
        parse_dji_xmp_payload(
            &payload,
            context.path,
            context.metadata,
            context.dimensions,
            context.warnings,
        );
    }
    true
}

fn read_jpeg_marker(reader: &mut impl Read) -> Option<u8> {
    let mut byte = [0_u8; 1];
    loop {
        reader.read_exact(&mut byte).ok()?;
        if byte[0] != 0xff {
            continue;
        }
        loop {
            reader.read_exact(&mut byte).ok()?;
            match byte[0] {
                0xff => {}
                0x00 => break,
                marker => return Some(marker),
            }
        }
    }
}

fn is_xmp_payload(payload: &[u8]) -> bool {
    payload.starts_with(XMP_HEADER)
        || find_bytes(payload, b"<x:xmpmeta").is_some()
        || find_bytes(payload, b"drone-dji:").is_some()
}

fn parse_dji_xmp_payload(
    payload: &[u8],
    path: &Path,
    metadata: &mut DjiXmpMetadata,
    dimensions: Option<ImageDimensions>,
    warnings: &mut Vec<ImageImportWarning>,
) {
    if find_bytes(payload, b"<!DOCTYPE").is_some() || find_bytes(payload, b"<!ENTITY").is_some() {
        warnings.push(warning(
            path,
            ImageImportWarningCode::XmpUnsafeXmlIgnored,
            "XMP containing a document type or entity declaration was ignored".to_owned(),
        ));
        return;
    }

    parse_dji_xmp_position(payload, path, metadata, warnings);
    parse_dji_xmp_attitudes(payload, path, metadata, warnings);
    parse_dji_xmp_rtk(payload, path, metadata, warnings);
    parse_dji_xmp_calibration(payload, path, metadata, dimensions, warnings);
}

fn parse_dji_xmp_position(
    payload: &[u8],
    path: &Path,
    metadata: &mut DjiXmpMetadata,
    warnings: &mut Vec<ImageImportWarning>,
) {
    set_height(
        &mut metadata.ground_altitude,
        payload,
        b"drone-dji:GroundAltitude",
        path,
        warnings,
    );
    if metadata.latitude_degrees.is_none() {
        metadata.latitude_degrees = xmp_number_first(
            payload,
            &[
                b"drone-dji:GpsLatitude",
                b"drone-dji:GPSLatitude",
                b"drone-dji:Latitude",
            ],
            path,
            warnings,
        );
    }
    if metadata.longitude_degrees.is_none() {
        metadata.longitude_degrees = xmp_number_first(
            payload,
            &[
                b"drone-dji:GpsLongitude",
                b"drone-dji:GPSLongitude",
                b"drone-dji:GPSLongtitude",
                b"drone-dji:Longitude",
            ],
            path,
            warnings,
        );
    }
    set_height(
        &mut metadata.absolute_altitude,
        payload,
        b"drone-dji:AbsoluteAltitude",
        path,
        warnings,
    );
    set_height(
        &mut metadata.relative_altitude,
        payload,
        b"drone-dji:RelativeAltitude",
        path,
        warnings,
    );
}

fn parse_dji_xmp_attitudes(
    payload: &[u8],
    path: &Path,
    metadata: &mut DjiXmpMetadata,
    warnings: &mut Vec<ImageImportWarning>,
) {
    let flight = DjiAttitudeDegrees {
        yaw: xmp_number(payload, b"drone-dji:FlightYawDegree", path, warnings),
        pitch: xmp_number(payload, b"drone-dji:FlightPitchDegree", path, warnings),
        roll: xmp_number(payload, b"drone-dji:FlightRollDegree", path, warnings),
    };
    if metadata.flight_attitude.is_none() && !flight.is_empty() {
        metadata.flight_attitude = Some(flight);
    }
    let gimbal = DjiAttitudeDegrees {
        yaw: xmp_number(payload, b"drone-dji:GimbalYawDegree", path, warnings),
        pitch: xmp_number(payload, b"drone-dji:GimbalPitchDegree", path, warnings),
        roll: xmp_number(payload, b"drone-dji:GimbalRollDegree", path, warnings),
    };
    if metadata.gimbal_attitude.is_none() && !gimbal.is_empty() {
        metadata.gimbal_attitude = Some(gimbal);
    }
}

fn parse_dji_xmp_rtk(
    payload: &[u8],
    path: &Path,
    metadata: &mut DjiXmpMetadata,
    warnings: &mut Vec<ImageImportWarning>,
) {
    let rtk = DjiRtkMetadata {
        flag: xmp_string(payload, b"drone-dji:RtkFlag", path, warnings),
        standard_deviation_longitude_meters: xmp_number(
            payload,
            b"drone-dji:RtkStdLon",
            path,
            warnings,
        ),
        standard_deviation_latitude_meters: xmp_number(
            payload,
            b"drone-dji:RtkStdLat",
            path,
            warnings,
        ),
        standard_deviation_height_meters: xmp_number_first(
            payload,
            &[b"drone-dji:RtkStdHgt", b"drone-dji:RtkHgt"],
            path,
            warnings,
        ),
    };
    if metadata.rtk.is_none()
        && (rtk.flag.is_some()
            || rtk.standard_deviation_longitude_meters.is_some()
            || rtk.standard_deviation_latitude_meters.is_some()
            || rtk.standard_deviation_height_meters.is_some())
    {
        metadata.rtk = Some(rtk);
    }
}

fn parse_dji_xmp_calibration(
    payload: &[u8],
    path: &Path,
    metadata: &mut DjiXmpMetadata,
    dimensions: Option<ImageDimensions>,
    warnings: &mut Vec<ImageImportWarning>,
) {
    if metadata.calibrated_focal_length_pixels.is_none() {
        metadata.calibrated_focal_length_pixels =
            xmp_number(payload, b"drone-dji:CalibratedFocalLength", path, warnings);
    }
    if metadata.calibrated_optical_center_x_pixels.is_none() {
        metadata.calibrated_optical_center_x_pixels = xmp_number(
            payload,
            b"drone-dji:CalibratedOpticalCenterX",
            path,
            warnings,
        );
    }
    if metadata.calibrated_optical_center_y_pixels.is_none() {
        metadata.calibrated_optical_center_y_pixels = xmp_number(
            payload,
            b"drone-dji:CalibratedOpticalCenterY",
            path,
            warnings,
        );
    }
    if metadata.dewarp_calibration.is_none() {
        metadata.dewarp_calibration =
            parse_dji_dewarp_calibration(payload, path, dimensions, warnings);
    }
}

fn parse_dji_dewarp_calibration(
    payload: &[u8],
    path: &Path,
    dimensions: Option<ImageDimensions>,
    warnings: &mut Vec<ImageImportWarning>,
) -> Option<DjiBrownConradyCalibration> {
    let raw = match xmp_raw_value(payload, b"drone-dji:DewarpData") {
        XmpRawValue::Absent => return None,
        XmpRawValue::Invalid => {
            warnings.push(warning(
                path,
                ImageImportWarningCode::MetadataValueInvalid,
                "DJI XMP DewarpData is malformed".into(),
            ));
            return None;
        }
        XmpRawValue::Value(raw) => raw,
    };
    let Some(dimensions) = dimensions else {
        warnings.push(warning(
            path,
            ImageImportWarningCode::MetadataValueInvalid,
            "DJI XMP DewarpData cannot be applied without source image dimensions".into(),
        ));
        return None;
    };
    let Some(value) = std::str::from_utf8(raw)
        .ok()
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 512)
    else {
        warnings.push(warning(
            path,
            ImageImportWarningCode::MetadataValueInvalid,
            "DJI XMP DewarpData is not valid bounded UTF-8".into(),
        ));
        return None;
    };
    let Some((calibration_date, parameters)) = value.split_once(';') else {
        warnings.push(warning(
            path,
            ImageImportWarningCode::MetadataValueInvalid,
            "DJI XMP DewarpData must contain a date and nine parameters".into(),
        ));
        return None;
    };
    let values = parameters
        .split(',')
        .map(str::trim)
        .map(str::parse::<f64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()
        .filter(|values| values.len() == 9 && values.iter().all(|value| value.is_finite()));
    let Some(values) = values else {
        warnings.push(warning(
            path,
            ImageImportWarningCode::MetadataValueInvalid,
            "DJI XMP DewarpData must contain exactly nine finite numeric parameters".into(),
        ));
        return None;
    };
    // DJI order: fx, fy, cx-offset, cy-offset, k1, k2, p1, p2, k3.
    let calibration = DjiBrownConradyCalibration {
        focal_x_pixels: values[0],
        focal_y_pixels: values[1],
        principal_x_pixels: f64::from(dimensions.width_pixels) * 0.5 + values[2],
        principal_y_pixels: f64::from(dimensions.height_pixels) * 0.5 + values[3],
        radial_distortion: [values[4], values[5], values[8]],
        tangential_distortion: [values[6], values[7]],
        calibration_date: calibration_date.trim().to_owned(),
        provenance: DjiCalibrationProvenance::DewarpData,
    };
    if calibration.is_valid_for_dimensions(dimensions) {
        Some(calibration)
    } else {
        warnings.push(warning(
            path,
            ImageImportWarningCode::MetadataValueInvalid,
            "DJI XMP DewarpData is outside the finite image calibration bounds".into(),
        ));
        None
    }
}

fn xmp_number_first(
    payload: &[u8],
    keys: &[&[u8]],
    path: &Path,
    warnings: &mut Vec<ImageImportWarning>,
) -> Option<f64> {
    keys.iter()
        .find_map(|key| xmp_number(payload, key, path, warnings))
}

fn xmp_string(
    payload: &[u8],
    key: &[u8],
    path: &Path,
    warnings: &mut Vec<ImageImportWarning>,
) -> Option<String> {
    match xmp_raw_value(payload, key) {
        XmpRawValue::Absent => None,
        XmpRawValue::Invalid => {
            warnings.push(warning(
                path,
                ImageImportWarningCode::MetadataValueInvalid,
                format!(
                    "DJI XMP value '{}' is malformed",
                    String::from_utf8_lossy(key)
                ),
            ));
            None
        }
        XmpRawValue::Value(raw) => std::str::from_utf8(raw)
            .ok()
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.len() <= 64)
            .map(str::to_owned),
    }
}

fn set_height(
    target: &mut Option<ImportedHeight>,
    payload: &[u8],
    key: &[u8],
    path: &Path,
    warnings: &mut Vec<ImageImportWarning>,
) {
    if target.is_none() {
        *target = xmp_number(payload, key, path, warnings).map(ImportedHeight::unknown_reference);
    }
}

fn xmp_number(
    payload: &[u8],
    key: &[u8],
    path: &Path,
    warnings: &mut Vec<ImageImportWarning>,
) -> Option<f64> {
    match xmp_raw_value(payload, key) {
        XmpRawValue::Absent => None,
        XmpRawValue::Invalid => {
            warnings.push(warning(
                path,
                ImageImportWarningCode::MetadataValueInvalid,
                format!(
                    "DJI XMP value '{}' is malformed",
                    String::from_utf8_lossy(key)
                ),
            ));
            None
        }
        XmpRawValue::Value(raw) => {
            let parsed = std::str::from_utf8(raw)
                .ok()
                .map(str::trim)
                .filter(|value| !value.is_empty() && value.len() <= 64)
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| value.is_finite());
            if parsed.is_none() {
                warnings.push(warning(
                    path,
                    ImageImportWarningCode::MetadataValueInvalid,
                    format!(
                        "DJI XMP value '{}' is not a finite number",
                        String::from_utf8_lossy(key)
                    ),
                ));
            }
            parsed
        }
    }
}

enum XmpRawValue<'a> {
    Absent,
    Value(&'a [u8]),
    Invalid,
}

fn xmp_raw_value<'a>(payload: &'a [u8], key: &[u8]) -> XmpRawValue<'a> {
    let mut search_start = 0_usize;
    while let Some(relative) = find_bytes(&payload[search_start..], key) {
        let key_start = search_start + relative;
        let mut cursor = key_start + key.len();
        while payload.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        match payload.get(cursor).copied() {
            Some(b'=') => {
                cursor += 1;
                while payload.get(cursor).is_some_and(u8::is_ascii_whitespace) {
                    cursor += 1;
                }
                let Some(quote @ (b'\'' | b'"')) = payload.get(cursor).copied() else {
                    return XmpRawValue::Invalid;
                };
                let value_start = cursor + 1;
                let Some(value_length) = payload[value_start..]
                    .iter()
                    .position(|byte| *byte == quote)
                else {
                    return XmpRawValue::Invalid;
                };
                return XmpRawValue::Value(&payload[value_start..value_start + value_length]);
            }
            Some(b'>') => {
                let value_start = cursor + 1;
                let Some(value_length) =
                    payload[value_start..].iter().position(|byte| *byte == b'<')
                else {
                    return XmpRawValue::Invalid;
                };
                return XmpRawValue::Value(&payload[value_start..value_start + value_length]);
            }
            _ => search_start = key_start + key.len(),
        }
    }
    XmpRawValue::Absent
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use std::{
        cell::Cell,
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::*;
    use himmelcad_core::photolab_images::HeightSemanticReference;

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    struct TempDirectory {
        path: PathBuf,
    }

    impl TempDirectory {
        fn new() -> Self {
            let suffix = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "himmelcad-photolab-image-import-{}-{suffix}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("test directory must be created");
            Self { path }
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn jpeg_with_xmp(xml: &[u8]) -> Vec<u8> {
        let mut payload = XMP_HEADER.to_vec();
        payload.extend_from_slice(xml);
        let segment_length = u16::try_from(payload.len() + 2).expect("test XMP fits APP1");
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe1];
        jpeg.extend_from_slice(&segment_length.to_be_bytes());
        jpeg.extend_from_slice(&payload);
        jpeg.extend_from_slice(&[0xff, 0xd9]);
        jpeg
    }

    fn push_ifd_entry(
        target: &mut Vec<u8>,
        tag: u16,
        field_type: u16,
        count: u32,
        value_or_offset: u32,
    ) {
        target.extend_from_slice(&tag.to_le_bytes());
        target.extend_from_slice(&field_type.to_le_bytes());
        target.extend_from_slice(&count.to_le_bytes());
        target.extend_from_slice(&value_or_offset.to_le_bytes());
    }

    fn inline_ascii(bytes: [u8; 4]) -> u32 {
        u32::from_le_bytes(bytes)
    }

    fn jpeg_with_exif_and_gps() -> Vec<u8> {
        const MODEL_OFFSET: u32 = 122;
        const LENS_OFFSET: u32 = 129;
        const FOCAL_OFFSET: u32 = 139;
        const DATE_OFFSET: u32 = 147;
        const GPS_IFD_OFFSET: u32 = 167;
        const LATITUDE_OFFSET: u32 = 245;
        const LONGITUDE_OFFSET: u32 = 269;
        const ALTITUDE_OFFSET: u32 = 293;

        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"II");
        tiff.extend_from_slice(&42_u16.to_le_bytes());
        tiff.extend_from_slice(&8_u32.to_le_bytes());
        tiff.extend_from_slice(&9_u16.to_le_bytes());
        push_ifd_entry(&mut tiff, 0x010f, 2, 4, inline_ascii(*b"DJI\0"));
        push_ifd_entry(&mut tiff, 0x0110, 2, 7, MODEL_OFFSET);
        push_ifd_entry(&mut tiff, 0x0112, 3, 1, 6);
        push_ifd_entry(&mut tiff, 0x0100, 4, 1, 4_000);
        push_ifd_entry(&mut tiff, 0x0101, 4, 1, 3_000);
        push_ifd_entry(&mut tiff, 0x920a, 5, 1, FOCAL_OFFSET);
        push_ifd_entry(&mut tiff, 0x9003, 2, 20, DATE_OFFSET);
        push_ifd_entry(&mut tiff, 0xa434, 2, 10, LENS_OFFSET);
        push_ifd_entry(&mut tiff, 0x8825, 4, 1, GPS_IFD_OFFSET);
        tiff.extend_from_slice(&0_u32.to_le_bytes());

        assert_eq!(tiff.len(), MODEL_OFFSET as usize);
        tiff.extend_from_slice(b"FC6310\0");
        assert_eq!(tiff.len(), LENS_OFFSET as usize);
        tiff.extend_from_slice(b"24mm F2.8\0");
        assert_eq!(tiff.len(), FOCAL_OFFSET as usize);
        tiff.extend_from_slice(&24_u32.to_le_bytes());
        tiff.extend_from_slice(&1_u32.to_le_bytes());
        assert_eq!(tiff.len(), DATE_OFFSET as usize);
        tiff.extend_from_slice(b"2024:05:06 07:08:09\0");
        assert_eq!(tiff.len(), GPS_IFD_OFFSET as usize);

        tiff.extend_from_slice(&6_u16.to_le_bytes());
        push_ifd_entry(&mut tiff, 0x0001, 2, 2, inline_ascii([b'N', 0, 0, 0]));
        push_ifd_entry(&mut tiff, 0x0002, 5, 3, LATITUDE_OFFSET);
        push_ifd_entry(&mut tiff, 0x0003, 2, 2, inline_ascii([b'E', 0, 0, 0]));
        push_ifd_entry(&mut tiff, 0x0004, 5, 3, LONGITUDE_OFFSET);
        push_ifd_entry(&mut tiff, 0x0005, 1, 1, 0);
        push_ifd_entry(&mut tiff, 0x0006, 5, 1, ALTITUDE_OFFSET);
        tiff.extend_from_slice(&0_u32.to_le_bytes());
        assert_eq!(tiff.len(), LATITUDE_OFFSET as usize);
        for (numerator, denominator) in [(48_u32, 1_u32), (8, 1), (30, 1)] {
            tiff.extend_from_slice(&numerator.to_le_bytes());
            tiff.extend_from_slice(&denominator.to_le_bytes());
        }
        assert_eq!(tiff.len(), LONGITUDE_OFFSET as usize);
        for (numerator, denominator) in [(11_u32, 1_u32), (34, 1), (15, 1)] {
            tiff.extend_from_slice(&numerator.to_le_bytes());
            tiff.extend_from_slice(&denominator.to_le_bytes());
        }
        assert_eq!(tiff.len(), ALTITUDE_OFFSET as usize);
        tiff.extend_from_slice(&535_u32.to_le_bytes());
        tiff.extend_from_slice(&2_u32.to_le_bytes());

        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(&tiff);
        let segment_length = u16::try_from(payload.len() + 2).expect("test EXIF fits APP1");
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe1];
        jpeg.extend_from_slice(&segment_length.to_be_bytes());
        jpeg.extend_from_slice(&payload);
        jpeg.extend_from_slice(&[0xff, 0xd9]);
        jpeg
    }

    #[test]
    fn recursively_discovers_supported_formats_and_warns_for_normal_files() {
        let temp = TempDirectory::new();
        let nested = temp.path.join("nested");
        fs::create_dir(&nested).expect("nested directory must be created");
        fs::write(temp.path.join("a.JPG"), [1_u8, 2, 3]).expect("photo fixture must be written");
        fs::write(nested.join("b.dng"), [4_u8, 5]).expect("raw fixture must be written");
        fs::write(nested.join("notes.txt"), b"not a photo").expect("normal file must be written");

        let discovery = discover_photo_files(std::slice::from_ref(&temp.path));

        assert_eq!(discovery.candidates.len(), 2);
        assert_eq!(discovery.candidates[0].format, PhotoFormat::Jpeg);
        assert_eq!(discovery.candidates[1].format, PhotoFormat::Dng);
        assert!(discovery
            .warnings
            .iter()
            .any(|warning| warning.code == ImageImportWarningCode::UnsupportedFormat));
    }

    #[test]
    fn parses_bounded_dji_xmp_without_assigning_height_semantics() {
        let temp = TempDirectory::new();
        let path = temp.path.join("dji.jpg");
        let xml = br#"<x:xmpmeta><rdf:Description
            drone-dji:AbsoluteAltitude="+127.25"
            drone-dji:RelativeAltitude="+42.5"
            drone-dji:GroundAltitude="84.75"
            drone-dji:FlightYawDegree="91.0"
            drone-dji:FlightPitchDegree="-2.5"
            drone-dji:FlightRollDegree="0.25"
            drone-dji:GimbalYawDegree="90.0"
            drone-dji:GimbalPitchDegree="-89.5"
            drone-dji:GimbalRollDegree="0.0"
            drone-dji:GpsLatitude="48.123456789"
            drone-dji:GpsLongitude="11.987654321"
            drone-dji:RtkFlag="50"
            drone-dji:RtkStdLon="0.012"
            drone-dji:RtkStdLat="0.013"
            drone-dji:RtkStdHgt="0.025"
            drone-dji:CalibratedFocalLength="3666.4"
            drone-dji:CalibratedOpticalCenterX="2736.1"
            drone-dji:CalibratedOpticalCenterY="1824.2"/></x:xmpmeta>"#;
        fs::write(&path, jpeg_with_xmp(xml)).expect("JPEG fixture must be written");
        let mut warnings = Vec::new();

        let metadata = parse_dji_xmp_from_jpeg(&path, None, &mut warnings);

        assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");
        assert_eq!(
            metadata.absolute_altitude.map(|height| height.meters),
            Some(127.25)
        );
        assert_eq!(
            metadata
                .absolute_altitude
                .map(|height| height.semantic_reference),
            Some(HeightSemanticReference::Unknown)
        );
        assert_eq!(
            metadata.relative_altitude.map(|height| height.meters),
            Some(42.5)
        );
        assert_eq!(
            metadata.ground_altitude.map(|height| height.meters),
            Some(84.75)
        );
        assert_eq!(
            metadata.flight_attitude.and_then(|pose| pose.yaw),
            Some(91.0)
        );
        assert_eq!(
            metadata.gimbal_attitude.and_then(|pose| pose.pitch),
            Some(-89.5)
        );
        assert_eq!(metadata.latitude_degrees, Some(48.123456789));
        assert_eq!(metadata.longitude_degrees, Some(11.987654321));
        assert!(metadata
            .rtk
            .as_ref()
            .is_some_and(|rtk| rtk.flag.as_deref() == Some("50")));
        assert_eq!(
            metadata
                .rtk
                .as_ref()
                .and_then(|rtk| rtk.standard_deviation_height_meters),
            Some(0.025)
        );
        assert_eq!(metadata.calibrated_focal_length_pixels, Some(3666.4));
    }

    #[test]
    fn parses_dji_dewarp_data_as_absolute_full_brown_calibration() {
        let temp = TempDirectory::new();
        let path = temp.path.join("dji-dewarp.jpg");
        let xml = br#"<x:xmpmeta><rdf:Description
            drone-dji:DewarpData="2025-02-26;3713.771893164336,3713.771893164336,20.720882112011,-16.733345702852,-0.107756512758,-0.000878853880,0.000130474491,-0.000011293710,-0.015723478938"/></x:xmpmeta>"#;
        fs::write(&path, jpeg_with_xmp(xml)).expect("JPEG fixture must be written");
        let dimensions = ImageDimensions {
            width_pixels: 5_280,
            height_pixels: 3_956,
        };
        let mut warnings = Vec::new();

        let metadata = parse_dji_xmp_from_jpeg(&path, Some(dimensions), &mut warnings);
        let calibration = metadata.dewarp_calibration.expect("DewarpData calibration");

        assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");
        assert_eq!(calibration.provenance, DjiCalibrationProvenance::DewarpData);
        assert_eq!(calibration.calibration_date, "2025-02-26");
        assert!((calibration.focal_x_pixels - 3713.771893164336).abs() < 1.0e-12);
        assert!((calibration.principal_x_pixels - 2660.720882112011).abs() < 1.0e-12);
        assert!((calibration.principal_y_pixels - 1961.266654297148).abs() < 1.0e-12);
        assert_eq!(
            calibration.radial_distortion,
            [-0.107756512758, -0.000878853880, -0.015723478938]
        );
        assert_eq!(
            calibration.tangential_distortion,
            [0.000130474491, -0.000011293710]
        );
        assert!(calibration.is_valid_for_dimensions(dimensions));
    }

    #[test]
    fn rejects_non_finite_or_dimensionless_dji_dewarp_data() {
        let temp = TempDirectory::new();
        let path = temp.path.join("invalid-dewarp.jpg");
        let xml = br#"<x:xmpmeta><rdf:Description drone-dji:DewarpData="2025-02-26;NaN,3713,0,0,0,0,0,0,0"/></x:xmpmeta>"#;
        fs::write(&path, jpeg_with_xmp(xml)).expect("JPEG fixture must be written");
        let mut warnings = Vec::new();

        let metadata = parse_dji_xmp_from_jpeg(&path, None, &mut warnings);

        assert!(metadata.dewarp_calibration.is_none());
        assert!(warnings
            .iter()
            .any(|warning| warning.code == ImageImportWarningCode::MetadataValueInvalid));
    }

    #[test]
    fn parses_synthetic_exif_camera_dimensions_time_focal_orientation_and_gps() {
        let temp = TempDirectory::new();
        let path = temp.path.join("exif.jpg");
        fs::write(&path, jpeg_with_exif_and_gps()).expect("EXIF fixture must be written");

        let batch = import_photo_files(std::slice::from_ref(&path));

        assert_eq!(batch.photos.len(), 1);
        let exif = &batch.photos[0].metadata.exif;
        assert_eq!(exif.make.as_deref(), Some("DJI"));
        assert_eq!(exif.model.as_deref(), Some("FC6310"));
        assert_eq!(exif.lens_model.as_deref(), Some("24mm F2.8"));
        assert_eq!(exif.focal_length_mm, Some(24.0));
        assert_eq!(
            exif.dimensions,
            Some(ImageDimensions {
                width_pixels: 4_000,
                height_pixels: 3_000,
            })
        );
        assert_eq!(exif.orientation, Some(ExifOrientation::Rotate90Clockwise));
        assert_eq!(
            exif.captured_at.as_ref().map(|time| time.reference),
            Some(CaptureTimeReference::UnknownLocalTime)
        );
        let gps = exif.gps.expect("GPS metadata must be parsed");
        assert!((gps.latitude_degrees - 48.141_666_666).abs() < 1e-8);
        assert!((gps.longitude_degrees - 11.570_833_333).abs() < 1e-8);
        assert_eq!(gps.altitude.map(|height| height.meters), Some(267.5));
        assert_eq!(
            gps.altitude.map(|height| height.semantic_reference),
            Some(HeightSemanticReference::Unknown)
        );
        assert_eq!(
            batch.photos[0].capture_source.device_class,
            himmelcad_core::photolab_capture::CaptureDeviceClass::Drone
        );
        let prior = batch.photos[0]
            .position_prior
            .as_ref()
            .expect("GPS must become an uncertain prior");
        assert_eq!(
            prior.role,
            himmelcad_core::photolab_capture::CapturePositionRole::PriorOnly
        );
        assert!(prior.covariance_enu_m2[0] > 0.0);
    }

    #[test]
    fn ignores_xmp_entity_declarations_instead_of_resolving_them() {
        let temp = TempDirectory::new();
        let path = temp.path.join("unsafe.jpg");
        let xml = br#"<!DOCTYPE x [<!ENTITY altitude "123">]>
            <x:xmpmeta drone-dji:AbsoluteAltitude="&altitude;"/>"#;
        fs::write(&path, jpeg_with_xmp(xml)).expect("JPEG fixture must be written");
        let mut warnings = Vec::new();

        let metadata = parse_dji_xmp_from_jpeg(&path, None, &mut warnings);

        assert!(metadata.is_empty());
        assert!(warnings
            .iter()
            .any(|warning| warning.code == ImageImportWarningCode::XmpUnsafeXmlIgnored));
    }

    #[test]
    fn streaming_hash_detects_duplicates_without_aborting_bad_metadata() {
        let temp = TempDirectory::new();
        let first = temp.path.join("first.jpg");
        let second = temp.path.join("second.jpeg");
        let bytes = jpeg_with_xmp(br#"<x:xmpmeta drone-dji:FlightYawDegree="12"/>"#);
        fs::write(&first, &bytes).expect("first fixture must be written");
        fs::write(&second, &bytes).expect("second fixture must be written");

        let batch = import_photo_files(std::slice::from_ref(&temp.path));

        assert_eq!(batch.photos.len(), 2);
        assert_eq!(batch.photos[0].sha256, batch.photos[1].sha256);
        assert!(batch.photos[0].duplicate_of.is_none());
        assert_eq!(
            batch.photos[1].duplicate_of.as_deref(),
            Some(batch.photos[0].source_path.as_str())
        );
        assert!(batch
            .warnings
            .iter()
            .any(|warning| warning.code == ImageImportWarningCode::DuplicateContent));
    }

    #[test]
    fn progress_is_monotonic_and_cancellation_discards_the_partial_batch() {
        let temp = TempDirectory::new();
        for index in 0..3 {
            fs::write(
                temp.path.join(format!("{index}.jpg")),
                [index as u8, 1, 2, 3],
            )
            .expect("photo fixture must be written");
        }
        let cancel = Cell::new(false);
        let last_progress = Cell::new(0.0_f64);
        let messages = Cell::new(0_usize);

        let batch = import_photo_files_with_progress(
            std::slice::from_ref(&temp.path),
            || cancel.get(),
            |fraction, message| {
                assert!(fraction >= last_progress.get());
                assert!((0.0..=1.0).contains(&fraction));
                assert!(!message.is_empty());
                last_progress.set(fraction);
                messages.set(messages.get() + 1);
                if fraction > 0.3 {
                    cancel.set(true);
                }
            },
        );

        assert!(
            batch.is_none(),
            "cancelled inspection must return no partial batch"
        );
        assert!(messages.get() >= 3);
        assert!(last_progress.get() < 1.0);
    }

    #[test]
    fn unsupported_heif_is_preserved_and_reported_without_decoder_guessing() {
        let temp = TempDirectory::new();
        let path = temp.path.join("phone.heic");
        fs::write(&path, b"immutable-heif-source").expect("HEIF fixture");

        let batch = import_photo_files(std::slice::from_ref(&path));

        assert_eq!(batch.photos.len(), 1);
        assert_eq!(batch.photos[0].format, PhotoFormat::Heic);
        assert!(batch.photos[0]
            .decoder_capability
            .as_ref()
            .is_some_and(|capability| matches!(
                capability.support,
                CaptureDecodeSupport::Unsupported { .. }
            )));
        assert!(batch
            .warnings
            .iter()
            .any(|warning| warning.code == ImageImportWarningCode::DecoderUnavailable));
    }
}
