//! Orthophoto/elevation raster decoding with explicit continuity semantics.

use std::error::Error;
use std::fmt::{Display, Formatter};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use himmelcad_core::canonical_document::EntityVersionRef;
use himmelcad_core::canonical_resources::CanonicalResourceRef;
use himmelcad_core::entity_model::{
    DepthField, DepthSemantics, GeometryObject, OrthoGridMapping, RasterCellDiagonal,
    RasterConfidenceEncoding, RasterConnectivity, RasterImageGeometry, RasterMapping, Vector3,
};
use himmelcad_core::entity_validation::validate_geometry_object;

/// Current provider-neutral prepared raster tile contract. Older layouts are
/// rejected rather than guessed because mapping and depth semantics affect
/// both rendered geometry and measurement coordinates.
pub const PREPARED_RASTER_TILE_SCHEMA_VERSION: u16 = 1;

/// Prepared surface-drape schema with independent colour and support grids.
pub const PREPARED_RASTER_SURFACE_TILE_SCHEMA_VERSION: u16 = 2;

/// Independently sampled elevation support for one orthographic colour page.
///
/// Integer grid coordinates address mesh vertices, not image pixel centres.
/// The four outer vertices must coincide with the colour pixel-footprint
/// corners so adjacent producer tiles can repeat a byte-identical boundary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedRasterSurfaceGrid {
    /// Number of support vertices per row.
    pub width: u32,
    /// Number of support vertices per column.
    pub height: u32,
    /// Entity-local XY mapping of support vertex `(0, 0)` and its steps.
    pub mapping: RasterGridMapping,
    /// Elevation, validity, confidence and connectivity resources.
    pub depth: DepthField,
    /// Exact canonical elevation-surface revision used for preparation.
    pub source_surface: EntityVersionRef,
    /// Immutable evaluator recipe including source geometry and parameters.
    pub derivation: CanonicalResourceRef,
}

/// Immutable semantic envelope shared by the decode worker and render host.
///
/// Payload transport remains provider-specific, but dimensions, mapping,
/// depth semantics, validity, confidence and connectivity have exactly the
/// same authority as an inline canonical raster.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedRasterTileContract {
    /// Exact contract version.
    pub schema_version: u16,
    /// Canonical raster semantics for this prepared tile.
    pub raster: RasterImageGeometry,
    /// Color payload encoding delivered to the bounded worker.
    pub color_encoding: RasterColorEncoding,
    /// Scalar payload encoding delivered to the bounded worker.
    pub depth_encoding: RasterElevationEncoding,
    /// Additional invalid-sample rule applied before the canonical validity
    /// mask. It preserves source sentinels without changing canonical masks.
    pub no_data: RasterNoData,
    /// Independent elevation support for a schema-v2 surface drape. Schema-v1
    /// co-registered image depth omits this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<PreparedRasterSurfaceGrid>,
}

impl PreparedRasterTileContract {
    /// Rejects schema drift and invalid canonical imaging semantics before any
    /// provider payload is decoded or allocated.
    pub fn validate(&self) -> Result<(), ElevationRasterError> {
        if validate_geometry_object(&GeometryObject::RasterImage {
            raster: Box::new(self.raster.clone()),
        })
        .is_err()
        {
            return Err(ElevationRasterError::Contract);
        }
        match (self.schema_version, &self.surface) {
            (PREPARED_RASTER_TILE_SCHEMA_VERSION, None) if self.raster.depth.is_some() => Ok(()),
            (PREPARED_RASTER_SURFACE_TILE_SCHEMA_VERSION, Some(surface))
                if self.raster.depth.is_none() =>
            {
                validate_surface_grid(&self.raster, surface, self.no_data)
            }
            _ => Err(ElevationRasterError::Contract),
        }
    }

    /// Resolves the canonical orthographic elevation contract used by the
    /// current topology-aware decoder. Other imaging mappings are rejected at
    /// this single boundary until their ray/plane evaluator is selected.
    pub fn elevation_grid_decode_semantics(
        &self,
    ) -> Result<(RasterGridMapping, RasterSurfaceTopology), ElevationRasterError> {
        self.validate()?;
        let (mapping, depth) = if let Some(surface) = &self.surface {
            (
                OrthoGridMapping {
                    origin: Vector3 {
                        x: surface.mapping.origin[0],
                        y: surface.mapping.origin[1],
                        z: 0.0,
                    },
                    column_step: Vector3 {
                        x: surface.mapping.column_step[0],
                        y: surface.mapping.column_step[1],
                        z: 0.0,
                    },
                    row_step: Vector3 {
                        x: surface.mapping.row_step[0],
                        y: surface.mapping.row_step[1],
                        z: 0.0,
                    },
                },
                &surface.depth,
            )
        } else {
            let RasterMapping::OrthoGrid(mapping) = self.raster.mapping else {
                return Err(ElevationRasterError::Contract);
            };
            (
                mapping,
                self.raster
                    .depth
                    .as_ref()
                    .ok_or(ElevationRasterError::Contract)?,
            )
        };
        if depth.sampling.semantics != DepthSemantics::ElevationZ
            || mapping.column_step.z.abs() > f64::EPSILON
            || mapping.row_step.z.abs() > f64::EPSILON
        {
            return Err(ElevationRasterError::Contract);
        }
        let topology = match &depth.sampling.connectivity {
            RasterConnectivity::Continuous {
                maximum_height_jump,
                diagonal,
            } => RasterSurfaceTopology::Continuous {
                maximum_height_jump: *maximum_height_jump,
                diagonal: *diagonal,
            },
            RasterConnectivity::PixelSteps => RasterSurfaceTopology::PixelSteps,
            RasterConnectivity::Mask { diagonal, .. } => RasterSurfaceTopology::Continuous {
                maximum_height_jump: None,
                diagonal: *diagonal,
            },
        };
        Ok((
            RasterGridMapping {
                origin: [mapping.origin.x, mapping.origin.y],
                column_step: [mapping.column_step.x, mapping.column_step.y],
                row_step: [mapping.row_step.x, mapping.row_step.y],
            },
            topology,
        ))
    }

    /// Returns independent colour and elevation dimensions after validation.
    pub fn decode_dimensions(&self) -> Result<(u32, u32, u32, u32), ElevationRasterError> {
        self.validate()?;
        let (elevation_width, elevation_height) = self
            .surface
            .as_ref()
            .map_or((self.raster.width, self.raster.height), |surface| {
                (surface.width, surface.height)
            });
        Ok((
            self.raster.width,
            self.raster.height,
            elevation_width,
            elevation_height,
        ))
    }

    /// Verifies every transported immutable payload against the canonical
    /// resource descriptor before decode. Empty slices mean the optional band
    /// is absent, not an unverified resource.
    pub fn validate_payloads(
        &self,
        color: &[u8],
        depth: &[u8],
        validity: Option<&[u8]>,
        confidence: Option<&[u8]>,
        connectivity: Option<&[u8]>,
    ) -> Result<(), ElevationRasterError> {
        self.validate()?;
        let depth_field = self
            .surface
            .as_ref()
            .map(|surface| &surface.depth)
            .or(self.raster.depth.as_ref())
            .ok_or(ElevationRasterError::Contract)?;
        if !resource_matches(&self.raster.pixels, color)
            || !resource_matches(&depth_field.values, depth)
            || !optional_resource_matches(
                depth_field.validity.as_ref().map(|mask| &mask.resource),
                validity,
            )
            || !optional_resource_matches(
                depth_field.confidence.as_ref().map(|band| &band.resource),
                confidence,
            )
        {
            return Err(ElevationRasterError::Contract);
        }
        if let (Some(band), Some(bytes)) = (&depth_field.confidence, confidence) {
            let normalized = match band.encoding {
                RasterConfidenceEncoding::Unorm8 => true,
                RasterConfidenceEncoding::Float32LittleEndian => {
                    bytes.chunks_exact(4).all(|sample| {
                        let value = f32::from_le_bytes(sample.try_into().unwrap());
                        (0.0..=1.0).contains(&value)
                    })
                }
            };
            if !normalized {
                return Err(ElevationRasterError::Contract);
            }
        }
        let connectivity_resource = match &depth_field.sampling.connectivity {
            RasterConnectivity::Mask { resource, .. } => Some(resource),
            RasterConnectivity::Continuous { .. } | RasterConnectivity::PixelSteps => None,
        };
        if !optional_resource_matches(connectivity_resource, connectivity) {
            return Err(ElevationRasterError::Contract);
        }
        Ok(())
    }
}

fn validate_surface_grid(
    raster: &RasterImageGeometry,
    surface: &PreparedRasterSurfaceGrid,
    no_data: RasterNoData,
) -> Result<(), ElevationRasterError> {
    let RasterMapping::OrthoGrid(colour_mapping) = raster.mapping else {
        return Err(ElevationRasterError::Contract);
    };
    if surface.width < 2
        || surface.height < 2
        || matches!(no_data, RasterNoData::AlphaMask)
        || surface.source_surface.id.0.trim().is_empty()
        || surface.derivation.resource_id.trim().is_empty()
        || surface.derivation.schema_id.trim().is_empty()
    {
        return Err(ElevationRasterError::Contract);
    }
    let support_mapping = OrthoGridMapping {
        origin: Vector3 {
            x: surface.mapping.origin[0],
            y: surface.mapping.origin[1],
            z: 0.0,
        },
        column_step: Vector3 {
            x: surface.mapping.column_step[0],
            y: surface.mapping.column_step[1],
            z: 0.0,
        },
        row_step: Vector3 {
            x: surface.mapping.row_step[0],
            y: surface.mapping.row_step[1],
            z: 0.0,
        },
    };
    let validation_raster = RasterImageGeometry {
        pixels: raster.pixels.clone(),
        width: surface.width,
        height: surface.height,
        mapping: RasterMapping::OrthoGrid(support_mapping),
        depth: Some(surface.depth.clone()),
    };
    if validate_geometry_object(&GeometryObject::RasterImage {
        raster: Box::new(validation_raster),
    })
    .is_err()
        || surface.depth.sampling.semantics != DepthSemantics::ElevationZ
    {
        return Err(ElevationRasterError::Contract);
    }
    let colour_corners = grid_corners(
        [colour_mapping.origin.x, colour_mapping.origin.y],
        [colour_mapping.column_step.x, colour_mapping.column_step.y],
        [colour_mapping.row_step.x, colour_mapping.row_step.y],
        -0.5,
        f64::from(raster.width) - 0.5,
        -0.5,
        f64::from(raster.height) - 0.5,
    );
    let support_corners = grid_corners(
        surface.mapping.origin,
        surface.mapping.column_step,
        surface.mapping.row_step,
        0.0,
        f64::from(surface.width - 1),
        0.0,
        f64::from(surface.height - 1),
    );
    let scale = colour_corners
        .iter()
        .flatten()
        .chain(support_corners.iter().flatten())
        .map(|value| value.abs())
        .fold(1.0, f64::max);
    let tolerance = scale * 1.0e-12;
    if colour_corners
        .iter()
        .zip(support_corners)
        .any(|(colour, support)| {
            (colour[0] - support[0]).abs() > tolerance || (colour[1] - support[1]).abs() > tolerance
        })
    {
        return Err(ElevationRasterError::Contract);
    }
    Ok(())
}

fn grid_corners(
    origin: [f64; 2],
    column_step: [f64; 2],
    row_step: [f64; 2],
    minimum_column: f64,
    maximum_column: f64,
    minimum_row: f64,
    maximum_row: f64,
) -> [[f64; 2]; 4] {
    let point = |column: f64, row: f64| {
        [
            origin[0] + column_step[0] * column + row_step[0] * row,
            origin[1] + column_step[1] * column + row_step[1] * row,
        ]
    };
    [
        point(minimum_column, minimum_row),
        point(maximum_column, minimum_row),
        point(minimum_column, maximum_row),
        point(maximum_column, maximum_row),
    ]
}

fn resource_matches(
    resource: &himmelcad_core::entity_model::GeometryResource,
    bytes: &[u8],
) -> bool {
    resource.object_hash == himmelcad_core::hash::ObjectHash::of_bytes(bytes)
        && resource.byte_length == u64::try_from(bytes.len()).ok()
}

fn optional_resource_matches(
    resource: Option<&himmelcad_core::entity_model::GeometryResource>,
    bytes: Option<&[u8]>,
) -> bool {
    match (resource, bytes) {
        (Some(resource), Some(bytes)) => resource_matches(resource, bytes),
        (None, None) => true,
        _ => false,
    }
}

use crate::{GpuMeshVertexInput, WorldVec3};

/// World mapping of raster sample centers. Integer `(column, row)` addresses
/// the sample center; pixel footprint boundaries lie at half-integers.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterGridMapping {
    /// World XY at sample center `(0, 0)`.
    pub origin: [f64; 2],
    /// World XY step for one increasing column.
    pub column_step: [f64; 2],
    /// World XY step for one increasing row.
    pub row_step: [f64; 2],
}

/// Declared spatial meaning between adjacent elevation samples.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RasterSurfaceTopology {
    /// Samples form one height field; optional jumps suppress crossing triangles.
    Continuous {
        /// Maximum elevation range inside one triangle.
        maximum_height_jump: Option<f64>,
        /// Stable cell triangulation shared by display and exact picking.
        diagonal: RasterCellDiagonal,
    },
    /// Each pixel is one constant-height footprint with disconnected edges.
    PixelSteps,
}

/// Encoding of the color payload accompanying one prepared raster tile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RasterColorEncoding {
    /// PNG or JPEG bytes decoded by the shared Rust image stack.
    EncodedImage,
    /// Tightly packed row-major RGBA8.
    Rgba8,
}

/// Scalar storage of the elevation payload.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RasterElevationEncoding {
    /// Little-endian IEEE-754 float32 samples.
    Float32LittleEndian,
    /// Big-endian IEEE-754 float32 samples.
    Float32BigEndian,
    /// Little-endian IEEE-754 float64 samples.
    Float64LittleEndian,
    /// Big-endian IEEE-754 float64 samples.
    Float64BigEndian,
    /// One elevation shared by every pixel.
    Constant {
        /// Project elevation shared by every pixel.
        value: f64,
    },
}

/// Invalid-sample semantics of a prepared elevation band.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RasterNoData {
    /// Every finite scalar is valid.
    None,
    /// NaN samples are invalid; infinities remain errors.
    Nan,
    /// Samples matching this exact stored sentinel are invalid.
    Numeric {
        /// Exact scalar sentinel stored in the source band.
        value: f64,
    },
    /// A zero color alpha channel marks an invalid elevation.
    AlphaMask,
}

/// Encoded bands plus explicit grid and discontinuity semantics.
#[derive(Debug, Clone, Copy)]
pub struct EncodedElevationRasterInput<'a> {
    /// Expected elevation/support width.
    pub width: u32,
    /// Expected elevation/support height.
    pub height: u32,
    /// Expected colour texture width.
    pub color_width: u32,
    /// Expected colour texture height.
    pub color_height: u32,
    /// Encoded or raw color bytes.
    pub color: &'a [u8],
    /// Raw scalar elevation bytes; empty only for constant elevation.
    pub elevations: &'a [u8],
    /// Optional authoritative LSB0 validity bitset, one bit per sample.
    pub validity_mask: Option<&'a [u8]>,
    /// Optional authoritative LSB0 connectivity mask, two bits per cell.
    pub triangle_mask: Option<&'a [u8]>,
    /// Color byte encoding.
    pub color_encoding: RasterColorEncoding,
    /// Elevation byte encoding.
    pub elevation_encoding: RasterElevationEncoding,
    /// Invalid sample rule.
    pub no_data: RasterNoData,
    /// Grid-to-world mapping.
    pub mapping: RasterGridMapping,
    /// Surface connectivity.
    pub topology: RasterSurfaceTopology,
}

/// Borrowed decoded color and elevation bands.
#[derive(Debug, Clone, Copy)]
pub struct ElevationRasterInput<'a> {
    /// Elevation/support width.
    pub width: u32,
    /// Elevation/support height.
    pub height: u32,
    /// Colour texture width.
    pub color_width: u32,
    /// Colour texture height.
    pub color_height: u32,
    /// Tightly packed sRGB RGBA8 color pixels.
    pub rgba8: &'a [u8],
    /// Row-major world elevations; `None` is an invalid pixel/sample.
    pub elevations: &'a [Option<f64>],
    /// Optional authoritative LSB0 connectivity mask, two bits per cell.
    pub triangle_mask: Option<&'a [u8]>,
    /// Grid-to-world mapping.
    pub mapping: RasterGridMapping,
    /// Connectivity and interpolation topology.
    pub topology: RasterSurfaceTopology,
}

/// Camera-independent raster mesh and its original color texture.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedElevationRaster {
    /// Stable f64 world origin subtracted from every vertex position.
    pub world_origin: WorldVec3,
    /// Elevation/support width.
    pub width: u32,
    /// Elevation/support height.
    pub height: u32,
    /// Width of `rgba8`.
    pub color_width: u32,
    /// Height of `rgba8`.
    pub color_height: u32,
    /// Original RGBA8 color band.
    pub rgba8: Vec<u8>,
    /// Exact row-major source elevations after no-data decoding.
    pub source_elevations: Arc<[f64]>,
    /// Vertices relative to the caller's stable render origin.
    pub vertices: Vec<GpuMeshVertexInput>,
    /// Triangle indices. Pixel-step topology never shares vertices across pixels.
    pub indices: Vec<u32>,
}

/// Invalid raster bands, mapping or coordinate conversion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElevationRasterError {
    /// Prepared tile schema or canonical raster semantics are invalid.
    Contract,
    /// Dimensions and band lengths differ or are zero.
    BandSize,
    /// Mapping or valid elevation contains a non-finite value.
    NonFinite,
    /// Column and row steps do not span a usable two-dimensional grid.
    InvalidMapping,
    /// Dimensions exceed portable index addressing.
    TooLarge,
    /// Continuity threshold is negative or non-finite.
    InvalidTopology,
    /// Encoded PNG/JPEG color bytes are invalid or have the wrong dimensions.
    Image,
    /// Elevation scalar bytes do not match their declared encoding and dimensions.
    ElevationEncoding,
}

impl Display for ElevationRasterError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Contract => "prepared raster tile contract is invalid",
            Self::BandSize => "raster band lengths do not match dimensions",
            Self::NonFinite => "raster mapping or elevation is non-finite",
            Self::InvalidMapping => "raster column and row steps are degenerate",
            Self::TooLarge => "raster mesh exceeds portable index addressing",
            Self::InvalidTopology => "raster continuity threshold is invalid",
            Self::Image => "raster color image is invalid or has unexpected dimensions",
            Self::ElevationEncoding => "raster elevation encoding or byte length is invalid",
        })
    }
}

impl Error for ElevationRasterError {}

/// Decodes permanent raster payloads before topology-aware mesh construction.
pub fn decode_encoded_elevation_raster(
    input: EncodedElevationRasterInput<'_>,
    render_origin: WorldVec3,
) -> Result<DecodedElevationRaster, ElevationRasterError> {
    let elevation_count = pixel_count(input.width, input.height)?;
    let color_count = pixel_count(input.color_width, input.color_height)?;
    validate_decode_budget(elevation_count, input.topology)?;
    validate_lsb0_mask(input.validity_mask, elevation_count)?;
    let rgba8 = match input.color_encoding {
        RasterColorEncoding::Rgba8 => {
            if input.color.len() != color_count.saturating_mul(4) {
                return Err(ElevationRasterError::Image);
            }
            input.color.to_vec()
        }
        RasterColorEncoding::EncodedImage => {
            let image = crate::decode_limits::decode_bounded_image(input.color)
                .map_err(|_| ElevationRasterError::Image)?
                .to_rgba8();
            if image.width() != input.color_width || image.height() != input.color_height {
                return Err(ElevationRasterError::Image);
            }
            image.into_raw()
        }
    };
    let values = decode_elevations(input.elevations, elevation_count, input.elevation_encoding)?;
    if matches!(input.no_data, RasterNoData::AlphaMask)
        && (input.width != input.color_width || input.height != input.color_height)
    {
        return Err(ElevationRasterError::Contract);
    }
    let elevations = values
        .into_iter()
        .enumerate()
        .map(|(index, value)| {
            let value = match input.no_data {
                RasterNoData::None => value.is_finite().then_some(value),
                RasterNoData::Nan => (!value.is_nan()).then_some(value),
                RasterNoData::Numeric { value: no_data } => {
                    (value.to_bits() != no_data.to_bits()).then_some(value)
                }
                RasterNoData::AlphaMask => (rgba8[index * 4 + 3] != 0).then_some(value),
            };
            if input.validity_mask.is_none_or(|mask| lsb0_bit(mask, index)) {
                value
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    decode_elevation_raster(
        ElevationRasterInput {
            width: input.width,
            height: input.height,
            color_width: input.color_width,
            color_height: input.color_height,
            rgba8: &rgba8,
            elevations: &elevations,
            triangle_mask: input.triangle_mask,
            mapping: input.mapping,
            topology: input.topology,
        },
        render_origin,
    )
}

fn decode_elevations(
    bytes: &[u8],
    count: usize,
    encoding: RasterElevationEncoding,
) -> Result<Vec<f64>, ElevationRasterError> {
    if let RasterElevationEncoding::Constant { value } = encoding {
        if !bytes.is_empty() || !value.is_finite() {
            return Err(ElevationRasterError::ElevationEncoding);
        }
        return Ok(vec![value; count]);
    }
    let width = match encoding {
        RasterElevationEncoding::Float32LittleEndian
        | RasterElevationEncoding::Float32BigEndian => 4,
        RasterElevationEncoding::Float64LittleEndian
        | RasterElevationEncoding::Float64BigEndian => 8,
        RasterElevationEncoding::Constant { .. } => unreachable!("handled above"),
    };
    if bytes.len() != count.saturating_mul(width) {
        return Err(ElevationRasterError::ElevationEncoding);
    }
    bytes
        .chunks_exact(width)
        .map(|sample| {
            let value = match encoding {
                RasterElevationEncoding::Float32LittleEndian => {
                    f64::from(f32::from_le_bytes(sample.try_into().expect("sample size")))
                }
                RasterElevationEncoding::Float32BigEndian => {
                    f64::from(f32::from_be_bytes(sample.try_into().expect("sample size")))
                }
                RasterElevationEncoding::Float64LittleEndian => {
                    f64::from_le_bytes(sample.try_into().expect("sample size"))
                }
                RasterElevationEncoding::Float64BigEndian => {
                    f64::from_be_bytes(sample.try_into().expect("sample size"))
                }
                RasterElevationEncoding::Constant { .. } => unreachable!("handled above"),
            };
            if value.is_infinite() {
                Err(ElevationRasterError::ElevationEncoding)
            } else {
                Ok(value)
            }
        })
        .collect()
}

/// Creates geometry without inventing connectivity across declared pixel edges.
pub fn decode_elevation_raster(
    input: ElevationRasterInput<'_>,
    render_origin: WorldVec3,
) -> Result<DecodedElevationRaster, ElevationRasterError> {
    validate(&input, render_origin)?;
    match input.topology {
        RasterSurfaceTopology::Continuous {
            maximum_height_jump,
            diagonal,
        } => continuous(input, render_origin, maximum_height_jump, diagonal),
        RasterSurfaceTopology::PixelSteps => pixel_steps(input, render_origin),
    }
}

fn continuous(
    input: ElevationRasterInput<'_>,
    origin: WorldVec3,
    maximum_jump: Option<f64>,
    diagonal: RasterCellDiagonal,
) -> Result<DecodedElevationRaster, ElevationRasterError> {
    let count = pixel_count(input.width, input.height)?;
    let mut vertices = Vec::with_capacity(count);
    for row in 0..input.height {
        for column in 0..input.width {
            let index = linear_index(column, row, input.width)?;
            let elevation = input.elevations[index].unwrap_or(origin.z);
            vertices.push(vertex(
                world_xy(input.mapping, f64::from(column), f64::from(row)),
                elevation,
                origin,
                uv_sample(column, row, input.width, input.height),
            )?);
        }
    }
    let mut indices = Vec::new();
    for row in 0..input.height.saturating_sub(1) {
        for column in 0..input.width.saturating_sub(1) {
            let a = linear_index(column, row, input.width)?;
            let b = linear_index(column + 1, row, input.width)?;
            let c = linear_index(column, row + 1, input.width)?;
            let d = linear_index(column + 1, row + 1, input.width)?;
            let triangles = match diagonal {
                RasterCellDiagonal::TopLeftToBottomRight => [[a, b, d], [a, d, c]],
                RasterCellDiagonal::TopRightToBottomLeft => [[a, b, c], [b, d, c]],
            };
            let cell = usize::try_from(row)
                .ok()
                .and_then(|row| {
                    usize::try_from(input.width.saturating_sub(1))
                        .ok()
                        .and_then(|width| row.checked_mul(width))
                })
                .and_then(|base| {
                    usize::try_from(column)
                        .ok()
                        .and_then(|column| base.checked_add(column))
                })
                .ok_or(ElevationRasterError::TooLarge)?;
            for (triangle_in_cell, triangle) in triangles.into_iter().enumerate() {
                let admitted = input.triangle_mask.is_none_or(|mask| {
                    lsb0_bit(
                        mask,
                        cell.saturating_mul(2).saturating_add(triangle_in_cell),
                    )
                });
                add_triangle(
                    &mut indices,
                    triangle,
                    input.elevations,
                    maximum_jump,
                    admitted,
                )?;
            }
        }
    }
    recompute_vertex_normals(&mut vertices, &indices);
    Ok(DecodedElevationRaster {
        world_origin: origin,
        width: input.width,
        height: input.height,
        color_width: input.color_width,
        color_height: input.color_height,
        rgba8: input.rgba8.to_vec(),
        source_elevations: compact_elevations(input.elevations),
        vertices,
        indices,
    })
}

fn pixel_steps(
    input: ElevationRasterInput<'_>,
    origin: WorldVec3,
) -> Result<DecodedElevationRaster, ElevationRasterError> {
    let count = pixel_count(input.width, input.height)?;
    let mut vertices = Vec::with_capacity(count.saturating_mul(4));
    let mut indices = Vec::with_capacity(count.saturating_mul(6));
    for row in 0..input.height {
        for column in 0..input.width {
            let source_index = linear_index(column, row, input.width)?;
            let Some(elevation) = input.elevations[source_index] else {
                continue;
            };
            let base = u32::try_from(vertices.len()).map_err(|_| ElevationRasterError::TooLarge)?;
            for (column_offset, row_offset) in [(0_u32, 0_u32), (1, 0), (1, 1), (0, 1)] {
                let grid_column = column + column_offset;
                let grid_row = row + row_offset;
                vertices.push(vertex(
                    world_xy(
                        input.mapping,
                        f64::from(grid_column) - 0.5,
                        f64::from(grid_row) - 0.5,
                    ),
                    elevation,
                    origin,
                    uv_corner(grid_column, grid_row, input.width, input.height),
                )?);
            }
            indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
        }
    }
    recompute_vertex_normals(&mut vertices, &indices);
    Ok(DecodedElevationRaster {
        world_origin: origin,
        width: input.width,
        height: input.height,
        color_width: input.color_width,
        color_height: input.color_height,
        rgba8: input.rgba8.to_vec(),
        source_elevations: compact_elevations(input.elevations),
        vertices,
        indices,
    })
}

fn add_triangle(
    indices: &mut Vec<u32>,
    triangle: [usize; 3],
    elevations: &[Option<f64>],
    maximum_jump: Option<f64>,
    admitted: bool,
) -> Result<(), ElevationRasterError> {
    if !admitted {
        return Ok(());
    }
    let Some(values) = triangle
        .map(|index| elevations[index])
        .into_iter()
        .collect::<Option<Vec<_>>>()
    else {
        return Ok(());
    };
    let minimum = values.iter().copied().fold(f64::INFINITY, f64::min);
    let maximum = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    if maximum_jump.is_some_and(|jump| maximum - minimum > jump) {
        return Ok(());
    }
    for index in triangle {
        indices.push(u32::try_from(index).map_err(|_| ElevationRasterError::TooLarge)?);
    }
    Ok(())
}

fn compact_elevations(elevations: &[Option<f64>]) -> Arc<[f64]> {
    elevations
        .iter()
        .map(|elevation| elevation.unwrap_or(f64::NAN))
        .collect::<Vec<_>>()
        .into()
}

fn validate(
    input: &ElevationRasterInput<'_>,
    origin: WorldVec3,
) -> Result<(), ElevationRasterError> {
    let count = pixel_count(input.width, input.height)?;
    let color_count = pixel_count(input.color_width, input.color_height)?;
    validate_decode_budget(count, input.topology)?;
    if input.elevations.len() != count || input.rgba8.len() != color_count.saturating_mul(4) {
        return Err(ElevationRasterError::BandSize);
    }
    validate_lsb0_mask(
        input.triangle_mask,
        cell_triangle_count(input.width, input.height)?,
    )?;
    if input.triangle_mask.is_some() && matches!(input.topology, RasterSurfaceTopology::PixelSteps)
    {
        return Err(ElevationRasterError::InvalidTopology);
    }
    let mapping_values = [
        input.mapping.origin[0],
        input.mapping.origin[1],
        input.mapping.column_step[0],
        input.mapping.column_step[1],
        input.mapping.row_step[0],
        input.mapping.row_step[1],
        origin.x,
        origin.y,
        origin.z,
    ];
    if mapping_values.iter().any(|value| !value.is_finite())
        || input
            .elevations
            .iter()
            .flatten()
            .any(|value| !value.is_finite())
    {
        return Err(ElevationRasterError::NonFinite);
    }
    let determinant = input.mapping.column_step[0].mul_add(
        input.mapping.row_step[1],
        -input.mapping.column_step[1] * input.mapping.row_step[0],
    );
    if determinant.abs() <= f64::EPSILON {
        return Err(ElevationRasterError::InvalidMapping);
    }
    if let RasterSurfaceTopology::Continuous {
        maximum_height_jump: Some(jump),
        ..
    } = input.topology
    {
        if !jump.is_finite() || jump < 0.0 {
            return Err(ElevationRasterError::InvalidTopology);
        }
    }
    Ok(())
}

fn cell_triangle_count(width: u32, height: u32) -> Result<usize, ElevationRasterError> {
    usize::try_from(width.saturating_sub(1))
        .ok()
        .and_then(|width| {
            usize::try_from(height.saturating_sub(1))
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .and_then(|cells| cells.checked_mul(2))
        .ok_or(ElevationRasterError::TooLarge)
}

fn validate_lsb0_mask(mask: Option<&[u8]>, bit_count: usize) -> Result<(), ElevationRasterError> {
    let Some(mask) = mask else { return Ok(()) };
    let expected = bit_count
        .checked_add(7)
        .map(|bits| bits / 8)
        .ok_or(ElevationRasterError::TooLarge)?;
    if mask.len() != expected {
        return Err(ElevationRasterError::BandSize);
    }
    let remainder = bit_count % 8;
    if remainder != 0 && mask.last().is_some_and(|byte| byte >> remainder != 0) {
        return Err(ElevationRasterError::BandSize);
    }
    Ok(())
}

fn lsb0_bit(mask: &[u8], bit: usize) -> bool {
    mask.get(bit / 8)
        .is_some_and(|byte| byte & (1_u8 << (bit % 8)) != 0)
}

fn validate_decode_budget(
    count: usize,
    topology: RasterSurfaceTopology,
) -> Result<(), ElevationRasterError> {
    let vertices_per_pixel = match topology {
        RasterSurfaceTopology::Continuous { .. } => 1,
        RasterSurfaceTopology::PixelSteps => 4,
    };
    let indices_per_pixel = 6_usize;
    let output_bytes = count
        .checked_mul(vertices_per_pixel)
        .and_then(|vertices| vertices.checked_mul(std::mem::size_of::<GpuMeshVertexInput>()))
        .and_then(|vertices| {
            count
                .checked_mul(indices_per_pixel * std::mem::size_of::<u32>())
                .and_then(|indices| vertices.checked_add(indices))
        })
        .and_then(|bytes| {
            count
                .checked_mul(12)
                .and_then(|bands| bytes.checked_add(bands))
        })
        .ok_or(ElevationRasterError::TooLarge)?;
    if output_bytes > crate::decode_limits::MAX_DECODED_CONTENT_BYTES {
        return Err(ElevationRasterError::TooLarge);
    }
    Ok(())
}

fn vertex(
    xy: [f64; 2],
    elevation: f64,
    origin: WorldVec3,
    tex_coord: [f32; 2],
) -> Result<GpuMeshVertexInput, ElevationRasterError> {
    #[allow(clippy::cast_possible_truncation)]
    let position = [
        (xy[0] - origin.x) as f32,
        (xy[1] - origin.y) as f32,
        (elevation - origin.z) as f32,
    ];
    if position.iter().any(|value| !value.is_finite()) {
        return Err(ElevationRasterError::NonFinite);
    }
    Ok(GpuMeshVertexInput {
        position,
        normal: [0.0; 3],
        tex_coord,
        additional_tex_coords: [[0.0; 2]; 7],
        color: [1.0; 4],
    })
}

fn recompute_vertex_normals(vertices: &mut [GpuMeshVertexInput], indices: &[u32]) {
    for triangle in indices.chunks_exact(3) {
        let [first, second, third] = triangle else {
            unreachable!("exact triangle chunks")
        };
        let Ok(first) = usize::try_from(*first) else {
            continue;
        };
        let Ok(second) = usize::try_from(*second) else {
            continue;
        };
        let Ok(third) = usize::try_from(*third) else {
            continue;
        };
        let Some(a) = vertices.get(first).map(|vertex| vertex.position) else {
            continue;
        };
        let Some(b) = vertices.get(second).map(|vertex| vertex.position) else {
            continue;
        };
        let Some(c) = vertices.get(third).map(|vertex| vertex.position) else {
            continue;
        };
        let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let mut face = [
            ab[1].mul_add(ac[2], -ab[2] * ac[1]),
            ab[2].mul_add(ac[0], -ab[0] * ac[2]),
            ab[0].mul_add(ac[1], -ab[1] * ac[0]),
        ];
        if face[2] < 0.0 {
            face = face.map(|component| -component);
        }
        for index in [first, second, third] {
            if let Some(vertex) = vertices.get_mut(index) {
                for (component, value) in vertex.normal.iter_mut().zip(face) {
                    *component += value;
                }
            }
        }
    }
    for vertex in vertices {
        let length = vertex
            .normal
            .iter()
            .map(|value| value * value)
            .sum::<f32>()
            .sqrt();
        if length > f32::EPSILON && length.is_finite() {
            for component in &mut vertex.normal {
                *component /= length;
            }
        } else {
            vertex.normal = [0.0, 0.0, 1.0];
        }
    }
}

fn world_xy(mapping: RasterGridMapping, column: f64, row: f64) -> [f64; 2] {
    [
        mapping.origin[0] + mapping.column_step[0] * column + mapping.row_step[0] * row,
        mapping.origin[1] + mapping.column_step[1] * column + mapping.row_step[1] * row,
    ]
}

fn uv_sample(column: u32, row: u32, width: u32, height: u32) -> [f32; 2] {
    let u_denominator = u16::try_from(width.saturating_sub(1).max(1)).unwrap_or(u16::MAX);
    let v_denominator = u16::try_from(height.saturating_sub(1).max(1)).unwrap_or(u16::MAX);
    let u = u16::try_from(column).unwrap_or(u16::MAX);
    let v = u16::try_from(row).unwrap_or(u16::MAX);
    [
        f32::from(u) / f32::from(u_denominator),
        f32::from(v) / f32::from(v_denominator),
    ]
}

fn uv_corner(column: u32, row: u32, width: u32, height: u32) -> [f32; 2] {
    let column = u16::try_from(column).unwrap_or(u16::MAX);
    let row = u16::try_from(row).unwrap_or(u16::MAX);
    let width = u16::try_from(width).unwrap_or(u16::MAX);
    let height = u16::try_from(height).unwrap_or(u16::MAX);
    [
        f32::from(column) / f32::from(width),
        f32::from(row) / f32::from(height),
    ]
}

fn linear_index(column: u32, row: u32, width: u32) -> Result<usize, ElevationRasterError> {
    let index = u64::from(row)
        .checked_mul(u64::from(width))
        .and_then(|value| value.checked_add(u64::from(column)))
        .ok_or(ElevationRasterError::TooLarge)?;
    usize::try_from(index).map_err(|_| ElevationRasterError::TooLarge)
}

fn pixel_count(width: u32, height: u32) -> Result<usize, ElevationRasterError> {
    if width == 0 || height == 0 || width > u32::from(u16::MAX) || height > u32::from(u16::MAX) {
        return Err(ElevationRasterError::BandSize);
    }
    usize::try_from(u64::from(width) * u64::from(height))
        .map_err(|_| ElevationRasterError::TooLarge)
}

#[cfg(test)]
mod tests {
    use himmelcad_core::canonical_document::EntityVersionRef;
    use himmelcad_core::canonical_resources::CanonicalResourceRef;
    use himmelcad_core::entity::EntityId;
    use himmelcad_core::entity_model::{
        DepthField, DepthSampling, DepthSemantics, GeometryResource, OrthoGridMapping,
        RasterCellDiagonal, RasterConfidenceBand, RasterConfidenceEncoding, RasterConnectivity,
        RasterImageGeometry, RasterInterpolation, RasterMapping, Vector3,
    };
    use himmelcad_core::hash::ObjectHash;

    use super::{
        decode_elevation_raster, decode_encoded_elevation_raster, ElevationRasterInput,
        EncodedElevationRasterInput, PreparedRasterSurfaceGrid, PreparedRasterTileContract,
        RasterColorEncoding, RasterElevationEncoding, RasterGridMapping, RasterNoData,
        RasterSurfaceTopology, PREPARED_RASTER_SURFACE_TILE_SCHEMA_VERSION,
        PREPARED_RASTER_TILE_SCHEMA_VERSION,
    };
    use crate::WorldVec3;

    fn mapping() -> RasterGridMapping {
        RasterGridMapping {
            origin: [500_000.0, 5_400_000.0],
            column_step: [1.0, 0.0],
            row_step: [0.0, -1.0],
        }
    }

    fn origin() -> WorldVec3 {
        WorldVec3 {
            x: 500_000.0,
            y: 5_400_000.0,
            z: 0.0,
        }
    }

    fn resource(bytes: &[u8], media_type: &str) -> GeometryResource {
        GeometryResource {
            object_hash: ObjectHash::of_bytes(bytes),
            media_type: media_type.to_owned(),
            byte_length: u64::try_from(bytes.len()).ok(),
        }
    }

    fn prepared_contract() -> PreparedRasterTileContract {
        PreparedRasterTileContract {
            schema_version: PREPARED_RASTER_TILE_SCHEMA_VERSION,
            raster: RasterImageGeometry {
                pixels: resource(&[255; 16], "image/rgba8"),
                width: 2,
                height: 2,
                mapping: RasterMapping::OrthoGrid(OrthoGridMapping {
                    origin: Vector3 {
                        x: 500_000.0,
                        y: 5_400_000.0,
                        z: 0.0,
                    },
                    column_step: Vector3 {
                        x: 1.0,
                        y: 0.0,
                        z: 0.0,
                    },
                    row_step: Vector3 {
                        x: 0.0,
                        y: -1.0,
                        z: 0.0,
                    },
                }),
                depth: Some(DepthField {
                    values: resource(&[0; 16], "application/vnd.himmelcad.depth-f32le"),
                    validity: None,
                    confidence: None,
                    sampling: DepthSampling {
                        semantics: DepthSemantics::ElevationZ,
                        interpolation: RasterInterpolation::DiscontinuityAware,
                        connectivity: RasterConnectivity::Continuous {
                            maximum_height_jump: Some(0.5),
                            diagonal: RasterCellDiagonal::TopLeftToBottomRight,
                        },
                    },
                }),
            },
            color_encoding: RasterColorEncoding::Rgba8,
            depth_encoding: RasterElevationEncoding::Float32LittleEndian,
            no_data: RasterNoData::None,
            surface: None,
        }
    }

    #[test]
    fn prepared_contract_reuses_canonical_raster_authority_and_rejects_schema_drift() {
        let mut contract = prepared_contract();
        assert_eq!(contract.validate(), Ok(()));
        assert_eq!(
            contract.validate_payloads(&[255; 16], &[0; 16], None, None, None),
            Ok(())
        );
        assert_eq!(
            contract.validate_payloads(&[254; 16], &[0; 16], None, None, None),
            Err(super::ElevationRasterError::Contract)
        );

        contract.schema_version += 1;
        assert_eq!(
            contract.validate(),
            Err(super::ElevationRasterError::Contract)
        );
        contract.schema_version = PREPARED_RASTER_TILE_SCHEMA_VERSION;
        contract.raster.depth = None;
        assert_eq!(
            contract.validate(),
            Err(super::ElevationRasterError::Contract)
        );
    }

    #[test]
    fn surface_drape_keeps_full_colour_page_and_independent_edge_support() {
        let color = [255_u8; 4 * 4 * 4];
        let elevations = [0_u8; 3 * 3 * 4];
        let depth = DepthField {
            values: resource(&elevations, "application/vnd.himmelcad.depth-f32le"),
            validity: None,
            confidence: None,
            sampling: DepthSampling {
                semantics: DepthSemantics::ElevationZ,
                interpolation: RasterInterpolation::DiscontinuityAware,
                connectivity: RasterConnectivity::Continuous {
                    maximum_height_jump: None,
                    diagonal: RasterCellDiagonal::TopLeftToBottomRight,
                },
            },
        };
        let mut contract = PreparedRasterTileContract {
            schema_version: PREPARED_RASTER_SURFACE_TILE_SCHEMA_VERSION,
            raster: RasterImageGeometry {
                pixels: resource(&color, "image/rgba8"),
                width: 4,
                height: 4,
                mapping: RasterMapping::OrthoGrid(OrthoGridMapping {
                    origin: Vector3 {
                        x: 0.5,
                        y: 3.5,
                        z: 0.0,
                    },
                    column_step: Vector3 {
                        x: 1.0,
                        y: 0.0,
                        z: 0.0,
                    },
                    row_step: Vector3 {
                        x: 0.0,
                        y: -1.0,
                        z: 0.0,
                    },
                }),
                depth: None,
            },
            color_encoding: RasterColorEncoding::Rgba8,
            depth_encoding: RasterElevationEncoding::Float32LittleEndian,
            no_data: RasterNoData::Nan,
            surface: Some(PreparedRasterSurfaceGrid {
                width: 3,
                height: 3,
                mapping: RasterGridMapping {
                    origin: [0.0, 4.0],
                    column_step: [2.0, 0.0],
                    row_step: [0.0, -2.0],
                },
                depth,
                source_surface: EntityVersionRef {
                    id: EntityId("surface-1".to_owned()),
                    revision: 7,
                    version_hash: ObjectHash::of_bytes(b"surface revision"),
                },
                derivation: CanonicalResourceRef {
                    resource_id: "surface-drape-1".to_owned(),
                    schema_id: "hcad.derivation.raster-surface-drape@1".to_owned(),
                    content_hash: ObjectHash::of_bytes(b"surface drape derivation"),
                },
            }),
        };
        assert_eq!(contract.validate(), Ok(()));
        assert_eq!(contract.decode_dimensions(), Ok((4, 4, 3, 3)));
        assert_eq!(
            contract.validate_payloads(&color, &elevations, None, None, None),
            Ok(())
        );
        let decoded = decode_encoded_elevation_raster(
            EncodedElevationRasterInput {
                width: 3,
                height: 3,
                color_width: 4,
                color_height: 4,
                color: &color,
                elevations: &elevations,
                validity_mask: None,
                triangle_mask: None,
                color_encoding: RasterColorEncoding::Rgba8,
                elevation_encoding: RasterElevationEncoding::Float32LittleEndian,
                no_data: RasterNoData::Nan,
                mapping: RasterGridMapping {
                    origin: [0.0, 4.0],
                    column_step: [2.0, 0.0],
                    row_step: [0.0, -2.0],
                },
                topology: RasterSurfaceTopology::Continuous {
                    maximum_height_jump: None,
                    diagonal: RasterCellDiagonal::TopLeftToBottomRight,
                },
            },
            WorldVec3 {
                x: 0.0,
                y: 4.0,
                z: 0.0,
            },
        )
        .expect("independent surface drape decode");
        assert_eq!((decoded.width, decoded.height), (3, 3));
        assert_eq!((decoded.color_width, decoded.color_height), (4, 4));
        assert_eq!(decoded.vertices.len(), 9);
        assert_eq!(decoded.rgba8.len(), 64);
        assert_eq!(decoded.vertices[0].tex_coord, [0.0, 0.0]);
        assert_eq!(decoded.vertices[8].tex_coord, [1.0, 1.0]);

        contract.surface.as_mut().unwrap().mapping.origin[0] = 0.25;
        assert_eq!(
            contract.validate(),
            Err(super::ElevationRasterError::Contract)
        );
    }

    #[test]
    fn prepared_contract_transports_confidence_without_changing_surface_semantics() {
        let mut contract = prepared_contract();
        let confidence = [0_u8, 127, 255, 64];
        contract.raster.depth.as_mut().unwrap().confidence = Some(RasterConfidenceBand {
            resource: resource(
                &confidence,
                "application/vnd.himmelcad.raster-confidence+unorm8",
            ),
            encoding: RasterConfidenceEncoding::Unorm8,
        });
        assert_eq!(
            contract.validate_payloads(&[255; 16], &[0; 16], None, Some(&confidence), None,),
            Ok(())
        );
        assert_eq!(
            contract.validate_payloads(&[255; 16], &[0; 16], None, None, None),
            Err(super::ElevationRasterError::Contract)
        );

        let invalid = [1.5_f32, 0.5, 0.25, 0.0]
            .into_iter()
            .flat_map(f32::to_le_bytes)
            .collect::<Vec<_>>();
        contract.raster.depth.as_mut().unwrap().confidence = Some(RasterConfidenceBand {
            resource: resource(
                &invalid,
                "application/vnd.himmelcad.raster-confidence+f32le",
            ),
            encoding: RasterConfidenceEncoding::Float32LittleEndian,
        });
        assert_eq!(
            contract.validate_payloads(&[255; 16], &[0; 16], None, Some(&invalid), None,),
            Err(super::ElevationRasterError::Contract)
        );
    }

    #[test]
    fn pixel_steps_do_not_share_or_bridge_height_discontinuities() {
        let decoded = decode_elevation_raster(
            ElevationRasterInput {
                width: 2,
                height: 1,
                color_width: 2,
                color_height: 1,
                rgba8: &[255; 8],
                elevations: &[Some(10.0), Some(100.0)],
                triangle_mask: None,
                mapping: mapping(),
                topology: RasterSurfaceTopology::PixelSteps,
            },
            origin(),
        )
        .expect("pixel steps");

        assert_eq!(decoded.vertices.len(), 8);
        assert_eq!(decoded.indices.len(), 12);
        assert!((decoded.vertices[1].position[2] - 10.0).abs() < f32::EPSILON);
        assert!((decoded.vertices[4].position[2] - 100.0).abs() < f32::EPSILON);
    }

    #[test]
    fn rejects_raster_dimensions_before_band_or_mesh_allocation() {
        let error = decode_elevation_raster(
            ElevationRasterInput {
                width: u32::from(u16::MAX),
                height: u32::from(u16::MAX),
                color_width: u32::from(u16::MAX),
                color_height: u32::from(u16::MAX),
                rgba8: &[],
                elevations: &[],
                triangle_mask: None,
                mapping: mapping(),
                topology: RasterSurfaceTopology::PixelSteps,
            },
            origin(),
        )
        .expect_err("oversized raster");
        assert_eq!(error, super::ElevationRasterError::TooLarge);
    }

    #[test]
    fn continuous_topology_suppresses_triangles_crossing_declared_jump() {
        let input = ElevationRasterInput {
            width: 2,
            height: 2,
            color_width: 2,
            color_height: 2,
            rgba8: &[255; 16],
            elevations: &[Some(0.0), Some(0.0), Some(0.0), Some(10.0)],
            triangle_mask: None,
            mapping: mapping(),
            topology: RasterSurfaceTopology::Continuous {
                maximum_height_jump: Some(1.0),
                diagonal: RasterCellDiagonal::TopLeftToBottomRight,
            },
        };
        let decoded = decode_elevation_raster(input, origin()).expect("height field");

        assert!(decoded.indices.is_empty());
    }

    #[test]
    fn encoded_float_grid_preserves_alpha_nodata_and_pixel_steps() {
        let elevations = [10.0_f32, 100.0]
            .into_iter()
            .flat_map(f32::to_le_bytes)
            .collect::<Vec<_>>();
        let decoded = decode_encoded_elevation_raster(
            EncodedElevationRasterInput {
                width: 2,
                height: 1,
                color_width: 2,
                color_height: 1,
                color: &[255, 0, 0, 255, 0, 255, 0, 0],
                elevations: &elevations,
                validity_mask: None,
                triangle_mask: None,
                color_encoding: RasterColorEncoding::Rgba8,
                elevation_encoding: RasterElevationEncoding::Float32LittleEndian,
                no_data: RasterNoData::AlphaMask,
                mapping: mapping(),
                topology: RasterSurfaceTopology::PixelSteps,
            },
            origin(),
        )
        .expect("encoded raster");
        assert_eq!(decoded.vertices.len(), 4);
        assert_eq!(decoded.indices.len(), 6);
        assert!((decoded.vertices[0].position[2] - 10.0).abs() < f32::EPSILON);
    }

    #[test]
    fn continuous_heightfield_normals_follow_the_slope_and_stay_upward() {
        let decoded = decode_elevation_raster(
            ElevationRasterInput {
                width: 2,
                height: 2,
                color_width: 2,
                color_height: 2,
                rgba8: &[255; 16],
                elevations: &[Some(0.0), Some(1.0), Some(0.0), Some(1.0)],
                triangle_mask: None,
                mapping: RasterGridMapping {
                    origin: [0.0, 0.0],
                    column_step: [1.0, 0.0],
                    row_step: [0.0, 1.0],
                },
                topology: RasterSurfaceTopology::Continuous {
                    maximum_height_jump: None,
                    diagonal: RasterCellDiagonal::TopLeftToBottomRight,
                },
            },
            WorldVec3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
        )
        .expect("sloped raster");

        let expected = 1.0_f32 / 2.0_f32.sqrt();
        for vertex in decoded.vertices {
            assert!((vertex.normal[0] + expected).abs() < 1.0e-6);
            assert!(vertex.normal[1].abs() < 1.0e-6);
            assert!((vertex.normal[2] - expected).abs() < 1.0e-6);
        }
    }

    #[test]
    fn prepared_validity_and_triangle_masks_gate_the_exact_same_triangles() {
        let elevations = [0.0_f32, 1.0, 2.0, 3.0]
            .into_iter()
            .flat_map(f32::to_le_bytes)
            .collect::<Vec<_>>();
        let decoded = decode_encoded_elevation_raster(
            EncodedElevationRasterInput {
                width: 2,
                height: 2,
                color_width: 2,
                color_height: 2,
                color: &[255; 16],
                elevations: &elevations,
                validity_mask: Some(&[0b0000_0111]),
                triangle_mask: Some(&[0b0000_0011]),
                color_encoding: RasterColorEncoding::Rgba8,
                elevation_encoding: RasterElevationEncoding::Float32LittleEndian,
                no_data: RasterNoData::None,
                mapping: mapping(),
                topology: RasterSurfaceTopology::Continuous {
                    maximum_height_jump: None,
                    diagonal: RasterCellDiagonal::TopRightToBottomLeft,
                },
            },
            origin(),
        )
        .expect("masked raster");

        assert_eq!(decoded.indices, [0, 1, 2]);
        assert!(decoded.source_elevations[3].is_nan());
    }

    #[test]
    fn prepared_masks_reject_nonzero_padding_bits() {
        let error = decode_encoded_elevation_raster(
            EncodedElevationRasterInput {
                width: 2,
                height: 2,
                color_width: 2,
                color_height: 2,
                color: &[255; 16],
                elevations: &[],
                validity_mask: Some(&[0b1000_1111]),
                triangle_mask: None,
                color_encoding: RasterColorEncoding::Rgba8,
                elevation_encoding: RasterElevationEncoding::Constant { value: 0.0 },
                no_data: RasterNoData::None,
                mapping: mapping(),
                topology: RasterSurfaceTopology::Continuous {
                    maximum_height_jump: None,
                    diagonal: RasterCellDiagonal::TopLeftToBottomRight,
                },
            },
            origin(),
        )
        .expect_err("non-canonical padding");
        assert_eq!(error, super::ElevationRasterError::BandSize);
    }
}
