//! Font-atlas text layout for world-space and pixel-stable annotations.

use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{Display, Formatter};

use glam::DVec3;
use serde::{Deserialize, Serialize};

use crate::{
    FloatingOrigin, GpuAlphaMode, GpuDrawBatch, GpuFrameError, GpuMeshVertexInput,
    GpuPresentationStyle, GpuScreenTextVertex, GpuSharedRenderer, GpuTextureData,
    GpuTextureResource, WorldVec3,
};

/// One atlas glyph expressed in font-em coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlyphMetrics {
    /// Inclusive/exclusive top-left atlas rectangle in pixels.
    pub atlas_min: [u32; 2],
    /// Inclusive/exclusive bottom-right atlas rectangle in pixels.
    pub atlas_max: [u32; 2],
    /// Lower-left glyph quad in em units relative to the baseline pen.
    pub plane_min: [f32; 2],
    /// Upper-right glyph quad in em units relative to the baseline pen.
    pub plane_max: [f32; 2],
    /// Horizontal pen advance in em units.
    pub advance: f32,
}

/// Immutable regular-alpha glyph atlas and metrics table.
#[derive(Debug, Clone, PartialEq)]
pub struct GlyphAtlas {
    /// Atlas pixel width.
    pub width: u32,
    /// Atlas pixel height.
    pub height: u32,
    /// Tightly packed sRGB RGBA8 pixels; alpha contains glyph coverage.
    pub rgba8: Vec<u8>,
    /// Baseline-to-baseline distance in em units.
    pub line_height: f32,
    /// Unicode scalar to glyph metrics.
    pub glyphs: BTreeMap<char, GlyphMetrics>,
    /// Optional fallback glyph used for absent characters.
    pub fallback: Option<char>,
}

/// Horizontal alignment around the authored anchor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextAlignment {
    /// First pen lies on the anchor.
    Left,
    /// Each line is centered around the anchor.
    Center,
    /// Each line ends on the anchor.
    Right,
}

/// Whether glyph offsets use project units or physical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TextLayoutSpace {
    /// Glyphs lie on an explicit project-space basis.
    World {
        /// Increasing text X direction.
        right: WorldVec3,
        /// Increasing text Y direction.
        up: WorldVec3,
    },
    /// Glyphs retain a physical-pixel height around a projected world anchor.
    Screen,
}

/// Complete deterministic layout request.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextLayoutOptions<'a> {
    /// UTF-8 source text; newline starts a new baseline.
    pub text: &'a str,
    /// Project-world anchor.
    pub anchor: WorldVec3,
    /// Em height in project units or physical pixels according to `space`.
    pub height: f64,
    /// Additional multiplier applied to atlas line height.
    pub line_spacing: f64,
    /// Horizontal line alignment.
    pub alignment: TextAlignment,
    /// World or pixel-stable placement.
    pub space: TextLayoutSpace,
    /// Linear RGBA glyph color.
    pub color: [f32; 4],
}

/// One laid-out glyph quad before backend upload.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LaidOutGlyph {
    /// Four XY offsets in counter-clockwise order.
    pub offsets: [[f64; 2]; 4],
    /// Four atlas UVs corresponding to `offsets`.
    pub texture_coordinates: [[f32; 2]; 4],
    /// Stable visible-glyph index.
    pub primitive_slot: u32,
}

/// Text layout retaining its placement and glyph quads.
#[derive(Debug, Clone, PartialEq)]
pub struct LaidOutText {
    /// Authored project anchor.
    pub anchor: WorldVec3,
    /// Placement convention.
    pub space: TextLayoutSpace,
    /// Linear glyph color.
    pub color: [f32; 4],
    /// Visible glyph quads.
    pub glyphs: Vec<LaidOutGlyph>,
}

/// GPU address and placement shared by every glyph in one text batch.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextBatchOptions {
    /// Non-zero render-proxy pick slot.
    pub proxy_slot: u32,
    /// Stable origin used by resident geometry buffers.
    pub floating_origin: FloatingOrigin,
}

/// Text atlas, layout or GPU conversion failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextError {
    /// Atlas dimensions, byte length or glyph rectangles are invalid.
    InvalidAtlas,
    /// Anchor, basis, sizing, color or glyph metric is invalid.
    InvalidLayout,
    /// Visible glyph count exceeds portable pick addressing.
    TooManyGlyphs,
    /// GPU resource validation failed.
    Gpu(GpuFrameError),
}

impl Display for TextError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidAtlas => "glyph atlas is invalid",
            Self::InvalidLayout => "text layout is invalid",
            Self::TooManyGlyphs => "text layout exceeds glyph pick addressing",
            Self::Gpu(error) => return Display::fmt(error, formatter),
        })
    }
}

impl Error for TextError {}

impl From<GpuFrameError> for TextError {
    fn from(error: GpuFrameError) -> Self {
        Self::Gpu(error)
    }
}

/// Validates and lays out UTF-8 text against an immutable glyph atlas.
pub fn layout_text(
    atlas: &GlyphAtlas,
    options: TextLayoutOptions<'_>,
) -> Result<LaidOutText, TextError> {
    validate_glyph_atlas(atlas)?;
    validate_options(&options)?;
    let lines = options.text.split('\n').collect::<Vec<_>>();
    let scale = options.height;
    let mut glyphs = Vec::new();
    for (line_index, line) in lines.iter().enumerate() {
        let width = line
            .chars()
            .filter_map(|character| metrics(atlas, character))
            .map(|glyph| f64::from(glyph.advance) * scale)
            .sum::<f64>();
        let mut pen_x = match options.alignment {
            TextAlignment::Left => 0.0,
            TextAlignment::Center => -width * 0.5,
            TextAlignment::Right => -width,
        };
        let line_index = u32::try_from(line_index).map_err(|_| TextError::TooManyGlyphs)?;
        let baseline_y =
            -f64::from(line_index) * f64::from(atlas.line_height) * scale * options.line_spacing;
        for character in line.chars() {
            let Some(metric) = metrics(atlas, character) else {
                continue;
            };
            if metric.atlas_min != metric.atlas_max {
                let primitive_slot =
                    u32::try_from(glyphs.len()).map_err(|_| TextError::TooManyGlyphs)?;
                glyphs.push(glyph_quad(
                    atlas,
                    metric,
                    pen_x,
                    baseline_y,
                    scale,
                    primitive_slot,
                ));
            }
            pen_x += f64::from(metric.advance) * scale;
        }
    }
    Ok(LaidOutText {
        anchor: options.anchor,
        space: options.space,
        color: options.color,
        glyphs,
    })
}

/// Uploads world- or screen-space text and its alpha atlas to the shared renderer.
pub fn build_text_batch(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &GpuSharedRenderer,
    label: &str,
    options: TextBatchOptions,
    atlas: &GlyphAtlas,
    layout: &LaidOutText,
) -> Result<GpuDrawBatch, TextError> {
    let texture = renderer.create_texture_resource(
        device,
        queue,
        &format!("{label}-atlas"),
        GpuTextureData {
            width: atlas.width,
            height: atlas.height,
            rgba8: &atlas.rgba8,
        },
    )?;
    build_text_batch_with_texture(
        device,
        queue,
        renderer,
        label,
        options,
        &texture,
        layout,
        GpuPresentationStyle::default(),
    )
}

/// Uploads only glyph geometry while reusing an immutable atlas texture and
/// retaining independent mutable style uniforms for the annotation entity.
#[allow(clippy::too_many_arguments)]
pub fn build_text_batch_with_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &GpuSharedRenderer,
    label: &str,
    options: TextBatchOptions,
    texture: &GpuTextureResource,
    layout: &LaidOutText,
    style: GpuPresentationStyle,
) -> Result<GpuDrawBatch, TextError> {
    if layout.glyphs.is_empty() {
        return Err(TextError::InvalidLayout);
    }
    let batch = match layout.space {
        TextLayoutSpace::World { right, up } => build_world_batch(
            device,
            queue,
            label,
            options.proxy_slot,
            options.floating_origin,
            layout,
            right,
            up,
        )?,
        TextLayoutSpace::Screen => build_screen_batch(
            device,
            queue,
            label,
            options.proxy_slot,
            options.floating_origin,
            layout,
        )?,
    };
    let material = renderer.create_styled_material_from_texture(
        device,
        queue,
        &format!("{label}-atlas"),
        texture,
        GpuAlphaMode::Mask { cutoff: 0.01 },
        style,
    )?;
    Ok(batch.with_material(material))
}

fn build_world_batch(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &str,
    proxy_slot: u32,
    floating_origin: FloatingOrigin,
    layout: &LaidOutText,
    right: WorldVec3,
    up: WorldVec3,
) -> Result<GpuDrawBatch, TextError> {
    let right = vector(right);
    let up = vector(up);
    let normal = right
        .cross(up)
        .try_normalize()
        .ok_or(TextError::InvalidLayout)?;
    #[allow(clippy::cast_possible_truncation)]
    let normal = [normal.x as f32, normal.y as f32, normal.z as f32];
    let mut vertices = Vec::with_capacity(layout.glyphs.len() * 4);
    let mut indices = Vec::with_capacity(layout.glyphs.len() * 6);
    for glyph in &layout.glyphs {
        let base = u32::try_from(vertices.len()).map_err(|_| TextError::TooManyGlyphs)?;
        for (offset, texture_coordinate) in glyph.offsets.iter().zip(glyph.texture_coordinates) {
            let world = vector(layout.anchor) + right * offset[0] + up * offset[1];
            vertices.push(GpuMeshVertexInput {
                position: floating_origin.world_to_render(world_position(world)),
                normal,
                tex_coord: texture_coordinate,
                additional_tex_coords: [[0.0; 2]; 7],
                color: layout.color,
            });
        }
        indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    Ok(GpuDrawBatch::new_indexed_mesh_with_queue(
        device, queue, label, proxy_slot, 0, &vertices, &indices, true,
    )?)
}

fn build_screen_batch(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &str,
    proxy_slot: u32,
    floating_origin: FloatingOrigin,
    layout: &LaidOutText,
) -> Result<GpuDrawBatch, TextError> {
    let anchor = floating_origin.world_to_render(layout.anchor);
    let mut vertices = Vec::with_capacity(layout.glyphs.len() * 6);
    for glyph in &layout.glyphs {
        for corner in [0, 1, 2, 0, 2, 3] {
            #[allow(clippy::cast_possible_truncation)]
            let pixel_offset = [
                glyph.offsets[corner][0] as f32,
                glyph.offsets[corner][1] as f32,
            ];
            vertices.push(GpuScreenTextVertex {
                anchor,
                pixel_offset,
                tex_coord: glyph.texture_coordinates[corner],
                color: layout.color,
                proxy_slot,
                primitive_slot: glyph.primitive_slot,
            });
        }
    }
    Ok(GpuDrawBatch::new_screen_text_with_queue(
        device, queue, label, &vertices, true,
    )?)
}

/// Validates atlas dimensions, pixels, metrics and fallback identity without
/// allocating GPU resources.
pub fn validate_glyph_atlas(atlas: &GlyphAtlas) -> Result<(), TextError> {
    let expected = u64::from(atlas.width)
        .checked_mul(u64::from(atlas.height))
        .and_then(|pixels| pixels.checked_mul(4))
        .and_then(|bytes| usize::try_from(bytes).ok());
    if atlas.width == 0
        || atlas.height == 0
        || expected != Some(atlas.rgba8.len())
        || !atlas.line_height.is_finite()
        || atlas.line_height <= 0.0
        || atlas
            .fallback
            .is_some_and(|fallback| !atlas.glyphs.contains_key(&fallback))
        || atlas.glyphs.values().any(|glyph| {
            glyph.atlas_min[0] > glyph.atlas_max[0]
                || glyph.atlas_min[1] > glyph.atlas_max[1]
                || glyph.atlas_max[0] > atlas.width
                || glyph.atlas_max[1] > atlas.height
                || glyph
                    .plane_min
                    .iter()
                    .chain(&glyph.plane_max)
                    .chain([glyph.advance].iter())
                    .any(|value| !value.is_finite())
        })
    {
        Err(TextError::InvalidAtlas)
    } else {
        Ok(())
    }
}

fn validate_options(options: &TextLayoutOptions<'_>) -> Result<(), TextError> {
    let basis_valid = match options.space {
        TextLayoutSpace::Screen => true,
        TextLayoutSpace::World { right, up } => {
            let right = vector(right);
            let up = vector(up);
            right.is_finite() && up.is_finite() && right.cross(up).length_squared() > f64::EPSILON
        }
    };
    if vector(options.anchor).is_finite()
        && options.height.is_finite()
        && options.height > 0.0
        && options.line_spacing.is_finite()
        && options.line_spacing > 0.0
        && options.color.iter().all(|value| value.is_finite())
        && basis_valid
    {
        Ok(())
    } else {
        Err(TextError::InvalidLayout)
    }
}

fn metrics(atlas: &GlyphAtlas, character: char) -> Option<GlyphMetrics> {
    atlas.glyphs.get(&character).copied().or_else(|| {
        atlas
            .fallback
            .and_then(|fallback| atlas.glyphs.get(&fallback).copied())
    })
}

fn glyph_quad(
    atlas: &GlyphAtlas,
    metric: GlyphMetrics,
    pen_x: f64,
    baseline_y: f64,
    scale: f64,
    primitive_slot: u32,
) -> LaidOutGlyph {
    let x0 = pen_x + f64::from(metric.plane_min[0]) * scale;
    let y0 = baseline_y + f64::from(metric.plane_min[1]) * scale;
    let x1 = pen_x + f64::from(metric.plane_max[0]) * scale;
    let y1 = baseline_y + f64::from(metric.plane_max[1]) * scale;
    #[allow(clippy::cast_precision_loss)]
    let uv = [
        metric.atlas_min[0] as f32 / atlas.width as f32,
        metric.atlas_min[1] as f32 / atlas.height as f32,
        metric.atlas_max[0] as f32 / atlas.width as f32,
        metric.atlas_max[1] as f32 / atlas.height as f32,
    ];
    LaidOutGlyph {
        offsets: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
        texture_coordinates: [
            [uv[0], uv[3]],
            [uv[2], uv[3]],
            [uv[2], uv[1]],
            [uv[0], uv[1]],
        ],
        primitive_slot,
    }
}

fn vector(value: WorldVec3) -> DVec3 {
    DVec3::new(value.x, value.y, value.z)
}

fn world_position(value: DVec3) -> WorldVec3 {
    WorldVec3 {
        x: value.x,
        y: value.y,
        z: value.z,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{
        layout_text, GlyphAtlas, GlyphMetrics, TextAlignment, TextLayoutOptions, TextLayoutSpace,
    };
    use crate::WorldVec3;

    #[test]
    fn centered_multiline_layout_is_deterministic_and_pixel_stable() {
        let atlas = atlas();
        let layout = layout_text(
            &atlas,
            TextLayoutOptions {
                text: "AA\nA",
                anchor: WorldVec3 {
                    x: 1_000_000.0,
                    y: 2_000_000.0,
                    z: 500.0,
                },
                height: 20.0,
                line_spacing: 1.0,
                alignment: TextAlignment::Center,
                space: TextLayoutSpace::Screen,
                color: [1.0; 4],
            },
        )
        .expect("layout");

        assert_eq!(layout.glyphs.len(), 3);
        assert!((layout.glyphs[0].offsets[0][0] + 24.0).abs() < 1.0e-5);
        assert!((layout.glyphs[2].offsets[0][1] + 20.0).abs() < 1.0e-5);
    }

    fn atlas() -> GlyphAtlas {
        GlyphAtlas {
            width: 2,
            height: 2,
            rgba8: vec![255; 16],
            line_height: 1.0,
            glyphs: BTreeMap::from([(
                'A',
                GlyphMetrics {
                    atlas_min: [0, 0],
                    atlas_max: [2, 2],
                    plane_min: [0.0, 0.0],
                    plane_max: [1.0, 1.0],
                    advance: 1.2,
                },
            )]),
            fallback: Some('A'),
        }
    }
}
