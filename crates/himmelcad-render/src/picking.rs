//! Shared GPU pick encoding and deterministic cursor candidate cycling.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    CameraFrame, CameraFrameError, GpuHitPixel, PickAddress, RenderProxyKind, RenderWorld,
    WorldVec3,
};

/// Two-attachment GPU identifier valid on the WebGL2 feature floor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickToken {
    /// Non-zero render-proxy slot encoded into one RGBA8 attachment.
    pub proxy_slot: u32,
    /// Proxy-local primitive slot encoded into a second RGBA8 attachment.
    pub primitive_slot: u32,
}

impl PickToken {
    /// Encodes both identifiers exactly as the portable `RGBA8Uint` pick pass does.
    #[must_use]
    pub fn encode_rgba8(self) -> ([u8; 4], [u8; 4]) {
        (
            self.proxy_slot.to_le_bytes(),
            self.primitive_slot.to_le_bytes(),
        )
    }

    /// Decodes one pixel from the two portable `RGBA8Uint` pick attachments.
    #[must_use]
    pub fn decode_rgba8(proxy: [u8; 4], primitive: [u8; 4]) -> Self {
        Self {
            proxy_slot: u32::from_le_bytes(proxy),
            primitive_slot: u32::from_le_bytes(primitive),
        }
    }
}

/// Semantic snap class used to rank provider-refined candidates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SnapKind {
    /// Authored or measured point.
    Point,
    /// Curve or triangle vertex.
    Vertex,
    /// Curve midpoint.
    Midpoint,
    /// Curve intersection.
    Intersection,
    /// Nearest point on an edge or analytic curve.
    Edge,
    /// Surface or triangle location.
    Surface,
    /// Raster/elevation sample.
    RasterSample,
}

/// Raw sample read asynchronously from a cursor-neighborhood ID/depth pass.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickSample {
    /// Encoded proxy and primitive slots.
    pub token: PickToken,
    /// Pixel distance from the cursor center.
    pub pixel_distance: f32,
    /// Normalized device depth.
    pub depth: f32,
}

/// Provider-refined, world-space snapping candidate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickCandidate {
    /// Entity/proxy/tile/primitive address.
    pub address: PickAddress,
    /// Exact or provider-refined world coordinate.
    pub world_position: WorldVec3,
    /// Semantic snap class.
    pub snap_kind: SnapKind,
    /// Pixel distance from the cursor.
    pub pixel_distance: f32,
    /// Camera depth used after screen-distance ranking.
    pub depth: f32,
}

/// Invertible presentation-only scaling of project-world Z about a fixed datum.
///
/// Exact providers keep their geometry and returned coordinates in source world
/// space. Cursor rays are transformed back through this value before exact
/// intersection, while source candidates are transformed forward only for
/// screen-space ranking.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PresentationTransform {
    vertical_exaggeration: f64,
    datum: f64,
}

impl PresentationTransform {
    /// Identity presentation used when no vertical exaggeration is active.
    pub const IDENTITY: Self = Self {
        vertical_exaggeration: 1.0,
        datum: 0.0,
    };

    /// Creates an invertible vertical presentation transform.
    ///
    /// Zero is deliberately rejected because a flattened presentation cannot
    /// be mapped back to one authoritative source height.
    pub fn new(vertical_exaggeration: f64, datum: f64) -> Result<Self, PresentationTransformError> {
        if !vertical_exaggeration.is_finite() || vertical_exaggeration <= 0.0 {
            return Err(PresentationTransformError::NonInvertibleExaggeration);
        }
        if !datum.is_finite() {
            return Err(PresentationTransformError::NonFiniteDatum);
        }
        Ok(Self {
            vertical_exaggeration,
            datum,
        })
    }

    /// Maps an authoritative source coordinate into displayed world space.
    #[must_use]
    pub fn present(self, mut source: WorldVec3) -> WorldVec3 {
        source.z = self.datum + (source.z - self.datum) * self.vertical_exaggeration;
        source
    }

    /// Maps a displayed coordinate back into authoritative source world space.
    #[must_use]
    pub fn source(self, mut presented: WorldVec3) -> WorldVec3 {
        presented.z = self.datum + (presented.z - self.datum) / self.vertical_exaggeration;
        presented
    }

    /// Largest affine length scale, used for conservative presented bounds and error.
    #[must_use]
    pub fn maximum_linear_scale(self) -> f64 {
        self.vertical_exaggeration.max(1.0)
    }

    /// Maps a displayed cursor ray into source space and restores unit length.
    #[must_use]
    pub fn source_ray(self, presented: crate::WorldRay) -> crate::WorldRay {
        let mut direction = presented.direction;
        direction.z /= self.vertical_exaggeration;
        let length = direction
            .x
            .mul_add(
                direction.x,
                direction.y.mul_add(direction.y, direction.z * direction.z),
            )
            .sqrt();
        debug_assert!(length.is_finite() && length > 0.0);
        direction.x /= length;
        direction.y /= length;
        direction.z /= length;
        crate::WorldRay {
            origin: self.source(presented.origin),
            direction,
        }
    }
}

impl Default for PresentationTransform {
    fn default() -> Self {
        Self::IDENTITY
    }
}

/// Invalid presentation transform that cannot preserve exact source picking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum PresentationTransformError {
    /// Vertical exaggeration must be finite and strictly positive.
    #[error("vertical exaggeration must be finite and greater than zero for exact picking")]
    NonInvertibleExaggeration,
    /// The fixed world-Z datum must be finite.
    #[error("vertical exaggeration datum must be finite")]
    NonFiniteDatum,
}

/// Inputs supplied to one format- or geometry-specific snap refiner.
#[derive(Debug, Clone, Copy)]
pub struct PickRefinementRequest<'a> {
    /// Approximate candidate reconstructed from the shared ID/depth pass.
    pub coarse: &'a PickCandidate,
    /// Exact f64 camera used to project refined candidates for screen ranking.
    pub camera: &'a CameraFrame,
    /// Exact f64 cursor ray for analytic closest-point calculations.
    pub cursor_ray: crate::WorldRay,
    /// Immutable provider-source to canonical project-world placement.
    pub source_to_project: crate::WorldTransform,
    /// Invertible mapping between authoritative source and displayed world space.
    pub presentation_transform: PresentationTransform,
    /// Physical top-left-origin cursor coordinate.
    pub cursor_pixel: [f64; 2],
    /// Physical viewport extent.
    pub viewport: [u32; 2],
    /// Maximum accepted screen-space snap distance.
    pub pixel_tolerance: f64,
}

impl PickRefinementRequest<'_> {
    /// Maps the displayed cursor ray through inverse presentation and inverse entity placement.
    #[must_use]
    pub fn source_ray(self) -> Option<crate::WorldRay> {
        let project_ray = self.presentation_transform.source_ray(self.cursor_ray);
        let inverse = self.source_to_project.inverse()?;
        let origin = inverse.transform_point(project_ray.origin)?;
        let direction = inverse.transform_vector(project_ray.direction)?;
        let length = direction
            .x
            .mul_add(
                direction.x,
                direction.y.mul_add(direction.y, direction.z * direction.z),
            )
            .sqrt();
        (length.is_finite() && length > 0.0).then(|| crate::WorldRay {
            origin,
            direction: crate::WorldVec3 {
                x: direction.x / length,
                y: direction.y / length,
                z: direction.z / length,
            },
        })
    }

    /// Maps one provider-source coordinate into canonical project world.
    #[must_use]
    pub fn project_source(self, source: WorldVec3) -> Option<WorldVec3> {
        self.source_to_project.transform_point(source)
    }

    /// Maps one project-world coordinate back into provider source space.
    #[must_use]
    pub fn source_from_project(self, project: WorldVec3) -> Option<WorldVec3> {
        self.source_to_project.inverse()?.transform_point(project)
    }

    /// Maps one provider-source coordinate through placement and view presentation.
    #[must_use]
    pub fn present_source(self, source: WorldVec3) -> Option<WorldVec3> {
        Some(
            self.presentation_transform
                .present(self.project_source(source)?),
        )
    }
}

/// Geometry/provider boundary for replacing visual depth hits with exact snaps.
pub trait PickRefinementProvider {
    /// Returns `None` when this provider does not own the address. `Some` may
    /// contain zero candidates when the visual hit has no valid geometric snap.
    fn refine(&self, request: PickRefinementRequest<'_>) -> Option<Vec<PickCandidate>>;
}

/// Routes coarse hits through a geometry provider while retaining unowned hits.
pub fn refine_pick_candidates(
    camera: CameraFrame,
    viewport: [u32; 2],
    cursor_pixel: [f64; 2],
    pixel_tolerance: f64,
    coarse: &[PickCandidate],
    provider: &dyn PickRefinementProvider,
) -> Result<Vec<PickCandidate>, CameraFrameError> {
    if !pixel_tolerance.is_finite() || pixel_tolerance < 0.0 {
        return Err(CameraFrameError::InvalidProjection);
    }
    let cursor_ray = camera.cursor_ray(cursor_pixel, viewport)?;
    let mut refined = Vec::new();
    for candidate in coarse {
        let request = PickRefinementRequest {
            coarse: candidate,
            camera: &camera,
            cursor_ray,
            source_to_project: crate::WorldTransform::IDENTITY,
            presentation_transform: PresentationTransform::IDENTITY,
            cursor_pixel,
            viewport,
            pixel_tolerance,
        };
        if let Some(candidates) = provider.refine(request) {
            refined.extend(candidates);
        } else {
            refined.push(candidate.clone());
        }
    }
    Ok(refined)
}

/// Converts GPU neighborhood samples into approximate world-space candidates.
///
/// The resulting positions lie on the rendered depth surface. Geometry
/// providers may subsequently replace them with analytic edge, vertex,
/// intersection or survey-point coordinates before the stack is installed.
#[allow(clippy::cast_possible_truncation)]
pub fn reconstruct_coarse_pick_candidates(
    world: &RenderWorld,
    camera: CameraFrame,
    viewport: [u32; 2],
    cursor_pixel: [u32; 2],
    hits: &[GpuHitPixel],
) -> Result<Vec<PickCandidate>, CameraFrameError> {
    let mut candidates = Vec::with_capacity(hits.len());
    for hit in hits {
        if hit.sample.token.proxy_slot == 0 {
            continue;
        }
        let Some((address, kind)) = world.resolve_pick_with_kind(hit.sample.token) else {
            continue;
        };
        let pixel = [f64::from(hit.pixel[0]) + 0.5, f64::from(hit.pixel[1]) + 0.5];
        let world_position =
            camera.unproject_pixel(pixel, f64::from(hit.sample.reverse_z_depth), viewport)?;
        let dx = f64::from(hit.pixel[0].abs_diff(cursor_pixel[0]));
        let dy = f64::from(hit.pixel[1].abs_diff(cursor_pixel[1]));
        candidates.push(PickCandidate {
            address,
            world_position,
            snap_kind: coarse_snap_kind(kind),
            pixel_distance: (dx.mul_add(dx, dy * dy)).sqrt() as f32,
            // PickCycle sorts smaller depth first; invert reverse-Z so near wins.
            depth: 1.0 - hit.sample.reverse_z_depth,
        });
    }
    Ok(candidates)
}

/// Replaces a point proxy's depth-reconstructed position with its exact source-world coordinate.
#[must_use]
#[allow(clippy::cast_possible_truncation)]
pub fn refine_exact_point_pick(
    request: PickRefinementRequest<'_>,
    source_position: WorldVec3,
) -> Vec<PickCandidate> {
    let Some(project_position) = request.project_source(source_position) else {
        return Vec::new();
    };
    let presented = request.presentation_transform.present(project_position);
    let Ok(projected) = request.camera.project_world(presented, request.viewport) else {
        return Vec::new();
    };
    let pixel_distance = (projected.pixel[0] - request.cursor_pixel[0])
        .hypot(projected.pixel[1] - request.cursor_pixel[1]);
    if !pixel_distance.is_finite() || pixel_distance > request.pixel_tolerance {
        return Vec::new();
    }
    let mut address = request.coarse.address.clone();
    address.primitive_id = Some(0);
    vec![PickCandidate {
        address,
        world_position: project_position,
        snap_kind: SnapKind::Point,
        pixel_distance: pixel_distance as f32,
        depth: (1.0 - projected.reverse_z_depth) as f32,
    }]
}

fn coarse_snap_kind(kind: RenderProxyKind) -> SnapKind {
    match kind {
        RenderProxyKind::Points | RenderProxyKind::Text => SnapKind::Point,
        RenderProxyKind::CadStroke => SnapKind::Edge,
        RenderProxyKind::Raster => SnapKind::RasterSample,
        RenderProxyKind::Triangles | RenderProxyKind::CadFill | RenderProxyKind::GaussianSplats => {
            SnapKind::Surface
        }
    }
}

/// Tab traversal direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickCycleDirection {
    /// Tab selects the next candidate.
    Forward,
    /// Shift+Tab selects the previous candidate.
    Backward,
}

/// Stable ranked candidate stack owned by one focused viewport.
#[derive(Debug, Default)]
pub struct PickCycle {
    candidates: Vec<PickCandidate>,
    selected: Option<usize>,
    render_generation: u64,
}

impl PickCycle {
    /// Creates an empty pick stack.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Replaces candidates for a completed asynchronous pick operation.
    pub fn replace(&mut self, render_generation: u64, mut candidates: Vec<PickCandidate>) {
        candidates.retain(|candidate| {
            candidate.pixel_distance.is_finite()
                && candidate.depth.is_finite()
                && candidate.pixel_distance >= 0.0
        });
        candidates.sort_by(|left, right| {
            snap_rank(left.snap_kind)
                .cmp(&snap_rank(right.snap_kind))
                .then_with(|| left.pixel_distance.total_cmp(&right.pixel_distance))
                .then_with(|| left.depth.total_cmp(&right.depth))
                .then_with(|| left.address.entity_id.cmp(&right.address.entity_id))
                .then_with(|| left.address.primitive_id.cmp(&right.address.primitive_id))
        });
        // Ranking by pixel distance deliberately interleaves addresses, so an
        // adjacent-only deduplication leaks one entry per covered GPU pixel.
        // The list is already best-first; retain the first semantic hit for an
        // address while preserving distinct vertices of the same primitive.
        let mut unique = Vec::with_capacity(candidates.len());
        for candidate in candidates {
            let duplicate = unique.iter().any(|existing: &PickCandidate| {
                existing.address == candidate.address
                    && existing.snap_kind == candidate.snap_kind
                    && (!matches!(
                        candidate.snap_kind,
                        SnapKind::Point
                            | SnapKind::Vertex
                            | SnapKind::Midpoint
                            | SnapKind::Intersection
                    ) || same_world_position(existing.world_position, candidate.world_position))
            });
            if !duplicate {
                unique.push(candidate);
            }
        }
        candidates = unique;
        self.candidates = candidates;
        self.selected = (!self.candidates.is_empty()).then_some(0);
        self.render_generation = render_generation;
    }

    /// Clears stale candidates if the render world changed before readback finished.
    pub fn invalidate_if_stale(&mut self, current_generation: u64) {
        if current_generation != self.render_generation {
            self.candidates.clear();
            self.selected = None;
            self.render_generation = current_generation;
        }
    }

    /// Current candidate, if any.
    #[must_use]
    pub fn current(&self) -> Option<&PickCandidate> {
        self.selected.and_then(|index| self.candidates.get(index))
    }

    /// Cycles with wraparound and returns the new current candidate.
    pub fn cycle(&mut self, direction: PickCycleDirection) -> Option<&PickCandidate> {
        let length = self.candidates.len();
        if length == 0 {
            self.selected = None;
            return None;
        }
        let current = self.selected.unwrap_or(0);
        self.selected = Some(match direction {
            PickCycleDirection::Forward => (current + 1) % length,
            PickCycleDirection::Backward => (current + length - 1) % length,
        });
        self.current()
    }

    /// Ranked candidates exposed for hover UI and diagnostics.
    #[must_use]
    pub fn candidates(&self) -> &[PickCandidate] {
        &self.candidates
    }
}

fn same_world_position(left: WorldVec3, right: WorldVec3) -> bool {
    let scale = left
        .x
        .abs()
        .max(left.y.abs())
        .max(left.z.abs())
        .max(right.x.abs())
        .max(right.y.abs())
        .max(right.z.abs())
        .max(1.0);
    let tolerance = scale * f64::EPSILON * 16.0;
    (left.x - right.x).abs() <= tolerance
        && (left.y - right.y).abs() <= tolerance
        && (left.z - right.z).abs() <= tolerance
}

fn snap_rank(kind: SnapKind) -> u8 {
    match kind {
        SnapKind::Point => 0,
        SnapKind::Intersection => 1,
        SnapKind::Vertex => 2,
        SnapKind::Midpoint => 3,
        SnapKind::Edge => 4,
        SnapKind::Surface => 5,
        SnapKind::RasterSample => 6,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        reconstruct_coarse_pick_candidates, refine_exact_point_pick, PickCandidate, PickCycle,
        PickCycleDirection, PickRefinementRequest, PickToken, PresentationTransform,
        PresentationTransformError, SnapKind,
    };
    use crate::{
        BoundingVolume, CameraFrame, CameraProjection, GpuHitPixel, GpuHitSample, PickAddress,
        RenderProxy, RenderProxyId, RenderProxyKind, RenderStyle, RenderWorld, ResourceCost,
        WorldAabb, WorldCamera, WorldTransform, WorldVec3,
    };

    #[test]
    fn tab_and_shift_tab_cycle_one_ranked_mixed_entity_stack() {
        let mut cycle = PickCycle::new();
        cycle.replace(
            7,
            vec![
                candidate("mesh", SnapKind::Surface, 0.1),
                candidate("survey-point", SnapKind::Point, 3.0),
                candidate("cad-line", SnapKind::Edge, 0.5),
            ],
        );

        assert_eq!(
            cycle.current().expect("current").address.entity_id,
            "survey-point"
        );
        assert_eq!(
            cycle
                .cycle(PickCycleDirection::Forward)
                .expect("next")
                .address
                .entity_id,
            "cad-line"
        );
        assert_eq!(
            cycle
                .cycle(PickCycleDirection::Backward)
                .expect("previous")
                .address
                .entity_id,
            "survey-point"
        );
    }

    #[test]
    fn world_mutation_invalidates_async_candidate_stack() {
        let mut cycle = PickCycle::new();
        cycle.replace(10, vec![candidate("point", SnapKind::Point, 0.0)]);
        cycle.invalidate_if_stale(11);

        assert!(cycle.current().is_none());
    }

    #[test]
    fn distinct_endpoints_of_one_segment_survive_candidate_deduplication() {
        let mut first = candidate("line", SnapKind::Vertex, 1.0);
        first.world_position.x = -5.0;
        let mut second = candidate("line", SnapKind::Vertex, 1.0);
        second.world_position.x = 5.0;
        let mut duplicate = second.clone();
        duplicate.pixel_distance = 2.0;
        let mut cycle = PickCycle::new();

        cycle.replace(1, vec![first, second, duplicate]);

        assert_eq!(cycle.candidates().len(), 2);
        assert_ne!(
            cycle.candidates()[0].world_position.x,
            cycle.candidates()[1].world_position.x
        );
    }

    #[test]
    fn duplicate_pixels_are_removed_even_when_other_addresses_interleave_ranking() {
        let mut first = candidate("surface-a", SnapKind::Surface, 1.0);
        let middle = candidate("surface-b", SnapKind::Surface, 2.0);
        let mut duplicate = first.clone();
        duplicate.pixel_distance = 3.0;
        first.depth = 0.2;
        duplicate.depth = 0.3;
        let mut cycle = PickCycle::new();

        cycle.replace(1, vec![duplicate, middle, first]);

        assert_eq!(cycle.candidates().len(), 2);
        assert_eq!(cycle.candidates()[0].address.entity_id, "surface-a");
        assert_eq!(cycle.candidates()[0].pixel_distance, 1.0);
    }

    #[test]
    fn rgba8_pick_encoding_preserves_all_32_bits_per_identifier() {
        let token = PickToken {
            proxy_slot: 0xFEDC_BA98,
            primitive_slot: 0x7654_3210,
        };
        let (proxy, primitive) = token.encode_rgba8();

        assert_eq!(PickToken::decode_rgba8(proxy, primitive), token);
    }

    #[test]
    fn presentation_transform_round_trips_and_rejects_flattening() {
        let transform = PresentationTransform::new(2.0, 500.0).expect("invertible");
        let source = WorldVec3 {
            x: 6_378_137.125,
            y: 5_400_000.25,
            z: 503.75,
        };
        let presented = transform.present(source);

        assert_eq!(presented.x, source.x);
        assert_eq!(presented.y, source.y);
        assert_eq!(presented.z, 507.5);
        assert_eq!(transform.source(presented), source);
        assert_eq!(
            PresentationTransform::new(0.0, 500.0),
            Err(PresentationTransformError::NonInvertibleExaggeration)
        );
        assert_eq!(
            PresentationTransform::new(-1.0, 500.0),
            Err(PresentationTransformError::NonInvertibleExaggeration)
        );
    }

    #[test]
    #[allow(clippy::cast_possible_truncation)]
    fn gpu_depth_reconstructs_world_candidate_and_point_semantics() {
        let mut world = RenderWorld::new();
        let slot = world
            .insert_proxy(point_proxy())
            .expect("insert point proxy");
        let camera = CameraFrame::new(
            WorldCamera {
                eye: WorldVec3 {
                    x: 0.0,
                    y: 0.0,
                    z: 10.0,
                },
                target: WorldVec3 {
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                },
                up: WorldVec3 {
                    x: 0.0,
                    y: 1.0,
                    z: 0.0,
                },
                projection: CameraProjection::Orthographic {
                    vertical_span: 20.0,
                    aspect: 1.0,
                    near: 0.1,
                    far: 100.0,
                },
            },
            WorldVec3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
        )
        .expect("camera");
        let projected = camera.view_projection * glam::DVec4::new(0.0, 0.0, 0.0, 1.0);
        let depth = (projected.z / projected.w) as f32;
        let candidates = reconstruct_coarse_pick_candidates(
            &world,
            camera,
            [100, 100],
            [49, 49],
            &[GpuHitPixel {
                pixel: [49, 49],
                sample: GpuHitSample {
                    token: PickToken {
                        proxy_slot: slot,
                        primitive_slot: 12,
                    },
                    reverse_z_depth: depth,
                },
            }],
        )
        .expect("reconstruct");

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].snap_kind, SnapKind::Point);
        assert_eq!(candidates[0].address.primitive_id, Some(12));
        assert!(candidates[0].world_position.z.abs() < 1.0e-5);
    }

    #[test]
    fn point_refinement_returns_exact_source_coordinate_under_exaggeration() {
        let presentation = PresentationTransform::new(4.0, 500.0).expect("presentation");
        let source = WorldVec3 {
            x: 6_378_137.123_456_789,
            y: 5_400_000.234_567_891,
            z: 503.25,
        };
        let presented = presentation.present(source);
        let camera = CameraFrame::new(
            WorldCamera {
                eye: WorldVec3 {
                    z: presented.z + 10.0,
                    ..presented
                },
                target: presented,
                up: WorldVec3 {
                    x: 0.0,
                    y: 1.0,
                    z: 0.0,
                },
                projection: CameraProjection::Orthographic {
                    vertical_span: 20.0,
                    aspect: 1.0,
                    near: 0.1,
                    far: 100.0,
                },
            },
            source,
        )
        .expect("camera");
        let cursor = [50.0, 50.0];
        let mut coarse = candidate("survey-point", SnapKind::Point, 0.0);
        coarse.world_position = presented;
        coarse.address.primitive_id = Some(99);

        let refined = refine_exact_point_pick(
            PickRefinementRequest {
                coarse: &coarse,
                camera: &camera,
                cursor_ray: camera.cursor_ray(cursor, [100, 100]).expect("ray"),
                source_to_project: WorldTransform::IDENTITY,
                presentation_transform: presentation,
                cursor_pixel: cursor,
                viewport: [100, 100],
                pixel_tolerance: 2.0,
            },
            source,
        );

        assert_eq!(refined.len(), 1);
        assert_eq!(refined[0].world_position, source);
        assert_ne!(refined[0].world_position.z, presented.z);
        assert_eq!(refined[0].address.primitive_id, Some(0));
    }

    fn candidate(entity: &str, snap_kind: SnapKind, pixel_distance: f32) -> PickCandidate {
        PickCandidate {
            address: PickAddress {
                entity_id: entity.to_owned(),
                render_proxy_id: format!("{entity}-proxy"),
                dataset_id: None,
                tile_id: None,
                primitive_id: Some(0),
            },
            world_position: WorldVec3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
            snap_kind,
            pixel_distance,
            depth: 0.5,
        }
    }

    fn point_proxy() -> RenderProxy {
        RenderProxy {
            id: RenderProxyId("survey-point-proxy".to_owned()),
            entity_id: "survey-point".to_owned(),
            kind: RenderProxyKind::Points,
            bounds: BoundingVolume::AxisAlignedBox {
                bounds: WorldAabb {
                    min: WorldVec3 {
                        x: 0.0,
                        y: 0.0,
                        z: 0.0,
                    },
                    max: WorldVec3 {
                        x: 0.0,
                        y: 0.0,
                        z: 0.0,
                    },
                },
            },
            dataset_id: None,
            tile_id: None,
            style: RenderStyle::default(),
            cost: ResourceCost::default(),
            visible: true,
            locked: false,
        }
    }
}
