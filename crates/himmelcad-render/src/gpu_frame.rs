//! Portable `wgpu` frame targets and first mixed-geometry pipelines.

use std::error::Error;
use std::fmt::{Display, Formatter};
use std::mem::size_of;
use std::sync::{Arc, Mutex};

use bytemuck::{Pod, Zeroable};
use glam::{DMat3, DMat4};
use himmelcad_core::canonical_resources::{LineTypeElement, LineTypePattern};
use wgpu::util::DeviceExt;

// BUFFER_UPLOAD_GATE: every initialized buffer goes through
// `create_queue_uploaded_buffer`. Browser WebGPU must never map a buffer at
// creation, including small uniform buffers.

use crate::gpu_texture_cache::ImmutableGpuTextureResource;
use crate::{
    ClipOperation, ClipVolume, ColorMode, PackedCivilPointAttributes, PickToken, RenderStyle,
    StrokeCap, StrokeColor, StrokeJoin, StrokeMode, StrokeWidth, TransparencyStrategy,
    WorldTransform, WorldVec3,
};

/// Maximum convex clip volumes in the portable first-tier uniform block.
pub const MAX_CLIP_VOLUMES: usize = 4;
/// Maximum total clip planes across the portable first-tier uniform block.
pub const MAX_CLIP_PLANES: usize = 24;
/// Maximum height-gradient or point-classification colors stored per material.
pub const MAX_GPU_GRADIENT_COLORS: usize = 256;
/// Maximum canonical line-type elements accepted by the shared GPU path.
///
/// This matches the canonical resource validation ceiling. Pattern lookup is
/// logarithmic in the shader and does not consume per-material uniform space.
pub const MAX_GPU_LINE_TYPE_ELEMENTS: usize = 65_536;
const DEFAULT_POINT_CLASSIFICATION_COLORS: [[f32; 4]; 19] = [
    [0.60, 0.60, 0.60, 1.0], // 0 never classified
    [0.75, 0.75, 0.75, 1.0], // 1 unclassified
    [0.55, 0.32, 0.15, 1.0], // 2 ground
    [0.50, 0.80, 0.35, 1.0], // 3 low vegetation
    [0.30, 0.65, 0.20, 1.0], // 4 medium vegetation
    [0.10, 0.45, 0.10, 1.0], // 5 high vegetation
    [0.75, 0.25, 0.20, 1.0], // 6 building
    [0.85, 0.20, 0.85, 1.0], // 7 low noise
    [0.65, 0.65, 0.65, 1.0], // 8 reserved/model key
    [0.15, 0.40, 0.85, 1.0], // 9 water
    [0.35, 0.25, 0.20, 1.0], // 10 rail
    [0.25, 0.25, 0.25, 1.0], // 11 road surface
    [0.90, 0.75, 0.15, 1.0], // 12 overlap/reserved
    [0.80, 0.55, 0.20, 1.0], // 13 wire guard
    [0.95, 0.65, 0.15, 1.0], // 14 wire conductor
    [0.90, 0.45, 0.10, 1.0], // 15 transmission tower
    [0.70, 0.35, 0.15, 1.0], // 16 wire connector
    [0.95, 0.55, 0.15, 1.0], // 17 bridge deck
    [1.00, 0.15, 0.15, 1.0], // 18 high noise
];
/// Maximum independently sorted downlevel splat block.
pub const SORTED_ALPHA_SPLAT_BLOCK_SIZE: usize = 32_768;
/// Maximum CPU-sorted transparent-instance upload traffic admitted by one
/// presented frame.
pub const SORTED_ALPHA_UPLOAD_BYTES_PER_FRAME: u64 = 4 * 1024 * 1024;
/// Largest compact mesh-instance block that can always be reordered within one
/// downlevel frame upload budget.
#[allow(clippy::cast_possible_truncation)] // Four MiB fits every supported wasm/native usize.
pub const SORTED_ALPHA_MESH_INSTANCE_BLOCK_SIZE: usize =
    SORTED_ALPHA_UPLOAD_BYTES_PER_FRAME as usize / size_of::<GpuMeshInstanceInput>();

/// Validated presentation style consumed without rebuilding geometry buffers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GpuPresentationStyle {
    color_mode: u32,
    base_color: [f32; 4],
    opacity: f32,
    vertical_exaggeration: f32,
    exaggeration_datum_relative: f32,
    height_minimum_relative: f32,
    height_maximum_relative: f32,
    gradient_count: u32,
    gradient_colors: [[f32; 4]; MAX_GPU_GRADIENT_COLORS],
    hatch_origin: [f32; 3],
    hatch_enabled: f32,
    hatch_direction: [f32; 3],
    hatch_spacing: f32,
    hatch_color: [f32; 4],
    hatch_line_width: f32,
    fill_visible: f32,
    stroke_visible: f32,
    stroke_color_mode: u32,
    stroke_color: [f32; 4],
    stroke_width_override: f32,
    stroke_cap: u32,
    stroke_join: u32,
    stroke_miter_limit: f32,
    line_type_count: u32,
    line_type_advance_count: u32,
    line_type_dot_count: u32,
    line_type_texture_width: u32,
    line_type_phase: f32,
    line_type_period: f32,
}

impl Default for GpuPresentationStyle {
    fn default() -> Self {
        Self {
            color_mode: 0,
            base_color: [1.0; 4],
            opacity: 1.0,
            vertical_exaggeration: 1.0,
            exaggeration_datum_relative: 0.0,
            height_minimum_relative: 0.0,
            height_maximum_relative: 1.0,
            gradient_count: 1,
            gradient_colors: [[1.0; 4]; MAX_GPU_GRADIENT_COLORS],
            hatch_origin: [0.0; 3],
            hatch_enabled: 0.0,
            hatch_direction: [1.0, 0.0, 0.0],
            hatch_spacing: 1.0,
            hatch_color: [0.0, 0.0, 0.0, 1.0],
            hatch_line_width: 0.1,
            fill_visible: 1.0,
            stroke_visible: 1.0,
            stroke_color_mode: 0,
            stroke_color: [1.0; 4],
            stroke_width_override: 0.0,
            stroke_cap: 0,
            stroke_join: 0,
            stroke_miter_limit: 4.0,
            line_type_count: 0,
            line_type_advance_count: 0,
            line_type_dot_count: 0,
            line_type_texture_width: 1,
            line_type_phase: 0.0,
            line_type_period: 1.0,
        }
    }
}

impl GpuPresentationStyle {
    /// Effective view opacity used to choose opaque versus transparent passes.
    #[must_use]
    pub fn opacity(self) -> f32 {
        self.opacity
    }

    /// Whether this presentation contributes color, depth and pick fragments.
    #[must_use]
    pub fn fill_visible(self) -> bool {
        self.fill_visible >= 0.5
    }

    /// Enables or disables all fragments for a fill-capable batch without
    /// changing its immutable geometry or pick identity.
    #[must_use]
    pub fn with_fill_visible(mut self, visible: bool) -> Self {
        self.fill_visible = if visible { 1.0 } else { 0.0 };
        self
    }

    /// Whether stroke-capable color and ID fragments are enabled.
    #[must_use]
    pub fn stroke_visible(self) -> bool {
        self.stroke_visible >= 0.5
    }

    /// Resolves the entity stroke contract without changing immutable line instances.
    pub fn with_stroke(mut self, style: &crate::StrokeStyle) -> Result<Self, GpuFrameError> {
        if !style.miter_limit.is_finite() || style.miter_limit < 1.0 {
            return Err(GpuFrameError::InvalidStyle);
        }
        self.stroke_visible = if matches!(style.mode, StrokeMode::None) {
            0.0
        } else {
            1.0
        };
        match style.color {
            StrokeColor::Inherit => self.stroke_color_mode = 0,
            StrokeColor::Uniform { color } => {
                if color.iter().any(|value| !value.is_finite()) {
                    return Err(GpuFrameError::InvalidStyle);
                }
                self.stroke_color_mode = 1;
                self.stroke_color = color;
            }
        }
        self.stroke_width_override = match style.width {
            StrokeWidth::Source => 0.0,
            StrokeWidth::Screen { pixels } if pixels.is_finite() && pixels > 0.0 => pixels,
            StrokeWidth::Screen { .. } => return Err(GpuFrameError::InvalidStyle),
        };
        self.stroke_cap = match style.cap {
            StrokeCap::Butt => 0,
            StrokeCap::Square => 1,
            StrokeCap::Round => 2,
        };
        self.stroke_join = match style.join {
            StrokeJoin::Miter => 0,
            StrokeJoin::Bevel => 1,
            StrokeJoin::Round => 2,
        };
        self.stroke_miter_limit = style.miter_limit;
        Ok(self)
    }

    /// Adds one validated world-distance line type to the current stroke.
    #[must_use]
    pub fn with_line_type(mut self, pattern: &GpuLineTypePattern) -> Self {
        self.line_type_count = pattern.element_count;
        self.line_type_advance_count = pattern.advance_count;
        self.line_type_dot_count = pattern.dot_count;
        self.line_type_texture_width = pattern.texture_width;
        self.line_type_phase = pattern.phase;
        self.line_type_period = pattern.period;
        self
    }

    /// Resolves a render-world style relative to the geometry batch origin.
    pub fn from_render_style(
        style: &RenderStyle,
        floating_origin: WorldVec3,
        exaggeration_datum: f64,
    ) -> Result<Self, GpuFrameError> {
        if style.base_color.iter().any(|value| !value.is_finite())
            || !style.opacity.is_finite()
            || !(0.0..=1.0).contains(&style.opacity)
            || !style.vertical_exaggeration.is_finite()
            || style.vertical_exaggeration <= 0.0
            || !exaggeration_datum.is_finite()
        {
            return Err(GpuFrameError::InvalidStyle);
        }
        let mut resolved = Self {
            base_color: style.base_color,
            opacity: style.opacity,
            vertical_exaggeration: style.vertical_exaggeration,
            exaggeration_datum_relative: f32_relative(exaggeration_datum, floating_origin.z)?,
            ..Self::default()
        };
        match &style.color_mode {
            ColorMode::Source => resolved.color_mode = 0,
            ColorMode::Uniform => resolved.color_mode = 1,
            ColorMode::Height(gradient) => {
                if !gradient.minimum.is_finite()
                    || !gradient.maximum.is_finite()
                    || gradient.maximum <= gradient.minimum
                    || gradient.colors.is_empty()
                    || gradient.colors.len() > MAX_GPU_GRADIENT_COLORS
                    || gradient
                        .colors
                        .iter()
                        .flatten()
                        .any(|value| !value.is_finite())
                {
                    return Err(GpuFrameError::InvalidStyle);
                }
                resolved.color_mode = 2;
                resolved.height_minimum_relative =
                    f32_relative(gradient.minimum, floating_origin.z)?;
                resolved.height_maximum_relative =
                    f32_relative(gradient.maximum, floating_origin.z)?;
                let output_count = gradient.colors.len();
                resolved.gradient_count =
                    u32::try_from(output_count).expect("gradient color capacity fits u32");
                for index in 0..output_count {
                    resolved.gradient_colors[index] =
                        sample_gradient(&gradient.colors, index, output_count);
                }
            }
            ColorMode::PointIntensity => resolved.color_mode = 3,
            ColorMode::PointClassification { colors } => {
                let colors = if colors.is_empty() {
                    DEFAULT_POINT_CLASSIFICATION_COLORS.as_slice()
                } else {
                    colors.as_slice()
                };
                if colors.len() > MAX_GPU_GRADIENT_COLORS
                    || colors.iter().flatten().any(|value| !value.is_finite())
                {
                    return Err(GpuFrameError::InvalidStyle);
                }
                resolved.color_mode = 4;
                resolved.gradient_count =
                    u32::try_from(colors.len()).expect("classification palette fits u32");
                resolved.gradient_colors[..colors.len()].copy_from_slice(colors);
            }
            ColorMode::PointReturnNumber => resolved.color_mode = 5,
            ColorMode::PointSourceId => resolved.color_mode = 6,
        }
        resolved.with_stroke(&style.stroke)
    }

    /// Adds one anti-aliased world-space vector hatch layer.
    #[must_use]
    pub fn with_hatch(mut self, hatch: GpuHatchPattern) -> Self {
        self.hatch_origin = hatch.origin_relative;
        self.hatch_enabled = 1.0;
        self.hatch_direction = hatch.direction;
        self.hatch_spacing = hatch.spacing;
        self.hatch_color = hatch.color;
        self.hatch_line_width = hatch.line_width;
        self
    }
}

/// Validated canonical world-distance line type prepared for logarithmic GPU lookup.
#[derive(Debug, Clone, PartialEq)]
pub struct GpuLineTypePattern {
    element_count: u32,
    advance_count: u32,
    dot_count: u32,
    texture_width: u32,
    phase: f32,
    period: f32,
    texels: Vec<[f32; 4]>,
}

impl GpuLineTypePattern {
    /// Compiles a validated canonical pattern without inventing alternation.
    pub fn from_canonical(pattern: &LineTypePattern) -> Result<Self, GpuFrameError> {
        Self::from_canonical_with_phase(pattern, 0.0)
    }

    fn from_canonical_with_phase(
        pattern: &LineTypePattern,
        phase: f64,
    ) -> Result<Self, GpuFrameError> {
        if !phase.is_finite() {
            return Err(GpuFrameError::InvalidStyle);
        }
        let LineTypePattern::Repeating { elements } = pattern else {
            return Ok(Self {
                element_count: 0,
                advance_count: 0,
                dot_count: 0,
                texture_width: 1,
                phase: 0.0,
                period: 1.0,
                texels: vec![[0.0; 4]],
            });
        };
        if elements.is_empty() || elements.len() > MAX_GPU_LINE_TYPE_ELEMENTS {
            return Err(GpuFrameError::InvalidStyle);
        }
        let mut boundary = 0.0_f64;
        let mut advances = Vec::with_capacity(elements.len());
        let mut dots = Vec::new();
        for element in elements {
            match element {
                LineTypeElement::Dash { length } if length.is_finite() && *length > 0.0 => {
                    boundary += length;
                    advances.push([boundary, 1.0, 0.0, 0.0]);
                }
                LineTypeElement::Gap { length } if length.is_finite() && *length > 0.0 => {
                    boundary += length;
                    advances.push([boundary, 0.0, 0.0, 0.0]);
                }
                LineTypeElement::Dot => dots.push([boundary, 2.0, 0.0, 0.0]),
                _ => return Err(GpuFrameError::InvalidStyle),
            }
            if !boundary.is_finite() {
                return Err(GpuFrameError::InvalidStyle);
            }
        }
        if boundary <= 0.0 {
            return Err(GpuFrameError::InvalidStyle);
        }
        let texel_count = advances
            .len()
            .checked_add(dots.len())
            .ok_or(GpuFrameError::InvalidStyle)?;
        let texture_width =
            u32::try_from(texel_count.min(256)).map_err(|_| GpuFrameError::InvalidStyle)?;
        let texture_height = u32::try_from(texel_count.div_ceil(texture_width as usize))
            .map_err(|_| GpuFrameError::InvalidStyle)?;
        let padded_count = usize::try_from(texture_width)
            .ok()
            .and_then(|width| {
                usize::try_from(texture_height)
                    .ok()
                    .and_then(|height| width.checked_mul(height))
            })
            .ok_or(GpuFrameError::InvalidStyle)?;
        let mut texels = Vec::with_capacity(padded_count);
        let mut previous_boundary = f32::NEG_INFINITY;
        for entry in &advances {
            #[allow(clippy::cast_possible_truncation)]
            let converted = [entry[0] as f32, entry[1] as f32, 0.0, 0.0];
            if !converted[0].is_finite() || converted[0] <= previous_boundary {
                return Err(GpuFrameError::InvalidStyle);
            }
            previous_boundary = converted[0];
            texels.push(converted);
        }
        for entry in &dots {
            #[allow(clippy::cast_possible_truncation)]
            let position = entry[0] as f32;
            if !position.is_finite() || position < 0.0 || position > previous_boundary {
                return Err(GpuFrameError::InvalidStyle);
            }
            texels.push([position, 2.0, 0.0, 0.0]);
        }
        texels.resize(padded_count, [0.0; 4]);
        #[allow(clippy::cast_possible_truncation)]
        let converted_phase = phase.rem_euclid(boundary) as f32;
        #[allow(clippy::cast_possible_truncation)]
        let converted_period = boundary as f32;
        if !converted_phase.is_finite() || !converted_period.is_finite() || converted_period <= 0.0
        {
            return Err(GpuFrameError::InvalidStyle);
        }
        Ok(Self {
            element_count: u32::try_from(elements.len())
                .map_err(|_| GpuFrameError::InvalidStyle)?,
            advance_count: u32::try_from(advances.len())
                .map_err(|_| GpuFrameError::InvalidStyle)?,
            dot_count: u32::try_from(dots.len()).map_err(|_| GpuFrameError::InvalidStyle)?,
            texture_width,
            phase: converted_phase,
            period: converted_period,
            texels,
        })
    }

    /// Creates the legacy alternating draw/gap sequence at the compatibility boundary.
    pub fn new(segments: &[f64], phase: f64) -> Result<Self, GpuFrameError> {
        if segments.is_empty()
            || !segments.len().is_multiple_of(2)
            || segments.len() > MAX_GPU_LINE_TYPE_ELEMENTS
            || segments
                .iter()
                .any(|value| !value.is_finite() || *value <= 0.0)
        {
            return Err(GpuFrameError::InvalidStyle);
        }
        let elements = segments
            .iter()
            .copied()
            .enumerate()
            .map(|(index, length)| {
                if index.is_multiple_of(2) {
                    LineTypeElement::Dash { length }
                } else {
                    LineTypeElement::Gap { length }
                }
            })
            .collect();
        Self::from_canonical_with_phase(&LineTypePattern::Repeating { elements }, phase)
    }
}

/// Immutable GPU texture containing one exact canonical line-type revision.
#[derive(Debug, Clone)]
pub struct GpuLineTypeResource(Arc<GpuLineTypeResourceInner>);

#[derive(Debug)]
struct GpuLineTypeResourceInner {
    _texture: wgpu::Texture,
    view: wgpu::TextureView,
    pattern: GpuLineTypePattern,
    resident_bytes: u64,
}

impl GpuLineTypeResource {
    fn upload(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        pattern: GpuLineTypePattern,
    ) -> Result<Self, GpuFrameError> {
        let texel_count = pattern.texels.len();
        let width = pattern.texture_width;
        let height = u32::try_from(texel_count.div_ceil(width as usize))
            .map_err(|_| GpuFrameError::InvalidStyle)?;
        let descriptor = wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba32Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        };
        let texture = device.create_texture_with_data(
            queue,
            &descriptor,
            wgpu::util::TextureDataOrder::LayerMajor,
            bytemuck::cast_slice(&pattern.texels),
        );
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let resident_bytes = u64::try_from(texel_count)
            .unwrap_or(u64::MAX)
            .saturating_mul(u64::try_from(size_of::<[f32; 4]>()).expect("size fits u64"));
        Ok(Self(Arc::new(GpuLineTypeResourceInner {
            _texture: texture,
            view,
            pattern,
            resident_bytes,
        })))
    }

    /// Validated canonical pattern represented by this immutable allocation.
    #[must_use]
    pub fn pattern(&self) -> &GpuLineTypePattern {
        &self.0.pattern
    }

    /// Exact GPU bytes retained by this resource revision.
    #[must_use]
    pub fn resident_bytes(&self) -> u64 {
        self.0.resident_bytes
    }

    /// Process-local allocation identity used to verify revision sharing.
    #[must_use]
    pub fn allocation_key(&self) -> usize {
        Arc::as_ptr(&self.0) as usize
    }
}

/// One world-space line hatch compiled from a project hatch resource.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GpuHatchPattern {
    origin_relative: [f32; 3],
    direction: [f32; 3],
    spacing: f32,
    line_width: f32,
    color: [f32; 4],
}

impl GpuHatchPattern {
    /// Resolves a hatch against the same floating origin as its cap geometry.
    pub fn new(
        origin: WorldVec3,
        direction: WorldVec3,
        spacing: f64,
        line_width: f64,
        color: [f32; 4],
        floating_origin: WorldVec3,
    ) -> Result<Self, GpuFrameError> {
        let length =
            (direction.x * direction.x + direction.y * direction.y + direction.z * direction.z)
                .sqrt();
        if !length.is_finite()
            || length <= f64::EPSILON
            || !spacing.is_finite()
            || spacing <= 0.0
            || !line_width.is_finite()
            || line_width <= 0.0
            || line_width > spacing
            || color.iter().any(|value| !value.is_finite())
        {
            return Err(GpuFrameError::InvalidStyle);
        }
        #[allow(clippy::cast_possible_truncation)]
        let converted = Self {
            origin_relative: [
                (origin.x - floating_origin.x) as f32,
                (origin.y - floating_origin.y) as f32,
                (origin.z - floating_origin.z) as f32,
            ],
            direction: [
                (direction.x / length) as f32,
                (direction.y / length) as f32,
                (direction.z / length) as f32,
            ],
            spacing: spacing as f32,
            line_width: line_width as f32,
            color,
        };
        if converted
            .origin_relative
            .iter()
            .chain(&converted.direction)
            .chain([converted.spacing, converted.line_width].iter())
            .any(|value| !value.is_finite())
        {
            return Err(GpuFrameError::InvalidStyle);
        }
        Ok(converted)
    }
}

/// Vertex format shared initially by point, line and triangle proxy buffers.
#[derive(Debug, Clone, Copy, PartialEq, Pod, Zeroable)]
#[repr(C)]
pub struct GpuVertex {
    /// Position relative to the immutable batch's stable world origin.
    pub position: [f32; 3],
    /// Linear RGBA color after resolving the current view style.
    pub color: [f32; 4],
    /// Non-zero render-proxy pick slot.
    pub proxy_slot: u32,
    /// Proxy-local primitive pick slot.
    pub primitive_slot: u32,
}

/// Compact point-cloud vertex avoiding float-color bandwidth.
#[derive(Debug, Clone, Copy, PartialEq, Pod, Zeroable)]
#[repr(C)]
pub struct GpuPointVertex {
    /// Position relative to the point tile's stable floating origin.
    pub position: [f32; 3],
    /// Source color consumed as normalized RGBA.
    pub color: [u8; 4],
    /// Non-zero render-proxy pick slot.
    pub proxy_slot: u32,
    /// Tile-local point index.
    pub primitive_slot: u32,
    /// Diameter in physical viewport pixels.
    pub point_size: f32,
    /// Packed intensity, classification and return number.
    pub civil_0: u32,
    /// Packed source id, number of returns and presence flags.
    pub civil_1: u32,
}

/// Exact byte stride of the point vertex uploaded by every shared point path.
///
/// Residency and hardware policy must derive their GPU point budgets from this
/// constant so changing the canonical vertex layout cannot silently leave stale
/// per-point byte estimates behind.
pub const GPU_POINT_VERTEX_STRIDE_BYTES: u64 = size_of::<GpuPointVertex>() as u64;

/// One anisotropic Gaussian instance in stable tile-local coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Pod, Zeroable)]
#[repr(C)]
pub struct GpuSplatVertex {
    /// Gaussian mean relative to the immutable splat-tile origin.
    pub position: [f32; 3],
    /// Linear RGB and opacity as normalized bytes.
    pub color: [u8; 4],
    /// Positive one-sigma local-axis radii in project units.
    pub scale: [f32; 3],
    /// Normalized local-to-world quaternion in XYZW order.
    pub rotation: [f32; 4],
    /// Non-zero render-proxy pick slot.
    pub proxy_slot: u32,
    /// Tile-local splat index.
    pub primitive_slot: u32,
}

/// One vertex of a pixel-stable glyph quad anchored in project space.
#[derive(Debug, Clone, Copy, PartialEq, Pod, Zeroable)]
#[repr(C)]
pub struct GpuScreenTextVertex {
    /// Project anchor relative to the immutable batch's stable world origin.
    pub anchor: [f32; 3],
    /// Physical-pixel offset from the projected anchor.
    pub pixel_offset: [f32; 2],
    /// Glyph-atlas texture coordinate.
    pub tex_coord: [f32; 2],
    /// Linear RGBA color.
    pub color: [f32; 4],
    /// Non-zero render-proxy pick slot.
    pub proxy_slot: u32,
    /// Glyph-local pick slot.
    pub primitive_slot: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Pod, Zeroable)]
#[repr(C)]
pub(crate) struct GpuLineInstance {
    pub(crate) start: [f32; 3],
    pub(crate) end: [f32; 3],
    pub(crate) color: [f32; 4],
    pub(crate) proxy_slot: u32,
    pub(crate) primitive_slot: u32,
    pub(crate) width: f32,
    pub(crate) previous: [f32; 3],
    pub(crate) next: [f32; 3],
    pub(crate) path_distance: [f32; 2],
    pub(crate) path_chunk: u32,
    pub(crate) topology_flags: u32,
}

fn line_segment_length(start: [f32; 3], end: [f32; 3]) -> f32 {
    start
        .into_iter()
        .zip(end)
        .map(|(start, end)| (end - start) * (end - start))
        .sum::<f32>()
        .sqrt()
}

/// Backend-neutral input vertex for an indexed mesh tile.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct GpuMeshVertexInput {
    /// Position relative to the mesh tile's f64 world origin.
    pub position: [f32; 3],
    /// World-space unit normal.
    pub normal: [f32; 3],
    /// First texture-coordinate set.
    pub tex_coord: [f32; 2],
    /// Linear vertex-color multiplier.
    pub color: [f32; 4],
}

/// Compact chunk-relative affine transform and stable pick identity for one
/// shared-mesh instance.
#[derive(Debug, Clone, Copy, PartialEq, Pod, Zeroable)]
#[repr(C)]
pub struct GpuMeshInstanceInput {
    /// First affine row.
    pub row_0: [f32; 4],
    /// Second affine row.
    pub row_1: [f32; 4],
    /// Third affine row.
    pub row_2: [f32; 4],
    /// Non-zero `RenderWorld` proxy slot for this chunk.
    pub proxy_slot: u32,
    /// Stable source primitive offset for this instance.
    pub primitive_offset: u32,
    /// First inverse-transposed normal row.
    pub normal_row_0: [f32; 4],
    /// Second inverse-transposed normal row.
    pub normal_row_1: [f32; 4],
    /// Third inverse-transposed normal row.
    pub normal_row_2: [f32; 4],
    _padding: [u32; 2],
}

impl GpuMeshInstanceInput {
    /// Creates one validated-layout instance record.
    #[must_use]
    pub fn new(
        rows: [[f32; 4]; 3],
        normal_rows: [[f32; 4]; 3],
        proxy_slot: u32,
        primitive_offset: u32,
    ) -> Self {
        Self {
            row_0: rows[0],
            row_1: rows[1],
            row_2: rows[2],
            proxy_slot,
            primitive_offset,
            normal_row_0: normal_rows[0],
            normal_row_1: normal_rows[1],
            normal_row_2: normal_rows[2],
            _padding: [0; 2],
        }
    }
}

/// Material alpha behavior implemented by the shared color shader.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GpuAlphaMode {
    /// Opaque material.
    Opaque,
    /// Discard samples below a fixed threshold.
    Mask {
        /// Alpha cutoff from zero to one.
        cutoff: f32,
    },
    /// Alpha-blended material.
    Blend,
}

/// Borrowed decoded RGBA8 texture upload.
#[derive(Debug, Clone, Copy)]
pub struct GpuTextureData<'a> {
    /// Pixel width.
    pub width: u32,
    /// Pixel height.
    pub height: u32,
    /// Tightly packed row-major RGBA8 pixels.
    pub rgba8: &'a [u8],
}

/// Borrowed device-ready two-dimensional texture with tightly packed mipmaps.
#[derive(Debug, Clone, Copy)]
pub struct GpuTextureMipChainData<'a> {
    /// Base-level pixel width.
    pub width: u32,
    /// Base-level pixel height.
    pub height: u32,
    /// Number of complete mip levels stored in the upload data.
    pub mip_level_count: u32,
    /// Uncompressed or GPU block-compressed upload format.
    pub format: wgpu::TextureFormat,
    /// Mip-major tightly packed texture blocks or pixels.
    pub data: &'a [u8],
}

/// Resident immutable texture and sampler shared independently from style state.
#[derive(Debug, Clone)]
pub struct GpuTextureResource(Arc<GpuTextureResourceInner>);

#[derive(Debug)]
struct GpuTextureResourceInner {
    _texture: wgpu::Texture,
    view: wgpu::TextureView,
    sampler: wgpu::Sampler,
    resident_bytes: u64,
}

impl GpuTextureResource {
    /// Process-local allocation key shared by every clone retaining this
    /// texture/sampler allocation.
    #[must_use]
    pub fn allocation_key(&self) -> usize {
        Arc::as_ptr(&self.0) as usize
    }

    /// Immutable uploaded texture bytes charged once globally.
    #[must_use]
    pub fn resident_bytes(&self) -> u64 {
        self.0.resident_bytes
    }
}

impl ImmutableGpuTextureResource for GpuTextureResource {
    fn allocation_key(&self) -> usize {
        GpuTextureResource::allocation_key(self)
    }

    fn resident_bytes(&self) -> u64 {
        GpuTextureResource::resident_bytes(self)
    }
}

/// Per-batch style state referencing a potentially shared immutable texture.
#[derive(Debug, Clone)]
pub struct GpuMaterial {
    bind_group: wgpu::BindGroup,
    source_texture_resource: GpuTextureResource,
    active_texture_resource: GpuTextureResource,
    line_type_resource: GpuLineTypeResource,
    uniform: wgpu::Buffer,
    alpha_mode: GpuAlphaMode,
    transparent: bool,
    style: GpuPresentationStyle,
    interaction_translation: [f32; 3],
    source_linear_rows: [[f32; 4]; 3],
    source_normal_rows: [[f32; 4]; 3],
    batch_origin: WorldVec3,
    frame_origin: WorldVec3,
}

#[derive(Debug, Clone, Copy)]
struct MaterialOriginState {
    batch: WorldVec3,
    frame: WorldVec3,
}

impl MaterialOriginState {
    const ZERO: Self = Self {
        batch: WorldVec3 {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        },
        frame: WorldVec3 {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        },
    };
}

impl GpuMaterial {
    fn rewrite_uniform(&self, queue: &wgpu::Queue) {
        let origin_delta = batch_origin_delta(self.batch_origin, self.frame_origin)
            .expect("validated material origins remain representable");
        queue.write_buffer(
            &self.uniform,
            0,
            bytemuck::bytes_of(&MaterialUniform::new(
                self.alpha_mode,
                &self.style,
                self.interaction_translation,
                origin_delta,
                self.source_linear_rows,
                self.source_normal_rows,
            )),
        );
    }

    /// Rewrites only presentation uniforms while retaining texture and geometry.
    pub fn update_style(&mut self, queue: &wgpu::Queue, style: &GpuPresentationStyle) {
        self.style = *style;
        self.rewrite_uniform(queue);
        self.transparent = self.alpha_mode == GpuAlphaMode::Blend || style.opacity < 1.0;
    }

    fn update_interaction_translation(
        &mut self,
        queue: &wgpu::Queue,
        translation: [f32; 3],
    ) -> Result<(), GpuFrameError> {
        if translation.iter().any(|value| !value.is_finite()) {
            return Err(GpuFrameError::InvalidStyle);
        }
        self.interaction_translation = translation;
        self.rewrite_uniform(queue);
        Ok(())
    }

    fn set_world_origins(
        &mut self,
        queue: &wgpu::Queue,
        batch_origin: WorldVec3,
        frame_origin: WorldVec3,
    ) -> Result<(), GpuFrameError> {
        batch_origin_delta(batch_origin, frame_origin)?;
        self.batch_origin = batch_origin;
        self.frame_origin = frame_origin;
        self.rewrite_uniform(queue);
        Ok(())
    }

    fn set_source_to_project_transform(
        &mut self,
        queue: &wgpu::Queue,
        source_origin: WorldVec3,
        frame_origin: WorldVec3,
        transform: WorldTransform,
    ) -> Result<(), GpuFrameError> {
        let (source_linear_rows, source_normal_rows) = affine_rows(transform)?;
        let batch_origin = transform
            .transform_point(source_origin)
            .ok_or(GpuFrameError::InvalidStyle)?;
        batch_origin_delta(batch_origin, frame_origin)?;
        self.source_linear_rows = source_linear_rows;
        self.source_normal_rows = source_normal_rows;
        self.batch_origin = batch_origin;
        self.frame_origin = frame_origin;
        self.rewrite_uniform(queue);
        Ok(())
    }

    fn update_frame_origin(
        &mut self,
        queue: &wgpu::Queue,
        frame_origin: WorldVec3,
    ) -> Result<(), GpuFrameError> {
        batch_origin_delta(self.batch_origin, frame_origin)?;
        self.frame_origin = frame_origin;
        self.rewrite_uniform(queue);
        Ok(())
    }

    fn rebind_active_texture(
        &mut self,
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        texture: &GpuTextureResource,
    ) {
        let bind_group = create_material_bind_group(
            device,
            layout,
            "himmelcad-presentation-texture",
            texture,
            &self.line_type_resource,
            &self.uniform,
        );
        self.active_texture_resource = texture.clone();
        self.bind_group = bind_group;
    }

    fn rebind_line_type_resource(
        &mut self,
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        resource: &GpuLineTypeResource,
    ) {
        self.bind_group = create_material_bind_group(
            device,
            layout,
            "himmelcad-line-type-resource",
            &self.active_texture_resource,
            resource,
            &self.uniform,
        );
        self.line_type_resource = resource.clone();
    }
}

fn batch_origin_delta(
    batch_origin: WorldVec3,
    frame_origin: WorldVec3,
) -> Result<[f32; 3], GpuFrameError> {
    let delta = [
        batch_origin.x - frame_origin.x,
        batch_origin.y - frame_origin.y,
        batch_origin.z - frame_origin.z,
    ];
    #[allow(clippy::cast_possible_truncation)]
    let delta = delta.map(|value| value as f32);
    if delta.iter().any(|value| !value.is_finite()) {
        return Err(GpuFrameError::NonFiniteFrameValue);
    }
    Ok(delta)
}

const IDENTITY_AFFINE_ROWS: [[f32; 4]; 3] = [
    [1.0, 0.0, 0.0, 0.0],
    [0.0, 1.0, 0.0, 0.0],
    [0.0, 0.0, 1.0, 0.0],
];

fn affine_rows(transform: WorldTransform) -> Result<([[f32; 4]; 3], [[f32; 4]; 3]), GpuFrameError> {
    if !transform.is_invertible_affine() {
        return Err(GpuFrameError::InvalidStyle);
    }
    let linear = DMat3::from_mat4(DMat4::from_cols_array(&transform.0));
    let normal = linear.inverse().transpose();
    let rows = |matrix: DMat3| {
        [
            [
                matrix.x_axis.x as f32,
                matrix.y_axis.x as f32,
                matrix.z_axis.x as f32,
                0.0,
            ],
            [
                matrix.x_axis.y as f32,
                matrix.y_axis.y as f32,
                matrix.z_axis.y as f32,
                0.0,
            ],
            [
                matrix.x_axis.z as f32,
                matrix.y_axis.z as f32,
                matrix.z_axis.z as f32,
                0.0,
            ],
        ]
    };
    let source = rows(linear);
    let normals = rows(normal);
    if source
        .iter()
        .chain(&normals)
        .flatten()
        .any(|value| !value.is_finite())
    {
        return Err(GpuFrameError::InvalidStyle);
    }
    Ok((source, normals))
}

fn create_queue_uploaded_buffer(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &str,
    contents: &[u8],
    usage: wgpu::BufferUsages,
) -> wgpu::Buffer {
    debug_assert!(!contents.is_empty());
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: u64::try_from(contents.len()).expect("buffer length fits u64"),
        usage: usage | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    queue.write_buffer(&buffer, 0, contents);
    buffer
}

#[derive(Debug, Clone, Copy, PartialEq, Pod, Zeroable)]
#[repr(C)]
struct GpuMeshVertex {
    position: [f32; 3],
    color: [u8; 4],
    proxy_slot: u32,
    primitive_slot: u32,
    normal: [i8; 4],
    tex_coord: [f32; 2],
}

#[derive(Debug)]
struct GpuIndexedMeshGeometryInner {
    vertex_buffer: wgpu::Buffer,
    pick_vertex_buffer: wgpu::Buffer,
    index_buffer: wgpu::Buffer,
    vertex_count: u32,
    index_count: u32,
    sort_center: [f32; 3],
    resident_bytes: u64,
}

/// Immutable indexed model geometry shareable by tile-specific instance batches.
#[derive(Debug, Clone)]
pub struct GpuIndexedMeshGeometry(Arc<GpuIndexedMeshGeometryInner>);

impl GpuIndexedMeshGeometry {
    /// Uploads shared geometry through an unmapped queue-backed allocation.
    /// Streaming providers must use this path so browser WebGPU never maps a
    /// large immutable allocation at creation time.
    pub fn new_with_queue(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        vertices: &[GpuMeshVertexInput],
        indices: &[u32],
    ) -> Result<Self, GpuFrameError> {
        Self::new_with_primitive_base_and_queue(device, queue, label, 0, vertices, indices)
    }

    /// Uploads shared geometry with stable triangle addresses through the GPU
    /// queue instead of a mapped-at-creation buffer.
    pub fn new_with_primitive_base_and_queue(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        primitive_base: u32,
        vertices: &[GpuMeshVertexInput],
        indices: &[u32],
    ) -> Result<Self, GpuFrameError> {
        if vertices.is_empty()
            || indices.is_empty()
            || !indices.len().is_multiple_of(3)
            || indices
                .iter()
                .any(|index| usize::try_from(*index).map_or(true, |index| index >= vertices.len()))
        {
            return Err(GpuFrameError::InvalidMeshIndices);
        }
        let vertex_count =
            u32::try_from(vertices.len()).map_err(|_| GpuFrameError::TooManyVertices)?;
        let index_count =
            u32::try_from(indices.len()).map_err(|_| GpuFrameError::TooManyVertices)?;
        let gpu_vertices = vertices
            .iter()
            .map(|vertex| mesh_vertex(vertex, 1, 0))
            .collect::<Vec<_>>();
        let upload = |label: &str, contents: &[u8], usage| {
            create_queue_uploaded_buffer(device, queue, label, contents, usage)
        };
        let vertex_buffer = upload(
            label,
            bytemuck::cast_slice(&gpu_vertices),
            wgpu::BufferUsages::VERTEX,
        );
        let mut pick_vertices = Vec::with_capacity(indices.len());
        for (triangle_index, triangle) in indices.chunks_exact(3).enumerate() {
            let primitive_slot = primitive_base
                .checked_add(
                    u32::try_from(triangle_index).map_err(|_| GpuFrameError::TooManyVertices)?,
                )
                .ok_or(GpuFrameError::TooManyVertices)?;
            for index in triangle {
                pick_vertices.push(mesh_vertex(
                    &vertices[usize::try_from(*index).expect("validated mesh index")],
                    1,
                    primitive_slot,
                ));
            }
        }
        let pick_vertex_buffer = upload(
            "himmelcad-shared-mesh-pick-vertices",
            bytemuck::cast_slice(&pick_vertices),
            wgpu::BufferUsages::VERTEX,
        );
        let index_buffer = upload(
            "himmelcad-shared-mesh-indices",
            bytemuck::cast_slice(indices),
            wgpu::BufferUsages::INDEX,
        );
        let resident_bytes = u64::try_from(gpu_vertices.len())
            .unwrap_or(u64::MAX)
            .saturating_mul(u64::try_from(size_of::<GpuMeshVertex>()).expect("stride fits u64"))
            .saturating_add(
                u64::try_from(indices.len())
                    .unwrap_or(u64::MAX)
                    .saturating_mul(4),
            )
            .saturating_add(
                u64::try_from(pick_vertices.len())
                    .unwrap_or(u64::MAX)
                    .saturating_mul(
                        u64::try_from(size_of::<GpuMeshVertex>()).expect("stride fits u64"),
                    ),
            );
        Ok(Self(Arc::new(GpuIndexedMeshGeometryInner {
            vertex_buffer,
            pick_vertex_buffer,
            index_buffer,
            vertex_count,
            index_count,
            sort_center: position_center(vertices.iter().map(|vertex| vertex.position)),
            resident_bytes,
        })))
    }

    /// Process-local allocation key for exact global cost/refcount accounting.
    #[must_use]
    pub fn allocation_key(&self) -> usize {
        Arc::as_ptr(&self.0) as usize
    }

    /// Immutable vertex and index bytes charged once globally.
    #[must_use]
    pub fn resident_bytes(&self) -> u64 {
        self.0.resident_bytes
    }
}

/// Raster primitive topology for one resident draw batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuPrimitive {
    /// One native one-pixel point per vertex.
    Points,
    /// Screen-aligned point quads for explicitly larger point diameters.
    PointSprites,
    /// Independent line segments.
    Lines,
    /// Independent triangles.
    Triangles,
    /// Indexed triangles sharing geometry across affine instances.
    InstancedTriangles,
    /// Instanced anisotropic Gaussian ellipses.
    GaussianSplats,
    /// Pixel-stable text triangle vertices.
    ScreenText,
}

/// Resident vertex batch submitted through the shared color and pick passes.
#[derive(Debug)]
pub struct GpuDrawBatch {
    vertex_buffer: wgpu::Buffer,
    instance_buffer: Option<wgpu::Buffer>,
    pick_vertex_buffer: Option<wgpu::Buffer>,
    index_buffer: Option<wgpu::Buffer>,
    vertex_count: u32,
    instance_count: u32,
    index_count: u32,
    material: Option<GpuMaterial>,
    primitive: GpuPrimitive,
    transparent: bool,
    pickable: bool,
    sort_center: [f32; 3],
    splat_sort: Option<Arc<Mutex<SplatSortState>>>,
    mesh_instance_sort: Option<Arc<Mutex<MeshInstanceSortState>>>,
    shared_mesh_geometry: Option<GpuIndexedMeshGeometry>,
    declared_texture_coordinates: bool,
}

#[derive(Debug)]
struct SplatSortState {
    vertices: Vec<GpuSplatVertex>,
    order: Vec<u32>,
    scratch: Vec<u32>,
    last_axis: Option<[f32; 3]>,
    last_vertical_exaggeration: f32,
}

#[derive(Debug)]
struct MeshInstanceSortState {
    instances: Vec<GpuMeshInstanceInput>,
    order: Vec<u32>,
    scratch: Vec<u32>,
    model_center: [f32; 3],
    last_axis: Option<[f32; 3]>,
    last_vertical_exaggeration: f32,
}

impl MeshInstanceSortState {
    fn new(instances: &[GpuMeshInstanceInput], model_center: [f32; 3]) -> Self {
        let order = (0..instances.len())
            .map(|index| u32::try_from(index).expect("validated instance count fits u32"))
            .collect::<Vec<_>>();
        Self {
            instances: instances.to_vec(),
            scratch: vec![0; instances.len()],
            model_center,
            last_axis: None,
            last_vertical_exaggeration: f32::NAN,
            order,
        }
    }

    fn sort(
        &mut self,
        view_projection: [[f32; 4]; 4],
        floating_origin: WorldVec3,
        material: Option<&GpuMaterial>,
    ) -> Result<bool, GpuFrameError> {
        let axis = depth_sort_axis(view_projection);
        let vertical_exaggeration =
            material.map_or(1.0, |material| material.style.vertical_exaggeration);
        if self.last_axis.is_some_and(|previous| {
            dot3(previous, axis) > 0.999_99
                && vertical_exaggeration.to_bits() == self.last_vertical_exaggeration.to_bits()
        }) {
            return Ok(false);
        }
        let keys = self
            .instances
            .iter()
            .map(|instance| {
                let center = transform_position(instance, self.model_center);
                render_position(center, material, floating_origin)
                    .map(|position| float_order_key(reverse_z_depth(view_projection, position)))
            })
            .collect::<Result<Vec<_>, GpuFrameError>>()?;
        self.order.iter_mut().enumerate().for_each(|(index, slot)| {
            *slot = u32::try_from(index).expect("instance count fits u32");
        });
        let primitive_keys = self
            .instances
            .iter()
            .map(|instance| instance.primitive_offset)
            .collect::<Vec<_>>();
        for shift in [0_u32, 8, 16, 24] {
            SplatSortState::radix_pass(&mut self.order, &mut self.scratch, shift, &primitive_keys);
        }
        for shift in [0_u32, 8, 16, 24] {
            SplatSortState::radix_pass(&mut self.order, &mut self.scratch, shift, &keys);
        }
        for (destination, source) in self.order.iter().copied().enumerate() {
            self.scratch[source as usize] =
                u32::try_from(destination).expect("instance count fits u32");
        }
        for index in 0..self.scratch.len() {
            while self.scratch[index] as usize != index {
                let destination = self.scratch[index] as usize;
                self.instances.swap(index, destination);
                self.scratch.swap(index, destination);
            }
        }
        self.last_axis = Some(axis);
        self.last_vertical_exaggeration = vertical_exaggeration;
        Ok(true)
    }
}

fn transform_position(instance: &GpuMeshInstanceInput, position: [f32; 3]) -> [f32; 3] {
    let homogeneous = [position[0], position[1], position[2], 1.0];
    [&instance.row_0, &instance.row_1, &instance.row_2].map(|row| {
        row.iter()
            .zip(homogeneous)
            .map(|(coefficient, value)| coefficient * value)
            .sum()
    })
}

impl SplatSortState {
    fn new(splats: &[GpuSplatVertex]) -> Self {
        let order = (0..splats.len())
            .map(|index| u32::try_from(index).expect("validated splat count fits u32"))
            .collect::<Vec<_>>();
        Self {
            vertices: splats.to_vec(),
            scratch: vec![0; splats.len()],
            last_axis: None,
            last_vertical_exaggeration: f32::NAN,
            order,
        }
    }

    fn sort(
        &mut self,
        view_projection: [[f32; 4]; 4],
        floating_origin: WorldVec3,
        material: Option<&GpuMaterial>,
    ) -> Result<bool, GpuFrameError> {
        let axis = depth_sort_axis(view_projection);
        let vertical_exaggeration =
            material.map_or(1.0, |material| material.style.vertical_exaggeration);
        if self.last_axis.is_some_and(|previous| {
            dot3(previous, axis) > 0.999_99
                && vertical_exaggeration.to_bits() == self.last_vertical_exaggeration.to_bits()
        }) {
            return Ok(false);
        }
        let keys = self
            .vertices
            .iter()
            .map(|splat| {
                render_position(splat.position, material, floating_origin)
                    .map(|position| float_order_key(reverse_z_depth(view_projection, position)))
            })
            .collect::<Result<Vec<_>, GpuFrameError>>()?;
        self.order
            .iter_mut()
            .enumerate()
            .for_each(|(index, slot)| *slot = u32::try_from(index).expect("splat count fits u32"));
        let primitive_keys = self
            .vertices
            .iter()
            .map(|vertex| vertex.primitive_slot)
            .collect::<Vec<_>>();
        for shift in [0_u32, 8, 16, 24] {
            Self::radix_pass(&mut self.order, &mut self.scratch, shift, &primitive_keys);
        }
        for shift in [0_u32, 8, 16, 24] {
            Self::radix_pass(&mut self.order, &mut self.scratch, shift, &keys);
        }
        for (destination, source) in self.order.iter().copied().enumerate() {
            self.scratch[source as usize] =
                u32::try_from(destination).expect("splat count fits u32");
        }
        for index in 0..self.scratch.len() {
            while self.scratch[index] as usize != index {
                let destination = self.scratch[index] as usize;
                self.vertices.swap(index, destination);
                self.scratch.swap(index, destination);
            }
        }
        self.last_axis = Some(axis);
        self.last_vertical_exaggeration = vertical_exaggeration;
        Ok(true)
    }

    fn radix_pass(order: &mut Vec<u32>, scratch: &mut Vec<u32>, shift: u32, keys: &[u32]) {
        let mut counts = [0_usize; 256];
        for index in order.iter().copied() {
            let bucket = usize::try_from((keys[index as usize] >> shift) & 0xff)
                .expect("radix byte fits usize");
            counts[bucket] += 1;
        }
        let mut offset = 0;
        for count in &mut counts {
            let next = offset + *count;
            *count = offset;
            offset = next;
        }
        for index in order.iter().copied() {
            let bucket = usize::try_from((keys[index as usize] >> shift) & 0xff)
                .expect("radix byte fits usize");
            scratch[counts[bucket]] = index;
            counts[bucket] += 1;
        }
        std::mem::swap(order, scratch);
    }
}

fn position_center(positions: impl Iterator<Item = [f32; 3]>) -> [f32; 3] {
    let mut minimum = [f32::INFINITY; 3];
    let mut maximum = [f32::NEG_INFINITY; 3];
    for position in positions {
        for axis in 0..3 {
            minimum[axis] = minimum[axis].min(position[axis]);
            maximum[axis] = maximum[axis].max(position[axis]);
        }
    }
    std::array::from_fn(|axis| (minimum[axis] + maximum[axis]) * 0.5)
}

fn render_position(
    position: [f32; 3],
    material: Option<&GpuMaterial>,
    floating_origin: WorldVec3,
) -> Result<[f32; 3], GpuFrameError> {
    let Some(material) = material else {
        return Ok(position);
    };
    let mut position = material.source_linear_rows.map(|row| {
        row[0].mul_add(
            position[0],
            row[1].mul_add(position[1], row[2] * position[2]),
        )
    });
    for (position, translation) in position.iter_mut().zip(material.interaction_translation) {
        *position += translation;
    }
    let datum = material.style.exaggeration_datum_relative;
    position[2] = datum + (position[2] - datum) * material.style.vertical_exaggeration;
    let origin = batch_origin_delta(material.batch_origin, floating_origin)?;
    Ok(std::array::from_fn(|axis| position[axis] + origin[axis]))
}

fn reverse_z_depth(view_projection: [[f32; 4]; 4], position: [f32; 3]) -> f32 {
    let homogeneous = [position[0], position[1], position[2], 1.0];
    let clip_z = (0..4)
        .map(|column| view_projection[column][2] * homogeneous[column])
        .sum::<f32>();
    let clip_w = (0..4)
        .map(|column| view_projection[column][3] * homogeneous[column])
        .sum::<f32>();
    let depth = clip_z / clip_w;
    if depth.is_finite() {
        depth
    } else {
        f32::NEG_INFINITY
    }
}

fn depth_sort_axis(view_projection: [[f32; 4]; 4]) -> [f32; 3] {
    let perspective = std::array::from_fn(|column| view_projection[column][3]);
    let orthographic = std::array::from_fn(|column| view_projection[column][2]);
    let candidate = if dot3(perspective, perspective) > 1.0e-12 {
        perspective
    } else {
        orthographic
    };
    let length = dot3(candidate, candidate).sqrt();
    if length > 1.0e-12 {
        candidate.map(|value| value / length)
    } else {
        [0.0, 0.0, 1.0]
    }
}

fn dot3(left: [f32; 3], right: [f32; 3]) -> f32 {
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

fn float_order_key(value: f32) -> u32 {
    let bits = value.to_bits();
    bits ^ if bits >> 31 == 0 {
        0x8000_0000
    } else {
        u32::MAX
    }
}

impl GpuDrawBatch {
    /// GPU bytes allocated exclusively by [`Self::fork_with_style`]. Shared
    /// geometry, textures and ordinary instance buffers are intentionally not
    /// charged again.
    #[must_use]
    pub fn styled_fork_exclusive_gpu_bytes(&self) -> u64 {
        let uniform_bytes = u64::from(self.material.is_some())
            .saturating_mul(u64::try_from(size_of::<MaterialUniform>()).expect("size fits u64"));
        let sorted_instance_bytes = if self.mesh_instance_sort.is_some() {
            u64::from(self.instance_count).saturating_mul(
                u64::try_from(size_of::<GpuMeshInstanceInput>()).expect("size fits u64"),
            )
        } else {
            0
        };
        uniform_bytes.saturating_add(sorted_instance_bytes)
    }

    /// Whether this batch owns a mutable presentation material.
    #[must_use]
    pub fn has_material(&self) -> bool {
        self.material.is_some()
    }

    /// Declares whether the immutable vertex layout carries authored texture
    /// coordinates. This is explicit metadata and is never inferred from UV values.
    #[must_use]
    pub fn with_declared_texture_coordinates(mut self, declared: bool) -> Self {
        self.declared_texture_coordinates = declared;
        self
    }

    /// Whether this batch may safely bind a presentation texture.
    #[must_use]
    pub fn has_declared_texture_coordinates(&self) -> bool {
        self.declared_texture_coordinates
    }

    /// Process-local identity of the immutable source texture retained by the material.
    #[must_use]
    pub fn source_texture_allocation_key(&self) -> Option<usize> {
        self.material
            .as_ref()
            .map(|material| material.source_texture_resource.allocation_key())
    }

    /// Process-local identity of the texture currently bound for presentation.
    #[must_use]
    pub fn active_texture_allocation_key(&self) -> Option<usize> {
        self.material
            .as_ref()
            .map(|material| material.active_texture_resource.allocation_key())
    }

    /// Current fragment visibility for presentation diagnostics and gates.
    #[must_use]
    pub fn presentation_fill_visible(&self) -> Option<bool> {
        self.material
            .as_ref()
            .map(|material| material.style.fill_visible())
    }

    /// Whether the current material uniform evaluates a vector hatch.
    #[must_use]
    pub fn presentation_hatch_enabled(&self) -> Option<bool> {
        self.material
            .as_ref()
            .map(|material| material.style.hatch_enabled >= 0.5)
    }

    /// Whether stroke-capable fragments are currently visible and ID-pickable.
    #[must_use]
    pub fn presentation_stroke_visible(&self) -> Option<bool> {
        self.material
            .as_ref()
            .map(|material| material.style.stroke_visible())
    }

    /// Active physical-pixel width override, or zero when source width is retained.
    #[must_use]
    pub fn presentation_stroke_width_override(&self) -> Option<f32> {
        self.material
            .as_ref()
            .map(|material| material.style.stroke_width_override)
    }

    /// Number of alternating components in the active GPU line type.
    #[must_use]
    pub fn presentation_line_type_components(&self) -> Option<u32> {
        self.material
            .as_ref()
            .map(|material| material.style.line_type_count)
    }

    /// Rebinds an immutable presentation texture without uploading geometry or
    /// replacing any material uniform state. `None` restores the source texture.
    pub fn rebind_presentation_texture(
        &mut self,
        device: &wgpu::Device,
        renderer: &GpuSharedRenderer,
        texture: Option<&GpuTextureResource>,
    ) -> Result<(), GpuFrameError> {
        if texture.is_some() && !self.declared_texture_coordinates {
            return Err(GpuFrameError::MissingTextureCoordinates);
        }
        let material = self.material.as_mut().ok_or(GpuFrameError::InvalidStyle)?;
        let active = texture.unwrap_or(&material.source_texture_resource).clone();
        material.rebind_active_texture(device, &renderer.material_bind_group_layout, &active);
        Ok(())
    }

    /// Binds one immutable canonical line-type revision without rebuilding
    /// geometry. `None` restores the renderer's continuous-line resource.
    pub fn rebind_line_type_resource(
        &mut self,
        device: &wgpu::Device,
        renderer: &GpuSharedRenderer,
        resource: Option<&GpuLineTypeResource>,
    ) -> Result<(), GpuFrameError> {
        let material = self.material.as_mut().ok_or(GpuFrameError::InvalidStyle)?;
        material.rebind_line_type_resource(
            device,
            &renderer.material_bind_group_layout,
            resource.unwrap_or(&renderer.default_line_type_resource),
        );
        Ok(())
    }

    /// Stable f64 origin of the immutable vertex coordinates.
    #[must_use]
    pub fn batch_origin(&self) -> Option<WorldVec3> {
        self.material.as_ref().map(|material| material.batch_origin)
    }

    /// Reorders one downlevel transparent block back-to-front for the active
    /// reverse-Z camera. Returns whether a GPU upload was necessary.
    pub fn prepare_sorted_alpha(
        &self,
        queue: &wgpu::Queue,
        view_projection: [[f32; 4]; 4],
        floating_origin: WorldVec3,
    ) -> Result<bool, GpuFrameError> {
        self.prepare_sorted_alpha_with_budget(queue, view_projection, floating_origin, u64::MAX)
            .map(|bytes| bytes != 0)
    }

    /// Prepares a downlevel transparent block without exceeding the caller's
    /// frame upload budget. A zero result leaves a stale-but-valid order intact.
    pub fn prepare_sorted_alpha_with_budget(
        &self,
        queue: &wgpu::Queue,
        view_projection: [[f32; 4]; 4],
        floating_origin: WorldVec3,
        maximum_upload_bytes: u64,
    ) -> Result<u64, GpuFrameError> {
        if !self.transparent {
            return Ok(0);
        }
        if let Some(state) = &self.splat_sort {
            let upload_bytes = u64::from(self.instance_count).saturating_mul(
                u64::try_from(size_of::<GpuSplatVertex>()).expect("stride fits u64"),
            );
            if upload_bytes > maximum_upload_bytes {
                return Ok(0);
            }
            let mut state = state.lock().map_err(|_| GpuFrameError::InvalidSplat)?;
            if !state.sort(view_projection, floating_origin, self.material.as_ref())? {
                return Ok(0);
            }
            queue.write_buffer(
                &self.vertex_buffer,
                0,
                bytemuck::cast_slice(&state.vertices),
            );
            return Ok(upload_bytes);
        }
        let Some(state) = &self.mesh_instance_sort else {
            return Ok(0);
        };
        let upload_bytes = u64::from(self.instance_count).saturating_mul(
            u64::try_from(size_of::<GpuMeshInstanceInput>()).expect("stride fits u64"),
        );
        if upload_bytes > maximum_upload_bytes {
            return Ok(0);
        }
        let mut state = state
            .lock()
            .map_err(|_| GpuFrameError::InvalidMeshIndices)?;
        if !state.sort(view_projection, floating_origin, self.material.as_ref())? {
            return Ok(0);
        }
        queue.write_buffer(
            self.instance_buffer
                .as_ref()
                .ok_or(GpuFrameError::InvalidMeshIndices)?,
            0,
            bytemuck::cast_slice(&state.instances),
        );
        Ok(upload_bytes)
    }

    /// Current GPU instance order for a CPU-sorted Gaussian block. Weighted
    /// OIT batches return `None` because they intentionally retain source order.
    #[must_use]
    pub fn sorted_splat_primitive_slots(&self) -> Option<Vec<u32>> {
        self.splat_sort.as_ref().and_then(|state| {
            state.lock().ok().map(|state| {
                state
                    .vertices
                    .iter()
                    .map(|vertex| vertex.primitive_slot)
                    .collect()
            })
        })
    }

    /// Current GPU order of compact shared-mesh instances. Non-instanced
    /// batches return `None`.
    #[must_use]
    pub fn sorted_mesh_instance_primitive_offsets(&self) -> Option<Vec<u32>> {
        self.mesh_instance_sort.as_ref().and_then(|state| {
            state.lock().ok().map(|state| {
                state
                    .instances
                    .iter()
                    .map(|instance| instance.primitive_offset)
                    .collect()
            })
        })
    }

    pub(crate) fn sorted_alpha_depth(
        &self,
        view_projection: [[f32; 4]; 4],
        floating_origin: WorldVec3,
    ) -> Result<f32, GpuFrameError> {
        Ok(reverse_z_depth(
            view_projection,
            render_position(self.sort_center, self.material.as_ref(), floating_origin)?,
        ))
    }

    /// Uploads one immutable batch. Streaming providers replace whole tile batches.
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        primitive: GpuPrimitive,
        transparent: bool,
        vertices: &[GpuVertex],
    ) -> Result<Self, GpuFrameError> {
        if vertices.is_empty() {
            return Err(GpuFrameError::EmptyBatch);
        }
        if primitive == GpuPrimitive::GaussianSplats
            || primitive == GpuPrimitive::InstancedTriangles
        {
            return Err(GpuFrameError::InvalidSplat);
        }
        if primitive == GpuPrimitive::ScreenText {
            return Err(GpuFrameError::InvalidText);
        }
        let compact_vertices;
        let line_instances;
        let mesh_vertices;
        let (contents, vertex_count, instance_count) = match primitive {
            GpuPrimitive::Points => {
                compact_vertices = vertices
                    .iter()
                    .map(|vertex| GpuPointVertex {
                        position: vertex.position,
                        color: vertex.color.map(float_color_channel),
                        proxy_slot: vertex.proxy_slot,
                        primitive_slot: vertex.primitive_slot,
                        point_size: 1.0,
                        civil_0: 0,
                        civil_1: 0,
                    })
                    .collect::<Vec<_>>();
                let count = u32::try_from(compact_vertices.len())
                    .map_err(|_| GpuFrameError::TooManyVertices)?;
                (bytemuck::cast_slice(&compact_vertices), count, 1)
            }
            GpuPrimitive::Lines => {
                if !vertices.len().is_multiple_of(2) {
                    return Err(GpuFrameError::InvalidLineVertices);
                }
                line_instances = vertices
                    .chunks_exact(2)
                    .map(|pair| GpuLineInstance {
                        start: pair[0].position,
                        end: pair[1].position,
                        color: pair[0].color,
                        proxy_slot: pair[0].proxy_slot,
                        primitive_slot: pair[0].primitive_slot,
                        width: 2.0,
                        previous: pair[0].position,
                        next: pair[1].position,
                        path_distance: [
                            0.0,
                            line_segment_length(pair[0].position, pair[1].position),
                        ],
                        path_chunk: 0,
                        topology_flags: 0,
                    })
                    .collect::<Vec<_>>();
                let count = u32::try_from(line_instances.len())
                    .map_err(|_| GpuFrameError::TooManyVertices)?;
                (bytemuck::cast_slice(&line_instances), 18, count)
            }
            GpuPrimitive::Triangles => {
                mesh_vertices = vertices
                    .iter()
                    .map(|vertex| GpuMeshVertex {
                        position: vertex.position,
                        color: vertex.color.map(float_color_channel),
                        proxy_slot: vertex.proxy_slot,
                        primitive_slot: vertex.primitive_slot,
                        normal: [0, 0, 127, 0],
                        tex_coord: [0.0; 2],
                    })
                    .collect::<Vec<_>>();
                let count = u32::try_from(mesh_vertices.len())
                    .map_err(|_| GpuFrameError::TooManyVertices)?;
                (bytemuck::cast_slice(&mesh_vertices), count, 1)
            }
            GpuPrimitive::GaussianSplats
            | GpuPrimitive::PointSprites
            | GpuPrimitive::InstancedTriangles
            | GpuPrimitive::ScreenText => {
                unreachable!("rejected above")
            }
        };
        let vertex_buffer = create_queue_uploaded_buffer(
            device,
            queue,
            label,
            contents,
            wgpu::BufferUsages::VERTEX,
        );
        Ok(Self {
            vertex_buffer,
            instance_buffer: None,
            pick_vertex_buffer: None,
            index_buffer: None,
            vertex_count,
            instance_count,
            index_count: 0,
            material: None,
            primitive,
            transparent,
            pickable: true,
            sort_center: position_center(vertices.iter().map(|vertex| vertex.position)),
            splat_sort: None,
            mesh_instance_sort: None,
            shared_mesh_geometry: None,
            declared_texture_coordinates: false,
        })
    }

    /// Uploads line instances through an unmapped queue-backed buffer.
    pub fn new_lines_with_width_and_queue(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        width: f32,
        vertices: &[GpuVertex],
    ) -> Result<Self, GpuFrameError> {
        if vertices.is_empty() {
            return Err(GpuFrameError::EmptyBatch);
        }
        if !vertices.len().is_multiple_of(2) {
            return Err(GpuFrameError::InvalidLineVertices);
        }
        if !width.is_finite() || width <= 0.0 {
            return Err(GpuFrameError::InvalidPrimitiveSize);
        }
        let instances = vertices
            .chunks_exact(2)
            .map(|pair| GpuLineInstance {
                start: pair[0].position,
                end: pair[1].position,
                color: pair[0].color,
                proxy_slot: pair[0].proxy_slot,
                primitive_slot: pair[0].primitive_slot,
                width,
                previous: pair[0].position,
                next: pair[1].position,
                path_distance: [0.0, line_segment_length(pair[0].position, pair[1].position)],
                path_chunk: 0,
                topology_flags: 0,
            })
            .collect::<Vec<_>>();
        let instance_count =
            u32::try_from(instances.len()).map_err(|_| GpuFrameError::TooManyVertices)?;
        let contents = bytemuck::cast_slice(&instances);
        let vertex_buffer = create_queue_uploaded_buffer(
            device,
            queue,
            label,
            contents,
            wgpu::BufferUsages::VERTEX,
        );
        Ok(Self {
            vertex_buffer,
            instance_buffer: None,
            pick_vertex_buffer: None,
            index_buffer: None,
            vertex_count: 18,
            instance_count,
            index_count: 0,
            material: None,
            primitive: GpuPrimitive::Lines,
            transparent: vertices[0].color[3] < 1.0,
            pickable: true,
            sort_center: position_center(vertices.iter().map(|vertex| vertex.position)),
            splat_sort: None,
            mesh_instance_sort: None,
            shared_mesh_geometry: None,
            declared_texture_coordinates: false,
        })
    }

    /// Uploads explicitly connected stroke instances through an unmapped queue-backed buffer.
    pub(crate) fn new_stroke_instances_with_queue(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        instances: &[GpuLineInstance],
    ) -> Result<Self, GpuFrameError> {
        if instances.is_empty() {
            return Err(GpuFrameError::EmptyBatch);
        }
        if instances.iter().any(|instance| {
            instance.proxy_slot == 0
                || !instance.width.is_finite()
                || instance.width <= 0.0
                || instance
                    .start
                    .iter()
                    .chain(&instance.end)
                    .chain(&instance.previous)
                    .chain(&instance.next)
                    .chain(&instance.color)
                    .chain(&instance.path_distance)
                    .any(|value| !value.is_finite())
                || instance.path_distance[1] <= 0.0
        }) {
            return Err(GpuFrameError::InvalidLineVertices);
        }
        let contents = bytemuck::cast_slice(instances);
        let vertex_buffer = create_queue_uploaded_buffer(
            device,
            queue,
            label,
            contents,
            wgpu::BufferUsages::VERTEX,
        );
        Ok(Self {
            vertex_buffer,
            instance_buffer: None,
            pick_vertex_buffer: None,
            index_buffer: None,
            vertex_count: 18,
            instance_count: u32::try_from(instances.len())
                .map_err(|_| GpuFrameError::TooManyVertices)?,
            index_count: 0,
            material: None,
            primitive: GpuPrimitive::Lines,
            transparent: instances[0].color[3] < 1.0,
            pickable: true,
            sort_center: position_center(
                instances
                    .iter()
                    .flat_map(|instance| [instance.start, instance.end]),
            ),
            splat_sort: None,
            mesh_instance_sort: None,
            shared_mesh_geometry: None,
            declared_texture_coordinates: false,
        })
    }

    /// Uploads compact decoded point data through an unmapped queue-backed buffer.
    pub fn new_points_with_queue(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        proxy_slot: u32,
        positions: &[[f32; 3]],
        colors: &[[u8; 4]],
    ) -> Result<Self, GpuFrameError> {
        Self::new_points_with_size_and_queue(
            device, queue, label, proxy_slot, positions, colors, 1.0,
        )
    }

    /// Uploads Potree points with compact, shader-readable civil attributes.
    pub fn new_potree_points_with_queue(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        proxy_slot: u32,
        positions: &[[f32; 3]],
        colors: &[[u8; 4]],
        civil_attributes: Option<&[PackedCivilPointAttributes]>,
    ) -> Result<Self, GpuFrameError> {
        Self::new_points_with_civil_and_size_and_queue(
            device,
            queue,
            label,
            proxy_slot,
            positions,
            colors,
            civil_attributes,
            1.0,
        )
    }

    /// Uploads compact decoded point data with a physical-pixel sprite diameter
    /// through an unmapped queue-backed buffer.
    #[allow(clippy::too_many_arguments)]
    pub fn new_points_with_size_and_queue(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        proxy_slot: u32,
        positions: &[[f32; 3]],
        colors: &[[u8; 4]],
        point_size: f32,
    ) -> Result<Self, GpuFrameError> {
        Self::new_points_with_civil_and_size_and_queue(
            device, queue, label, proxy_slot, positions, colors, None, point_size,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn new_points_with_civil_and_size_and_queue(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        proxy_slot: u32,
        positions: &[[f32; 3]],
        colors: &[[u8; 4]],
        civil_attributes: Option<&[PackedCivilPointAttributes]>,
        point_size: f32,
    ) -> Result<Self, GpuFrameError> {
        if positions.is_empty() {
            return Err(GpuFrameError::EmptyBatch);
        }
        if positions.len() != colors.len() {
            return Err(GpuFrameError::AttributeLengthMismatch);
        }
        if civil_attributes.is_some_and(|attributes| attributes.len() != positions.len()) {
            return Err(GpuFrameError::AttributeLengthMismatch);
        }
        if proxy_slot == 0 {
            return Err(GpuFrameError::InvalidProxySlot);
        }
        if !point_size.is_finite() || point_size <= 0.0 {
            return Err(GpuFrameError::InvalidPrimitiveSize);
        }
        let point_count =
            u32::try_from(positions.len()).map_err(|_| GpuFrameError::TooManyVertices)?;
        let vertices = positions
            .iter()
            .zip(colors)
            .enumerate()
            .map(|(primitive_slot, (position, color))| {
                let civil = civil_attributes
                    .map_or_else(PackedCivilPointAttributes::default, |attributes| {
                        attributes[primitive_slot]
                    });
                Ok(GpuPointVertex {
                    position: *position,
                    color: *color,
                    proxy_slot,
                    primitive_slot: u32::try_from(primitive_slot)
                        .map_err(|_| GpuFrameError::TooManyVertices)?,
                    point_size,
                    civil_0: civil.civil_0,
                    civil_1: civil.civil_1,
                })
            })
            .collect::<Result<Vec<_>, GpuFrameError>>()?;
        let contents = bytemuck::cast_slice(&vertices);
        let vertex_buffer = create_queue_uploaded_buffer(
            device,
            queue,
            label,
            contents,
            wgpu::BufferUsages::VERTEX,
        );
        let native_points = point_size <= 1.0;
        Ok(Self {
            vertex_buffer,
            instance_buffer: None,
            pick_vertex_buffer: None,
            index_buffer: None,
            vertex_count: if native_points { point_count } else { 6 },
            instance_count: if native_points { 1 } else { point_count },
            index_count: 0,
            material: None,
            primitive: if native_points {
                GpuPrimitive::Points
            } else {
                GpuPrimitive::PointSprites
            },
            transparent: false,
            pickable: true,
            sort_center: position_center(positions.iter().copied()),
            splat_sort: None,
            mesh_instance_sort: None,
            shared_mesh_geometry: None,
            declared_texture_coordinates: false,
        })
    }

    /// Uploads decoded splats through an unmapped queue-backed allocation.
    pub fn new_gaussian_splats_for_transparency_with_queue(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        splats: &[GpuSplatVertex],
        transparency: TransparencyStrategy,
    ) -> Result<Self, GpuFrameError> {
        if splats.is_empty() {
            return Err(GpuFrameError::EmptyBatch);
        }
        if splats.iter().any(|splat| {
            splat.proxy_slot == 0
                || splat
                    .position
                    .iter()
                    .chain(&splat.scale)
                    .chain(&splat.rotation)
                    .any(|value| !value.is_finite())
                || splat.scale.iter().any(|scale| *scale <= 0.0)
                || splat
                    .rotation
                    .iter()
                    .map(|value| value * value)
                    .sum::<f32>()
                    <= f32::EPSILON
        }) {
            return Err(GpuFrameError::InvalidSplat);
        }
        let instance_count =
            u32::try_from(splats.len()).map_err(|_| GpuFrameError::TooManyVertices)?;
        let usage = if transparency == TransparencyStrategy::SortedAlpha {
            wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST
        } else {
            wgpu::BufferUsages::VERTEX
        };
        let contents = bytemuck::cast_slice(splats);
        let vertex_buffer = create_queue_uploaded_buffer(device, queue, label, contents, usage);
        Ok(Self {
            vertex_buffer,
            instance_buffer: None,
            pick_vertex_buffer: None,
            index_buffer: None,
            vertex_count: 6,
            instance_count,
            index_count: 0,
            material: None,
            primitive: GpuPrimitive::GaussianSplats,
            transparent: true,
            pickable: true,
            sort_center: position_center(splats.iter().map(|splat| splat.position)),
            splat_sort: (transparency == TransparencyStrategy::SortedAlpha)
                .then(|| Arc::new(Mutex::new(SplatSortState::new(splats)))),
            mesh_instance_sort: None,
            shared_mesh_geometry: None,
            declared_texture_coordinates: false,
        })
    }

    /// Uploads screen-space glyph vertices through an unmapped queue-backed buffer.
    pub fn new_screen_text_with_queue(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        vertices: &[GpuScreenTextVertex],
        transparent: bool,
    ) -> Result<Self, GpuFrameError> {
        if vertices.is_empty() {
            return Err(GpuFrameError::EmptyBatch);
        }
        if !vertices.len().is_multiple_of(3)
            || vertices.iter().any(|vertex| {
                vertex.proxy_slot == 0
                    || vertex
                        .anchor
                        .iter()
                        .chain(&vertex.pixel_offset)
                        .chain(&vertex.tex_coord)
                        .chain(&vertex.color)
                        .any(|value| !value.is_finite())
            })
        {
            return Err(GpuFrameError::InvalidText);
        }
        let vertex_count =
            u32::try_from(vertices.len()).map_err(|_| GpuFrameError::TooManyVertices)?;
        let contents = bytemuck::cast_slice(vertices);
        let vertex_buffer = create_queue_uploaded_buffer(
            device,
            queue,
            label,
            contents,
            wgpu::BufferUsages::VERTEX,
        );
        Ok(Self {
            vertex_buffer,
            instance_buffer: None,
            pick_vertex_buffer: None,
            index_buffer: None,
            vertex_count,
            instance_count: 1,
            index_count: 0,
            material: None,
            primitive: GpuPrimitive::ScreenText,
            transparent,
            pickable: true,
            sort_center: position_center(vertices.iter().map(|vertex| vertex.anchor)),
            splat_sort: None,
            mesh_instance_sort: None,
            shared_mesh_geometry: None,
            declared_texture_coordinates: false,
        })
    }

    /// Uploads a streamed indexed mesh, its exact-pick vertices and its index
    /// data through unmapped queue-backed allocations.
    #[allow(clippy::too_many_arguments)]
    pub fn new_indexed_mesh_with_queue(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        proxy_slot: u32,
        primitive_base: u32,
        vertices: &[GpuMeshVertexInput],
        indices: &[u32],
        transparent: bool,
    ) -> Result<Self, GpuFrameError> {
        if vertices.is_empty() || indices.is_empty() {
            return Err(GpuFrameError::EmptyBatch);
        }
        if !indices.len().is_multiple_of(3)
            || indices
                .iter()
                .any(|index| usize::try_from(*index).map_or(true, |index| index >= vertices.len()))
        {
            return Err(GpuFrameError::InvalidMeshIndices);
        }
        if proxy_slot == 0 {
            return Err(GpuFrameError::InvalidProxySlot);
        }
        let vertex_count =
            u32::try_from(vertices.len()).map_err(|_| GpuFrameError::TooManyVertices)?;
        let index_count =
            u32::try_from(indices.len()).map_err(|_| GpuFrameError::TooManyVertices)?;
        let gpu_vertices = vertices
            .iter()
            .map(|vertex| mesh_vertex(vertex, proxy_slot, 0))
            .collect::<Vec<_>>();
        let mut pick_vertices = Vec::with_capacity(indices.len());
        for (primitive_slot, triangle) in indices.chunks_exact(3).enumerate() {
            let local_primitive =
                u32::try_from(primitive_slot).map_err(|_| GpuFrameError::TooManyVertices)?;
            let primitive_slot = primitive_base
                .checked_add(local_primitive)
                .ok_or(GpuFrameError::TooManyVertices)?;
            for index in triangle {
                pick_vertices.push(mesh_vertex(
                    &vertices[usize::try_from(*index).expect("validated mesh index")],
                    proxy_slot,
                    primitive_slot,
                ));
            }
        }
        let upload = |label: &str, contents: &[u8], usage| {
            create_queue_uploaded_buffer(device, queue, label, contents, usage)
        };
        let vertex_buffer = upload(
            label,
            bytemuck::cast_slice(&gpu_vertices),
            wgpu::BufferUsages::VERTEX,
        );
        let pick_vertex_buffer = upload(
            "himmelcad-mesh-pick-vertices",
            bytemuck::cast_slice(&pick_vertices),
            wgpu::BufferUsages::VERTEX,
        );
        let index_buffer = upload(
            "himmelcad-mesh-indices",
            bytemuck::cast_slice(indices),
            wgpu::BufferUsages::INDEX,
        );
        Ok(Self {
            vertex_buffer,
            instance_buffer: None,
            pick_vertex_buffer: Some(pick_vertex_buffer),
            index_buffer: Some(index_buffer),
            vertex_count,
            instance_count: 1,
            index_count,
            material: None,
            primitive: GpuPrimitive::Triangles,
            transparent,
            pickable: true,
            sort_center: position_center(vertices.iter().map(|vertex| vertex.position)),
            splat_sort: None,
            mesh_instance_sort: None,
            shared_mesh_geometry: None,
            declared_texture_coordinates: false,
        })
    }

    /// Uploads one indexed mesh once and draws it through compact affine
    /// instance records in both color and exact-ID passes.
    pub fn new_instanced_indexed_mesh_with_queue(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        primitive_base: u32,
        vertices: &[GpuMeshVertexInput],
        indices: &[u32],
        instances: &[GpuMeshInstanceInput],
        transparent: bool,
    ) -> Result<Self, GpuFrameError> {
        Self::new_instanced_indexed_mesh_for_transparency_with_queue(
            device,
            queue,
            label,
            primitive_base,
            vertices,
            indices,
            instances,
            transparent,
            TransparencyStrategy::SortedAlpha,
        )
    }

    /// Uploads a shared indexed mesh and retains a CPU instance copy only when
    /// the selected backend needs sorted-alpha blending.
    #[allow(clippy::too_many_arguments)]
    pub fn new_instanced_indexed_mesh_for_transparency_with_queue(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        primitive_base: u32,
        vertices: &[GpuMeshVertexInput],
        indices: &[u32],
        instances: &[GpuMeshInstanceInput],
        transparent: bool,
        transparency: TransparencyStrategy,
    ) -> Result<Self, GpuFrameError> {
        if instances.is_empty() {
            return Err(GpuFrameError::EmptyBatch);
        }
        if instances.iter().any(|instance| {
            instance.proxy_slot == 0
                || instance
                    .row_0
                    .iter()
                    .chain(&instance.row_1)
                    .chain(&instance.row_2)
                    .chain(&instance.normal_row_0)
                    .chain(&instance.normal_row_1)
                    .chain(&instance.normal_row_2)
                    .any(|value| !value.is_finite())
        }) {
            return Err(GpuFrameError::InvalidMeshIndices);
        }
        let mut batch = Self::new_indexed_mesh_with_queue(
            device,
            queue,
            label,
            instances[0].proxy_slot,
            primitive_base,
            vertices,
            indices,
            transparent,
        )?;
        let model_center = batch.sort_center;
        let instance_centers = instances
            .iter()
            .map(|instance| transform_position(instance, model_center))
            .collect::<Vec<_>>();
        if instance_centers
            .iter()
            .flatten()
            .any(|value| !value.is_finite())
        {
            return Err(GpuFrameError::InvalidMeshIndices);
        }
        batch.sort_center = position_center(instance_centers.into_iter());
        let usage = if transparency == TransparencyStrategy::SortedAlpha {
            wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST
        } else {
            wgpu::BufferUsages::VERTEX
        };
        let instance_buffer = create_queue_uploaded_buffer(
            device,
            queue,
            "himmelcad-mesh-instances",
            bytemuck::cast_slice(instances),
            usage,
        );
        batch.instance_buffer = Some(instance_buffer);
        batch.instance_count =
            u32::try_from(instances.len()).map_err(|_| GpuFrameError::TooManyVertices)?;
        batch.primitive = GpuPrimitive::InstancedTriangles;
        batch.mesh_instance_sort = (transparency == TransparencyStrategy::SortedAlpha).then(|| {
            Arc::new(Mutex::new(MeshInstanceSortState::new(
                instances,
                model_center,
            )))
        });
        Ok(batch)
    }

    /// Creates tile-specific instances over one immutable indexed allocation.
    /// Uploads tile-local shared-mesh instances through an unmapped
    /// queue-backed allocation. Sorted-alpha keeps `COPY_DST` for reordering.
    pub fn new_instanced_shared_indexed_mesh_for_transparency_with_queue(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        geometry: &GpuIndexedMeshGeometry,
        instances: &[GpuMeshInstanceInput],
        transparent: bool,
        transparency: TransparencyStrategy,
    ) -> Result<Self, GpuFrameError> {
        if instances.is_empty()
            || instances.iter().any(|instance| {
                instance.proxy_slot == 0
                    || instance
                        .row_0
                        .iter()
                        .chain(&instance.row_1)
                        .chain(&instance.row_2)
                        .chain(&instance.normal_row_0)
                        .chain(&instance.normal_row_1)
                        .chain(&instance.normal_row_2)
                        .any(|value| !value.is_finite())
            })
        {
            return Err(GpuFrameError::InvalidMeshIndices);
        }
        let model_center = geometry.0.sort_center;
        let instance_centers = instances
            .iter()
            .map(|instance| transform_position(instance, model_center))
            .collect::<Vec<_>>();
        if instance_centers
            .iter()
            .flatten()
            .any(|value| !value.is_finite())
        {
            return Err(GpuFrameError::InvalidMeshIndices);
        }
        let usage = if transparency == TransparencyStrategy::SortedAlpha {
            wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST
        } else {
            wgpu::BufferUsages::VERTEX
        };
        let contents = bytemuck::cast_slice(instances);
        let instance_buffer = create_queue_uploaded_buffer(
            device,
            queue,
            "himmelcad-shared-model-instances",
            contents,
            usage,
        );
        Ok(Self {
            vertex_buffer: geometry.0.vertex_buffer.clone(),
            instance_buffer: Some(instance_buffer),
            pick_vertex_buffer: Some(geometry.0.pick_vertex_buffer.clone()),
            index_buffer: Some(geometry.0.index_buffer.clone()),
            vertex_count: geometry.0.vertex_count,
            instance_count: u32::try_from(instances.len())
                .map_err(|_| GpuFrameError::TooManyVertices)?,
            index_count: geometry.0.index_count,
            material: None,
            primitive: GpuPrimitive::InstancedTriangles,
            transparent,
            pickable: true,
            sort_center: position_center(instance_centers.into_iter()),
            splat_sort: None,
            mesh_instance_sort: (transparency == TransparencyStrategy::SortedAlpha).then(|| {
                Arc::new(Mutex::new(MeshInstanceSortState::new(
                    instances,
                    model_center,
                )))
            }),
            shared_mesh_geometry: Some(geometry.clone()),
            declared_texture_coordinates: false,
        })
    }

    /// Shared immutable geometry allocation used by this instance batch.
    #[must_use]
    pub fn shared_mesh_geometry_allocation(&self) -> Option<(usize, u64)> {
        self.shared_mesh_geometry
            .as_ref()
            .map(|geometry| (geometry.allocation_key(), geometry.resident_bytes()))
    }

    /// Attaches a resident material and derives transparent-pass placement from it.
    #[must_use]
    pub fn with_material(mut self, material: GpuMaterial) -> Self {
        self.transparent = material.transparent;
        self.material = Some(material);
        self
    }

    /// Enables or disables ID-pass writes without changing color rendering.
    #[must_use]
    pub fn with_pickable(mut self, pickable: bool) -> Self {
        self.pickable = pickable;
        self
    }

    pub(crate) fn fork_with_mesh_instances_and_queue(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        instances: &[GpuMeshInstanceInput],
    ) -> Result<Self, GpuFrameError> {
        if self.primitive != GpuPrimitive::InstancedTriangles || instances.is_empty() {
            return Err(GpuFrameError::InvalidMeshIndices);
        }
        if instances.iter().any(|instance| {
            instance.proxy_slot == 0
                || instance
                    .row_0
                    .iter()
                    .chain(&instance.row_1)
                    .chain(&instance.row_2)
                    .chain(&instance.normal_row_0)
                    .chain(&instance.normal_row_1)
                    .chain(&instance.normal_row_2)
                    .any(|value| !value.is_finite())
        }) {
            return Err(GpuFrameError::InvalidMeshIndices);
        }
        let source_sort = self
            .mesh_instance_sort
            .as_ref()
            .ok_or(GpuFrameError::InvalidMeshIndices)?
            .lock()
            .map_err(|_| GpuFrameError::InvalidMeshIndices)?;
        let instance_centers = instances
            .iter()
            .map(|instance| transform_position(instance, source_sort.model_center))
            .collect::<Vec<_>>();
        if instance_centers
            .iter()
            .flatten()
            .any(|value| !value.is_finite())
        {
            return Err(GpuFrameError::InvalidMeshIndices);
        }
        let contents = bytemuck::cast_slice(instances);
        let usage = wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST;
        let instance_buffer = create_queue_uploaded_buffer(
            device,
            queue,
            "himmelcad-sorted-mesh-instance-block",
            contents,
            usage,
        );
        Ok(Self {
            vertex_buffer: self.vertex_buffer.clone(),
            instance_buffer: Some(instance_buffer),
            pick_vertex_buffer: self.pick_vertex_buffer.clone(),
            index_buffer: self.index_buffer.clone(),
            vertex_count: self.vertex_count,
            instance_count: u32::try_from(instances.len())
                .map_err(|_| GpuFrameError::TooManyVertices)?,
            index_count: self.index_count,
            material: self.material.clone(),
            primitive: self.primitive,
            transparent: self.transparent,
            pickable: self.pickable,
            sort_center: position_center(instance_centers.into_iter()),
            splat_sort: None,
            mesh_instance_sort: Some(Arc::new(Mutex::new(MeshInstanceSortState::new(
                instances,
                source_sort.model_center,
            )))),
            shared_mesh_geometry: self.shared_mesh_geometry.clone(),
            declared_texture_coordinates: self.declared_texture_coordinates,
        })
    }

    /// Applies a live view style without rebuilding immutable vertex resources.
    pub fn update_material_style(
        &mut self,
        queue: &wgpu::Queue,
        style: &GpuPresentationStyle,
    ) -> Result<(), GpuFrameError> {
        let material = self.material.as_mut().ok_or(GpuFrameError::InvalidStyle)?;
        material.update_style(queue, style);
        self.transparent = material.transparent;
        Ok(())
    }

    /// Moves a resident batch in render coordinates without rewriting source
    /// vertices; intended for live drag previews and transient transforms.
    pub fn update_interaction_translation(
        &mut self,
        queue: &wgpu::Queue,
        translation: [f32; 3],
    ) -> Result<(), GpuFrameError> {
        let material = self.material.as_mut().ok_or(GpuFrameError::InvalidStyle)?;
        material.update_interaction_translation(queue, translation)
    }

    /// Associates immutable vertex coordinates with their stable f64 batch
    /// origin and uploads the camera-relative delta for the active frame.
    pub fn set_world_origins(
        &mut self,
        queue: &wgpu::Queue,
        batch_origin: WorldVec3,
        frame_origin: WorldVec3,
    ) -> Result<(), GpuFrameError> {
        self.material
            .as_mut()
            .ok_or(GpuFrameError::InvalidStyle)?
            .set_world_origins(queue, batch_origin, frame_origin)
    }

    /// Validates an origin-only placement update without writing GPU or CPU material state.
    pub fn validate_world_origins(
        &self,
        batch_origin: WorldVec3,
        frame_origin: WorldVec3,
    ) -> Result<(), GpuFrameError> {
        self.material.as_ref().ok_or(GpuFrameError::InvalidStyle)?;
        batch_origin_delta(batch_origin, frame_origin).map(|_| ())
    }

    /// Applies one immutable provider-source to project-world affine without rebuilding vertices.
    ///
    /// The source origin is transformed in f64; only the affine linear part is
    /// uploaded for batch-local f32 positions and inverse-transposed normals.
    pub fn set_source_to_project_transform(
        &mut self,
        queue: &wgpu::Queue,
        source_origin: WorldVec3,
        frame_origin: WorldVec3,
        transform: WorldTransform,
    ) -> Result<(), GpuFrameError> {
        self.material
            .as_mut()
            .ok_or(GpuFrameError::InvalidStyle)?
            .set_source_to_project_transform(queue, source_origin, frame_origin, transform)
    }

    /// Validates that this batch can be represented relative to `frame_origin`
    /// without mutating GPU or CPU state.
    pub fn validate_frame_origin(&self, frame_origin: WorldVec3) -> Result<(), GpuFrameError> {
        let material = self.material.as_ref().ok_or(GpuFrameError::InvalidStyle)?;
        batch_origin_delta(material.batch_origin, frame_origin).map(|_| ())
    }

    /// Re-bases only the small material uniform. Immutable vertex, index and
    /// decoded provider resources retain their stable batch-local coordinates.
    pub fn update_frame_origin(
        &mut self,
        queue: &wgpu::Queue,
        frame_origin: WorldVec3,
    ) -> Result<(), GpuFrameError> {
        self.material
            .as_mut()
            .ok_or(GpuFrameError::InvalidStyle)?
            .update_frame_origin(queue, frame_origin)
    }

    /// Lazily rebases a batch only when it next participates in a visible frame.
    ///
    /// Hidden streamed residency therefore does not receive one queue write per
    /// camera-origin shift along a large project corridor.
    pub fn ensure_frame_origin(
        &mut self,
        queue: &wgpu::Queue,
        frame_origin: WorldVec3,
    ) -> Result<bool, GpuFrameError> {
        let material = self.material.as_mut().ok_or(GpuFrameError::InvalidStyle)?;
        if material.frame_origin == frame_origin {
            return Ok(false);
        }
        material.update_frame_origin(queue, frame_origin)?;
        Ok(true)
    }

    /// Reuses immutable geometry buffers with a new material uniform while
    /// sharing the original texture resource. The clone can be made non-pickable
    /// for a translucent live-move ghost.
    /// Forks presentation state while queue-uploading any sorted instance copy.
    #[allow(clippy::too_many_arguments)]
    pub fn fork_with_style_and_queue(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        renderer: &GpuSharedRenderer,
        label: &str,
        style: GpuPresentationStyle,
        pickable: bool,
    ) -> Result<Self, GpuFrameError> {
        let source = self.material.as_ref().ok_or(GpuFrameError::InvalidStyle)?;
        let mut material = renderer.create_styled_material_from_texture_with_origins(
            device,
            queue,
            label,
            &source.active_texture_resource,
            source.alpha_mode,
            &style,
            MaterialOriginState {
                batch: source.batch_origin,
                frame: source.frame_origin,
            },
        )?;
        material.source_texture_resource = source.source_texture_resource.clone();
        material.active_texture_resource = source.active_texture_resource.clone();
        material.rebind_line_type_resource(
            device,
            &renderer.material_bind_group_layout,
            &source.line_type_resource,
        );
        material.interaction_translation = source.interaction_translation;
        material.source_linear_rows = source.source_linear_rows;
        material.source_normal_rows = source.source_normal_rows;
        material.rewrite_uniform(queue);
        let (instance_buffer, mesh_instance_sort) = if let Some(sort) = &self.mesh_instance_sort {
            let sort = sort.lock().map_err(|_| GpuFrameError::InvalidMeshIndices)?;
            let contents = bytemuck::cast_slice(&sort.instances);
            let usage = wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST;
            let buffer = create_queue_uploaded_buffer(
                device,
                queue,
                "himmelcad-forked-mesh-instances",
                contents,
                usage,
            );
            (
                Some(buffer),
                Some(Arc::new(Mutex::new(MeshInstanceSortState::new(
                    &sort.instances,
                    sort.model_center,
                )))),
            )
        } else {
            (self.instance_buffer.clone(), None)
        };
        Ok(Self {
            vertex_buffer: self.vertex_buffer.clone(),
            instance_buffer,
            pick_vertex_buffer: self.pick_vertex_buffer.clone(),
            index_buffer: self.index_buffer.clone(),
            vertex_count: self.vertex_count,
            instance_count: self.instance_count,
            index_count: self.index_count,
            transparent: material.transparent,
            material: Some(material),
            primitive: self.primitive,
            pickable,
            sort_center: self.sort_center,
            splat_sort: self.splat_sort.clone(),
            mesh_instance_sort,
            shared_mesh_geometry: self.shared_mesh_geometry.clone(),
            declared_texture_coordinates: self.declared_texture_coordinates,
        })
    }
}

/// Shared depth plus exact 64-bit ID and reverse-Z hit targets for one viewport.
#[derive(Debug)]
pub struct GpuFrameTargets {
    width: u32,
    height: u32,
    _depth_texture: wgpu::Texture,
    depth_view: wgpu::TextureView,
    proxy_texture: wgpu::Texture,
    proxy_view: wgpu::TextureView,
    primitive_texture: wgpu::Texture,
    primitive_view: wgpu::TextureView,
    hit_depth_texture: wgpu::Texture,
    hit_depth_view: wgpu::TextureView,
    oit: Option<GpuOitTargets>,
}

#[derive(Debug)]
struct GpuOitTargets {
    _accumulation_texture: wgpu::Texture,
    accumulation_view: wgpu::TextureView,
    _revealage_texture: wgpu::Texture,
    revealage_view: wgpu::TextureView,
    composite_bind_group: wgpu::BindGroup,
}

impl GpuFrameTargets {
    /// Allocates portable targets for a non-zero viewport extent.
    #[must_use]
    pub fn new(device: &wgpu::Device, width: u32, height: u32) -> Self {
        Self::create(device, width, height, None)
    }

    fn create(
        device: &wgpu::Device,
        width: u32,
        height: u32,
        oit_layout: Option<&wgpu::BindGroupLayout>,
    ) -> Self {
        let width = width.max(1);
        let height = height.max(1);
        let depth_texture = texture(
            device,
            "himmelcad-shared-depth",
            width,
            height,
            wgpu::TextureFormat::Depth32Float,
            wgpu::TextureUsages::RENDER_ATTACHMENT,
        );
        let proxy_texture = texture(
            device,
            "himmelcad-pick-proxy",
            width,
            height,
            wgpu::TextureFormat::Rgba8Uint,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        );
        let primitive_texture = texture(
            device,
            "himmelcad-pick-primitive",
            width,
            height,
            wgpu::TextureFormat::Rgba8Uint,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        );
        let hit_depth_texture = texture(
            device,
            "himmelcad-pick-depth",
            width,
            height,
            // Store the IEEE-754 bits in an integer attachment. Rgba8Uint is
            // available on the downlevel WebGL2 path where a renderable
            // single-channel float target is not guaranteed.
            wgpu::TextureFormat::Rgba8Uint,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        );
        let depth_view = depth_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let proxy_view = proxy_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let primitive_view = primitive_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let hit_depth_view = hit_depth_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let oit = oit_layout.map(|layout| {
            let accumulation_texture = texture(
                device,
                "himmelcad-oit-accumulation",
                width,
                height,
                wgpu::TextureFormat::Rgba16Float,
                wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            );
            let revealage_texture = texture(
                device,
                "himmelcad-oit-revealage",
                width,
                height,
                wgpu::TextureFormat::R8Unorm,
                wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            );
            let accumulation_view =
                accumulation_texture.create_view(&wgpu::TextureViewDescriptor::default());
            let revealage_view =
                revealage_texture.create_view(&wgpu::TextureViewDescriptor::default());
            let composite_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("himmelcad-oit-composite-bind-group"),
                layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&accumulation_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&revealage_view),
                    },
                ],
            });
            GpuOitTargets {
                _accumulation_texture: accumulation_texture,
                accumulation_view,
                _revealage_texture: revealage_texture,
                revealage_view,
                composite_bind_group,
            }
        });
        Self {
            width,
            height,
            _depth_texture: depth_texture,
            depth_view,
            proxy_texture,
            proxy_view,
            primitive_texture,
            primitive_view,
            hit_depth_texture,
            hit_depth_view,
            oit,
        }
    }

    /// Allocated viewport width.
    #[must_use]
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Allocated viewport height.
    #[must_use]
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Encodes a one-pixel copy from both ID attachments after the pick pass.
    pub fn copy_pick_pixel(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        x: u32,
        y: u32,
    ) -> Result<GpuPickReadback, GpuPickReadbackError> {
        if x >= self.width || y >= self.height {
            return Err(GpuPickReadbackError::PixelOutOfBounds);
        }
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("himmelcad-pick-pixel-readback"),
            size: 8,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        copy_pick_attachment(encoder, &self.proxy_texture, &buffer, 0, x, y);
        copy_pick_attachment(encoder, &self.primitive_texture, &buffer, 4, x, y);
        Ok(GpuPickReadback { buffer })
    }

    /// Encodes one-pixel ID plus reverse-Z depth copies for world reconstruction.
    pub fn copy_hit_pixel(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        x: u32,
        y: u32,
    ) -> Result<GpuHitReadback, GpuPickReadbackError> {
        if x >= self.width || y >= self.height {
            return Err(GpuPickReadbackError::PixelOutOfBounds);
        }
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("himmelcad-hit-pixel-readback"),
            // WebGPU mapping ranges are 8-byte aligned even though the copied
            // ID/primitive/depth payload itself is three u32 values.
            size: 16,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        copy_pick_attachment(encoder, &self.proxy_texture, &buffer, 0, x, y);
        copy_pick_attachment(encoder, &self.primitive_texture, &buffer, 4, x, y);
        copy_pick_attachment(encoder, &self.hit_depth_texture, &buffer, 8, x, y);
        Ok(GpuHitReadback { buffer })
    }

    /// Encodes a bounded square hit neighborhood in nearest-pixel-first order.
    pub fn copy_hit_neighborhood(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        center_x: u32,
        center_y: u32,
        radius: u32,
    ) -> Result<GpuHitNeighborhoodReadback, GpuPickReadbackError> {
        if center_x >= self.width || center_y >= self.height {
            return Err(GpuPickReadbackError::PixelOutOfBounds);
        }
        if radius > MAX_HIT_NEIGHBORHOOD_RADIUS {
            return Err(GpuPickReadbackError::NeighborhoodTooLarge);
        }
        let min_x = center_x.saturating_sub(radius);
        let min_y = center_y.saturating_sub(radius);
        let max_x = center_x.saturating_add(radius).min(self.width - 1);
        let max_y = center_y.saturating_add(radius).min(self.height - 1);
        let mut pixels = (min_y..=max_y)
            .flat_map(|y| (min_x..=max_x).map(move |x| [x, y]))
            .collect::<Vec<_>>();
        pixels.sort_by_key(|[x, y]| {
            let dx = x.abs_diff(center_x);
            let dy = y.abs_diff(center_y);
            (dx * dx + dy * dy, *y, *x)
        });

        let width = max_x - min_x + 1;
        let height = max_y - min_y + 1;
        let (bytes_per_row, plane_stride, byte_size) =
            hit_neighborhood_buffer_layout(width, height);
        let intermediate = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("himmelcad-hit-neighborhood-copy-intermediate"),
            size: byte_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let staging = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("himmelcad-hit-neighborhood-map-staging"),
            size: byte_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        copy_pick_attachment_region(
            encoder,
            &self.proxy_texture,
            &intermediate,
            0,
            [min_x, min_y],
            [width, height],
            bytes_per_row,
        );
        copy_pick_attachment_region(
            encoder,
            &self.primitive_texture,
            &intermediate,
            plane_stride,
            [min_x, min_y],
            [width, height],
            bytes_per_row,
        );
        copy_pick_attachment_region(
            encoder,
            &self.hit_depth_texture,
            &intermediate,
            plane_stride * 2,
            [min_x, min_y],
            [width, height],
            bytes_per_row,
        );
        encoder.copy_buffer_to_buffer(&intermediate, 0, &staging, 0, byte_size);
        let (mapping_sender, mapping_receiver) = futures_channel::oneshot::channel();
        encoder.map_buffer_on_submit(&staging, wgpu::MapMode::Read, .., move |result| {
            let _ignored = mapping_sender.send(result);
        });
        Ok(GpuHitNeighborhoodReadback {
            buffer: staging,
            _intermediate: intermediate,
            mapping_receiver,
            pixels,
            origin: [min_x, min_y],
            bytes_per_row: usize::try_from(bytes_per_row)
                .expect("bounded neighborhood row pitch fits usize"),
            plane_stride: usize::try_from(plane_stride)
                .expect("bounded neighborhood plane fits usize"),
        })
    }
}

/// Pending asynchronous copy of one pixel from the two pick attachments.
#[derive(Debug)]
pub struct GpuPickReadback {
    buffer: wgpu::Buffer,
}

impl GpuPickReadback {
    /// Requests asynchronous mapping after the command buffer has been submitted.
    pub fn map(
        self,
        callback: impl FnOnce(Result<PickToken, GpuPickReadbackError>) + wgpu::WasmNotSend + 'static,
    ) {
        let callback_buffer = self.buffer.clone();
        self.buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                if let Err(error) = result {
                    callback(Err(GpuPickReadbackError::MappingFailedDetail(
                        error.to_string(),
                    )));
                    return;
                }
                let Ok(mapped) = callback_buffer.slice(..).get_mapped_range() else {
                    callback_buffer.unmap();
                    callback(Err(GpuPickReadbackError::MappingFailed));
                    return;
                };
                let proxy = [mapped[0], mapped[1], mapped[2], mapped[3]];
                let primitive = [mapped[4], mapped[5], mapped[6], mapped[7]];
                drop(mapped);
                callback_buffer.unmap();
                callback(Ok(PickToken::decode_rgba8(proxy, primitive)));
            });
    }
}

/// ID and reverse-Z depth from one rendered cursor pixel.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GpuHitSample {
    /// Shared proxy and provider-local primitive address.
    pub token: PickToken,
    /// Depth in the reverse-Z zero-through-one target.
    pub reverse_z_depth: f32,
}

/// One hit sample together with its viewport pixel.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GpuHitPixel {
    /// Top-left-origin viewport pixel used for this sample.
    pub pixel: [u32; 2],
    /// IDs and reverse-Z depth stored at the pixel.
    pub sample: GpuHitSample,
}

/// Pending asynchronous ID and depth copy.
#[derive(Debug)]
pub struct GpuHitReadback {
    buffer: wgpu::Buffer,
}

impl GpuHitReadback {
    /// Maps the hit after its copy command has been submitted.
    pub fn map(
        self,
        callback: impl FnOnce(Result<GpuHitSample, GpuPickReadbackError>) + wgpu::WasmNotSend + 'static,
    ) {
        let callback_buffer = self.buffer.clone();
        self.buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                if let Err(error) = result {
                    callback(Err(GpuPickReadbackError::MappingFailedDetail(
                        error.to_string(),
                    )));
                    return;
                }
                let Ok(mapped) = callback_buffer.slice(..).get_mapped_range() else {
                    callback_buffer.unmap();
                    callback(Err(GpuPickReadbackError::MappingFailed));
                    return;
                };
                let sample = decode_hit_bytes(&mapped);
                drop(mapped);
                callback_buffer.unmap();
                callback(sample);
            });
    }
}

fn decode_hit_bytes(bytes: &[u8]) -> Result<GpuHitSample, GpuPickReadbackError> {
    let proxy: [u8; 4] = bytes
        .get(0..4)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(GpuPickReadbackError::MappingFailed)?;
    let primitive: [u8; 4] = bytes
        .get(4..8)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(GpuPickReadbackError::MappingFailed)?;
    let depth_bytes: [u8; 4] = bytes
        .get(8..12)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(GpuPickReadbackError::MappingFailed)?;
    let depth = f32::from_le_bytes(depth_bytes);
    if !depth.is_finite() || !(0.0..=1.0).contains(&depth) {
        return Err(GpuPickReadbackError::MappingFailed);
    }
    Ok(GpuHitSample {
        token: PickToken::decode_rgba8(proxy, primitive),
        reverse_z_depth: depth,
    })
}

/// Largest accepted hover neighborhood radius in pixels.
pub const MAX_HIT_NEIGHBORHOOD_RADIUS: u32 = 8;

/// Pending asynchronous readback of a cursor-centered hit neighborhood.
pub struct GpuHitNeighborhoodReadback {
    buffer: wgpu::Buffer,
    _intermediate: wgpu::Buffer,
    mapping_receiver: futures_channel::oneshot::Receiver<Result<(), wgpu::BufferAsyncError>>,
    pixels: Vec<[u32; 2]>,
    origin: [u32; 2],
    bytes_per_row: usize,
    plane_stride: usize,
}

impl GpuHitNeighborhoodReadback {
    /// Maps samples ordered by screen distance from the requested center.
    pub async fn resolve(self) -> Result<Vec<GpuHitPixel>, GpuPickReadbackError> {
        let pixels = self.pixels;
        let origin = self.origin;
        let bytes_per_row = self.bytes_per_row;
        let plane_stride = self.plane_stride;
        self.mapping_receiver
            .await
            .map_err(|_| GpuPickReadbackError::MappingFailed)?
            .map_err(|error| GpuPickReadbackError::MappingFailedDetail(error.to_string()))?;
        let mapped = self
            .buffer
            .slice(..)
            .get_mapped_range()
            .map_err(|_| GpuPickReadbackError::MappingFailed)?;
        let hits = decode_hit_neighborhood(&mapped, &pixels, origin, bytes_per_row, plane_stride);
        drop(mapped);
        self.buffer.unmap();
        hits
    }
}

impl std::fmt::Debug for GpuHitNeighborhoodReadback {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GpuHitNeighborhoodReadback")
            .field("pixels", &self.pixels.len())
            .field("origin", &self.origin)
            .field("bytes_per_row", &self.bytes_per_row)
            .field("plane_stride", &self.plane_stride)
            .finish_non_exhaustive()
    }
}

fn hit_neighborhood_buffer_layout(width: u32, height: u32) -> (u32, u64, u64) {
    let unpadded_bytes_per_row = width * 4;
    let bytes_per_row = unpadded_bytes_per_row.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
        * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let plane_stride = u64::from(bytes_per_row) * u64::from(height);
    (bytes_per_row, plane_stride, plane_stride * 3)
}

fn decode_hit_neighborhood(
    mapped: &[u8],
    pixels: &[[u32; 2]],
    origin: [u32; 2],
    bytes_per_row: usize,
    plane_stride: usize,
) -> Result<Vec<GpuHitPixel>, GpuPickReadbackError> {
    let mut hits = Vec::with_capacity(pixels.len());
    for pixel in pixels.iter().copied() {
        let local_x =
            usize::try_from(pixel[0] - origin[0]).expect("bounded neighborhood x fits usize");
        let local_y =
            usize::try_from(pixel[1] - origin[1]).expect("bounded neighborhood y fits usize");
        let texel_offset = local_y * bytes_per_row + local_x * 4;
        let proxy = mapped
            .get(texel_offset..texel_offset + 4)
            .ok_or(GpuPickReadbackError::MappingFailed)?;
        let primitive = mapped
            .get(plane_stride + texel_offset..plane_stride + texel_offset + 4)
            .ok_or(GpuPickReadbackError::MappingFailed)?;
        let depth = mapped
            .get(plane_stride * 2 + texel_offset..plane_stride * 2 + texel_offset + 4)
            .ok_or(GpuPickReadbackError::MappingFailed)?;
        let mut bytes = [0_u8; 12];
        bytes[0..4].copy_from_slice(proxy);
        bytes[4..8].copy_from_slice(primitive);
        bytes[8..12].copy_from_slice(depth);
        hits.push(GpuHitPixel {
            pixel,
            sample: decode_hit_bytes(&bytes)?,
        });
    }
    Ok(hits)
}

/// Pick copy or asynchronous mapping failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GpuPickReadbackError {
    /// Requested cursor pixel is outside the allocated viewport.
    PixelOutOfBounds,
    /// Requested hover neighborhood would exceed the bounded readback contract.
    NeighborhoodTooLarge,
    /// GPU readback buffer mapping failed.
    MappingFailed,
    /// Backend-provided mapping failure retained for diagnostics.
    MappingFailedDetail(String),
}

impl Display for GpuPickReadbackError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::PixelOutOfBounds => "pick pixel is outside the GPU frame target",
            Self::NeighborhoodTooLarge => "pick neighborhood exceeds the portable radius limit",
            Self::MappingFailed => "GPU pick readback mapping failed",
            Self::MappingFailedDetail(message) => {
                return write!(formatter, "GPU pick readback mapping failed: {message}");
            }
        })
    }
}

impl Error for GpuPickReadbackError {}

/// Validation failure before command encoding reaches a GPU backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuFrameError {
    /// Draw batches must contain at least one vertex.
    EmptyBatch,
    /// Vertex count does not fit the portable non-indexed draw contract.
    TooManyVertices,
    /// Parallel decoded point attributes have different element counts.
    AttributeLengthMismatch,
    /// Zero is reserved for the pick-buffer background.
    InvalidProxySlot,
    /// Mesh indices are not a valid in-range triangle list.
    InvalidMeshIndices,
    /// Line batches must contain endpoint pairs.
    InvalidLineVertices,
    /// Point or line screen-space size must be positive and finite.
    InvalidPrimitiveSize,
    /// A Gaussian has invalid coordinates, covariance axes, rotation or pick slot.
    InvalidSplat,
    /// Presentation color, opacity, gradient or exaggeration is invalid.
    InvalidStyle,
    /// A presentation texture was requested for geometry without declared UVs.
    MissingTextureCoordinates,
    /// Screen-text vertices or addressing are invalid.
    InvalidText,
    /// Viewport size is zero or exceeds the portable uniform contract.
    InvalidViewport,
    /// More active clip volumes were supplied than the portable contract supports.
    TooManyClipVolumes,
    /// Active clip volumes exceed the total portable plane budget.
    TooManyClipPlanes,
    /// A matrix, floating origin or clip plane contains a non-finite value.
    NonFiniteFrameValue,
    /// Texture dimensions or RGBA byte count are invalid.
    InvalidTexture,
}

impl Display for GpuFrameError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::EmptyBatch => "GPU draw batch is empty",
            Self::TooManyVertices => "GPU draw batch exceeds u32 vertex addressing",
            Self::AttributeLengthMismatch => "GPU point attribute lengths differ",
            Self::InvalidProxySlot => "GPU proxy pick slot must be non-zero",
            Self::InvalidMeshIndices => "GPU mesh indices are not a valid triangle list",
            Self::InvalidLineVertices => "GPU line batch does not contain endpoint pairs",
            Self::InvalidPrimitiveSize => "GPU point or line size is invalid",
            Self::InvalidSplat => "GPU Gaussian splat attributes are invalid",
            Self::InvalidStyle => "GPU presentation style is invalid",
            Self::MissingTextureCoordinates => {
                "GPU presentation texture requires declared texture coordinates"
            }
            Self::InvalidText => "GPU screen-text geometry is invalid",
            Self::InvalidViewport => "GPU viewport size is invalid",
            Self::TooManyClipVolumes => "portable GPU clip-volume limit exceeded",
            Self::TooManyClipPlanes => "portable GPU clip-plane limit exceeded",
            Self::NonFiniteFrameValue => "GPU frame uniform contains a non-finite value",
            Self::InvalidTexture => "GPU texture dimensions or byte count are invalid",
        })
    }
}

impl Error for GpuFrameError {}

/// First real shared renderer: one uniform block, depth target and pick namespace.
#[derive(Debug)]
pub struct GpuSharedRenderer {
    frame_uniform: wgpu::Buffer,
    frame_bind_group: wgpu::BindGroup,
    material_bind_group_layout: wgpu::BindGroupLayout,
    default_line_type_resource: GpuLineTypeResource,
    default_material: GpuMaterial,
    opaque: PrimitivePipelines,
    transparent: PrimitivePipelines,
    pick: PrimitivePipelines,
    oit: Option<OitRenderer>,
    transparency_strategy: TransparencyStrategy,
}

#[derive(Debug)]
struct OitRenderer {
    composite_bind_group_layout: wgpu::BindGroupLayout,
    composite_pipeline: wgpu::RenderPipeline,
}

impl GpuSharedRenderer {
    /// Compiles portable point, line, triangle, transparent and ID pipelines.
    #[must_use]
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        color_format: wgpu::TextureFormat,
    ) -> Self {
        Self::new_with_transparency(
            device,
            queue,
            color_format,
            TransparencyStrategy::SortedAlpha,
        )
    }

    /// Compiles the shared renderer with an explicitly capability-resolved
    /// transparency path.
    #[must_use]
    #[allow(clippy::too_many_lines)]
    pub fn new_with_transparency(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        color_format: wgpu::TextureFormat,
        transparency_strategy: TransparencyStrategy,
    ) -> Self {
        let initial_uniform = FrameUniform::zeroed();
        let frame_uniform = create_queue_uploaded_buffer(
            device,
            queue,
            "himmelcad-frame-uniform",
            bytemuck::bytes_of(&initial_uniform),
            wgpu::BufferUsages::UNIFORM,
        );
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("himmelcad-frame-bind-group-layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let frame_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("himmelcad-frame-bind-group"),
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: frame_uniform.as_entire_binding(),
            }],
        });
        let material_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("himmelcad-material-bind-group-layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 3,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                ],
            });
        let default_texture = create_texture_resource(
            device,
            queue,
            "himmelcad-default-material",
            GpuTextureData {
                width: 1,
                height: 1,
                rgba8: &[255; 4],
            },
        )
        .expect("one-pixel default texture is valid");
        let default_line_type_resource = GpuLineTypeResource::upload(
            device,
            queue,
            "himmelcad-continuous-line-type",
            GpuLineTypePattern::from_canonical(&LineTypePattern::Continuous)
                .expect("continuous canonical line type is valid"),
        )
        .expect("continuous GPU line type is valid");
        let default_material = create_material_from_texture(
            device,
            queue,
            &material_bind_group_layout,
            "himmelcad-default-material",
            &default_texture,
            &default_line_type_resource,
            GpuAlphaMode::Opaque,
            &GpuPresentationStyle::default(),
            MaterialOriginState::ZERO,
        );
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("himmelcad-shared-pipeline-layout"),
            bind_group_layouts: &[Some(&bind_group_layout), Some(&material_bind_group_layout)],
            immediate_size: 0,
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("himmelcad-mixed-shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/mixed.wgsl").into()),
        });
        let opaque =
            PrimitivePipelines::color(device, &pipeline_layout, &shader, color_format, false);
        let transparent = match transparency_strategy {
            TransparencyStrategy::WeightedBlended => {
                PrimitivePipelines::oit(device, &pipeline_layout, &shader)
            }
            TransparencyStrategy::SortedAlpha => {
                PrimitivePipelines::color(device, &pipeline_layout, &shader, color_format, true)
            }
        };
        let pick = PrimitivePipelines::pick(device, &pipeline_layout, &shader);
        let oit = (transparency_strategy == TransparencyStrategy::WeightedBlended)
            .then(|| OitRenderer::new(device, color_format));
        Self {
            frame_uniform,
            frame_bind_group,
            material_bind_group_layout,
            default_line_type_resource,
            default_material,
            opaque,
            transparent,
            pick,
            oit,
            transparency_strategy,
        }
    }

    /// Transparency implementation compiled into this renderer.
    #[must_use]
    pub fn transparency_strategy(&self) -> TransparencyStrategy {
        self.transparency_strategy
    }

    /// Allocates extent-dependent depth, picking and optional OIT attachments.
    #[must_use]
    pub fn create_frame_targets(
        &self,
        device: &wgpu::Device,
        width: u32,
        height: u32,
    ) -> GpuFrameTargets {
        GpuFrameTargets::create(
            device,
            width,
            height,
            self.oit
                .as_ref()
                .map(|oit| &oit.composite_bind_group_layout),
        )
    }

    /// Uploads one decoded RGBA8 sRGB material texture.
    pub fn create_material(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        texture: GpuTextureData<'_>,
        alpha_mode: GpuAlphaMode,
    ) -> Result<GpuMaterial, GpuFrameError> {
        let texture = create_texture_resource(device, queue, label, texture)?;
        Ok(create_material_from_texture(
            device,
            queue,
            &self.material_bind_group_layout,
            label,
            &texture,
            &self.default_line_type_resource,
            alpha_mode,
            &GpuPresentationStyle::default(),
            MaterialOriginState::ZERO,
        ))
    }

    /// Uploads one validated canonical line-type revision as an immutable,
    /// shareable lookup texture. The same sampled-texture path is available on
    /// native WebGPU and the WebGL2 backend.
    pub fn create_line_type_resource(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        pattern: GpuLineTypePattern,
    ) -> Result<GpuLineTypeResource, GpuFrameError> {
        GpuLineTypeResource::upload(device, queue, label, pattern)
    }

    /// Uploads a texture with independently resolved color, opacity and Z styling.
    pub fn create_styled_material(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        texture: GpuTextureData<'_>,
        alpha_mode: GpuAlphaMode,
        style: GpuPresentationStyle,
    ) -> Result<GpuMaterial, GpuFrameError> {
        let texture = create_texture_resource(device, queue, label, texture)?;
        Ok(create_material_from_texture(
            device,
            queue,
            &self.material_bind_group_layout,
            label,
            &texture,
            &self.default_line_type_resource,
            alpha_mode,
            &style,
            MaterialOriginState::ZERO,
        ))
    }

    /// Uploads a complete device-ready mip chain and creates a styled material.
    pub fn create_styled_mip_chain_material(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        texture: GpuTextureMipChainData<'_>,
        alpha_mode: GpuAlphaMode,
        style: GpuPresentationStyle,
    ) -> Result<GpuMaterial, GpuFrameError> {
        let texture = create_mip_chain_texture_resource(device, queue, label, texture)?;
        Ok(create_material_from_texture(
            device,
            queue,
            &self.material_bind_group_layout,
            label,
            &texture,
            &self.default_line_type_resource,
            alpha_mode,
            &style,
            MaterialOriginState::ZERO,
        ))
    }

    /// Uploads one immutable texture that may be shared by many independently
    /// styled materials, such as a font atlas used by thousands of labels.
    pub fn create_texture_resource(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        texture: GpuTextureData<'_>,
    ) -> Result<GpuTextureResource, GpuFrameError> {
        create_texture_resource(device, queue, label, texture)
    }

    /// Uploads one immutable device-ready mip chain independently from
    /// tile-local material/style uniforms.
    pub fn create_mip_chain_texture_resource(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        texture: GpuTextureMipChainData<'_>,
    ) -> Result<GpuTextureResource, GpuFrameError> {
        create_mip_chain_texture_resource(device, queue, label, texture)
    }

    /// Creates independent mutable style uniforms around a shared texture.
    pub fn create_styled_material_from_texture(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        texture: &GpuTextureResource,
        alpha_mode: GpuAlphaMode,
        style: GpuPresentationStyle,
    ) -> Result<GpuMaterial, GpuFrameError> {
        self.create_styled_material_from_texture_with_origins(
            device,
            queue,
            label,
            texture,
            alpha_mode,
            &style,
            MaterialOriginState::ZERO,
        )
    }

    fn create_styled_material_from_texture_with_origins(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        texture: &GpuTextureResource,
        alpha_mode: GpuAlphaMode,
        style: &GpuPresentationStyle,
        origins: MaterialOriginState,
    ) -> Result<GpuMaterial, GpuFrameError> {
        batch_origin_delta(origins.batch, origins.frame)?;
        Ok(create_material_from_texture(
            device,
            queue,
            &self.material_bind_group_layout,
            label,
            texture,
            &self.default_line_type_resource,
            alpha_mode,
            style,
            origins,
        ))
    }

    /// Uploads camera-relative clipping and projection state once per frame.
    pub fn update_frame(
        &self,
        queue: &wgpu::Queue,
        view_projection: [[f32; 4]; 4],
        floating_origin: WorldVec3,
        clip_volumes: &[&ClipVolume],
        viewport_size: [u32; 2],
    ) -> Result<(), GpuFrameError> {
        let uniform = FrameUniform::prepare(
            view_projection,
            floating_origin,
            clip_volumes,
            viewport_size,
        )?;
        queue.write_buffer(&self.frame_uniform, 0, bytemuck::bytes_of(&uniform));
        Ok(())
    }

    /// Encodes color and optional ID/depth passes for resident mixed geometry.
    pub fn encode(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        color_view: &wgpu::TextureView,
        targets: &GpuFrameTargets,
        batches: &[&GpuDrawBatch],
        clear_color: wgpu::Color,
        picking_requested: bool,
    ) {
        self.encode_with_timestamp_begin(
            encoder,
            color_view,
            targets,
            batches,
            clear_color,
            picking_requested,
            None,
        );
    }

    /// Encodes a frame and optionally records the beginning of the complete
    /// surface workload in the first render pass.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn encode_with_timestamp_begin(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        color_view: &wgpu::TextureView,
        targets: &GpuFrameTargets,
        batches: &[&GpuDrawBatch],
        clear_color: wgpu::Color,
        picking_requested: bool,
        timestamp_begin: Option<(&wgpu::QuerySet, u32)>,
    ) {
        {
            let color_attachments = [Some(wgpu::RenderPassColorAttachment {
                view: color_view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(clear_color),
                    store: wgpu::StoreOp::Store,
                },
            })];
            let timestamp_writes =
                timestamp_begin.map(|(query_set, index)| wgpu::RenderPassTimestampWrites {
                    query_set,
                    beginning_of_pass_write_index: Some(index),
                    end_of_pass_write_index: None,
                });
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("himmelcad-mixed-color-pass"),
                color_attachments: &color_attachments,
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &targets.depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(0.0),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_bind_group(0, &self.frame_bind_group, &[]);
            encode_batches(
                &mut pass,
                &self.opaque,
                &self.default_material.bind_group,
                batches,
                false,
                false,
            );
            if self.transparency_strategy == TransparencyStrategy::SortedAlpha {
                encode_batches(
                    &mut pass,
                    &self.transparent,
                    &self.default_material.bind_group,
                    batches,
                    true,
                    false,
                );
            }
        }
        if let Some(oit) = &self.oit {
            self.encode_oit(encoder, color_view, targets, batches, oit);
        }
        if picking_requested {
            self.encode_pick_pass(encoder, targets, batches);
        }
    }

    /// Encodes only the exact ID/depth workload into persistent offscreen targets.
    pub(crate) fn encode_pick(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        targets: &GpuFrameTargets,
        batches: &[&GpuDrawBatch],
    ) {
        self.encode_pick_pass(encoder, targets, batches);
    }

    fn encode_oit(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        color_view: &wgpu::TextureView,
        targets: &GpuFrameTargets,
        batches: &[&GpuDrawBatch],
        oit_renderer: &OitRenderer,
    ) {
        let oit_targets = targets
            .oit
            .as_ref()
            .expect("renderer-created targets include OIT attachments");
        {
            let attachments = [
                Some(wgpu::RenderPassColorAttachment {
                    view: &oit_targets.accumulation_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                }),
                Some(wgpu::RenderPassColorAttachment {
                    view: &oit_targets.revealage_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::WHITE),
                        store: wgpu::StoreOp::Store,
                    },
                }),
            ];
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("himmelcad-weighted-oit-pass"),
                color_attachments: &attachments,
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &targets.depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_bind_group(0, &self.frame_bind_group, &[]);
            encode_batches(
                &mut pass,
                &self.transparent,
                &self.default_material.bind_group,
                batches,
                true,
                false,
            );
        }
        let attachments = [Some(wgpu::RenderPassColorAttachment {
            view: color_view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Load,
                store: wgpu::StoreOp::Store,
            },
        })];
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("himmelcad-weighted-oit-composite-pass"),
            color_attachments: &attachments,
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&oit_renderer.composite_pipeline);
        pass.set_bind_group(0, &oit_targets.composite_bind_group, &[]);
        pass.draw(0..3, 0..1);
    }

    fn encode_pick_pass(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        targets: &GpuFrameTargets,
        batches: &[&GpuDrawBatch],
    ) {
        let attachment = |view| {
            Some(wgpu::RenderPassColorAttachment {
                view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })
        };
        let pick_attachments = [
            attachment(&targets.proxy_view),
            attachment(&targets.primitive_view),
            attachment(&targets.hit_depth_view),
        ];
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("himmelcad-mixed-pick-pass"),
            color_attachments: &pick_attachments,
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &targets.depth_view,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Clear(0.0),
                    store: wgpu::StoreOp::Store,
                }),
                stencil_ops: None,
            }),
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        if !batches.is_empty() {
            pass.set_bind_group(0, &self.frame_bind_group, &[]);
        }
        for transparent in [false, true] {
            encode_batches(
                &mut pass,
                &self.pick,
                &self.default_material.bind_group,
                batches,
                transparent,
                true,
            );
        }
    }
}

#[derive(Debug)]
struct PrimitivePipelines {
    points: wgpu::RenderPipeline,
    point_sprites: wgpu::RenderPipeline,
    lines: wgpu::RenderPipeline,
    triangles: wgpu::RenderPipeline,
    instanced_triangles: wgpu::RenderPipeline,
    splats: wgpu::RenderPipeline,
    screen_text: wgpu::RenderPipeline,
}

impl PrimitivePipelines {
    fn color(
        device: &wgpu::Device,
        layout: &wgpu::PipelineLayout,
        shader: &wgpu::ShaderModule,
        format: wgpu::TextureFormat,
        transparent: bool,
    ) -> Self {
        Self {
            points: color_pipeline(
                device,
                layout,
                shader,
                format,
                GpuPrimitive::Points,
                transparent,
            ),
            point_sprites: color_pipeline(
                device,
                layout,
                shader,
                format,
                GpuPrimitive::PointSprites,
                transparent,
            ),
            lines: color_pipeline(
                device,
                layout,
                shader,
                format,
                GpuPrimitive::Lines,
                transparent,
            ),
            triangles: color_pipeline(
                device,
                layout,
                shader,
                format,
                GpuPrimitive::Triangles,
                transparent,
            ),
            instanced_triangles: color_pipeline(
                device,
                layout,
                shader,
                format,
                GpuPrimitive::InstancedTriangles,
                transparent,
            ),
            splats: color_pipeline(
                device,
                layout,
                shader,
                format,
                GpuPrimitive::GaussianSplats,
                transparent,
            ),
            screen_text: color_pipeline(
                device,
                layout,
                shader,
                format,
                GpuPrimitive::ScreenText,
                transparent,
            ),
        }
    }

    fn pick(
        device: &wgpu::Device,
        layout: &wgpu::PipelineLayout,
        shader: &wgpu::ShaderModule,
    ) -> Self {
        Self {
            points: pick_pipeline(device, layout, shader, GpuPrimitive::Points),
            point_sprites: pick_pipeline(device, layout, shader, GpuPrimitive::PointSprites),
            lines: pick_pipeline(device, layout, shader, GpuPrimitive::Lines),
            triangles: pick_pipeline(device, layout, shader, GpuPrimitive::Triangles),
            instanced_triangles: pick_pipeline(
                device,
                layout,
                shader,
                GpuPrimitive::InstancedTriangles,
            ),
            splats: pick_pipeline(device, layout, shader, GpuPrimitive::GaussianSplats),
            screen_text: pick_pipeline(device, layout, shader, GpuPrimitive::ScreenText),
        }
    }

    fn oit(
        device: &wgpu::Device,
        layout: &wgpu::PipelineLayout,
        shader: &wgpu::ShaderModule,
    ) -> Self {
        Self {
            points: oit_pipeline(device, layout, shader, GpuPrimitive::Points),
            point_sprites: oit_pipeline(device, layout, shader, GpuPrimitive::PointSprites),
            lines: oit_pipeline(device, layout, shader, GpuPrimitive::Lines),
            triangles: oit_pipeline(device, layout, shader, GpuPrimitive::Triangles),
            instanced_triangles: oit_pipeline(
                device,
                layout,
                shader,
                GpuPrimitive::InstancedTriangles,
            ),
            splats: oit_pipeline(device, layout, shader, GpuPrimitive::GaussianSplats),
            screen_text: oit_pipeline(device, layout, shader, GpuPrimitive::ScreenText),
        }
    }

    fn get(&self, primitive: GpuPrimitive) -> &wgpu::RenderPipeline {
        match primitive {
            GpuPrimitive::Points => &self.points,
            GpuPrimitive::PointSprites => &self.point_sprites,
            GpuPrimitive::Lines => &self.lines,
            GpuPrimitive::Triangles => &self.triangles,
            GpuPrimitive::InstancedTriangles => &self.instanced_triangles,
            GpuPrimitive::GaussianSplats => &self.splats,
            GpuPrimitive::ScreenText => &self.screen_text,
        }
    }
}

impl OitRenderer {
    fn new(device: &wgpu::Device, color_format: wgpu::TextureFormat) -> Self {
        let composite_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("himmelcad-oit-composite-layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                ],
            });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("himmelcad-oit-composite-pipeline-layout"),
            bind_group_layouts: &[Some(&composite_bind_group_layout)],
            immediate_size: 0,
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("himmelcad-oit-composite-shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/oit_composite.wgsl").into()),
        });
        let composite_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("himmelcad-oit-composite-pipeline"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vertex_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fragment_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: color_format,
                    blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        Self {
            composite_bind_group_layout,
            composite_pipeline,
        }
    }
}

#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
struct FrameUniform {
    view_projection: [[f32; 4]; 4],
    clip_planes: [[f32; 4]; MAX_CLIP_PLANES],
    clip_volume_meta: [[u32; 4]; MAX_CLIP_VOLUMES],
    viewport_size: [f32; 2],
    clip_volume_count: u32,
    padding: u32,
}

#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
struct MaterialUniform {
    alpha_cutoff: f32,
    alpha_mode: u32,
    color_mode: u32,
    gradient_count: u32,
    base_color: [f32; 4],
    style_values: [f32; 4],
    height_values: [f32; 4],
    gradient_colors: [[f32; 4]; MAX_GPU_GRADIENT_COLORS],
    hatch_origin_enabled: [f32; 4],
    hatch_direction_spacing: [f32; 4],
    hatch_color: [f32; 4],
    hatch_values: [f32; 4],
    stroke_color: [f32; 4],
    stroke_values: [f32; 4],
    stroke_modes: [u32; 4],
    line_type_values: [f32; 4],
    interaction_translation: [f32; 4],
    batch_origin_delta: [f32; 4],
    source_linear_rows: [[f32; 4]; 3],
    source_normal_rows: [[f32; 4]; 3],
}

impl MaterialUniform {
    fn new(
        alpha_mode: GpuAlphaMode,
        style: &GpuPresentationStyle,
        interaction_translation: [f32; 3],
        batch_origin_delta: [f32; 3],
        source_linear_rows: [[f32; 4]; 3],
        source_normal_rows: [[f32; 4]; 3],
    ) -> Self {
        let (alpha_mode, alpha_cutoff) = match alpha_mode {
            GpuAlphaMode::Opaque | GpuAlphaMode::Blend => (0, 0.0),
            GpuAlphaMode::Mask { cutoff } => (1, cutoff.clamp(0.0, 1.0)),
        };
        Self {
            alpha_cutoff,
            alpha_mode,
            color_mode: style.color_mode,
            gradient_count: style.gradient_count,
            base_color: style.base_color,
            style_values: [
                style.opacity,
                style.vertical_exaggeration,
                style.exaggeration_datum_relative,
                style.fill_visible,
            ],
            height_values: [
                style.height_minimum_relative,
                style.height_maximum_relative,
                0.0,
                0.0,
            ],
            gradient_colors: style.gradient_colors,
            hatch_origin_enabled: [
                style.hatch_origin[0],
                style.hatch_origin[1],
                style.hatch_origin[2],
                style.hatch_enabled,
            ],
            hatch_direction_spacing: [
                style.hatch_direction[0],
                style.hatch_direction[1],
                style.hatch_direction[2],
                style.hatch_spacing,
            ],
            hatch_color: style.hatch_color,
            hatch_values: [style.hatch_line_width, 0.0, 0.0, 0.0],
            stroke_color: style.stroke_color,
            stroke_values: [
                style.stroke_visible,
                style.stroke_width_override,
                style.stroke_miter_limit,
                style.line_type_phase,
            ],
            stroke_modes: [
                style.stroke_cap,
                style.stroke_join,
                style.stroke_color_mode,
                style.line_type_count,
            ],
            line_type_values: [
                style.line_type_period,
                style.line_type_texture_width as f32,
                style.line_type_advance_count as f32,
                style.line_type_dot_count as f32,
            ],
            interaction_translation: [
                interaction_translation[0],
                interaction_translation[1],
                interaction_translation[2],
                0.0,
            ],
            batch_origin_delta: [
                batch_origin_delta[0],
                batch_origin_delta[1],
                batch_origin_delta[2],
                0.0,
            ],
            source_linear_rows,
            source_normal_rows,
        }
    }
}

impl FrameUniform {
    fn prepare(
        view_projection: [[f32; 4]; 4],
        floating_origin: WorldVec3,
        clip_volumes: &[&ClipVolume],
        viewport_size: [u32; 2],
    ) -> Result<Self, GpuFrameError> {
        if clip_volumes.len() > MAX_CLIP_VOLUMES {
            return Err(GpuFrameError::TooManyClipVolumes);
        }
        let viewport_width =
            u16::try_from(viewport_size[0]).map_err(|_| GpuFrameError::InvalidViewport)?;
        let viewport_height =
            u16::try_from(viewport_size[1]).map_err(|_| GpuFrameError::InvalidViewport)?;
        if viewport_size[0] == 0 || viewport_size[1] == 0 {
            return Err(GpuFrameError::InvalidViewport);
        }
        if view_projection
            .iter()
            .flatten()
            .any(|value| !value.is_finite())
            || !finite_world(floating_origin)
        {
            return Err(GpuFrameError::NonFiniteFrameValue);
        }
        let mut result = Self {
            view_projection,
            viewport_size: [f32::from(viewport_width), f32::from(viewport_height)],
            ..Self::zeroed()
        };
        let mut next_plane = 0_usize;
        for (volume_index, volume) in clip_volumes.iter().enumerate() {
            let next_end = next_plane
                .checked_add(volume.planes.len())
                .ok_or(GpuFrameError::TooManyClipPlanes)?;
            if next_end > MAX_CLIP_PLANES {
                return Err(GpuFrameError::TooManyClipPlanes);
            }
            result.clip_volume_meta[volume_index] = [
                u32::try_from(next_plane).expect("clip plane capacity fits u32"),
                u32::try_from(volume.planes.len()).expect("clip plane capacity fits u32"),
                u32::from(volume.operation == ClipOperation::RemoveInside),
                0,
            ];
            for (target, source) in result.clip_planes[next_plane..next_end]
                .iter_mut()
                .zip(&volume.planes)
            {
                if !finite_world(source.normal) || !source.distance.is_finite() {
                    return Err(GpuFrameError::NonFiniteFrameValue);
                }
                let relative_distance = source.distance
                    + source.normal.x * floating_origin.x
                    + source.normal.y * floating_origin.y
                    + source.normal.z * floating_origin.z;
                if !relative_distance.is_finite() {
                    return Err(GpuFrameError::NonFiniteFrameValue);
                }
                #[allow(clippy::cast_possible_truncation)]
                let converted = [
                    source.normal.x as f32,
                    source.normal.y as f32,
                    source.normal.z as f32,
                    relative_distance as f32,
                ];
                if converted.iter().any(|value| !value.is_finite()) {
                    return Err(GpuFrameError::NonFiniteFrameValue);
                }
                *target = converted;
            }
            next_plane = next_end;
        }
        result.clip_volume_count =
            u32::try_from(clip_volumes.len()).expect("clip volume capacity fits u32");
        Ok(result)
    }
}

fn texture(
    device: &wgpu::Device,
    label: &str,
    width: u32,
    height: u32,
    format: wgpu::TextureFormat,
    usage: wgpu::TextureUsages,
) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage,
        view_formats: &[],
    })
}

fn create_texture_resource(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &str,
    data: GpuTextureData<'_>,
) -> Result<GpuTextureResource, GpuFrameError> {
    let byte_count = u64::from(data.width)
        .checked_mul(u64::from(data.height))
        .and_then(|pixels| pixels.checked_mul(4))
        .and_then(|bytes| usize::try_from(bytes).ok())
        .ok_or(GpuFrameError::InvalidTexture)?;
    if data.width == 0 || data.height == 0 || data.rgba8.len() != byte_count {
        return Err(GpuFrameError::InvalidTexture);
    }
    let texture = texture(
        device,
        label,
        data.width,
        data.height,
        wgpu::TextureFormat::Rgba8UnormSrgb,
        wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
    );
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        data.rgba8,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(data.width.saturating_mul(4)),
            rows_per_image: Some(data.height),
        },
        wgpu::Extent3d {
            width: data.width,
            height: data.height,
            depth_or_array_layers: 1,
        },
    );
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some(label),
        address_mode_u: wgpu::AddressMode::Repeat,
        address_mode_v: wgpu::AddressMode::Repeat,
        address_mode_w: wgpu::AddressMode::Repeat,
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::MipmapFilterMode::Linear,
        ..wgpu::SamplerDescriptor::default()
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    Ok(GpuTextureResource(Arc::new(GpuTextureResourceInner {
        _texture: texture,
        view,
        sampler,
        resident_bytes: u64::try_from(data.rgba8.len()).unwrap_or(u64::MAX),
    })))
}

fn create_mip_chain_texture_resource(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &str,
    data: GpuTextureMipChainData<'_>,
) -> Result<GpuTextureResource, GpuFrameError> {
    if data.width == 0 || data.height == 0 || data.mip_level_count == 0 || data.data.is_empty() {
        return Err(GpuFrameError::InvalidTexture);
    }
    let descriptor = wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width: data.width,
            height: data.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: data.mip_level_count,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: data.format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    };
    let texture = device.create_texture_with_data(
        queue,
        &descriptor,
        wgpu::util::TextureDataOrder::MipMajor,
        data.data,
    );
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some(label),
        address_mode_u: wgpu::AddressMode::Repeat,
        address_mode_v: wgpu::AddressMode::Repeat,
        address_mode_w: wgpu::AddressMode::Repeat,
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::MipmapFilterMode::Linear,
        ..wgpu::SamplerDescriptor::default()
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    Ok(GpuTextureResource(Arc::new(GpuTextureResourceInner {
        _texture: texture,
        view,
        sampler,
        resident_bytes: u64::try_from(data.data.len()).unwrap_or(u64::MAX),
    })))
}

fn create_material_from_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    layout: &wgpu::BindGroupLayout,
    label: &str,
    texture: &GpuTextureResource,
    line_type_resource: &GpuLineTypeResource,
    alpha_mode: GpuAlphaMode,
    style: &GpuPresentationStyle,
    origins: MaterialOriginState,
) -> GpuMaterial {
    let origin_delta = batch_origin_delta(origins.batch, origins.frame)
        .expect("material origins were validated before allocation");
    let material_uniform = MaterialUniform::new(
        alpha_mode,
        style,
        [0.0; 3],
        origin_delta,
        IDENTITY_AFFINE_ROWS,
        IDENTITY_AFFINE_ROWS,
    );
    let uniform = create_queue_uploaded_buffer(
        device,
        queue,
        label,
        bytemuck::bytes_of(&material_uniform),
        wgpu::BufferUsages::UNIFORM,
    );
    let bind_group =
        create_material_bind_group(device, layout, label, texture, line_type_resource, &uniform);
    GpuMaterial {
        bind_group,
        source_texture_resource: texture.clone(),
        active_texture_resource: texture.clone(),
        line_type_resource: line_type_resource.clone(),
        uniform,
        alpha_mode,
        transparent: alpha_mode == GpuAlphaMode::Blend || style.opacity < 1.0,
        style: *style,
        interaction_translation: [0.0; 3],
        source_linear_rows: IDENTITY_AFFINE_ROWS,
        source_normal_rows: IDENTITY_AFFINE_ROWS,
        batch_origin: origins.batch,
        frame_origin: origins.frame,
    }
}

fn create_material_bind_group(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    label: &str,
    texture: &GpuTextureResource,
    line_type_resource: &GpuLineTypeResource,
    uniform: &wgpu::Buffer,
) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some(label),
        layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&texture.0.view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::Sampler(&texture.0.sampler),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: wgpu::BindingResource::TextureView(&line_type_resource.0.view),
            },
        ],
    })
}

fn copy_pick_attachment(
    encoder: &mut wgpu::CommandEncoder,
    texture: &wgpu::Texture,
    buffer: &wgpu::Buffer,
    offset: u64,
    x: u32,
    y: u32,
) {
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d { x, y, z: 0 },
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset,
                bytes_per_row: None,
                rows_per_image: None,
            },
        },
        wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        },
    );
}

fn copy_pick_attachment_region(
    encoder: &mut wgpu::CommandEncoder,
    texture: &wgpu::Texture,
    buffer: &wgpu::Buffer,
    offset: u64,
    origin: [u32; 2],
    extent: [u32; 2],
    bytes_per_row: u32,
) {
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d {
                x: origin[0],
                y: origin[1],
                z: 0,
            },
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset,
                bytes_per_row: Some(bytes_per_row),
                rows_per_image: Some(extent[1]),
            },
        },
        wgpu::Extent3d {
            width: extent[0],
            height: extent[1],
            depth_or_array_layers: 1,
        },
    );
}

fn vertex_layout(primitive: GpuPrimitive) -> wgpu::VertexBufferLayout<'static> {
    const POINT_ATTRIBUTES: [wgpu::VertexAttribute; 7] = wgpu::vertex_attr_array![
        0 => Float32x3,
        1 => Unorm8x4,
        2 => Uint32,
        3 => Uint32,
        4 => Float32,
        5 => Uint32,
        6 => Uint32
    ];
    const LINE_ATTRIBUTES: [wgpu::VertexAttribute; 10] = wgpu::vertex_attr_array![
        0 => Float32x3,
        1 => Float32x3,
        2 => Float32x4,
        3 => Uint32,
        4 => Uint32,
        5 => Float32,
        6 => Float32x3,
        7 => Float32x3,
        8 => Float32x2,
        9 => Uint32x2
    ];
    const MESH_ATTRIBUTES: [wgpu::VertexAttribute; 6] = wgpu::vertex_attr_array![
        0 => Float32x3,
        1 => Unorm8x4,
        2 => Uint32,
        3 => Uint32,
        4 => Snorm8x4,
        5 => Float32x2
    ];
    const SPLAT_ATTRIBUTES: [wgpu::VertexAttribute; 6] = wgpu::vertex_attr_array![
        0 => Float32x3,
        1 => Unorm8x4,
        2 => Float32x3,
        3 => Float32x4,
        4 => Uint32,
        5 => Uint32
    ];
    const SCREEN_TEXT_ATTRIBUTES: [wgpu::VertexAttribute; 6] = wgpu::vertex_attr_array![
        0 => Float32x3,
        1 => Float32x2,
        2 => Float32x2,
        3 => Float32x4,
        4 => Uint32,
        5 => Uint32
    ];
    let (array_stride, attributes, step_mode) = match primitive {
        GpuPrimitive::Points => (
            GPU_POINT_VERTEX_STRIDE_BYTES,
            POINT_ATTRIBUTES.as_slice(),
            wgpu::VertexStepMode::Vertex,
        ),
        GpuPrimitive::PointSprites => (
            GPU_POINT_VERTEX_STRIDE_BYTES,
            POINT_ATTRIBUTES.as_slice(),
            wgpu::VertexStepMode::Instance,
        ),
        GpuPrimitive::Lines => (
            u64::try_from(size_of::<GpuLineInstance>()).expect("line instance stride fits u64"),
            LINE_ATTRIBUTES.as_slice(),
            wgpu::VertexStepMode::Instance,
        ),
        GpuPrimitive::Triangles => (
            u64::try_from(size_of::<GpuMeshVertex>()).expect("mesh vertex stride fits u64"),
            MESH_ATTRIBUTES.as_slice(),
            wgpu::VertexStepMode::Vertex,
        ),
        GpuPrimitive::InstancedTriangles => (
            u64::try_from(size_of::<GpuMeshVertex>()).expect("mesh vertex stride fits u64"),
            MESH_ATTRIBUTES.as_slice(),
            wgpu::VertexStepMode::Vertex,
        ),
        GpuPrimitive::GaussianSplats => (
            u64::try_from(size_of::<GpuSplatVertex>()).expect("splat instance stride fits u64"),
            SPLAT_ATTRIBUTES.as_slice(),
            wgpu::VertexStepMode::Instance,
        ),
        GpuPrimitive::ScreenText => (
            u64::try_from(size_of::<GpuScreenTextVertex>()).expect("text vertex stride fits u64"),
            SCREEN_TEXT_ATTRIBUTES.as_slice(),
            wgpu::VertexStepMode::Vertex,
        ),
    };
    wgpu::VertexBufferLayout {
        array_stride,
        step_mode,
        attributes,
    }
}

fn mesh_instance_layout() -> wgpu::VertexBufferLayout<'static> {
    const ATTRIBUTES: [wgpu::VertexAttribute; 8] = wgpu::vertex_attr_array![
        6 => Float32x4,
        7 => Float32x4,
        8 => Float32x4,
        9 => Uint32,
        10 => Uint32,
        11 => Float32x4,
        12 => Float32x4,
        13 => Float32x4
    ];
    wgpu::VertexBufferLayout {
        array_stride: u64::try_from(size_of::<GpuMeshInstanceInput>())
            .expect("mesh instance stride fits u64"),
        step_mode: wgpu::VertexStepMode::Instance,
        attributes: &ATTRIBUTES,
    }
}

fn color_pipeline(
    device: &wgpu::Device,
    layout: &wgpu::PipelineLayout,
    shader: &wgpu::ShaderModule,
    format: wgpu::TextureFormat,
    primitive: GpuPrimitive,
    transparent: bool,
) -> wgpu::RenderPipeline {
    let targets = [Some(wgpu::ColorTargetState {
        format,
        blend: transparent.then_some(wgpu::BlendState::ALPHA_BLENDING),
        write_mask: wgpu::ColorWrites::ALL,
    })];
    pipeline(
        device,
        layout,
        shader,
        "color_fragment",
        &targets,
        primitive,
        !transparent,
    )
}

fn oit_pipeline(
    device: &wgpu::Device,
    layout: &wgpu::PipelineLayout,
    shader: &wgpu::ShaderModule,
    primitive: GpuPrimitive,
) -> wgpu::RenderPipeline {
    let additive = wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::One,
        dst_factor: wgpu::BlendFactor::One,
        operation: wgpu::BlendOperation::Add,
    };
    let revealage = wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::Zero,
        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        operation: wgpu::BlendOperation::Add,
    };
    let targets = [
        Some(wgpu::ColorTargetState {
            format: wgpu::TextureFormat::Rgba16Float,
            blend: Some(wgpu::BlendState {
                color: additive,
                alpha: additive,
            }),
            write_mask: wgpu::ColorWrites::ALL,
        }),
        Some(wgpu::ColorTargetState {
            format: wgpu::TextureFormat::R8Unorm,
            blend: Some(wgpu::BlendState {
                color: revealage,
                alpha: revealage,
            }),
            write_mask: wgpu::ColorWrites::RED,
        }),
    ];
    pipeline(
        device,
        layout,
        shader,
        "oit_fragment",
        &targets,
        primitive,
        false,
    )
}

fn pick_pipeline(
    device: &wgpu::Device,
    layout: &wgpu::PipelineLayout,
    shader: &wgpu::ShaderModule,
    primitive: GpuPrimitive,
) -> wgpu::RenderPipeline {
    let targets = [
        Some(wgpu::ColorTargetState {
            format: wgpu::TextureFormat::Rgba8Uint,
            blend: None,
            write_mask: wgpu::ColorWrites::ALL,
        }),
        Some(wgpu::ColorTargetState {
            format: wgpu::TextureFormat::Rgba8Uint,
            blend: None,
            write_mask: wgpu::ColorWrites::ALL,
        }),
        Some(wgpu::ColorTargetState {
            format: wgpu::TextureFormat::Rgba8Uint,
            blend: None,
            write_mask: wgpu::ColorWrites::ALL,
        }),
    ];
    pipeline(
        device,
        layout,
        shader,
        "pick_fragment",
        &targets,
        primitive,
        true,
    )
}

fn pipeline(
    device: &wgpu::Device,
    layout: &wgpu::PipelineLayout,
    shader: &wgpu::ShaderModule,
    fragment_entry: &str,
    targets: &[Option<wgpu::ColorTargetState>],
    primitive: GpuPrimitive,
    depth_write_enabled: bool,
) -> wgpu::RenderPipeline {
    let buffers = if primitive == GpuPrimitive::InstancedTriangles {
        vec![
            Some(vertex_layout(GpuPrimitive::Triangles)),
            Some(mesh_instance_layout()),
        ]
    } else {
        vec![Some(vertex_layout(primitive))]
    };
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("himmelcad-shared-render-pipeline"),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some(match primitive {
                GpuPrimitive::Points => "native_point_vertex_main",
                GpuPrimitive::PointSprites => "point_vertex_main",
                GpuPrimitive::Lines => "line_vertex_main",
                GpuPrimitive::Triangles => "mesh_vertex_main",
                GpuPrimitive::InstancedTriangles => "instanced_mesh_vertex_main",
                GpuPrimitive::GaussianSplats => "splat_vertex_main",
                GpuPrimitive::ScreenText => "screen_text_vertex_main",
            }),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            buffers: &buffers,
        },
        primitive: wgpu::PrimitiveState {
            topology: if primitive == GpuPrimitive::Points {
                wgpu::PrimitiveTopology::PointList
            } else {
                wgpu::PrimitiveTopology::TriangleList
            },
            ..wgpu::PrimitiveState::default()
        },
        depth_stencil: Some(wgpu::DepthStencilState {
            format: wgpu::TextureFormat::Depth32Float,
            depth_write_enabled: Some(depth_write_enabled),
            depth_compare: Some(wgpu::CompareFunction::GreaterEqual),
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        }),
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some(fragment_entry),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            targets,
        }),
        multiview_mask: None,
        cache: None,
    })
}

fn encode_batches<'pass>(
    pass: &mut wgpu::RenderPass<'pass>,
    pipelines: &'pass PrimitivePipelines,
    default_material: &'pass wgpu::BindGroup,
    batches: &'pass [&'pass GpuDrawBatch],
    transparent: bool,
    picking: bool,
) {
    for batch in batches {
        if batch.transparent != transparent || (picking && !batch.pickable) {
            continue;
        }
        pass.set_pipeline(pipelines.get(batch.primitive));
        pass.set_bind_group(
            1,
            batch
                .material
                .as_ref()
                .map_or(default_material, |material| &material.bind_group),
            &[],
        );
        if let Some(instance_buffer) = &batch.instance_buffer {
            pass.set_vertex_buffer(1, instance_buffer.slice(..));
        }
        if picking {
            let vertex_buffer = batch
                .pick_vertex_buffer
                .as_ref()
                .unwrap_or(&batch.vertex_buffer);
            pass.set_vertex_buffer(0, vertex_buffer.slice(..));
            let count = batch
                .pick_vertex_buffer
                .as_ref()
                .map_or(batch.vertex_count, |_| batch.index_count);
            let instances = if batch.pick_vertex_buffer.is_some()
                && batch.primitive != GpuPrimitive::InstancedTriangles
            {
                1
            } else {
                batch.instance_count
            };
            pass.draw(0..count, 0..instances);
        } else if let Some(index_buffer) = &batch.index_buffer {
            pass.set_vertex_buffer(0, batch.vertex_buffer.slice(..));
            pass.set_index_buffer(index_buffer.slice(..), wgpu::IndexFormat::Uint32);
            pass.draw_indexed(0..batch.index_count, 0, 0..batch.instance_count);
        } else {
            pass.set_vertex_buffer(0, batch.vertex_buffer.slice(..));
            pass.draw(0..batch.vertex_count, 0..batch.instance_count);
        }
    }
}

fn finite_world(value: WorldVec3) -> bool {
    value.x.is_finite() && value.y.is_finite() && value.z.is_finite()
}

fn float_color_channel(value: f32) -> u8 {
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let converted = (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    converted
}

fn mesh_vertex(input: &GpuMeshVertexInput, proxy_slot: u32, primitive_slot: u32) -> GpuMeshVertex {
    GpuMeshVertex {
        position: input.position,
        color: input.color.map(float_color_channel),
        proxy_slot,
        primitive_slot,
        normal: [
            snorm_channel(input.normal[0]),
            snorm_channel(input.normal[1]),
            snorm_channel(input.normal[2]),
            0,
        ],
        tex_coord: input.tex_coord,
    }
}

fn snorm_channel(value: f32) -> i8 {
    #[allow(clippy::cast_possible_truncation)]
    let converted = (value.clamp(-1.0, 1.0) * 127.0).round() as i8;
    converted
}

fn f32_relative(value: f64, origin: f64) -> Result<f32, GpuFrameError> {
    #[allow(clippy::cast_possible_truncation)]
    let converted = (value - origin) as f32;
    converted
        .is_finite()
        .then_some(converted)
        .ok_or(GpuFrameError::InvalidStyle)
}

#[allow(clippy::cast_precision_loss)]
fn sample_gradient(colors: &[[f32; 4]], index: usize, output_count: usize) -> [f32; 4] {
    if colors.len() == 1 || output_count == 1 {
        return colors[0];
    }
    let parameter = index as f32 * (colors.len() - 1) as f32 / (output_count - 1) as f32;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let lower = parameter.floor() as usize;
    let upper = (lower + 1).min(colors.len() - 1);
    let fraction = parameter - lower as f32;
    std::array::from_fn(|channel| {
        colors[lower][channel].mul_add(1.0 - fraction, colors[upper][channel] * fraction)
    })
}

#[cfg(test)]
mod tests {
    use super::{
        affine_rows, batch_origin_delta, decode_hit_neighborhood, hit_neighborhood_buffer_layout,
        FrameUniform, GpuAlphaMode, GpuDrawBatch, GpuFrameError, GpuIndexedMeshGeometry,
        GpuMeshInstanceInput, GpuMeshVertexInput, GpuPointVertex, GpuPrimitive,
        GpuScreenTextVertex, GpuSharedRenderer, GpuSplatVertex, GpuTextureData, GpuVertex,
        MeshInstanceSortState, SplatSortState, GPU_POINT_VERTEX_STRIDE_BYTES,
        SORTED_ALPHA_MESH_INSTANCE_BLOCK_SIZE, SORTED_ALPHA_SPLAT_BLOCK_SIZE,
        SORTED_ALPHA_UPLOAD_BYTES_PER_FRAME,
    };
    use crate::{
        build_cad_curve_batch_with_width, tessellate_curve, ClipOperation, ClipPlane, ClipVolume,
        ClipVolumeId, ColorMode, CurveTessellationOptions, FloatingOrigin, HeightGradient,
        PickToken, RenderStyle, TransparencyStrategy, UnresolvedHeightDisplay, WorldTransform,
        WorldVec3,
    };
    use himmelcad_core::canonical_resources::{CanonicalResourceRef, LINE_TYPE_RESOURCE_SCHEMA_ID};
    use himmelcad_core::entity_model::{CurveGeometry, Position};
    use himmelcad_core::hash::ObjectHash;

    fn line_type_ref(resource_id: &str) -> CanonicalResourceRef {
        CanonicalResourceRef {
            resource_id: resource_id.to_owned(),
            schema_id: LINE_TYPE_RESOURCE_SCHEMA_ID.to_owned(),
            content_hash: ObjectHash::of_bytes(resource_id.as_bytes()),
        }
    }

    #[test]
    fn point_vertex_stride_constant_tracks_the_uploaded_layout() {
        assert_eq!(
            GPU_POINT_VERTEX_STRIDE_BYTES,
            u64::try_from(std::mem::size_of::<GpuPointVertex>()).expect("point stride fits u64")
        );
    }

    #[test]
    fn maximum_pick_neighborhood_layout_preserves_every_unique_pixel() {
        let width = 17_u32;
        let height = 17_u32;
        let (bytes_per_row, plane_stride, total_bytes) =
            hit_neighborhood_buffer_layout(width, height);
        assert_eq!(bytes_per_row % wgpu::COPY_BYTES_PER_ROW_ALIGNMENT, 0);
        assert_eq!(
            plane_stride % u64::from(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT),
            0
        );
        assert_eq!(
            (plane_stride * 2) % u64::from(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT),
            0
        );
        assert_eq!(total_bytes % 8, 0);

        let bytes_per_row = usize::try_from(bytes_per_row).expect("row pitch fits usize");
        let plane_stride = usize::try_from(plane_stride).expect("plane fits usize");
        let mut mapped = vec![0_u8; usize::try_from(total_bytes).expect("mapping fits usize")];
        let center = [8_u32, 8_u32];
        let mut pixels = (0..height)
            .flat_map(|y| (0..width).map(move |x| [x, y]))
            .collect::<Vec<_>>();
        pixels.sort_by_key(|[x, y]| {
            let dx = x.abs_diff(center[0]);
            let dy = y.abs_diff(center[1]);
            (dx * dx + dy * dy, *y, *x)
        });
        for y in 0..height {
            for x in 0..width {
                let index = y * width + x;
                let offset = usize::try_from(y).expect("y fits usize") * bytes_per_row
                    + usize::try_from(x).expect("x fits usize") * 4;
                mapped[offset..offset + 4].copy_from_slice(&(index + 1).to_le_bytes());
                mapped[plane_stride + offset..plane_stride + offset + 4]
                    .copy_from_slice(&(10_000 + index).to_le_bytes());
                mapped[plane_stride * 2 + offset..plane_stride * 2 + offset + 4]
                    .copy_from_slice(&((index + 1) as f32 / 290.0).to_le_bytes());
            }
        }

        let decoded =
            decode_hit_neighborhood(&mapped, &pixels, [0, 0], bytes_per_row, plane_stride)
                .expect("maximum neighborhood decodes");
        assert_eq!(decoded.len(), 289);
        assert_eq!(decoded[0].pixel, center);
        for hit in decoded {
            let index = hit.pixel[1] * width + hit.pixel[0];
            assert_eq!(hit.sample.token.proxy_slot, index + 1);
            assert_eq!(hit.sample.token.primitive_slot, 10_000 + index);
            assert_eq!(hit.sample.reverse_z_depth, (index + 1) as f32 / 290.0);
        }
    }

    #[test]
    fn every_initialized_buffer_upload_rejects_mapped_at_creation() {
        let gpu_frame = include_str!("gpu_frame.rs");
        let resource_builder = include_str!("resource_builder.rs");
        let mapped_at_creation_true = ["mapped_at_creation", ": true"].concat();
        let buffer_init = ["device.", "create_buffer_init"].concat();
        let any_buffer_init = ["create_", "buffer_init"].concat();

        assert!(!gpu_frame.contains(&mapped_at_creation_true));
        assert!(!resource_builder.contains(&any_buffer_init));
        assert_eq!(gpu_frame.matches(&buffer_init).count(), 0);
        assert!(gpu_frame.contains("himmelcad-frame-uniform"));
        assert!(gpu_frame.contains("MaterialUniform::new"));
    }

    #[test]
    fn mesh_instance_layout_matches_shader_offsets() {
        assert_eq!(std::mem::size_of::<GpuMeshInstanceInput>(), 112);
        assert_eq!(std::mem::offset_of!(GpuMeshInstanceInput, row_0), 0);
        assert_eq!(std::mem::offset_of!(GpuMeshInstanceInput, row_1), 16);
        assert_eq!(std::mem::offset_of!(GpuMeshInstanceInput, row_2), 32);
        assert_eq!(std::mem::offset_of!(GpuMeshInstanceInput, proxy_slot), 48);
        assert_eq!(
            std::mem::offset_of!(GpuMeshInstanceInput, primitive_offset),
            52
        );
        assert_eq!(std::mem::offset_of!(GpuMeshInstanceInput, normal_row_0), 56);
        assert_eq!(std::mem::offset_of!(GpuMeshInstanceInput, normal_row_1), 72);
        assert_eq!(std::mem::offset_of!(GpuMeshInstanceInput, normal_row_2), 88);
        let sorted_block_bytes =
            SORTED_ALPHA_MESH_INSTANCE_BLOCK_SIZE * std::mem::size_of::<GpuMeshInstanceInput>();
        let upload_budget = usize::try_from(SORTED_ALPHA_UPLOAD_BYTES_PER_FRAME)
            .expect("four MiB fits supported targets");
        assert!(sorted_block_bytes <= upload_budget);
        assert!(sorted_block_bytes + std::mem::size_of::<GpuMeshInstanceInput>() > upload_budget);
    }

    #[test]
    fn sorted_alpha_splats_use_stable_depth_then_primitive_order() {
        let block_bytes = u64::try_from(SORTED_ALPHA_SPLAT_BLOCK_SIZE)
            .expect("block size fits u64")
            * u64::try_from(std::mem::size_of::<GpuSplatVertex>()).expect("stride fits u64");
        assert!(block_bytes * 2 <= SORTED_ALPHA_UPLOAD_BYTES_PER_FRAME);
        assert!(block_bytes * 3 > SORTED_ALPHA_UPLOAD_BYTES_PER_FRAME);
        let splat = |depth: f32, primitive_slot: u32| GpuSplatVertex {
            position: [0.0, 0.0, depth],
            color: [255; 4],
            scale: [1.0; 3],
            rotation: [0.0, 0.0, 0.0, 1.0],
            proxy_slot: 7,
            primitive_slot,
        };
        let mut state = SplatSortState::new(&[splat(0.9, 30), splat(0.1, 20), splat(0.1, 10)]);
        let origin = WorldVec3 {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        };

        assert!(state.sort(identity(), origin, None).expect("initial sort"));
        assert_eq!(
            state
                .vertices
                .iter()
                .map(|vertex| vertex.primitive_slot)
                .collect::<Vec<_>>(),
            vec![10, 20, 30]
        );
        assert!(state.vertices.iter().all(|vertex| vertex.proxy_slot == 7));
        assert!(!state
            .sort(identity(), origin, None)
            .expect("unchanged camera reuses ordering"));

        let mut reversed_depth = identity();
        reversed_depth[2][2] = -1.0;
        assert!(state
            .sort(reversed_depth, origin, None)
            .expect("changed view axis resorts"));
        assert_eq!(
            state
                .vertices
                .iter()
                .map(|vertex| vertex.primitive_slot)
                .collect::<Vec<_>>(),
            vec![30, 10, 20]
        );
    }

    #[test]
    fn sorted_alpha_mesh_instances_use_transformed_centers_and_stable_ids() {
        let instance = |depth: f32, primitive_offset: u32| {
            GpuMeshInstanceInput::new(
                [
                    [1.0, 0.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0, 0.0],
                    [0.0, 0.0, 1.0, depth],
                ],
                [
                    [1.0, 0.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0, 0.0],
                    [0.0, 0.0, 1.0, 0.0],
                ],
                7,
                primitive_offset,
            )
        };
        let mut state = MeshInstanceSortState::new(
            &[instance(0.9, 30), instance(0.1, 20), instance(0.1, 10)],
            [4.0, 5.0, 0.0],
        );
        let origin = WorldVec3 {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        };

        assert!(state.sort(identity(), origin, None).expect("initial sort"));
        assert_eq!(
            state
                .instances
                .iter()
                .map(|instance| instance.primitive_offset)
                .collect::<Vec<_>>(),
            vec![10, 20, 30]
        );
        assert!(state
            .instances
            .iter()
            .all(|instance| instance.proxy_slot == 7));
        assert!(!state
            .sort(identity(), origin, None)
            .expect("unchanged camera reuses ordering"));

        let mut reversed_depth = identity();
        reversed_depth[2][2] = -1.0;
        assert!(state
            .sort(reversed_depth, origin, None)
            .expect("changed view axis resorts"));
        assert_eq!(
            state
                .instances
                .iter()
                .map(|instance| instance.primitive_offset)
                .collect::<Vec<_>>(),
            vec![30, 10, 20]
        );
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[tokio::test]
    async fn instanced_mesh_sort_state_is_backend_resolved_and_uploadable() {
        let _native_test_guard = crate::test_sync::native_gpu_or_transcoder();
        let Some((device, queue)) = smoke_device().await else {
            return;
        };
        let vertices = [
            GpuMeshVertexInput {
                position: [-1.0, -1.0, 0.0],
                normal: [0.0, 0.0, 1.0],
                tex_coord: [0.0, 0.0],
                color: [1.0; 4],
            },
            GpuMeshVertexInput {
                position: [1.0, -1.0, 0.0],
                normal: [0.0, 0.0, 1.0],
                tex_coord: [1.0, 0.0],
                color: [1.0; 4],
            },
            GpuMeshVertexInput {
                position: [0.0, 1.0, 0.0],
                normal: [0.0, 0.0, 1.0],
                tex_coord: [0.5, 1.0],
                color: [1.0; 4],
            },
        ];
        let instance = |depth: f32, primitive_offset: u32| {
            GpuMeshInstanceInput::new(
                [
                    [1.0, 0.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0, 0.0],
                    [0.0, 0.0, 1.0, depth],
                ],
                [
                    [1.0, 0.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0, 0.0],
                    [0.0, 0.0, 1.0, 0.0],
                ],
                7,
                primitive_offset,
            )
        };
        let instances = [instance(0.9, 30), instance(0.1, 10)];
        let sorted = GpuDrawBatch::new_instanced_indexed_mesh_for_transparency_with_queue(
            &device,
            &queue,
            "sorted-alpha-instances",
            0,
            &vertices,
            &[0, 1, 2],
            &instances,
            true,
            TransparencyStrategy::SortedAlpha,
        )
        .expect("sorted-alpha instance batch");
        assert!(sorted
            .prepare_sorted_alpha(&queue, identity(), zero())
            .expect("instance order upload"));
        assert_eq!(
            sorted.sorted_mesh_instance_primitive_offsets(),
            Some(vec![10, 30])
        );

        let weighted = GpuDrawBatch::new_instanced_indexed_mesh_for_transparency_with_queue(
            &device,
            &queue,
            "weighted-instances",
            0,
            &vertices,
            &[0, 1, 2],
            &instances,
            true,
            TransparencyStrategy::WeightedBlended,
        )
        .expect("weighted instance batch");
        assert_eq!(weighted.sorted_mesh_instance_primitive_offsets(), None);
        assert!(!weighted
            .prepare_sorted_alpha(&queue, identity(), zero())
            .expect("weighted path skips sorting"));
    }

    #[test]
    fn frame_origin_shift_preserves_batch_local_geometry_at_ecef_scale() {
        let batch_origin = WorldVec3 {
            x: 6_378_137.25,
            y: 4_812_345.5,
            z: 512.125,
        };
        let local_vertex = [0.125_f32, -0.25, 1.5];
        let initial = batch_origin_delta(batch_origin, batch_origin).expect("initial origin");
        let next_frame = WorldVec3 {
            x: batch_origin.x + 1_024.0,
            y: batch_origin.y - 512.0,
            z: batch_origin.z + 64.0,
        };
        let shifted = batch_origin_delta(batch_origin, next_frame).expect("shifted origin");

        assert_eq!(initial, [0.0; 3]);
        assert_eq!(shifted, [-1_024.0, 512.0, -64.0]);
        assert_eq!(local_vertex, [0.125, -0.25, 1.5]);
        assert_eq!(
            std::array::from_fn::<_, 3, _>(|axis| local_vertex[axis] + shifted[axis]),
            [-1_023.875, 511.75, -62.5]
        );
    }

    #[test]
    fn streamed_entity_affine_rows_preserve_position_and_normal_semantics() {
        let transform = WorldTransform([
            0.0, 2.0, 0.0, 0.0, // rotated and scaled X axis
            -3.0, 0.0, 0.0, 0.0, // rotated and scaled Y axis
            0.0, 0.0, 4.0, 0.0, // scaled Z axis
            100.0, -50.0, 25.0, 1.0, // translation
        ]);
        let source = WorldVec3 {
            x: 2.0,
            y: 1.0,
            z: 0.5,
        };
        let project = transform.transform_point(source).expect("project point");
        let restored = transform
            .inverse()
            .expect("invertible transform")
            .transform_point(project)
            .expect("source point");
        let (position_rows, normal_rows) = affine_rows(transform).expect("GPU affine rows");

        assert_eq!(
            project,
            WorldVec3 {
                x: 97.0,
                y: -46.0,
                z: 27.0
            }
        );
        assert!((restored.x - source.x).abs() < 1.0e-12);
        assert!((restored.y - source.y).abs() < 1.0e-12);
        assert!((restored.z - source.z).abs() < 1.0e-12);
        assert_eq!(position_rows[0], [0.0, -3.0, 0.0, 0.0]);
        assert_eq!(position_rows[1], [2.0, 0.0, 0.0, 0.0]);
        assert_eq!(position_rows[2], [0.0, 0.0, 4.0, 0.0]);
        assert_eq!(normal_rows[0], [0.0, -1.0 / 3.0, 0.0, 0.0]);
        assert_eq!(normal_rows[1], [0.5, 0.0, 0.0, 0.0]);
        assert_eq!(normal_rows[2], [0.0, 0.0, 0.25, 0.0]);
    }

    #[test]
    fn world_clip_planes_are_shifted_into_render_relative_coordinates() {
        let volume = clip_volume(vec![ClipPlane {
            normal: WorldVec3 {
                x: 1.0,
                y: 0.0,
                z: 0.0,
            },
            distance: -500_000.25,
        }]);
        let uniform = FrameUniform::prepare(
            identity(),
            WorldVec3 {
                x: 500_000.0,
                y: 5_400_000.0,
                z: 100.0,
            },
            &[&volume],
            [16, 16],
        )
        .expect("valid frame");

        assert!((uniform.clip_planes[0][3] + 0.25).abs() < f32::EPSILON);
    }

    #[test]
    fn overflowing_portable_clip_budget_is_rejected_not_truncated() {
        let volume = clip_volume(vec![
            ClipPlane {
                normal: WorldVec3 {
                    x: 0.0,
                    y: 0.0,
                    z: 1.0,
                },
                distance: 0.0,
            };
            25
        ]);

        assert!(matches!(
            FrameUniform::prepare(identity(), zero(), &[&volume], [16, 16]),
            Err(GpuFrameError::TooManyClipPlanes)
        ));
    }

    #[test]
    #[allow(clippy::cast_precision_loss)]
    fn render_style_resolves_height_and_datum_relative_to_batch_origin() {
        let colors = (0..20)
            .map(|index| [index as f32 / 19.0, 0.25, 1.0, 1.0])
            .collect();
        let style = RenderStyle {
            base_color: [0.8, 0.9, 1.0, 1.0],
            opacity: 0.5,
            vertical_exaggeration: 2.0,
            color_mode: ColorMode::Height(HeightGradient {
                minimum: 100.0,
                maximum: 200.0,
                colors,
            }),
            ..RenderStyle::default()
        };
        let resolved = super::GpuPresentationStyle::from_render_style(
            &style,
            WorldVec3 {
                x: 1_000_000.0,
                y: 2_000_000.0,
                z: 100.0,
            },
            150.0,
        )
        .expect("style")
        .with_hatch(
            super::GpuHatchPattern::new(
                WorldVec3 {
                    x: 1_000_000.0,
                    y: 2_000_000.0,
                    z: 150.0,
                },
                WorldVec3 {
                    x: 1.0,
                    y: 1.0,
                    z: 0.0,
                },
                0.25,
                0.02,
                [0.0, 0.0, 0.0, 1.0],
                WorldVec3 {
                    x: 1_000_000.0,
                    y: 2_000_000.0,
                    z: 100.0,
                },
            )
            .expect("hatch"),
        );

        assert_eq!(resolved.gradient_count, 20);
        assert!((resolved.height_minimum_relative - 0.0).abs() < f32::EPSILON);
        assert!((resolved.height_maximum_relative - 100.0).abs() < f32::EPSILON);
        assert!((resolved.exaggeration_datum_relative - 50.0).abs() < f32::EPSILON);
        assert!((resolved.hatch_origin[2] - 50.0).abs() < f32::EPSILON);
        assert!((resolved.hatch_spacing - 0.25).abs() < f32::EPSILON);
    }

    #[test]
    fn point_classification_style_resolves_default_and_custom_indexed_palettes() {
        let default_style = RenderStyle {
            color_mode: ColorMode::PointClassification { colors: Vec::new() },
            ..RenderStyle::default()
        };
        let default = super::GpuPresentationStyle::from_render_style(&default_style, zero(), 0.0)
            .expect("default classification palette");
        assert_eq!(default.color_mode, 4);
        assert_eq!(default.gradient_count, 19);
        assert_eq!(default.gradient_colors[2], [0.55, 0.32, 0.15, 1.0]);

        let custom_colors = vec![[0.0, 0.0, 0.0, 1.0], [0.2, 0.4, 0.6, 0.8]];
        let custom_style = RenderStyle {
            color_mode: ColorMode::PointClassification {
                colors: custom_colors.clone(),
            },
            ..RenderStyle::default()
        };
        let custom = super::GpuPresentationStyle::from_render_style(&custom_style, zero(), 0.0)
            .expect("custom classification palette");
        assert_eq!(custom.gradient_count, 2);
        assert_eq!(&custom.gradient_colors[..2], custom_colors.as_slice());

        let oversized = RenderStyle {
            color_mode: ColorMode::PointClassification {
                colors: vec![[1.0; 4]; super::MAX_GPU_GRADIENT_COLORS + 1],
            },
            ..RenderStyle::default()
        };
        assert!(super::GpuPresentationStyle::from_render_style(&oversized, zero(), 0.0).is_err());
    }

    #[test]
    fn fill_visibility_is_an_explicit_reversible_uniform_state() {
        let visible = super::GpuPresentationStyle::default();
        assert!(visible.fill_visible());
        let hidden = visible.with_fill_visible(false);
        assert!(!hidden.fill_visible());
        assert!(hidden.with_fill_visible(true).fill_visible());
    }

    #[test]
    fn stroke_style_and_line_type_resolve_without_geometry_state() {
        let style = RenderStyle {
            stroke: crate::StrokeStyle {
                mode: crate::StrokeMode::LineType {
                    resource: line_type_ref("survey-dash"),
                },
                color: crate::StrokeColor::Uniform {
                    color: [0.9, 0.2, 0.1, 1.0],
                },
                width: crate::StrokeWidth::Screen { pixels: 7.0 },
                cap: crate::StrokeCap::Round,
                join: crate::StrokeJoin::Bevel,
                miter_limit: 3.0,
            },
            ..RenderStyle::default()
        };
        let resolved = super::GpuPresentationStyle::from_render_style(&style, zero(), 0.0)
            .expect("stroke style")
            .with_line_type(
                &super::GpuLineTypePattern::new(&[2.4, 0.8, 0.25, 0.8], -0.15).expect("line type"),
            );
        assert!(resolved.stroke_visible());
        assert_eq!(resolved.stroke_color_mode, 1);
        assert_eq!(resolved.stroke_width_override, 7.0);
        assert_eq!(resolved.stroke_cap, 2);
        assert_eq!(resolved.stroke_join, 1);
        assert_eq!(resolved.line_type_count, 4);
        assert!(resolved.line_type_phase >= 0.0);
        assert!(super::GpuLineTypePattern::new(&[1.0, 0.0], 0.0).is_err());
        assert!(super::GpuLineTypePattern::new(&[1.0], 0.0).is_err());
    }

    #[test]
    fn canonical_line_type_keeps_explicit_kinds_dots_and_large_patterns() {
        use himmelcad_core::canonical_resources::{LineTypeElement, LineTypePattern};

        let mut elements = vec![
            LineTypeElement::Gap { length: 1.0 },
            LineTypeElement::Dot,
            LineTypeElement::Dash { length: 0.5 },
            LineTypeElement::Dash { length: 0.25 },
        ];
        for index in 0_usize..64 {
            elements.push(if index.is_multiple_of(3) {
                LineTypeElement::Gap { length: 0.125 }
            } else {
                LineTypeElement::Dash { length: 0.125 }
            });
        }
        let pattern =
            super::GpuLineTypePattern::from_canonical(&LineTypePattern::Repeating { elements })
                .expect("arbitrary canonical line type");
        assert_eq!(pattern.element_count, 68);
        assert_eq!(pattern.advance_count, 67);
        assert_eq!(pattern.dot_count, 1);
        assert_eq!(pattern.texels[0][1], 0.0, "first element remains a gap");
        assert_eq!(pattern.texels[1][1], 1.0);
        assert_eq!(
            pattern.texels[2][1], 1.0,
            "adjacent dashes are not alternated"
        );
        assert_eq!(pattern.texels[67], [1.0, 2.0, 0.0, 0.0]);
    }

    #[test]
    fn canonical_line_type_fails_when_f64_boundaries_collapse_in_gpu_precision() {
        use himmelcad_core::canonical_resources::{LineTypeElement, LineTypePattern};

        let pattern = LineTypePattern::Repeating {
            elements: vec![
                LineTypeElement::Dash { length: 1.0e20 },
                LineTypeElement::Gap { length: 1.0 },
            ],
        };
        assert_eq!(
            super::GpuLineTypePattern::from_canonical(&pattern),
            Err(super::GpuFrameError::InvalidStyle)
        );
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[tokio::test]
    async fn presentation_texture_rebind_retains_source_and_fork_state() {
        let _native_test_guard = crate::test_sync::native_gpu_or_transcoder();
        let Some((device, queue)) = smoke_device().await else {
            return;
        };
        let renderer = GpuSharedRenderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
        let vertices = [
            mesh_vertex([-1.0, -1.0, 0.0]),
            mesh_vertex([1.0, -1.0, 0.0]),
            mesh_vertex([0.0, 1.0, 0.0]),
        ];
        let source_style = super::GpuPresentationStyle::default();
        let source_material = renderer
            .create_styled_material(
                &device,
                &queue,
                "presentation-source",
                GpuTextureData {
                    width: 1,
                    height: 1,
                    rgba8: &[255, 255, 255, 255],
                },
                GpuAlphaMode::Opaque,
                source_style,
            )
            .expect("source material");
        let override_texture = renderer
            .create_texture_resource(
                &device,
                &queue,
                "presentation-override",
                GpuTextureData {
                    width: 1,
                    height: 1,
                    rgba8: &[255, 0, 0, 255],
                },
            )
            .expect("override texture");
        let mut batch = GpuDrawBatch::new_indexed_mesh_with_queue(
            &device,
            &queue,
            "presentation-triangle",
            1,
            0,
            &vertices,
            &[0, 1, 2],
            false,
        )
        .expect("triangle")
        .with_material(source_material);
        assert!(matches!(
            batch.rebind_presentation_texture(&device, &renderer, Some(&override_texture)),
            Err(GpuFrameError::MissingTextureCoordinates)
        ));
        batch = batch.with_declared_texture_coordinates(true);
        let source_key = batch.source_texture_allocation_key().expect("source key");
        batch
            .rebind_presentation_texture(&device, &renderer, Some(&override_texture))
            .expect("override binding");
        assert_eq!(batch.source_texture_allocation_key(), Some(source_key));
        assert_eq!(
            batch.active_texture_allocation_key(),
            Some(override_texture.allocation_key())
        );
        let hidden = source_style.with_fill_visible(false);
        batch
            .update_material_style(&queue, &hidden)
            .expect("hidden presentation");
        let fork = batch
            .fork_with_style_and_queue(
                &device,
                &queue,
                &renderer,
                "presentation-fork",
                hidden,
                false,
            )
            .expect("presentation fork");
        assert_eq!(fork.source_texture_allocation_key(), Some(source_key));
        assert_eq!(
            fork.active_texture_allocation_key(),
            Some(override_texture.allocation_key())
        );
        assert_eq!(fork.presentation_fill_visible(), Some(false));
        batch
            .rebind_presentation_texture(&device, &renderer, None)
            .expect("source restore");
        assert_eq!(batch.active_texture_allocation_key(), Some(source_key));
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn real_wgpu_device_validates_mixed_color_depth_clip_and_pick_passes() {
        let _native_test_guard = crate::test_sync::native_gpu_or_transcoder();
        let Some((device, queue)) = smoke_device().await else {
            return;
        };
        let error_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let color = smoke_color_target(&device);
        let color_view = color.create_view(&wgpu::TextureViewDescriptor::default());
        let renderer = GpuSharedRenderer::new_with_transparency(
            &device,
            &queue,
            wgpu::TextureFormat::Rgba8Unorm,
            TransparencyStrategy::WeightedBlended,
        );
        let targets = renderer.create_frame_targets(&device, 16, 16);
        let clip = clip_volume(vec![ClipPlane {
            normal: WorldVec3 {
                x: 1.0,
                y: 0.0,
                z: 0.0,
            },
            distance: 0.0,
        }]);
        renderer
            .update_frame(&queue, identity(), zero(), &[&clip], [16, 16])
            .expect("frame");
        let [triangle, line, point, splat, screen_text] = smoke_batches(&device, &queue);
        let mut triangle = triangle.with_material(
            renderer
                .create_material(
                    &device,
                    &queue,
                    "himmelcad-render-smoke-material",
                    super::GpuTextureData {
                        width: 1,
                        height: 1,
                        rgba8: &[255, 64, 32, 255],
                    },
                    super::GpuAlphaMode::Opaque,
                )
                .expect("material"),
        );
        let ecef_origin = WorldVec3 {
            x: 6_378_137.0,
            y: 4_812_000.0,
            z: 512.0,
        };
        triangle
            .set_world_origins(&queue, ecef_origin, ecef_origin)
            .expect("stable batch origin");
        assert!(!triangle
            .ensure_frame_origin(&queue, ecef_origin)
            .expect("unchanged origin"));
        let shifted_origin = WorldVec3 {
            x: ecef_origin.x + 1_024.0,
            y: ecef_origin.y,
            z: ecef_origin.z,
        };
        assert!(triangle
            .ensure_frame_origin(&queue, shifted_origin)
            .expect("camera-relative origin delta"));
        assert!(!triangle
            .ensure_frame_origin(&queue, shifted_origin)
            .expect("already shifted origin"));
        assert!(triangle
            .ensure_frame_origin(&queue, ecef_origin)
            .expect("restore frame origin"));
        let line_style = super::GpuPresentationStyle::from_render_style(
            &RenderStyle {
                vertical_exaggeration: 2.0,
                ..RenderStyle::default()
            },
            zero(),
            0.0,
        )
        .expect("line style");
        let mut line = line.with_material(
            renderer
                .create_styled_material(
                    &device,
                    &queue,
                    "himmelcad-render-smoke-line-style",
                    super::GpuTextureData {
                        width: 1,
                        height: 1,
                        rgba8: &[255; 4],
                    },
                    super::GpuAlphaMode::Opaque,
                    line_style,
                )
                .expect("styled line material"),
        );
        let updated_style = super::GpuPresentationStyle::from_render_style(
            &RenderStyle {
                opacity: 0.75,
                vertical_exaggeration: 2.0,
                ..RenderStyle::default()
            },
            zero(),
            0.0,
        )
        .expect("live style");
        line.update_material_style(&queue, &updated_style)
            .expect("live material update");
        assert!(line.transparent);
        let ghost_style = super::GpuPresentationStyle::from_render_style(
            &RenderStyle {
                opacity: 0.5,
                ..RenderStyle::default()
            },
            zero(),
            0.0,
        )
        .expect("ghost style");
        let mut ghost = line
            .fork_with_style_and_queue(&device, &queue, &renderer, "move-ghost", ghost_style, false)
            .expect("buffer-sharing ghost");
        ghost
            .update_interaction_translation(&queue, [0.25, 0.0, 0.0])
            .expect("live ghost translation");
        assert!(ghost.transparent);
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("himmelcad-render-smoke-encoder"),
        });
        renderer.encode(
            &mut encoder,
            &color_view,
            &targets,
            &[&triangle, &line, &ghost, &point, &splat, &screen_text],
            wgpu::Color::BLACK,
            true,
        );
        let clipped_readback = targets
            .copy_pick_pixel(&device, &mut encoder, 6, 10)
            .expect("clipped readback copy");
        let visible_readback = targets
            .copy_pick_pixel(&device, &mut encoder, 9, 10)
            .expect("visible readback copy");
        let wide_line_readback = targets
            .copy_pick_pixel(&device, &mut encoder, 8, 2)
            .expect("wide line readback copy");
        let wide_line_hit_readback = targets
            .copy_hit_pixel(&device, &mut encoder, 8, 2)
            .expect("wide line hit readback copy");
        let point_sprite_readback = targets
            .copy_pick_pixel(&device, &mut encoder, 14, 14)
            .expect("point sprite readback copy");
        let point_hit_readback = targets
            .copy_hit_pixel(&device, &mut encoder, 14, 14)
            .expect("point hit readback copy");
        let point_neighborhood_readback = targets
            .copy_hit_neighborhood(&device, &mut encoder, 14, 14, 2)
            .expect("point neighborhood readback copy");
        let splat_readback = targets
            .copy_pick_pixel(&device, &mut encoder, 14, 8)
            .expect("splat readback copy");
        let text_readback = targets
            .copy_pick_pixel(&device, &mut encoder, 12, 4)
            .expect("screen text readback copy");
        queue.submit([encoder.finish()]);

        let clipped_receiver = map_pick(clipped_readback);
        let visible_receiver = map_pick(visible_readback);
        let line_receiver = map_pick(wide_line_readback);
        let line_hit_receiver = map_hit(wide_line_hit_readback);
        let point_receiver = map_pick(point_sprite_readback);
        let hit_receiver = map_hit(point_hit_readback);
        let neighborhood_receiver = point_neighborhood_readback;
        let splat_receiver = map_pick(splat_readback);
        let text_receiver = map_pick(text_readback);
        device
            .poll(wgpu::PollType::wait_indefinitely())
            .expect("device poll");
        let clipped_token = receive_pick(clipped_receiver).await;
        let visible_token = receive_pick(visible_receiver).await;
        let line_token = receive_pick(line_receiver).await;
        let line_hit = receive_hit(line_hit_receiver).await;
        let point_token = receive_pick(point_receiver).await;
        let point_hit = receive_hit(hit_receiver).await;
        let point_neighborhood = receive_hit_neighborhood(neighborhood_receiver).await;
        let splat_token = receive_pick(splat_receiver).await;
        let text_token = receive_pick(text_receiver).await;

        if let Some(error) = error_scope.pop().await {
            panic!("wgpu validation failed: {error}");
        }
        assert_pick(clipped_token, 0);
        assert_pick(visible_token, 1);
        assert_pick(line_token, 2);
        assert!((line_hit.reverse_z_depth - 1.0).abs() < f32::EPSILON);
        assert_pick(point_token, 3);
        assert_pick(point_hit.token, 3);
        assert!((point_hit.reverse_z_depth - 0.5).abs() < f32::EPSILON);
        assert_eq!(point_neighborhood.len(), 16);
        assert_eq!(point_neighborhood[0].pixel, [14, 14]);
        assert!(point_neighborhood
            .iter()
            .any(|hit| hit.sample.token.proxy_slot == 3));
        assert_pick(splat_token, 4);
        assert_pick(text_token, 5);
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[tokio::test]
    async fn large_stream_uploads_use_unmapped_copy_dst_buffers() {
        const CHROME_REPRO_POINT_COUNT: usize = 31_668;

        let _native_test_guard = crate::test_sync::native_gpu_or_transcoder();
        let Some((device, queue)) = smoke_device().await else {
            return;
        };
        let error_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);

        let expected_point_bytes = u64::try_from(CHROME_REPRO_POINT_COUNT)
            .expect("fixture point count fits u64")
            * GPU_POINT_VERTEX_STRIDE_BYTES;
        let positions = vec![[0.0, 0.0, 0.0]; CHROME_REPRO_POINT_COUNT];
        let colors = vec![[255, 255, 255, 255]; CHROME_REPRO_POINT_COUNT];
        let points = GpuDrawBatch::new_points_with_queue(
            &device,
            &queue,
            "himmelcad-large-browser-point-upload",
            1,
            &positions,
            &colors,
        )
        .expect("queue-backed point upload");
        assert_eq!(points.vertex_buffer.size(), expected_point_bytes);
        assert!(points
            .vertex_buffer
            .usage()
            .contains(wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST));

        let mesh_vertices = (0..CHROME_REPRO_POINT_COUNT)
            .map(|index| GpuMeshVertexInput {
                position: [
                    f32::from(u16::try_from(index).expect("fixture index fits u16")),
                    0.0,
                    0.0,
                ],
                normal: [0.0, 0.0, 1.0],
                tex_coord: [0.0, 0.0],
                color: [1.0; 4],
            })
            .collect::<Vec<_>>();
        let mesh_indices = (0..u32::try_from(CHROME_REPRO_POINT_COUNT).expect("count fits u32"))
            .collect::<Vec<_>>();
        let geometry = GpuIndexedMeshGeometry::new_with_queue(
            &device,
            &queue,
            "himmelcad-large-browser-mesh-upload",
            &mesh_vertices,
            &mesh_indices,
        )
        .expect("queue-backed indexed mesh upload");
        let expected_resident_bytes = u64::try_from(CHROME_REPRO_POINT_COUNT)
            .expect("count fits u64")
            .saturating_mul(
                u64::try_from(std::mem::size_of::<super::GpuMeshVertex>())
                    .expect("stride fits u64")
                    .saturating_mul(2)
                    .saturating_add(4),
            );
        assert_eq!(geometry.resident_bytes(), expected_resident_bytes);
        assert!(geometry
            .0
            .vertex_buffer
            .usage()
            .contains(wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST));
        assert!(geometry
            .0
            .pick_vertex_buffer
            .usage()
            .contains(wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST));
        assert!(geometry
            .0
            .index_buffer
            .usage()
            .contains(wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST));

        let splats = vec![
            GpuSplatVertex {
                position: [0.0, 0.0, 0.0],
                color: [255; 4],
                scale: [1.0; 3],
                rotation: [0.0, 0.0, 0.0, 1.0],
                proxy_slot: 2,
                primitive_slot: 0,
            };
            20_000
        ];
        let splats = GpuDrawBatch::new_gaussian_splats_for_transparency_with_queue(
            &device,
            &queue,
            "himmelcad-large-browser-splat-upload",
            &splats,
            TransparencyStrategy::SortedAlpha,
        )
        .expect("queue-backed splat upload");
        assert!(splats
            .vertex_buffer
            .usage()
            .contains(wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST));

        queue.submit([]);
        device
            .poll(wgpu::PollType::wait_indefinitely())
            .expect("large queue uploads complete");
        if let Some(error) = error_scope.pop().await {
            panic!("large queue upload validation failed: {error}");
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[tokio::test]
    async fn two_tiles_share_one_immutable_instanced_mesh_allocation() {
        let _native_test_guard = crate::test_sync::native_gpu_or_transcoder();
        let Some((device, queue)) = smoke_device().await else {
            return;
        };
        let vertices = [
            mesh_vertex([-1.0, -1.0, 0.0]),
            mesh_vertex([1.0, -1.0, 0.0]),
            mesh_vertex([0.0, 1.0, 0.0]),
        ];
        let geometry = GpuIndexedMeshGeometry::new_with_queue(
            &device,
            &queue,
            "shared-i3dm-model",
            &vertices,
            &[0, 1, 2],
        )
        .expect("shared indexed geometry");
        let instance = |proxy_slot, x| {
            GpuMeshInstanceInput::new(
                [
                    [1.0, 0.0, 0.0, x],
                    [0.0, 1.0, 0.0, 0.0],
                    [0.0, 0.0, 1.0, 0.0],
                ],
                [
                    [1.0, 0.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0, 0.0],
                    [0.0, 0.0, 1.0, 0.0],
                ],
                proxy_slot,
                0,
            )
        };
        let first = GpuDrawBatch::new_instanced_shared_indexed_mesh_for_transparency_with_queue(
            &device,
            &queue,
            &geometry,
            &[instance(11, 0.0)],
            false,
            TransparencyStrategy::WeightedBlended,
        )
        .expect("first tile batch");
        let second = GpuDrawBatch::new_instanced_shared_indexed_mesh_for_transparency_with_queue(
            &device,
            &queue,
            &geometry,
            &[instance(12, 100.0)],
            false,
            TransparencyStrategy::WeightedBlended,
        )
        .expect("second tile batch");
        let first_allocation = first
            .shared_mesh_geometry_allocation()
            .expect("first shared allocation");
        let second_allocation = second
            .shared_mesh_geometry_allocation()
            .expect("second shared allocation");

        assert_eq!(first_allocation, second_allocation);
        assert!(first_allocation.1 > 0);
        let globally_accounted = [first_allocation, second_allocation]
            .into_iter()
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(globally_accounted.len(), 1);
        assert_eq!(
            globally_accounted.values().copied().sum::<u64>(),
            geometry.resident_bytes()
        );
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[tokio::test]
    async fn line_type_gaps_match_color_and_pick_on_a_real_device() {
        let _native_test_guard = crate::test_sync::native_gpu_or_transcoder();
        let Some((device, queue)) = smoke_device().await else {
            return;
        };
        let renderer = GpuSharedRenderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
        let targets = renderer.create_frame_targets(&device, 16, 16);
        renderer
            .update_frame(&queue, identity(), zero(), &[], [16, 16])
            .expect("line type frame");
        let curve = tessellate_curve(
            &CurveGeometry::LineSegment {
                start: Position {
                    x: -0.8,
                    y: 0.0,
                    z: Some(0.5),
                },
                end: Position {
                    x: 0.8,
                    y: 0.0,
                    z: Some(0.5),
                },
            },
            CurveTessellationOptions {
                chord_tolerance: 0.01,
                maximum_segments: 8,
                unresolved_height: UnresolvedHeightDisplay::Reject,
            },
        )
        .expect("line type curve");
        let pattern = super::GpuLineTypePattern::new(&[0.4, 0.4], 0.0).expect("dash");
        let line_type_resource = renderer
            .create_line_type_resource(&device, &queue, "line-type-dash", pattern.clone())
            .expect("line type texture");
        let style = super::GpuPresentationStyle::from_render_style(
            &RenderStyle {
                stroke: crate::StrokeStyle {
                    mode: crate::StrokeMode::LineType {
                        resource: line_type_ref("dash"),
                    },
                    color: crate::StrokeColor::Uniform {
                        color: [1.0, 0.2, 0.1, 1.0],
                    },
                    width: crate::StrokeWidth::Screen { pixels: 4.0 },
                    cap: crate::StrokeCap::Butt,
                    join: crate::StrokeJoin::Miter,
                    miter_limit: 4.0,
                },
                ..RenderStyle::default()
            },
            zero(),
            0.0,
        )
        .expect("stroke style")
        .with_line_type(&pattern);
        let mut line = build_cad_curve_batch_with_width(
            &device,
            &queue,
            "line-type-parity",
            9,
            FloatingOrigin::from_selected(1.0, zero()).expect("origin"),
            [1.0; 4],
            2.0,
            &curve,
        )
        .expect("line batch")
        .with_material(
            renderer
                .create_styled_material(
                    &device,
                    &queue,
                    "line-type-material",
                    GpuTextureData {
                        width: 1,
                        height: 1,
                        rgba8: &[255; 4],
                    },
                    GpuAlphaMode::Opaque,
                    style,
                )
                .expect("line material"),
        );
        line.set_world_origins(&queue, zero(), zero())
            .expect("line origins");
        line.rebind_line_type_resource(&device, &renderer, Some(&line_type_resource))
            .expect("line type binding");
        let color = smoke_color_target(&device);
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("line-type-parity-encoder"),
        });
        renderer.encode(
            &mut encoder,
            &color.create_view(&wgpu::TextureViewDescriptor::default()),
            &targets,
            &[&line],
            wgpu::Color::BLACK,
            true,
        );
        let samples = [3_u32, 6, 10, 13];
        let pick_readbacks = samples.map(|x| {
            targets
                .copy_pick_pixel(&device, &mut encoder, x, 8)
                .expect("pick copy")
        });
        let color_readbacks =
            samples.map(|x| copy_color_pixel(&device, &mut encoder, &color, x, 8));
        queue.submit([encoder.finish()]);
        let pick_receivers = pick_readbacks.map(map_pick);
        let color_receivers = color_readbacks.each_ref().map(|buffer| map_color(buffer));
        device
            .poll(wgpu::PollType::wait_indefinitely())
            .expect("line type device poll");
        for (index, receiver) in pick_receivers.into_iter().enumerate() {
            let token = receive_pick(receiver).await;
            assert_eq!(token.proxy_slot != 0, index.is_multiple_of(2));
        }
        for (index, receiver) in color_receivers.into_iter().enumerate() {
            let pixel = receiver.await.expect("line type color pixel");
            assert_eq!(pixel != [0, 0, 0, 255], index.is_multiple_of(2));
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[tokio::test]
    async fn weighted_oit_is_draw_order_independent_on_a_real_device() {
        let _native_test_guard = crate::test_sync::native_gpu_or_transcoder();
        let Some((device, queue)) = smoke_device().await else {
            return;
        };
        let error_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let renderer = GpuSharedRenderer::new_with_transparency(
            &device,
            &queue,
            wgpu::TextureFormat::Rgba8Unorm,
            TransparencyStrategy::WeightedBlended,
        );
        let targets = renderer.create_frame_targets(&device, 16, 16);
        renderer
            .update_frame(&queue, identity(), zero(), &[], [16, 16])
            .expect("OIT frame");
        let red = transparent_triangle(
            &device,
            &queue,
            "himmelcad-oit-near-red",
            [1.0, 0.0, 0.0, 0.5],
            0.9,
            1,
        );
        let blue = transparent_triangle(
            &device,
            &queue,
            "himmelcad-oit-far-blue",
            [0.0, 0.0, 1.0, 0.5],
            0.1,
            2,
        );
        let first = smoke_color_target(&device);
        let second = smoke_color_target(&device);
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("himmelcad-oit-order-test"),
        });
        renderer.encode(
            &mut encoder,
            &first.create_view(&wgpu::TextureViewDescriptor::default()),
            &targets,
            &[&red, &blue],
            wgpu::Color::BLACK,
            false,
        );
        let first_readback = copy_color_pixel(&device, &mut encoder, &first, 8, 8);
        renderer.encode(
            &mut encoder,
            &second.create_view(&wgpu::TextureViewDescriptor::default()),
            &targets,
            &[&blue, &red],
            wgpu::Color::BLACK,
            false,
        );
        let second_readback = copy_color_pixel(&device, &mut encoder, &second, 8, 8);
        queue.submit([encoder.finish()]);
        let first_receiver = map_color(&first_readback);
        let second_receiver = map_color(&second_readback);
        device
            .poll(wgpu::PollType::wait_indefinitely())
            .expect("OIT device poll");
        let first_color = first_receiver.await.expect("first OIT pixel");
        let second_color = second_receiver.await.expect("second OIT pixel");
        if let Some(error) = error_scope.pop().await {
            panic!("wgpu OIT validation failed: {error}");
        }
        assert_eq!(first_color, second_color);
        assert!(first_color[0] > 0);
        assert!(first_color[2] > 0);
        assert!(
            first_color[0] > first_color[2],
            "reverse-Z OIT must weight near red above far blue: {first_color:?}"
        );
        assert!(first_color[3] > 0);
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn map_pick(
        readback: super::GpuPickReadback,
    ) -> tokio::sync::oneshot::Receiver<Result<PickToken, super::GpuPickReadbackError>> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        readback.map(move |result| {
            let _ignored = sender.send(result);
        });
        receiver
    }

    #[cfg(not(target_arch = "wasm32"))]
    async fn receive_pick(
        receiver: tokio::sync::oneshot::Receiver<Result<PickToken, super::GpuPickReadbackError>>,
    ) -> PickToken {
        receiver
            .await
            .expect("pick readback callback")
            .expect("mapped pick token")
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn map_hit(
        readback: super::GpuHitReadback,
    ) -> tokio::sync::oneshot::Receiver<Result<super::GpuHitSample, super::GpuPickReadbackError>>
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        readback.map(move |result| {
            let _ignored = sender.send(result);
        });
        receiver
    }

    #[cfg(not(target_arch = "wasm32"))]
    async fn receive_hit(
        receiver: tokio::sync::oneshot::Receiver<
            Result<super::GpuHitSample, super::GpuPickReadbackError>,
        >,
    ) -> super::GpuHitSample {
        receiver
            .await
            .expect("hit readback callback")
            .expect("mapped hit sample")
    }

    #[cfg(not(target_arch = "wasm32"))]
    async fn receive_hit_neighborhood(
        readback: super::GpuHitNeighborhoodReadback,
    ) -> Vec<super::GpuHitPixel> {
        readback.resolve().await.expect("mapped hit neighborhood")
    }

    fn assert_pick(token: PickToken, proxy_slot: u32) {
        assert_eq!(
            token,
            PickToken {
                proxy_slot,
                primitive_slot: 0,
            }
        );
    }

    #[cfg(not(target_arch = "wasm32"))]
    async fn smoke_device() -> Option<(wgpu::Device, wgpu::Queue)> {
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = wgpu::Backends::PRIMARY;
        let instance = wgpu::Instance::new(descriptor);
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
            .ok()?;
        Some(
            adapter
                .request_device(&wgpu::DeviceDescriptor {
                    label: Some("himmelcad-render-smoke-device"),
                    required_features: wgpu::Features::empty(),
                    required_limits: adapter.limits(),
                    ..wgpu::DeviceDescriptor::default()
                })
                .await
                .expect("device"),
        )
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn smoke_color_target(device: &wgpu::Device) -> wgpu::Texture {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some("himmelcad-render-smoke-color"),
            size: wgpu::Extent3d {
                width: 16,
                height: 16,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        })
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn transparent_triangle(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        label: &str,
        color: [f32; 4],
        reverse_z: f32,
        proxy_slot: u32,
    ) -> GpuDrawBatch {
        GpuDrawBatch::new(
            device,
            queue,
            label,
            GpuPrimitive::Triangles,
            true,
            &[
                GpuVertex {
                    position: [-1.0, -1.0, reverse_z],
                    color,
                    proxy_slot,
                    primitive_slot: 0,
                },
                GpuVertex {
                    position: [1.0, -1.0, reverse_z],
                    color,
                    proxy_slot,
                    primitive_slot: 0,
                },
                GpuVertex {
                    position: [0.0, 1.0, reverse_z],
                    color,
                    proxy_slot,
                    primitive_slot: 0,
                },
            ],
        )
        .expect("transparent triangle")
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn copy_color_pixel(
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        texture: &wgpu::Texture,
        x: u32,
        y: u32,
    ) -> wgpu::Buffer {
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("himmelcad-oit-color-readback"),
            size: 4,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d { x, y, z: 0 },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout::default(),
            },
            wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
        );
        buffer
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn map_color(buffer: &wgpu::Buffer) -> tokio::sync::oneshot::Receiver<[u8; 4]> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let callback_buffer = buffer.clone();
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                result.expect("OIT color mapping");
                let mapped = callback_buffer
                    .slice(..)
                    .get_mapped_range()
                    .expect("OIT mapped range");
                let color = [mapped[0], mapped[1], mapped[2], mapped[3]];
                drop(mapped);
                callback_buffer.unmap();
                let _ignored = sender.send(color);
            });
        receiver
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn smoke_batches(device: &wgpu::Device, queue: &wgpu::Queue) -> [GpuDrawBatch; 5] {
        let triangle = GpuDrawBatch::new_indexed_mesh_with_queue(
            device,
            queue,
            "himmelcad-render-smoke-triangle",
            1,
            0,
            &[
                mesh_vertex([-0.5, -0.5, 0.5]),
                mesh_vertex([0.5, -0.5, 0.5]),
                mesh_vertex([0.0, 0.5, 0.5]),
            ],
            &[0, 1, 2],
            false,
        )
        .expect("triangle batch");
        let authored_line = tessellate_curve(
            &CurveGeometry::LineSegment {
                start: Position {
                    x: -0.8,
                    y: 0.8,
                    z: Some(0.5),
                },
                end: Position {
                    x: 0.8,
                    y: 0.8,
                    z: Some(0.5),
                },
            },
            CurveTessellationOptions {
                chord_tolerance: 0.001,
                maximum_segments: 16,
                unresolved_height: UnresolvedHeightDisplay::Reject,
            },
        )
        .expect("authored CAD line tessellation");
        let line = build_cad_curve_batch_with_width(
            device,
            queue,
            "himmelcad-render-smoke-cad-line",
            2,
            FloatingOrigin::new(1.0, zero()).expect("floating origin"),
            [1.0, 0.5, 0.25, 1.0],
            4.0,
            &authored_line,
        )
        .expect("line batch");
        let point = GpuDrawBatch::new_points_with_queue(
            device,
            queue,
            "himmelcad-render-smoke-point",
            3,
            &[[0.8, -0.8, 0.5]],
            &[[255, 128, 64, 255]],
        )
        .expect("point batch");
        let splat = GpuDrawBatch::new_gaussian_splats_for_transparency_with_queue(
            device,
            queue,
            "himmelcad-render-smoke-splat",
            &[GpuSplatVertex {
                position: [0.75, 0.0, 0.5],
                color: [64, 192, 255, 224],
                scale: [0.08, 0.04, 0.02],
                rotation: [0.0, 0.0, 0.0, 1.0],
                proxy_slot: 4,
                primitive_slot: 0,
            }],
            TransparencyStrategy::SortedAlpha,
        )
        .expect("splat batch");
        let screen_text = screen_text_batch(device, queue);
        [triangle, line, point, splat, screen_text]
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn screen_text_batch(device: &wgpu::Device, queue: &wgpu::Queue) -> GpuDrawBatch {
        let corners = [
            ([-2.0, -2.0], [0.0, 1.0]),
            ([2.0, -2.0], [1.0, 1.0]),
            ([2.0, 2.0], [1.0, 0.0]),
            ([-2.0, 2.0], [0.0, 0.0]),
        ];
        let vertices = [0, 1, 2, 0, 2, 3].map(|corner| GpuScreenTextVertex {
            anchor: [0.5, 0.5, 0.75],
            pixel_offset: corners[corner].0,
            tex_coord: corners[corner].1,
            color: [1.0; 4],
            proxy_slot: 5,
            primitive_slot: 0,
        });
        GpuDrawBatch::new_screen_text_with_queue(
            device,
            queue,
            "himmelcad-render-smoke-screen-text",
            &vertices,
            true,
        )
        .expect("screen text batch")
    }

    fn clip_volume(planes: Vec<ClipPlane>) -> ClipVolume {
        ClipVolume {
            id: ClipVolumeId("clip".to_owned()),
            planes,
            operation: ClipOperation::KeepInside,
            preview_cap: false,
            section_fill_resource: None,
            section_material_hatches: std::collections::BTreeMap::new(),
            enabled: true,
        }
    }

    fn identity() -> [[f32; 4]; 4] {
        [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ]
    }

    fn zero() -> WorldVec3 {
        WorldVec3 {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        }
    }

    fn mesh_vertex(position: [f32; 3]) -> GpuMeshVertexInput {
        GpuMeshVertexInput {
            position,
            normal: [0.0, 0.0, 1.0],
            tex_coord: [0.0; 2],
            color: [1.0, 0.5, 0.25, 1.0],
        }
    }
}
