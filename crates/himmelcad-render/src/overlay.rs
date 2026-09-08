//! Protected vector/text overlay payloads rendered in the mixed frame.

use serde::{Deserialize, Serialize};
use std::fmt::{Display, Formatter};

use crate::{
    build_text_batch_with_texture, layout_text, FloatingOrigin, GlyphAtlas, GpuAlphaMode,
    GpuDrawBatch, GpuFrameError, GpuPresentationStyle, GpuScreenTextVertex, GpuSharedRenderer,
    GpuTextureResource, GpuVertex, TextAlignment, TextBatchOptions, TextError, TextLayoutOptions,
    TextLayoutSpace, WorldVec3,
};

const MAX_OVERLAY_LINES: usize = 8_192;
const MAX_OVERLAY_LINE_POINTS: usize = 65_536;
const MAX_OVERLAY_QUADS: usize = 16_384;
const MAX_OVERLAY_LABELS: usize = 4_096;
const MAX_OVERLAY_LABEL_CHARACTERS: usize = 256;
const MAX_OVERLAY_PIXEL_OFFSET: f32 = 4_096.0;

/// One protected line strip in project truth coordinates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverlayLineStrip {
    /// Stable caller identity used for deterministic replacement.
    pub id: String,
    /// At least two project-world positions.
    pub points: Vec<WorldVec3>,
    /// Physical-pixel stroke width.
    pub width_pixels: f32,
    /// Linear RGBA resolved from the selection/support design token.
    pub color: [f32; 4],
}

/// One arbitrary pixel-space quad anchored at a project-world depth.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverlayScreenQuad {
    /// Stable caller identity.
    pub id: String,
    /// Project-world anchor supplying position, clip and depth.
    pub anchor: WorldVec3,
    /// Counter-clockwise pixel offsets. This supports squares and arrow arms.
    pub offsets: [[f32; 2]; 4],
    /// Linear RGBA resolved from the selection/support design token.
    pub color: [f32; 4],
}

/// One screen-space label chip rendered through the shared glyph pipeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverlayLabelChip {
    /// Stable caller identity.
    pub id: String,
    /// Project-world anchor supplying position, clip and depth.
    pub anchor: WorldVec3,
    /// Offset matching the DOM chip's midpoint-plus-12-pixel placement.
    pub pixel_offset: [f32; 2],
    /// Label source text.
    pub text: String,
    /// Physical-pixel em height.
    pub height_pixels: f64,
    /// Linear glyph RGBA.
    pub text_color: [f32; 4],
    /// Linear chip fill RGBA.
    pub background_color: [f32; 4],
    /// Linear chip border RGBA.
    pub border_color: [f32; 4],
}

/// Complete protected lane-2/3 overlay replacement for one frame state.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererOverlayPayload {
    /// Support/selection/measurement lines.
    #[serde(default)]
    pub lines: Vec<OverlayLineStrip>,
    /// Point/anchor squares and selected-line end arrows.
    #[serde(default)]
    pub quads: Vec<OverlayScreenQuad>,
    /// Measurement and entity label chips.
    #[serde(default)]
    pub labels: Vec<OverlayLabelChip>,
}

/// Overlay validation or GPU build failure.
#[derive(Debug)]
pub enum OverlayBuildError {
    /// The typed payload is empty, non-finite or outside the bounded glyph sizes.
    InvalidPayload,
    /// Shared geometry upload failed.
    Gpu(GpuFrameError),
    /// Shared text layout/upload failed.
    Text(TextError),
}

impl Display for OverlayBuildError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPayload => formatter.write_str("renderer overlay payload is invalid"),
            Self::Gpu(error) => Display::fmt(error, formatter),
            Self::Text(error) => Display::fmt(error, formatter),
        }
    }
}

impl std::error::Error for OverlayBuildError {}

impl From<GpuFrameError> for OverlayBuildError {
    fn from(value: GpuFrameError) -> Self {
        Self::Gpu(value)
    }
}

impl From<TextError> for OverlayBuildError {
    fn from(value: TextError) -> Self {
        Self::Text(value)
    }
}

/// Validates and uploads protected overlay batches. Callers replace the whole
/// payload atomically; no overlay buffer is mutated on the frame path.
#[allow(clippy::too_many_arguments)]
pub fn build_renderer_overlay_batches(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &GpuSharedRenderer,
    label: &str,
    floating_origin: FloatingOrigin,
    atlas: &GlyphAtlas,
    atlas_texture: &GpuTextureResource,
    payload: &RendererOverlayPayload,
) -> Result<Vec<GpuDrawBatch>, OverlayBuildError> {
    validate_renderer_overlay_payload(payload)?;
    let mut output = Vec::new();
    for (index, line) in payload.lines.iter().enumerate() {
        validate_color(line.color)?;
        if line.id.is_empty()
            || line.points.len() < 2
            || !line.width_pixels.is_finite()
            || !(0.5..=16.0).contains(&line.width_pixels)
            || line.points.iter().any(|point| !finite_world(*point))
        {
            return Err(OverlayBuildError::InvalidPayload);
        }
        let mut vertices = Vec::with_capacity((line.points.len() - 1) * 2);
        for (primitive_slot, pair) in line.points.windows(2).enumerate() {
            for point in pair {
                vertices.push(GpuVertex {
                    position: floating_origin.world_to_render(*point),
                    color: line.color,
                    proxy_slot: 1,
                    primitive_slot: u32::try_from(primitive_slot)
                        .map_err(|_| OverlayBuildError::InvalidPayload)?,
                });
            }
        }
        let mut batch = GpuDrawBatch::new_lines_with_width_and_queue(
            device,
            queue,
            &format!("{label}-line-{index}"),
            line.width_pixels,
            &vertices,
        )?
        .with_pickable(false);
        let material = renderer.create_solid_styled_material(
            device,
            queue,
            &format!("{label}-line-material-{index}"),
            if line.color[3] < 1.0 {
                GpuAlphaMode::Blend
            } else {
                GpuAlphaMode::Opaque
            },
            GpuPresentationStyle::default(),
        )?;
        batch = batch.with_material(material);
        batch.set_world_origins(queue, floating_origin.world(), floating_origin.world())?;
        output.push(batch);
    }
    for (index, quad) in payload.quads.iter().enumerate() {
        output.push(build_screen_quad(
            device,
            queue,
            renderer,
            &format!("{label}-quad-{index}"),
            floating_origin,
            quad,
        )?);
    }
    for (index, chip) in payload.labels.iter().enumerate() {
        validate_color(chip.text_color)?;
        validate_color(chip.background_color)?;
        validate_color(chip.border_color)?;
        if chip.id.is_empty()
            || chip.text.is_empty()
            || !finite_world(chip.anchor)
            || chip.pixel_offset.iter().any(|value| !value.is_finite())
            || !chip.height_pixels.is_finite()
            || !(6.0..=64.0).contains(&chip.height_pixels)
        {
            return Err(OverlayBuildError::InvalidPayload);
        }
        let mut layout = layout_text(
            atlas,
            TextLayoutOptions {
                text: &chip.text,
                anchor: chip.anchor,
                height: chip.height_pixels,
                line_spacing: 1.0,
                alignment: TextAlignment::Center,
                space: TextLayoutSpace::Screen,
                color: chip.text_color,
            },
        )?;
        for glyph in &mut layout.glyphs {
            for offset in &mut glyph.offsets {
                offset[0] += f64::from(chip.pixel_offset[0]);
                offset[1] += f64::from(chip.pixel_offset[1]);
            }
        }
        let bounds = glyph_bounds(&layout).ok_or(OverlayBuildError::InvalidPayload)?;
        let border = OverlayScreenQuad {
            id: format!("{}:border", chip.id),
            anchor: chip.anchor,
            offsets: rectangle_offsets(
                bounds[0] - 6.0,
                bounds[1] - 4.0,
                bounds[2] + 6.0,
                bounds[3] + 4.0,
            ),
            color: chip.border_color,
        };
        output.push(build_screen_quad(
            device,
            queue,
            renderer,
            &format!("{label}-label-border-{index}"),
            floating_origin,
            &border,
        )?);
        let background = OverlayScreenQuad {
            id: format!("{}:background", chip.id),
            anchor: chip.anchor,
            offsets: rectangle_offsets(
                bounds[0] - 5.0,
                bounds[1] - 3.0,
                bounds[2] + 5.0,
                bounds[3] + 3.0,
            ),
            color: chip.background_color,
        };
        output.push(build_screen_quad(
            device,
            queue,
            renderer,
            &format!("{label}-label-background-{index}"),
            floating_origin,
            &background,
        )?);
        let mut text = build_text_batch_with_texture(
            device,
            queue,
            renderer,
            &format!("{label}-label-text-{index}"),
            TextBatchOptions {
                proxy_slot: 1,
                floating_origin,
            },
            atlas_texture,
            &layout,
            GpuPresentationStyle::default(),
        )?
        .with_pickable(false);
        text.set_world_origins(queue, floating_origin.world(), floating_origin.world())?;
        output.push(text);
    }
    Ok(output)
}

fn build_screen_quad(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &GpuSharedRenderer,
    label: &str,
    floating_origin: FloatingOrigin,
    quad: &OverlayScreenQuad,
) -> Result<GpuDrawBatch, OverlayBuildError> {
    validate_color(quad.color)?;
    if quad.id.is_empty()
        || !finite_world(quad.anchor)
        || quad
            .offsets
            .iter()
            .flatten()
            .any(|value| !value.is_finite())
    {
        return Err(OverlayBuildError::InvalidPayload);
    }
    let anchor = floating_origin.world_to_render(quad.anchor);
    let vertices = [0_usize, 1, 2, 0, 2, 3].map(|corner| GpuScreenTextVertex {
        anchor,
        pixel_offset: quad.offsets[corner],
        tex_coord: [0.5, 0.5],
        color: quad.color,
        proxy_slot: 1,
        primitive_slot: 0,
    });
    let mut batch =
        GpuDrawBatch::new_screen_text_with_queue(device, queue, label, &vertices, true)?
            .with_pickable(false);
    let material = renderer.create_solid_styled_material(
        device,
        queue,
        &format!("{label}-material"),
        GpuAlphaMode::Blend,
        GpuPresentationStyle::default(),
    )?;
    batch = batch.with_material(material);
    batch.set_world_origins(queue, floating_origin.world(), floating_origin.world())?;
    Ok(batch)
}

fn glyph_bounds(layout: &crate::LaidOutText) -> Option<[f32; 4]> {
    let mut bounds = [
        f32::INFINITY,
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::NEG_INFINITY,
    ];
    for offset in layout.glyphs.iter().flat_map(|glyph| glyph.offsets) {
        #[allow(clippy::cast_possible_truncation)]
        let point = [offset[0] as f32, offset[1] as f32];
        bounds[0] = bounds[0].min(point[0]);
        bounds[1] = bounds[1].min(point[1]);
        bounds[2] = bounds[2].max(point[0]);
        bounds[3] = bounds[3].max(point[1]);
    }
    bounds
        .iter()
        .all(|value| value.is_finite())
        .then_some(bounds)
}

fn rectangle_offsets(left: f32, top: f32, right: f32, bottom: f32) -> [[f32; 2]; 4] {
    [[left, top], [right, top], [right, bottom], [left, bottom]]
}

fn validate_color(color: [f32; 4]) -> Result<(), OverlayBuildError> {
    if color
        .iter()
        .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
    {
        return Err(OverlayBuildError::InvalidPayload);
    }
    Ok(())
}

fn validate_renderer_overlay_payload(
    payload: &RendererOverlayPayload,
) -> Result<(), OverlayBuildError> {
    let line_points = payload.lines.iter().try_fold(0_usize, |total, line| {
        total
            .checked_add(line.points.len())
            .ok_or(OverlayBuildError::InvalidPayload)
    })?;
    if payload.lines.len() > MAX_OVERLAY_LINES
        || line_points > MAX_OVERLAY_LINE_POINTS
        || payload.quads.len() > MAX_OVERLAY_QUADS
        || payload.labels.len() > MAX_OVERLAY_LABELS
        || payload.labels.iter().any(|label| {
            label.text.chars().count() > MAX_OVERLAY_LABEL_CHARACTERS
                || label
                    .pixel_offset
                    .iter()
                    .any(|value| value.abs() > MAX_OVERLAY_PIXEL_OFFSET)
        })
        || payload.quads.iter().any(|quad| {
            quad.offsets
                .iter()
                .flatten()
                .any(|value| value.abs() > MAX_OVERLAY_PIXEL_OFFSET)
        })
    {
        return Err(OverlayBuildError::InvalidPayload);
    }
    Ok(())
}

fn finite_world(point: WorldVec3) -> bool {
    point.x.is_finite() && point.y.is_finite() && point.z.is_finite()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn square_and_chip_offsets_match_dom_centres() {
        assert_eq!(
            rectangle_offsets(-3.0, -3.0, 3.0, 3.0),
            [[-3.0, -3.0], [3.0, -3.0], [3.0, 3.0], [-3.0, 3.0],]
        );
        let chip = OverlayLabelChip {
            id: "distance".to_owned(),
            anchor: WorldVec3 {
                x: 1.0,
                y: 2.0,
                z: 3.0,
            },
            pixel_offset: [0.0, 12.0],
            text: "12.345 m".to_owned(),
            height_pixels: 12.0,
            text_color: [1.0; 4],
            background_color: [0.05, 0.05, 0.05, 0.96],
            border_color: [0.26, 0.73, 1.0, 1.0],
        };
        assert_eq!(chip.pixel_offset, [0.0, 12.0]);
    }

    #[test]
    fn protected_overlay_payload_rejects_unbounded_label_work() {
        let payload = RendererOverlayPayload {
            labels: vec![OverlayLabelChip {
                id: "too-long".to_owned(),
                anchor: WorldVec3 {
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                },
                pixel_offset: [0.0, 12.0],
                text: "x".repeat(MAX_OVERLAY_LABEL_CHARACTERS + 1),
                height_pixels: 12.0,
                text_color: [1.0; 4],
                background_color: [0.0, 0.0, 0.0, 1.0],
                border_color: [1.0; 4],
            }],
            ..RendererOverlayPayload::default()
        };
        assert!(matches!(
            validate_renderer_overlay_payload(&payload),
            Err(OverlayBuildError::InvalidPayload)
        ));
    }
}
