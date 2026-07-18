//! Format-neutral frustum culling and screen-space-error hierarchy selection.

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::sync::Arc;

use glam::DVec3;
use serde::{Deserialize, Serialize};

use crate::{
    BoundingVolume, CameraProjection, ClipOperation, ClipVolume, HierarchyPageReference,
    HierarchySource, PresentationTransform, RefinementMode, TileDescriptor, TileId, TileKey,
    WorldAabb, WorldCamera, WorldTransform, WorldVec3,
};

/// Current lifecycle state of all visual contents attached to one tile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TileResidency {
    /// No content request has started.
    Unloaded,
    /// Compressed bytes are being fetched.
    Requested,
    /// Content is decoded on the CPU but not yet uploaded completely.
    Decoded,
    /// Every visual content required by this tile is GPU-resident.
    Resident,
    /// The latest load attempt failed and awaits explicit retry policy.
    Failed,
}

/// Camera and quality parameters for one hierarchy traversal.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileSelectionView {
    /// Authoritative f64 project-world camera.
    pub camera: WorldCamera,
    /// Physical viewport width in pixels.
    pub viewport_width: u32,
    /// Physical viewport height in pixels.
    pub viewport_height: u32,
    /// Baseline maximum acceptable geometric error in physical pixels.
    pub maximum_screen_space_error: f64,
    /// Runtime detail multiplier; values above one request finer hierarchy levels.
    pub detail_scale: f64,
    /// Hard work bound protecting the UI thread from malformed or enormous trees.
    pub maximum_traversed_nodes: usize,
    /// Maximum unloaded request candidates retained after exact traversal.
    /// Active and resident contents are never removed by this frontier.
    pub maximum_unloaded_candidates: usize,
}

/// One visible tile whose content participates in residency planning.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedTile {
    /// Globally unique tile address.
    pub key: TileKey,
    /// Projected geometric error at selection time.
    pub screen_space_error: f64,
    /// Current content lifecycle state.
    pub residency: TileResidency,
    /// Provider descriptor retained for request, decode and proxy construction.
    pub descriptor: Arc<TileDescriptor>,
}

/// A visible hierarchy page needed before refinement can continue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HierarchyPageRequest {
    /// Tile that owns the lazy child page.
    pub owner: TileKey,
    /// Range-addressable page reference.
    pub reference: HierarchyPageReference,
}

/// Deterministic output shared by Potree, 3D Tiles, raster and splat providers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileSelection {
    /// Visible contents wanted by the residency pipeline, ordered by descending SSE.
    pub wanted: Vec<SelectedTile>,
    /// Resident tiles that may be drawn without violating ADD/REPLACE fallback rules.
    pub render: Vec<TileKey>,
    /// Lazy hierarchy pages required to make a later traversal complete.
    pub hierarchy_pages: Vec<HierarchyPageRequest>,
    /// Number of descriptors inspected.
    pub traversed_nodes: usize,
    /// Number of descriptors rejected by the view frustum or active clip volumes.
    pub culled_nodes: usize,
    /// Whether the traversal stopped at its explicit work bound.
    pub work_limit_reached: bool,
}

/// Invalid view state or provider hierarchy failure.
#[derive(Debug)]
pub enum TileSelectionError<E> {
    /// Camera, viewport, SSE threshold or work limit is invalid.
    InvalidView,
    /// A child or root identity was declared but has no descriptor.
    MissingTile(TileId),
    /// Provider-specific hierarchy access failed.
    Hierarchy(E),
}

impl<E: Display> Display for TileSelectionError<E> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidView => formatter.write_str("invalid tile-selection view"),
            Self::MissingTile(id) => write!(formatter, "hierarchy tile is missing: {}", id.0),
            Self::Hierarchy(error) => write!(formatter, "hierarchy access failed: {error}"),
        }
    }
}

impl<E: Error + 'static> Error for TileSelectionError<E> {}

/// Stateless, format-neutral hierarchy selector.
#[derive(Debug, Default)]
pub struct TileSelector;

impl TileSelector {
    /// Traverses one dataset without examining source primitives.
    ///
    /// `residency` must be a lock-free snapshot lookup; no request or upload is
    /// started during traversal. The resulting `wanted` set is admitted globally
    /// with candidates from every other dataset.
    pub fn select<S, F>(
        source: &mut S,
        view: TileSelectionView,
        residency: F,
    ) -> Result<TileSelection, TileSelectionError<S::Error>>
    where
        S: HierarchySource,
        F: Fn(&TileKey) -> TileResidency,
    {
        Self::select_with_clips(source, view, &[], residency)
    }

    /// Traverses one dataset and conservatively rejects hierarchy branches
    /// wholly removed by the active world-space clip volumes.
    pub fn select_with_clips<S, F>(
        source: &mut S,
        view: TileSelectionView,
        clip_volumes: &[ClipVolume],
        residency: F,
    ) -> Result<TileSelection, TileSelectionError<S::Error>>
    where
        S: HierarchySource,
        F: Fn(&TileKey) -> TileResidency,
    {
        Self::select_with_clips_and_presentation(
            source,
            view,
            clip_volumes,
            PresentationTransform::IDENTITY,
            residency,
        )
    }

    /// Traverses with camera/SSE bounds transformed into presentation space.
    ///
    /// Clip volumes deliberately continue to evaluate source-world geometry:
    /// vertical exaggeration is display state and must not move Civil cut
    /// heights or measurement boundaries.
    pub fn select_with_clips_and_presentation<S, F>(
        source: &mut S,
        view: TileSelectionView,
        clip_volumes: &[ClipVolume],
        presentation: PresentationTransform,
        residency: F,
    ) -> Result<TileSelection, TileSelectionError<S::Error>>
    where
        S: HierarchySource,
        F: Fn(&TileKey) -> TileResidency,
    {
        Self::select_with_clips_and_transforms(
            source,
            view,
            clip_volumes,
            WorldTransform::IDENTITY,
            presentation,
            residency,
        )
    }

    /// Traverses with provider-source placement followed by view presentation.
    ///
    /// Project clip volumes evaluate placed source geometry; frustum and SSE
    /// evaluate the same geometry after presentation-only exaggeration.
    pub fn select_with_clips_and_transforms<S, F>(
        source: &mut S,
        view: TileSelectionView,
        clip_volumes: &[ClipVolume],
        source_to_project: WorldTransform,
        presentation: PresentationTransform,
        residency: F,
    ) -> Result<TileSelection, TileSelectionError<S::Error>>
    where
        S: HierarchySource,
        F: Fn(&TileKey) -> TileResidency,
    {
        if !source_to_project.is_invertible_affine() {
            return Err(TileSelectionError::InvalidView);
        }
        let camera = SelectionCamera::new(view).ok_or(TileSelectionError::InvalidView)?;
        let dataset_id = source.dataset_id().clone();
        let roots = source.roots().to_vec();
        let mut context = SelectionContext {
            source,
            dataset_id,
            residency: &residency,
            camera,
            source_to_project,
            presentation,
            clip_volumes,
            maximum_nodes: view.maximum_traversed_nodes,
            wanted: Vec::new(),
            unloaded_candidates: Vec::new(),
            maximum_unloaded_candidates: view.maximum_unloaded_candidates,
            hierarchy_pages: BTreeMap::new(),
            traversed_nodes: 0,
            culled_nodes: 0,
            work_limit_reached: false,
        };
        let mut render = Vec::new();
        for root in roots {
            render.extend(context.visit(&root)?.render);
        }
        let mut wanted = context.wanted;
        retain_best_unloaded(
            &mut context.unloaded_candidates,
            view.maximum_unloaded_candidates,
        );
        wanted.append(&mut context.unloaded_candidates);
        wanted.sort_by(wanted_order);
        let render = render
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        Ok(TileSelection {
            wanted,
            render,
            hierarchy_pages: context.hierarchy_pages.into_values().collect(),
            traversed_nodes: context.traversed_nodes,
            culled_nodes: context.culled_nodes,
            work_limit_reached: context.work_limit_reached,
        })
    }
}

fn wanted_order(left: &SelectedTile, right: &SelectedTile) -> std::cmp::Ordering {
    right
        .screen_space_error
        .total_cmp(&left.screen_space_error)
        .then_with(|| left.key.cmp(&right.key))
}

fn retain_best_unloaded(candidates: &mut Vec<SelectedTile>, limit: usize) {
    if candidates.len() <= limit {
        return;
    }
    candidates.select_nth_unstable_by(limit, wanted_order);
    candidates.truncate(limit);
}

struct SelectionContext<'a, S, F> {
    source: &'a mut S,
    dataset_id: crate::DatasetId,
    residency: &'a F,
    camera: SelectionCamera,
    source_to_project: WorldTransform,
    presentation: PresentationTransform,
    clip_volumes: &'a [ClipVolume],
    maximum_nodes: usize,
    wanted: Vec<SelectedTile>,
    unloaded_candidates: Vec<SelectedTile>,
    maximum_unloaded_candidates: usize,
    hierarchy_pages: BTreeMap<TileKey, HierarchyPageRequest>,
    traversed_nodes: usize,
    culled_nodes: usize,
    work_limit_reached: bool,
}

#[derive(Default)]
struct BranchSelection {
    render: Vec<TileKey>,
    covered: bool,
}

impl<S, F> SelectionContext<'_, S, F>
where
    S: HierarchySource,
    F: Fn(&TileKey) -> TileResidency,
{
    fn visit(&mut self, id: &TileId) -> Result<BranchSelection, TileSelectionError<S::Error>> {
        if self.traversed_nodes >= self.maximum_nodes {
            self.work_limit_reached = true;
            return Ok(BranchSelection::default());
        }
        self.traversed_nodes += 1;
        let descriptor = self
            .source
            .shared_tile(id)
            .map_err(TileSelectionError::Hierarchy)?
            .ok_or_else(|| TileSelectionError::MissingTile(id.clone()))?;
        let placed_bounds = transform_bounding_volume(&descriptor.bounds, self.source_to_project)
            .ok_or(TileSelectionError::InvalidView)?;
        let source_sphere = bounding_sphere(&placed_bounds);
        let presented_sphere = presented_bounding_sphere(&placed_bounds, self.presentation);
        if !self.camera.visible(presented_sphere)
            || sphere_is_clipped(source_sphere, self.clip_volumes)
        {
            self.culled_nodes += 1;
            return Ok(BranchSelection {
                render: Vec::new(),
                covered: true,
            });
        }
        let key = TileKey {
            dataset_id: self.dataset_id.clone(),
            tile_id: descriptor.id.clone(),
        };
        let placement_scale = self
            .source_to_project
            .maximum_linear_scale()
            .ok_or(TileSelectionError::InvalidView)?;
        let screen_space_error = self.camera.screen_space_error(
            descriptor.geometric_error * placement_scale * self.presentation.maximum_linear_scale(),
            presented_sphere,
        );
        let wants_refinement = screen_space_error > self.camera.maximum_sse
            && (!descriptor.children.is_empty() || descriptor.child_page.is_some());
        if !wants_refinement || self.traversed_nodes >= self.maximum_nodes {
            if wants_refinement {
                self.work_limit_reached = true;
            }
            return Ok(self.select_content(key, descriptor, screen_space_error));
        }

        let page_missing = descriptor.child_page.is_some();
        if let Some(reference) = descriptor.child_page.clone() {
            self.hierarchy_pages.insert(
                key.clone(),
                HierarchyPageRequest {
                    owner: key.clone(),
                    reference,
                },
            );
        }
        let mut children = BranchSelection {
            render: Vec::new(),
            covered: !page_missing,
        };
        for child in &descriptor.children {
            let selected = self.visit(child)?;
            children.covered &= selected.covered;
            children.render.extend(selected.render);
        }
        let own = self.select_content(key, Arc::clone(&descriptor), screen_space_error);
        match descriptor.refinement {
            RefinementMode::Add => {
                let mut render = own.render;
                render.extend(children.render);
                Ok(BranchSelection {
                    render,
                    covered: own.covered && children.covered,
                })
            }
            RefinementMode::Replace if children.covered => Ok(children),
            RefinementMode::Replace if own.covered => Ok(own),
            RefinementMode::Replace => {
                let mut render = own.render;
                render.extend(children.render);
                Ok(BranchSelection {
                    render,
                    covered: false,
                })
            }
        }
    }

    fn select_content(
        &mut self,
        key: TileKey,
        descriptor: Arc<TileDescriptor>,
        screen_space_error: f64,
    ) -> BranchSelection {
        if descriptor.contents.is_empty() {
            return BranchSelection {
                render: Vec::new(),
                covered: descriptor.child_page.is_none(),
            };
        }
        let residency = (self.residency)(&key);
        let selected = SelectedTile {
            key: key.clone(),
            screen_space_error,
            residency,
            descriptor,
        };
        if residency == TileResidency::Unloaded {
            self.unloaded_candidates.push(selected);
            if self.unloaded_candidates.len() >= self.maximum_unloaded_candidates.saturating_mul(2)
            {
                retain_best_unloaded(
                    &mut self.unloaded_candidates,
                    self.maximum_unloaded_candidates,
                );
            }
        } else {
            self.wanted.push(selected);
        }
        if residency == TileResidency::Resident {
            BranchSelection {
                render: vec![key],
                covered: true,
            }
        } else {
            BranchSelection {
                render: Vec::new(),
                covered: false,
            }
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Sphere {
    center: DVec3,
    radius: f64,
}

#[derive(Debug, Clone, Copy)]
struct SelectionCamera {
    eye: DVec3,
    right: DVec3,
    up: DVec3,
    forward: DVec3,
    projection: CameraProjection,
    viewport_height: f64,
    maximum_sse: f64,
}

impl SelectionCamera {
    fn new(view: TileSelectionView) -> Option<Self> {
        if view.viewport_width == 0
            || view.viewport_height == 0
            || !view.maximum_screen_space_error.is_finite()
            || view.maximum_screen_space_error <= 0.0
            || !view.detail_scale.is_finite()
            || view.detail_scale <= 0.0
            || view.maximum_traversed_nodes == 0
            || view.maximum_unloaded_candidates == 0
        {
            return None;
        }
        let eye = vector(view.camera.eye);
        let target = vector(view.camera.target);
        let supplied_up = vector(view.camera.up);
        let forward = (target - eye).try_normalize()?;
        let right = forward.cross(supplied_up).try_normalize()?;
        let up = right.cross(forward).try_normalize()?;
        if !valid_projection(view.camera.projection) {
            return None;
        }
        Some(Self {
            eye,
            right,
            up,
            forward,
            projection: view.camera.projection,
            viewport_height: f64::from(view.viewport_height),
            maximum_sse: view.maximum_screen_space_error / view.detail_scale,
        })
    }

    fn visible(self, sphere: Sphere) -> bool {
        let relative = sphere.center - self.eye;
        let x = relative.dot(self.right);
        let y = relative.dot(self.up);
        let depth = relative.dot(self.forward);
        match self.projection {
            CameraProjection::Perspective {
                vertical_fov_radians,
                aspect,
                near,
                far,
            } => {
                let vertical = vertical_fov_radians * 0.5;
                let horizontal = (vertical.tan() * aspect).atan();
                depth + sphere.radius >= near
                    && depth - sphere.radius <= far
                    && x.abs() * horizontal.cos() <= depth * horizontal.sin() + sphere.radius
                    && y.abs() * vertical.cos() <= depth * vertical.sin() + sphere.radius
            }
            CameraProjection::Orthographic {
                vertical_span,
                aspect,
                near,
                far,
            } => {
                let half_height = vertical_span * 0.5;
                let half_width = half_height * aspect;
                depth + sphere.radius >= near
                    && depth - sphere.radius <= far
                    && x.abs() <= half_width + sphere.radius
                    && y.abs() <= half_height + sphere.radius
            }
        }
    }

    fn screen_space_error(self, geometric_error: f64, sphere: Sphere) -> f64 {
        if geometric_error <= 0.0 {
            return 0.0;
        }
        match self.projection {
            CameraProjection::Perspective {
                vertical_fov_radians,
                near,
                ..
            } => {
                let distance = (sphere.center - self.eye).length() - sphere.radius;
                let denominator = 2.0 * vertical_fov_radians.mul_add(0.5, 0.0).tan();
                geometric_error * self.viewport_height / (distance.max(near) * denominator)
            }
            CameraProjection::Orthographic { vertical_span, .. } => {
                geometric_error * self.viewport_height / vertical_span
            }
        }
    }
}

fn valid_projection(projection: CameraProjection) -> bool {
    match projection {
        CameraProjection::Perspective {
            vertical_fov_radians,
            aspect,
            near,
            far,
        } => {
            vertical_fov_radians.is_finite()
                && vertical_fov_radians > 0.0
                && vertical_fov_radians < std::f64::consts::PI
                && aspect.is_finite()
                && aspect > 0.0
                && near.is_finite()
                && near > 0.0
                && far.is_finite()
                && far > near
        }
        CameraProjection::Orthographic {
            vertical_span,
            aspect,
            near,
            far,
        } => {
            vertical_span.is_finite()
                && vertical_span > 0.0
                && aspect.is_finite()
                && aspect > 0.0
                && near.is_finite()
                && far.is_finite()
                && far > near
        }
    }
}

/// Places one provider bound into canonical project world without rewriting source geometry.
#[must_use]
pub fn transform_bounding_volume(
    bounds: &BoundingVolume,
    source_to_project: WorldTransform,
) -> Option<BoundingVolume> {
    match bounds {
        BoundingVolume::AxisAlignedBox { bounds } => {
            let minimum = vector(bounds.min);
            let maximum = vector(bounds.max);
            let center = world((minimum + maximum) * 0.5);
            let half = (maximum - minimum) * 0.5;
            Some(BoundingVolume::OrientedBox {
                center: source_to_project.transform_point(center)?,
                half_axes: [
                    source_to_project.transform_vector(WorldVec3 {
                        x: half.x,
                        y: 0.0,
                        z: 0.0,
                    })?,
                    source_to_project.transform_vector(WorldVec3 {
                        x: 0.0,
                        y: half.y,
                        z: 0.0,
                    })?,
                    source_to_project.transform_vector(WorldVec3 {
                        x: 0.0,
                        y: 0.0,
                        z: half.z,
                    })?,
                ],
            })
        }
        BoundingVolume::OrientedBox { center, half_axes } => Some(BoundingVolume::OrientedBox {
            center: source_to_project.transform_point(*center)?,
            half_axes: [
                source_to_project.transform_vector(half_axes[0])?,
                source_to_project.transform_vector(half_axes[1])?,
                source_to_project.transform_vector(half_axes[2])?,
            ],
        }),
        BoundingVolume::Sphere { center, radius } => Some(BoundingVolume::Sphere {
            center: source_to_project.transform_point(*center)?,
            radius: radius * source_to_project.maximum_linear_scale()?,
        }),
        BoundingVolume::GeodeticRegion {
            west,
            south,
            east,
            north,
            minimum_height,
            maximum_height,
        } => {
            let mut minimum = DVec3::splat(f64::INFINITY);
            let mut maximum = DVec3::splat(f64::NEG_INFINITY);
            for longitude in [*west, *east] {
                for latitude in [*south, *north] {
                    for height in [*minimum_height, *maximum_height] {
                        let source = geodetic_to_ecef(longitude, latitude, height);
                        let placed = vector(source_to_project.transform_point(world(source))?);
                        minimum = minimum.min(placed);
                        maximum = maximum.max(placed);
                    }
                }
            }
            Some(BoundingVolume::AxisAlignedBox {
                bounds: WorldAabb {
                    min: world(minimum),
                    max: world(maximum),
                },
            })
        }
    }
}

fn bounding_sphere(bounds: &BoundingVolume) -> Sphere {
    match bounds {
        BoundingVolume::AxisAlignedBox { bounds } => {
            let minimum = vector(bounds.min);
            let maximum = vector(bounds.max);
            Sphere {
                center: (minimum + maximum) * 0.5,
                radius: (maximum - minimum).length() * 0.5,
            }
        }
        BoundingVolume::OrientedBox { center, half_axes } => {
            oriented_box_sphere(*center, *half_axes, PresentationTransform::IDENTITY)
        }
        BoundingVolume::Sphere { center, radius } => Sphere {
            center: vector(*center),
            radius: *radius,
        },
        BoundingVolume::GeodeticRegion {
            west,
            south,
            east,
            north,
            minimum_height,
            maximum_height,
        } => region_sphere(
            *west,
            *south,
            *east,
            *north,
            *minimum_height,
            *maximum_height,
        ),
    }
}

fn presented_bounding_sphere(
    bounds: &BoundingVolume,
    presentation: PresentationTransform,
) -> Sphere {
    match bounds {
        BoundingVolume::AxisAlignedBox { bounds } => {
            let minimum = vector(presentation.present(bounds.min));
            let maximum = vector(presentation.present(bounds.max));
            Sphere {
                center: (minimum + maximum) * 0.5,
                radius: (maximum - minimum).length() * 0.5,
            }
        }
        BoundingVolume::OrientedBox { center, half_axes } => {
            oriented_box_sphere(*center, *half_axes, presentation)
        }
        BoundingVolume::Sphere { center, radius } => Sphere {
            center: vector(presentation.present(*center)),
            radius: *radius * presentation.maximum_linear_scale(),
        },
        BoundingVolume::GeodeticRegion {
            west,
            south,
            east,
            north,
            minimum_height,
            maximum_height,
        } => region_sphere_with_presentation(
            *west,
            *south,
            *east,
            *north,
            *minimum_height,
            *maximum_height,
            presentation,
        ),
    }
}

fn oriented_box_sphere(
    center: WorldVec3,
    half_axes: [WorldVec3; 3],
    presentation: PresentationTransform,
) -> Sphere {
    let source_center = vector(center);
    let presented_center = vector(presentation.present(center));
    let axes = half_axes.map(vector);
    let mut radius = 0.0_f64;
    for x_sign in [-1.0, 1.0] {
        for y_sign in [-1.0, 1.0] {
            for z_sign in [-1.0, 1.0] {
                let corner = source_center + axes[0] * x_sign + axes[1] * y_sign + axes[2] * z_sign;
                radius = radius
                    .max((vector(presentation.present(world(corner))) - presented_center).length());
            }
        }
    }
    Sphere {
        center: presented_center,
        radius,
    }
}

fn region_sphere_with_presentation(
    west: f64,
    south: f64,
    east: f64,
    north: f64,
    minimum_height: f64,
    maximum_height: f64,
    presentation: PresentationTransform,
) -> Sphere {
    let mut corners = Vec::with_capacity(8);
    for longitude in [west, east] {
        for latitude in [south, north] {
            for height in [minimum_height, maximum_height] {
                let source = geodetic_to_ecef(longitude, latitude, height);
                corners.push(vector(presentation.present(WorldVec3 {
                    x: source.x,
                    y: source.y,
                    z: source.z,
                })));
            }
        }
    }
    let center = corners.iter().copied().sum::<DVec3>() / 8.0;
    let radius = corners
        .iter()
        .map(|corner| (*corner - center).length())
        .fold(0.0_f64, f64::max);
    Sphere { center, radius }
}

fn region_sphere(
    west: f64,
    south: f64,
    east: f64,
    north: f64,
    minimum_height: f64,
    maximum_height: f64,
) -> Sphere {
    let mut corners = Vec::with_capacity(8);
    for longitude in [west, east] {
        for latitude in [south, north] {
            for height in [minimum_height, maximum_height] {
                corners.push(geodetic_to_ecef(longitude, latitude, height));
            }
        }
    }
    let center = corners.iter().copied().sum::<DVec3>() / 8.0;
    let radius = corners
        .iter()
        .map(|corner| (*corner - center).length())
        .fold(0.0_f64, f64::max);
    Sphere { center, radius }
}

fn geodetic_to_ecef(longitude: f64, latitude: f64, height: f64) -> DVec3 {
    const SEMI_MAJOR: f64 = 6_378_137.0;
    const ECCENTRICITY_SQUARED: f64 = 6.694_379_990_14e-3;
    let sin_latitude = latitude.sin();
    let cos_latitude = latitude.cos();
    let normal = SEMI_MAJOR / (1.0 - ECCENTRICITY_SQUARED * sin_latitude * sin_latitude).sqrt();
    DVec3::new(
        (normal + height) * cos_latitude * longitude.cos(),
        (normal + height) * cos_latitude * longitude.sin(),
        (normal * (1.0 - ECCENTRICITY_SQUARED) + height) * sin_latitude,
    )
}

fn vector(value: WorldVec3) -> DVec3 {
    DVec3::new(value.x, value.y, value.z)
}

fn world(value: DVec3) -> WorldVec3 {
    WorldVec3 {
        x: value.x,
        y: value.y,
        z: value.z,
    }
}

fn sphere_is_clipped(sphere: Sphere, volumes: &[ClipVolume]) -> bool {
    volumes
        .iter()
        .filter(|volume| volume.enabled)
        .any(|volume| match volume.operation {
            ClipOperation::KeepInside => volume.planes.iter().any(|plane| {
                let normal = vector(plane.normal);
                normal.dot(sphere.center) + plane.distance < -sphere.radius * normal.length()
            }),
            ClipOperation::RemoveInside => volume.planes.iter().all(|plane| {
                let normal = vector(plane.normal);
                normal.dot(sphere.center) + plane.distance >= sphere.radius * normal.length()
            }),
        })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{presented_bounding_sphere, TileResidency, TileSelectionView, TileSelector};
    use crate::{
        BoundingVolume, CameraProjection, ClipOperation, ClipPlane, ClipVolume, ClipVolumeId,
        ContentKind, ContentReference, DatasetId, HierarchySource, PresentationTransform,
        RefinementMode, TileDescriptor, TileId, WorldAabb, WorldCamera, WorldTransform, WorldVec3,
    };

    struct Source {
        dataset: DatasetId,
        roots: Vec<TileId>,
        tiles: BTreeMap<TileId, TileDescriptor>,
    }

    impl HierarchySource for Source {
        type Error = std::convert::Infallible;

        fn dataset_id(&self) -> &DatasetId {
            &self.dataset
        }

        fn roots(&self) -> &[TileId] {
            &self.roots
        }

        fn tile(&mut self, id: &TileId) -> Result<Option<TileDescriptor>, Self::Error> {
            Ok(self.tiles.get(id).cloned())
        }
    }

    fn descriptor(
        id: &str,
        center_x: f64,
        error: f64,
        refinement: RefinementMode,
    ) -> TileDescriptor {
        TileDescriptor {
            id: TileId(id.to_owned()),
            parent: (id != "root").then(|| TileId("root".to_owned())),
            children: Vec::new(),
            bounds: BoundingVolume::AxisAlignedBox {
                bounds: WorldAabb {
                    min: WorldVec3 {
                        x: center_x - 1.0,
                        y: -1.0,
                        z: -1.0,
                    },
                    max: WorldVec3 {
                        x: center_x + 1.0,
                        y: 1.0,
                        z: 1.0,
                    },
                },
            },
            content_transform: WorldTransform::IDENTITY,
            geometric_error: error,
            refinement,
            contents: vec![ContentReference {
                kind: ContentKind::Gltf,
                uri: format!("{id}.glb"),
                byte_offset: None,
                byte_length: Some(100),
                primitive_count: Some(10),
                content_hash: None,
                decoder_parameters: None,
            }],
            child_page: None,
            provider_metadata: None,
        }
    }

    fn source(refinement: RefinementMode) -> Source {
        let mut root = descriptor("root", 20.0, 10.0, refinement);
        root.children = vec![TileId("near".to_owned()), TileId("outside".to_owned())];
        let near = descriptor("near", 20.0, 0.1, refinement);
        let outside = descriptor("outside", -20.0, 0.1, refinement);
        Source {
            dataset: DatasetId("dataset".to_owned()),
            roots: vec![TileId("root".to_owned())],
            tiles: [
                (root.id.clone(), root),
                (near.id.clone(), near),
                (outside.id.clone(), outside),
            ]
            .into_iter()
            .collect(),
        }
    }

    fn view(projection: CameraProjection) -> TileSelectionView {
        TileSelectionView {
            camera: WorldCamera {
                eye: WorldVec3 {
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                },
                target: WorldVec3 {
                    x: 1.0,
                    y: 0.0,
                    z: 0.0,
                },
                up: WorldVec3 {
                    x: 0.0,
                    y: 0.0,
                    z: 1.0,
                },
                projection,
            },
            viewport_width: 1_000,
            viewport_height: 1_000,
            maximum_screen_space_error: 4.0,
            detail_scale: 1.0,
            maximum_traversed_nodes: 100,
            maximum_unloaded_candidates: 100,
        }
    }

    fn perspective() -> CameraProjection {
        CameraProjection::Perspective {
            vertical_fov_radians: std::f64::consts::FRAC_PI_2,
            aspect: 1.0,
            near: 0.1,
            far: 1_000.0,
        }
    }

    #[test]
    fn replace_keeps_resident_parent_until_visible_child_is_resident() {
        let mut source = source(RefinementMode::Replace);
        let selection = TileSelector::select(&mut source, view(perspective()), |key| {
            if key.tile_id.0 == "root" {
                TileResidency::Resident
            } else {
                TileResidency::Unloaded
            }
        })
        .expect("valid hierarchy");

        assert_eq!(selection.render.len(), 1);
        assert_eq!(selection.render[0].tile_id.0, "root");
        assert!(selection
            .wanted
            .iter()
            .any(|tile| tile.key.tile_id.0 == "near"));
        assert_eq!(selection.culled_nodes, 1);
    }

    #[test]
    fn replace_switches_atomically_when_selected_child_is_resident() {
        let mut source = source(RefinementMode::Replace);
        let selection = TileSelector::select(&mut source, view(perspective()), |key| {
            if key.tile_id.0 == "outside" {
                TileResidency::Unloaded
            } else {
                TileResidency::Resident
            }
        })
        .expect("valid hierarchy");

        assert_eq!(selection.render.len(), 1);
        assert_eq!(selection.render[0].tile_id.0, "near");
    }

    #[test]
    fn additive_refinement_draws_parent_and_resident_child_together() {
        let mut source = source(RefinementMode::Add);
        let selection = TileSelector::select(&mut source, view(perspective()), |_| {
            TileResidency::Resident
        })
        .expect("valid hierarchy");

        assert_eq!(selection.render.len(), 2);
        assert!(selection.render.iter().any(|key| key.tile_id.0 == "root"));
        assert!(selection.render.iter().any(|key| key.tile_id.0 == "near"));
    }

    #[test]
    fn unloaded_frontier_keeps_highest_sse_without_dropping_active_fallbacks() {
        let mut bounded_view = view(perspective());
        bounded_view.maximum_unloaded_candidates = 1;

        let mut unloaded_source = source(RefinementMode::Add);
        let unloaded = TileSelector::select(&mut unloaded_source, bounded_view, |_| {
            TileResidency::Unloaded
        })
        .expect("bounded unloaded selection");
        assert_eq!(unloaded.wanted.len(), 1);
        assert_eq!(unloaded.wanted[0].key.tile_id.0, "root");

        let mut fallback_source = source(RefinementMode::Add);
        let fallback = TileSelector::select(&mut fallback_source, bounded_view, |key| {
            if key.tile_id.0 == "root" {
                TileResidency::Resident
            } else {
                TileResidency::Unloaded
            }
        })
        .expect("bounded fallback selection");
        assert_eq!(fallback.wanted.len(), 2);
        assert!(fallback
            .wanted
            .iter()
            .any(|tile| tile.key.tile_id.0 == "root"));
        assert!(fallback
            .wanted
            .iter()
            .any(|tile| tile.key.tile_id.0 == "near"));
    }

    #[test]
    fn orthographic_sse_is_independent_of_camera_distance() {
        let orthographic = CameraProjection::Orthographic {
            vertical_span: 100.0,
            aspect: 1.0,
            near: 0.0,
            far: 1_000.0,
        };
        let mut first = source(RefinementMode::Replace);
        let a = TileSelector::select(&mut first, view(orthographic), |_| TileResidency::Resident)
            .expect("valid hierarchy");
        let mut second = source(RefinementMode::Replace);
        for tile in second.tiles.values_mut() {
            if let BoundingVolume::AxisAlignedBox { bounds } = &mut tile.bounds {
                bounds.min.x += 200.0;
                bounds.max.x += 200.0;
            }
        }
        let b = TileSelector::select(&mut second, view(orthographic), |_| TileResidency::Resident)
            .expect("valid hierarchy");

        let first_near = a
            .wanted
            .iter()
            .find(|tile| tile.key.tile_id.0 == "near")
            .expect("near tile selected");
        let second_near = b
            .wanted
            .iter()
            .find(|tile| tile.key.tile_id.0 == "near")
            .expect("near tile selected");
        assert!(
            (first_near.screen_space_error - second_near.screen_space_error).abs() < f64::EPSILON
        );
    }

    #[test]
    fn keep_inside_clip_rejects_a_wholly_outside_hierarchy_branch() {
        let mut source = source(RefinementMode::Replace);
        let clip = clip(ClipOperation::KeepInside, 30.0, true);
        let selection =
            TileSelector::select_with_clips(&mut source, view(perspective()), &[clip], |_| {
                TileResidency::Resident
            })
            .expect("valid hierarchy");

        assert!(selection.wanted.is_empty());
        assert!(selection.render.is_empty());
        assert_eq!(selection.traversed_nodes, 1);
        assert_eq!(selection.culled_nodes, 1);
    }

    #[test]
    fn remove_inside_clip_rejects_only_wholly_contained_branches() {
        let mut source = source(RefinementMode::Replace);
        let clip = clip(ClipOperation::RemoveInside, 10.0, true);
        let selection =
            TileSelector::select_with_clips(&mut source, view(perspective()), &[clip], |_| {
                TileResidency::Resident
            })
            .expect("valid hierarchy");

        assert!(selection.wanted.is_empty());
        assert!(selection.render.is_empty());
        assert_eq!(selection.traversed_nodes, 1);
        assert_eq!(selection.culled_nodes, 1);
    }

    #[test]
    fn disabled_clip_volume_does_not_affect_selection() {
        let mut source = source(RefinementMode::Replace);
        let clip = clip(ClipOperation::KeepInside, 30.0, false);
        let selection =
            TileSelector::select_with_clips(&mut source, view(perspective()), &[clip], |_| {
                TileResidency::Resident
            })
            .expect("valid hierarchy");

        assert!(!selection.wanted.is_empty());
        assert!(!selection.render.is_empty());
    }

    #[test]
    fn exaggerated_bounds_drive_visibility_while_clips_remain_in_source_space() {
        let mut root = descriptor("root", 0.0, 0.1, RefinementMode::Replace);
        root.parent = None;
        let mut source = Source {
            dataset: DatasetId("exaggerated".to_owned()),
            roots: vec![root.id.clone()],
            tiles: [(root.id.clone(), root)].into_iter().collect(),
        };
        let view = TileSelectionView {
            camera: WorldCamera {
                eye: WorldVec3 {
                    x: -100.0,
                    y: 0.0,
                    z: 30.0,
                },
                target: WorldVec3 {
                    x: 0.0,
                    y: 0.0,
                    z: 30.0,
                },
                up: WorldVec3 {
                    x: 0.0,
                    y: 0.0,
                    z: 1.0,
                },
                projection: CameraProjection::Orthographic {
                    vertical_span: 4.0,
                    aspect: 1.0,
                    near: 0.1,
                    far: 1_000.0,
                },
            },
            viewport_width: 1_000,
            viewport_height: 1_000,
            maximum_screen_space_error: 4.0,
            detail_scale: 1.0,
            maximum_traversed_nodes: 10,
            maximum_unloaded_candidates: 10,
        };
        let source_height_clip = ClipVolume {
            id: ClipVolumeId("source-height".to_owned()),
            planes: vec![ClipPlane {
                normal: WorldVec3 {
                    x: 0.0,
                    y: 0.0,
                    z: -1.0,
                },
                distance: 2.0,
            }],
            operation: ClipOperation::KeepInside,
            preview_cap: false,
            section_fill_resource: None,
            section_material_hatches: BTreeMap::new(),
            enabled: true,
        };
        let presentation = PresentationTransform::new(4.0, -10.0).expect("presentation");

        let selection = TileSelector::select_with_clips_and_presentation(
            &mut source,
            view,
            &[source_height_clip],
            presentation,
            |_| TileResidency::Resident,
        )
        .expect("presented hierarchy");

        assert_eq!(selection.culled_nodes, 0);
        assert_eq!(selection.render.len(), 1);
        assert_eq!(selection.wanted.len(), 1);
    }

    #[test]
    fn exaggerated_geometric_error_requests_conservative_display_detail() {
        let mut root = descriptor("root", 0.0, 1.0, RefinementMode::Replace);
        root.parent = None;
        let build_source = || Source {
            dataset: DatasetId("exaggerated-sse".to_owned()),
            roots: vec![root.id.clone()],
            tiles: [(root.id.clone(), root.clone())].into_iter().collect(),
        };
        let mut selection_view = view(CameraProjection::Orthographic {
            vertical_span: 100.0,
            aspect: 1.0,
            near: 0.0,
            far: 1_000.0,
        });
        selection_view.camera.eye.z = 30.0;
        selection_view.camera.target.z = 30.0;
        let mut identity_source = build_source();
        let identity = TileSelector::select(&mut identity_source, selection_view, |_| {
            TileResidency::Resident
        })
        .expect("identity hierarchy");
        let mut exaggerated_source = build_source();
        let exaggerated = TileSelector::select_with_clips_and_presentation(
            &mut exaggerated_source,
            selection_view,
            &[],
            PresentationTransform::new(4.0, -10.0).expect("presentation"),
            |_| TileResidency::Resident,
        )
        .expect("presented hierarchy");

        assert!(
            (exaggerated.wanted[0].screen_space_error
                - identity.wanted[0].screen_space_error * 4.0)
                .abs()
                < f64::EPSILON
        );
    }

    #[test]
    fn flat_civil_aabb_exaggerates_only_its_vertical_extent() {
        let bounds = BoundingVolume::AxisAlignedBox {
            bounds: WorldAabb {
                min: WorldVec3 {
                    x: -500.0,
                    y: -500.0,
                    z: 99.0,
                },
                max: WorldVec3 {
                    x: 500.0,
                    y: 500.0,
                    z: 101.0,
                },
            },
        };
        let sphere = presented_bounding_sphere(
            &bounds,
            PresentationTransform::new(10.0, 100.0).expect("presentation"),
        );

        assert!((sphere.center.z - 100.0).abs() < f64::EPSILON);
        assert!((sphere.radius - 500.0_f64.hypot(500.0).hypot(10.0)).abs() < 1.0e-9);
        assert!(sphere.radius < 708.0);
    }

    #[test]
    fn entity_placement_drives_visibility_and_project_space_clipping() {
        let mut root = descriptor("root", -20.0, 0.1, RefinementMode::Replace);
        root.parent = None;
        let build_source = || Source {
            dataset: DatasetId("placed".to_owned()),
            roots: vec![root.id.clone()],
            tiles: [(root.id.clone(), root.clone())].into_iter().collect(),
        };
        let translated = WorldTransform([
            1.0, 0.0, 0.0, 0.0, // X axis
            0.0, 1.0, 0.0, 0.0, // Y axis
            0.0, 0.0, 1.0, 0.0, // Z axis
            40.0, 0.0, 0.0, 1.0, // Translation
        ]);
        let project_clip = clip(ClipOperation::KeepInside, 10.0, true);

        let mut unplaced_source = build_source();
        let unplaced = TileSelector::select_with_clips_and_transforms(
            &mut unplaced_source,
            view(perspective()),
            &[project_clip.clone()],
            WorldTransform::IDENTITY,
            PresentationTransform::IDENTITY,
            |_| TileResidency::Resident,
        )
        .expect("unplaced hierarchy");
        let mut placed_source = build_source();
        let placed = TileSelector::select_with_clips_and_transforms(
            &mut placed_source,
            view(perspective()),
            &[project_clip],
            translated,
            PresentationTransform::IDENTITY,
            |_| TileResidency::Resident,
        )
        .expect("placed hierarchy");

        assert!(unplaced.render.is_empty());
        assert_eq!(placed.render.len(), 1);
        assert_eq!(placed.culled_nodes, 0);
    }

    #[test]
    fn entity_scale_conservatively_increases_streaming_detail() {
        let mut root = descriptor("root", 20.0, 1.0, RefinementMode::Replace);
        root.parent = None;
        let build_source = || Source {
            dataset: DatasetId("scaled".to_owned()),
            roots: vec![root.id.clone()],
            tiles: [(root.id.clone(), root.clone())].into_iter().collect(),
        };
        let scale = WorldTransform([
            3.0, 0.0, 0.0, 0.0, // X axis
            0.0, 2.0, 0.0, 0.0, // Y axis
            0.0, 0.0, 1.5, 0.0, // Z axis
            0.0, 0.0, 0.0, 1.0, // Translation
        ]);
        let mut identity_source = build_source();
        let identity = TileSelector::select_with_clips_and_transforms(
            &mut identity_source,
            view(CameraProjection::Orthographic {
                vertical_span: 100.0,
                aspect: 1.0,
                near: 0.0,
                far: 1_000.0,
            }),
            &[],
            WorldTransform::IDENTITY,
            PresentationTransform::IDENTITY,
            |_| TileResidency::Resident,
        )
        .expect("identity hierarchy");
        let mut scaled_source = build_source();
        let scaled = TileSelector::select_with_clips_and_transforms(
            &mut scaled_source,
            view(CameraProjection::Orthographic {
                vertical_span: 100.0,
                aspect: 1.0,
                near: 0.0,
                far: 1_000.0,
            }),
            &[],
            scale,
            PresentationTransform::IDENTITY,
            |_| TileResidency::Resident,
        )
        .expect("scaled hierarchy");

        assert!(scaled.wanted[0].screen_space_error >= identity.wanted[0].screen_space_error * 3.0);
    }

    fn clip(operation: ClipOperation, minimum_x: f64, enabled: bool) -> ClipVolume {
        ClipVolume {
            id: ClipVolumeId("selection-clip".to_owned()),
            planes: vec![ClipPlane {
                normal: WorldVec3 {
                    x: 1.0,
                    y: 0.0,
                    z: 0.0,
                },
                distance: -minimum_x,
            }],
            operation,
            preview_cap: false,
            section_fill_resource: None,
            section_material_hatches: std::collections::BTreeMap::new(),
            enabled,
        }
    }
}
