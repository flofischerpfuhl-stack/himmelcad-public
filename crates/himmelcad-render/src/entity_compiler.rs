//! Canonical geometry compilation into shared GPU batches and proxy metadata.

use std::collections::{BTreeMap, BTreeSet};

use glam::{DMat3, DMat4, DVec3};
use himmelcad_core::canonical_resources::CanonicalResourceRef;
use himmelcad_core::entity::EntityId;
use himmelcad_core::entity_model::{
    AlignmentGeometry, CsgNode, CurveGeometry, ElevationSurfaceGeometry, GeometryObject, Position,
    SlopeRule, SolidGeometry, SolidPrimitive, StationFunction, Transform3d, TriangleMeshGeometry,
    TriangleMeshStorage, Vector3, VerticalAlignmentSegment,
};
use himmelcad_core::entity_validation::{validate_geometry_object, EntityValidationError};
use himmelcad_core::hash::ObjectHash;
use thiserror::Error;

use crate::{
    build_cad_area_batches, build_cad_curve_batch_with_width, tessellate_area, tessellate_curve,
    AreaFillMode, BoundingVolume, CadAreaError, CadCurveError, CurveTessellationOptions,
    FloatingOrigin, GpuAlphaMode, GpuDrawBatch, GpuFrameError, GpuMeshVertexInput,
    GpuPresentationStyle, GpuSharedRenderer, GpuTextureData, RenderProxyKind, RenderStyle,
    ResourceCost, TessellatedArea, TessellatedCurve, TessellatedCurvePath, TessellatedCurveSegment,
    UnresolvedHeightDisplay, WorldAabb, WorldVec3, GPU_POINT_VERTEX_STRIDE_BYTES,
};

/// View-dependent choices that never alter canonical geometry.
#[derive(Debug, Clone, PartialEq)]
pub struct EntityCompilationOptions {
    /// Stable f64 world coordinate represented by render-local zero.
    pub floating_origin: FloatingOrigin,
    /// Explicit view-only handling of source positions with unknown Z.
    pub unresolved_height: UnresolvedHeightDisplay,
    /// Maximum analytic-curve chord error in project units.
    pub chord_tolerance: f64,
    /// Hard upper bound for one analytic tessellation.
    pub maximum_curve_segments: u32,
    /// CAD stroke diameter in physical viewport pixels.
    pub line_width: f32,
    /// Half-length of the two construction-plane display axes in project units.
    pub plane_extent: f64,
    /// Whether spatially resolved areas receive a fill batch.
    pub fill_areas: bool,
    /// View style resolved without changing source buffers.
    pub style: RenderStyle,
    /// World Z used as the exaggeration fixed point.
    pub exaggeration_datum: f64,
    /// Optional entity-level local-to-project placement.
    pub placement: Option<Transform3d>,
}

/// One compiled render proxy part sharing the global pick namespace.
#[derive(Debug)]
pub struct CompiledEntityPart {
    /// Pipeline class used for frame ordering and exact pick semantics.
    pub kind: RenderProxyKind,
    /// Conservative f64 world bounds after entity placement.
    pub bounds: BoundingVolume,
    /// Complete estimated resident cost for admission policy.
    pub cost: ResourceCost,
    /// Resident production GPU batch.
    pub batch: GpuDrawBatch,
    /// Additional draw batches sharing this proxy and exact pick namespace.
    ///
    /// Canonical per-triangle material slots are compiled into immutable,
    /// compact batches. They deliberately remain one render proxy so material
    /// partitioning cannot change entity or primitive identity.
    pub additional_batches: Vec<GpuDrawBatch>,
    /// Exact canonical material-table revision used by this mesh part.
    pub source_material_table: Option<CanonicalResourceRef>,
}

/// One immutable, f64-authoritative slope surface evaluated outside the render core.
///
/// `SlopeRule` does not identify which width-band edge is the authored source
/// edge and does not pin a target-surface revision. The render core therefore
/// never invents daylight geometry from the rule alone. An authoritative civil
/// evaluator returns this target-version-bound representation instead.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedAlignmentSlopeGeometry {
    /// Rule that produced this representation.
    pub rule_id: String,
    /// Width band used by the evaluator; must equal the authored rule binding.
    pub source_band_id: String,
    /// Target elevation/TIN entity used by the evaluator.
    pub target_surface: EntityId,
    /// Immutable target-surface revision used by the evaluator.
    pub target_surface_version: ObjectHash,
    /// SHA-256 of the canonical serialized `mesh`, checked by the render core.
    pub geometry_version: ObjectHash,
    /// Evaluated open slope surface in the requesting alignment's local frame.
    pub mesh: TriangleMeshGeometry,
}

/// Validation, representation or GPU failure during canonical compilation.
#[derive(Debug, Error)]
pub enum EntityCompilationError {
    /// Canonical geometry invariants failed before any GPU allocation.
    #[error("invalid canonical geometry: {0}")]
    Validation(#[from] EntityValidationError),
    /// Geometry is valid but needs a provider or parametric evaluator not supplied here.
    #[error("canonical geometry requires an unavailable compiler: {0}")]
    Unsupported(&'static str),
    /// An associative slope rule has no authoritative evaluated representation.
    #[error(
        "alignment slope rule {rule_id} has no resolved geometry for target surface {target_surface:?}"
    )]
    UnresolvedAlignmentSlope {
        /// Stable authored rule identifier.
        rule_id: String,
        /// Authored target-surface entity identifier.
        target_surface: EntityId,
    },
    /// A resolver returned geometry that is not bound to the exact authored rule.
    #[error("resolved alignment slope rule {rule_id} is invalid: {reason}")]
    InvalidAlignmentSlopeResolution {
        /// Stable authored rule identifier.
        rule_id: String,
        /// Static contract violation suitable for deterministic diagnostics.
        reason: &'static str,
    },
    /// The caller supplied the wrong number of non-zero global pick slots.
    #[error("canonical geometry requires {expected} pick slots, received {actual}")]
    PickSlots {
        /// Exact required slot count.
        expected: usize,
        /// Supplied slot count.
        actual: usize,
    },
    /// Analytic curve compilation failed.
    #[error(transparent)]
    Curve(#[from] CadCurveError),
    /// Area topology or fill compilation failed.
    #[error(transparent)]
    Area(#[from] CadAreaError),
    /// GPU batch or style validation failed.
    #[error(transparent)]
    Gpu(#[from] GpuFrameError),
}

/// Returns the exact global pick slots needed by a supported geometry object.
pub fn required_entity_proxy_slots(
    geometry: &GeometryObject,
    fill_areas: bool,
) -> Result<usize, EntityCompilationError> {
    validate_geometry_object(geometry)?;
    // Complex solids can be resolved to an immutable closed mesh by the
    // geometry evaluator before entering this backend-neutral compiler.
    match geometry {
        GeometryObject::Point { .. }
        | GeometryObject::Curve { .. }
        | GeometryObject::Plane { .. }
        | GeometryObject::Text { .. }
        | GeometryObject::Surface3d { .. }
        | GeometryObject::Solid { .. }
        | GeometryObject::RasterImage { .. }
        | GeometryObject::Panorama { .. }
        // Namespaced extensions are compiled from one immutable evaluated mesh
        // by the host without changing or interpreting their preserved payload.
        | GeometryObject::Extension { .. } => Ok(1),
        GeometryObject::Alignment { alignment } => Ok(1 + alignment.slope_rules.len()),
        GeometryObject::Area { .. } => Ok(if fill_areas { 2 } else { 1 }),
        GeometryObject::ElevationSurface { surface } => match surface.as_ref() {
            ElevationSurfaceGeometry::Tin { breaklines, .. } => {
                Ok(1 + usize::from(!breaklines.is_empty()))
            }
            ElevationSurfaceGeometry::Grid { .. } => Err(EntityCompilationError::Unsupported(
                "elevation grid provider",
            )),
        },
        GeometryObject::PointCloud { .. } => Err(EntityCompilationError::Unsupported(
            "point-cloud stream provider",
        )),
        GeometryObject::GaussianSplatCloud { .. } => Err(EntityCompilationError::Unsupported(
            "Gaussian-splat stream provider",
        )),
        GeometryObject::Block { .. } => Err(EntityCompilationError::Unsupported(
            "block definition resolver",
        )),
        GeometryObject::Label { label } => Ok(1 + usize::from(label.leader.len() >= 2)),
        // The shared host resolves associative anchors and immutable annotation
        // styles before submitting the two ordinary text/stroke parts.
        GeometryObject::Dimension { .. } => Ok(2),
    }
}

/// Compiles supported inline canonical geometry through the production pipelines.
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
pub fn compile_entity_geometry(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &GpuSharedRenderer,
    label: &str,
    geometry: &GeometryObject,
    pick_slots: &[u32],
    options: &EntityCompilationOptions,
) -> Result<Vec<CompiledEntityPart>, EntityCompilationError> {
    compile_entity_geometry_with_associations(
        device,
        queue,
        renderer,
        label,
        geometry,
        pick_slots,
        options,
        |_entity_id, _expected_version| None,
    )
}

/// Compiles canonical geometry while resolving associative area boundaries
/// from the authoritative resident entity graph supplied by the caller.
/// Returned curves must already be expressed in the area's local frame; hosts
/// must reject or explicitly transform incompatible entity placements.
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
pub fn compile_entity_geometry_with_associations<F>(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &GpuSharedRenderer,
    label: &str,
    geometry: &GeometryObject,
    pick_slots: &[u32],
    options: &EntityCompilationOptions,
    mut resolve_curve: F,
) -> Result<Vec<CompiledEntityPart>, EntityCompilationError>
where
    F: FnMut(&EntityId, Option<&ObjectHash>) -> Option<CurveGeometry>,
{
    compile_entity_geometry_with_complete_resolvers(
        device,
        queue,
        renderer,
        label,
        geometry,
        pick_slots,
        options,
        &mut resolve_curve,
        |_rule| None,
    )
}

/// Compiles canonical geometry with the complete associative resolver set.
///
/// Alignment slope rules require an immutable result from `resolve_slope`.
/// The render core validates its rule, target-surface provenance and geometry
/// hash before any GPU allocation; it does not derive civil semantics itself.
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
pub fn compile_entity_geometry_with_complete_resolvers<F, A>(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &GpuSharedRenderer,
    label: &str,
    geometry: &GeometryObject,
    pick_slots: &[u32],
    options: &EntityCompilationOptions,
    mut resolve_curve: F,
    mut resolve_slope: A,
) -> Result<Vec<CompiledEntityPart>, EntityCompilationError>
where
    F: FnMut(&EntityId, Option<&ObjectHash>) -> Option<CurveGeometry>,
    A: FnMut(&SlopeRule) -> Option<ResolvedAlignmentSlopeGeometry>,
{
    let expected = required_entity_proxy_slots(geometry, options.fill_areas)?;
    if pick_slots.len() != expected || pick_slots.contains(&0) {
        return Err(EntityCompilationError::PickSlots {
            expected,
            actual: pick_slots.len(),
        });
    }
    let transform = placement_matrix(options.placement)?;
    let curve_options = CurveTessellationOptions {
        chord_tolerance: options.chord_tolerance,
        maximum_segments: options.maximum_curve_segments,
        unresolved_height: options.unresolved_height,
    };
    let parts = match geometry {
        GeometryObject::Point { position } => {
            let position = resolve_entity_point_world(*position, options)?;
            let batch = GpuDrawBatch::new_points_with_queue(
                device,
                queue,
                label,
                pick_slots[0],
                &[options.floating_origin.world_to_render(position)],
                &[[255; 4]],
            )?;
            vec![part(
                RenderProxyKind::Points,
                bounds(std::iter::once(position))?,
                point_resource_cost(1),
                batch,
            )]
        }
        GeometryObject::Curve { curve } => {
            let curve = transformed_curve(tessellate_curve(curve, curve_options)?, transform);
            vec![curve_part(
                device,
                queue,
                label,
                pick_slots[0],
                &curve,
                options,
            )?]
        }
        GeometryObject::Alignment { alignment } => {
            let curve =
                transformed_curve(tessellate_alignment(alignment, curve_options)?, transform);
            let slopes = resolve_alignment_slopes(alignment, &mut resolve_slope)?;
            let mut parts = Vec::with_capacity(1 + slopes.len());
            parts.push(curve_part(
                device,
                queue,
                label,
                pick_slots[0],
                &curve,
                options,
            )?);
            for (index, slope) in slopes.iter().enumerate() {
                parts.push(mesh_part(
                    device,
                    queue,
                    &format!("{label}-slope-{}", slope.rule_id),
                    pick_slots[index + 1],
                    &slope.mesh,
                    transform,
                    options,
                )?);
            }
            parts
        }
        GeometryObject::Area { area } => {
            let fill_mode = if options.fill_areas {
                AreaFillMode::TriangulateResolved
            } else {
                AreaFillMode::BoundaryOnly
            };
            let area = transformed_area(
                tessellate_area(area, curve_options, fill_mode, &mut resolve_curve)?,
                transform,
            );
            let batches = build_cad_area_batches(
                device,
                queue,
                label,
                pick_slots[0],
                pick_slots.get(1).copied().unwrap_or(pick_slots[0]),
                options.floating_origin,
                [1.0; 4],
                [1.0; 4],
                options.line_width,
                &area,
            )?;
            let boundary_positions = area
                .boundary
                .segments
                .iter()
                .flat_map(|segment| [segment.start, segment.end]);
            let mut parts = vec![part(
                RenderProxyKind::CadStroke,
                bounds(boundary_positions)?,
                ResourceCost {
                    gpu_buffer_bytes: u64::try_from(area.boundary.segments.len())
                        .unwrap_or(u64::MAX)
                        .saturating_mul(64),
                    draw_calls: 1,
                    ..ResourceCost::default()
                },
                batches.boundary,
            )];
            if let (Some(fill), Some(batch)) = (area.fill, batches.fill) {
                parts.push(part(
                    RenderProxyKind::CadFill,
                    bounds(fill.vertices.iter().copied())?,
                    ResourceCost {
                        gpu_buffer_bytes: u64::try_from(fill.vertices.len())
                            .unwrap_or(u64::MAX)
                            .saturating_mul(32),
                        triangles: u64::try_from(fill.indices.len() / 3).unwrap_or(u64::MAX),
                        draw_calls: 1,
                        ..ResourceCost::default()
                    },
                    batch,
                ));
            }
            parts
        }
        GeometryObject::Plane { plane } => {
            if !options.plane_extent.is_finite() || options.plane_extent <= 0.0 {
                return Err(EntityCompilationError::Unsupported("plane display extent"));
            }
            let normal = model_vec(plane.normal).normalize();
            let reference = if normal.z.abs() < 0.9 {
                DVec3::Z
            } else {
                DVec3::X
            };
            let axis_x = reference.cross(normal).normalize();
            let axis_y = normal.cross(axis_x).normalize();
            let center = model_vec(plane.origin);
            let curve = TessellatedCurve {
                segments: vec![
                    TessellatedCurveSegment {
                        start: world_vec(transform_point(
                            transform,
                            center - axis_x * options.plane_extent,
                        )),
                        end: world_vec(transform_point(
                            transform,
                            center + axis_x * options.plane_extent,
                        )),
                        primitive_slot: 0,
                    },
                    TessellatedCurveSegment {
                        start: world_vec(transform_point(
                            transform,
                            center - axis_y * options.plane_extent,
                        )),
                        end: world_vec(transform_point(
                            transform,
                            center + axis_y * options.plane_extent,
                        )),
                        primitive_slot: 1,
                    },
                ],
                semantic_snaps: Vec::new(),
                paths: vec![
                    TessellatedCurvePath {
                        first_segment: 0,
                        segment_count: 1,
                        closed: false,
                    },
                    TessellatedCurvePath {
                        first_segment: 1,
                        segment_count: 1,
                        closed: false,
                    },
                ],
            };
            vec![curve_part(
                device,
                queue,
                label,
                pick_slots[0],
                &curve,
                options,
            )?]
        }
        GeometryObject::Surface3d { mesh } => {
            vec![mesh_part(
                device,
                queue,
                label,
                pick_slots[0],
                mesh,
                transform,
                options,
            )?]
        }
        GeometryObject::Solid { solid } => {
            let generated;
            let (mesh, solid_transform) = match solid.as_ref() {
                SolidGeometry::ClosedMesh { mesh } => (mesh, transform),
                solid => {
                    let Some((mesh, local_transform)) =
                        tessellate_generated_solid_mesh(solid, curve_options)?
                    else {
                        return Err(EntityCompilationError::Unsupported(
                            "exact BRep, Boolean CSG or sweep evaluator",
                        ));
                    };
                    generated = mesh;
                    let local_transform = placement_matrix(Some(local_transform))?;
                    (&generated, transform * local_transform)
                }
            };
            vec![mesh_part(
                device,
                queue,
                label,
                pick_slots[0],
                mesh,
                solid_transform,
                options,
            )?]
        }
        GeometryObject::ElevationSurface { surface } => {
            let ElevationSurfaceGeometry::Tin { mesh, breaklines } = surface.as_ref() else {
                return Err(EntityCompilationError::Unsupported(
                    "elevation grid provider",
                ));
            };
            let mut parts = vec![mesh_part(
                device,
                queue,
                label,
                pick_slots[0],
                mesh,
                transform,
                options,
            )?];
            if !breaklines.is_empty() {
                let compound = himmelcad_core::entity_model::CurveGeometry::Composite {
                    segments: breaklines.clone(),
                };
                let curve =
                    transformed_curve(tessellate_curve(&compound, curve_options)?, transform);
                parts.push(curve_part(
                    device,
                    queue,
                    &format!("{label}-breaklines"),
                    pick_slots[1],
                    &curve,
                    options,
                )?);
            }
            parts
        }
        _ => {
            return Err(EntityCompilationError::Unsupported(
                "external resource resolver",
            ));
        }
    };
    let gpu_style = GpuPresentationStyle::from_render_style(
        &options.style,
        options.floating_origin.world(),
        options.exaggeration_datum,
    )?;
    let alpha_mode = if options.style.opacity < 1.0 {
        GpuAlphaMode::Blend
    } else {
        GpuAlphaMode::Opaque
    };
    let material = renderer.create_styled_material(
        device,
        queue,
        &format!("{label}-style"),
        GpuTextureData {
            width: 1,
            height: 1,
            rgba8: &[255; 4],
        },
        alpha_mode,
        gpu_style,
    )?;
    Ok(parts
        .into_iter()
        .map(|part| CompiledEntityPart {
            kind: part.kind,
            bounds: part.bounds,
            cost: part.cost,
            batch: part.batch.with_material(material.clone()),
            additional_batches: part
                .additional_batches
                .into_iter()
                .map(|batch| batch.with_material(material.clone()))
                .collect(),
            source_material_table: part.source_material_table,
        })
        .collect())
}

/// Resolves the exact source-world coordinate used by point compilation and picking.
pub fn resolve_entity_point_world(
    position: Position,
    options: &EntityCompilationOptions,
) -> Result<WorldVec3, EntityCompilationError> {
    if !position.x.is_finite() || !position.y.is_finite() {
        return Err(CadCurveError::NonFinite.into());
    }
    let z = resolve_height(position.z, options.unresolved_height)?;
    if !z.is_finite() {
        return Err(CadCurveError::NonFinite.into());
    }
    let transform = placement_matrix(options.placement)?;
    Ok(world_vec(transform_point(
        transform,
        DVec3::new(position.x, position.y, z),
    )))
}

/// Recreates the exact f64 stroke representation used by supported inline CAD
/// entities for post-readback snapping. It deliberately shares tessellation
/// and placement semantics with compilation.
pub fn tessellate_entity_strokes(
    geometry: &GeometryObject,
    options: &EntityCompilationOptions,
) -> Result<Vec<TessellatedCurve>, EntityCompilationError> {
    tessellate_entity_strokes_with_associations(
        geometry,
        options,
        |_entity_id, _expected_version| None,
    )
}

/// Recreates exact strokes while resolving associative area boundaries with
/// the same version-aware callback used during GPU compilation. Returned
/// curves use the area's local frame.
pub fn tessellate_entity_strokes_with_associations<F>(
    geometry: &GeometryObject,
    options: &EntityCompilationOptions,
    mut resolve_curve: F,
) -> Result<Vec<TessellatedCurve>, EntityCompilationError>
where
    F: FnMut(&EntityId, Option<&ObjectHash>) -> Option<CurveGeometry>,
{
    tessellate_entity_strokes_with_complete_resolvers(
        geometry,
        options,
        &mut resolve_curve,
        |_rule| None,
    )
}

/// Recreates exact f64 strokes while validating every alignment slope result.
///
/// Slope meshes are filled surface parts rather than authored strokes, so they
/// are not returned here. Their resolver is still mandatory to keep snapping
/// and GPU compilation on the same complete associative entity snapshot.
pub fn tessellate_entity_strokes_with_complete_resolvers<F, A>(
    geometry: &GeometryObject,
    options: &EntityCompilationOptions,
    mut resolve_curve: F,
    mut resolve_slope: A,
) -> Result<Vec<TessellatedCurve>, EntityCompilationError>
where
    F: FnMut(&EntityId, Option<&ObjectHash>) -> Option<CurveGeometry>,
    A: FnMut(&SlopeRule) -> Option<ResolvedAlignmentSlopeGeometry>,
{
    validate_geometry_object(geometry)?;
    let transform = placement_matrix(options.placement)?;
    let curve_options = CurveTessellationOptions {
        chord_tolerance: options.chord_tolerance,
        maximum_segments: options.maximum_curve_segments,
        unresolved_height: options.unresolved_height,
    };
    match geometry {
        GeometryObject::Curve { curve } => Ok(vec![transformed_curve(
            tessellate_curve(curve, curve_options)?,
            transform,
        )]),
        GeometryObject::Alignment { alignment } => {
            resolve_alignment_slopes(alignment, &mut resolve_slope)?;
            Ok(vec![transformed_curve(
                tessellate_alignment(alignment, curve_options)?,
                transform,
            )])
        }
        GeometryObject::Area { area } => Ok(vec![transformed_curve(
            tessellate_area(
                area,
                curve_options,
                AreaFillMode::BoundaryOnly,
                &mut resolve_curve,
            )?
            .boundary,
            transform,
        )]),
        GeometryObject::Label { label } if label.leader.len() >= 2 => Ok(vec![transformed_curve(
            tessellate_curve(
                &himmelcad_core::entity_model::CurveGeometry::Polyline {
                    positions: label.leader.clone(),
                    closed: false,
                },
                curve_options,
            )?,
            transform,
        )]),
        _ => Ok(Vec::new()),
    }
}

fn curve_part(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &str,
    pick_slot: u32,
    curve: &TessellatedCurve,
    options: &EntityCompilationOptions,
) -> Result<CompiledEntityPart, EntityCompilationError> {
    let batch = build_cad_curve_batch_with_width(
        device,
        queue,
        label,
        pick_slot,
        options.floating_origin,
        [1.0; 4],
        options.line_width,
        curve,
    )?;
    let positions = curve
        .segments
        .iter()
        .flat_map(|segment| [segment.start, segment.end]);
    Ok(part(
        RenderProxyKind::CadStroke,
        bounds(positions)?,
        ResourceCost {
            gpu_buffer_bytes: u64::try_from(curve.segments.len())
                .unwrap_or(u64::MAX)
                .saturating_mul(64),
            draw_calls: 1,
            ..ResourceCost::default()
        },
        batch,
    ))
}

/// Tessellates the solid forms rendered directly by the shared compiler and
/// returns their additional solid-local placement.
///
/// `None` means the solid requires an external exact evaluator. Calling this
/// function for picking guarantees the same f64 mesh generator and tolerance
/// contract used for GPU compilation.
pub fn tessellate_generated_solid_mesh(
    solid: &SolidGeometry,
    curve_options: CurveTessellationOptions,
) -> Result<Option<(TriangleMeshGeometry, Transform3d)>, EntityCompilationError> {
    match solid {
        SolidGeometry::Csg {
            root:
                CsgNode::Primitive {
                    primitive,
                    placement,
                },
        } => Ok(Some((
            primitive_mesh(
                primitive,
                curve_options.chord_tolerance,
                curve_options.maximum_segments,
            )?,
            *placement,
        ))),
        SolidGeometry::Extrusion { profile, direction } => Ok(Some((
            extrusion_mesh(profile, *direction, curve_options)?,
            Transform3d::IDENTITY,
        ))),
        _ => Ok(None),
    }
}

pub(crate) fn primitive_mesh(
    primitive: &SolidPrimitive,
    chord_tolerance: f64,
    maximum_segments: u32,
) -> Result<TriangleMeshGeometry, CadCurveError> {
    match *primitive {
        SolidPrimitive::Box { size } => Ok(box_mesh(size)),
        SolidPrimitive::Sphere { radius } => {
            let segments = radial_segments(radius, chord_tolerance, maximum_segments)?;
            sphere_mesh(radius, segments)
        }
        SolidPrimitive::Cylinder { radius, height } => {
            let segments = radial_segments(radius, chord_tolerance, maximum_segments)?;
            frustum_mesh(radius, radius, height, segments)
        }
        SolidPrimitive::Cone {
            bottom_radius,
            top_radius,
            height,
        } => {
            let segments = radial_segments(
                bottom_radius.max(top_radius),
                chord_tolerance,
                maximum_segments,
            )?;
            frustum_mesh(bottom_radius, top_radius, height, segments)
        }
    }
}

fn radial_segments(
    radius: f64,
    chord_tolerance: f64,
    maximum_segments: u32,
) -> Result<u32, CadCurveError> {
    const MINIMUM_SEGMENTS: u32 = 12;
    const HARD_SEGMENT_LIMIT: u32 = 65_536;
    if !radius.is_finite()
        || radius <= 0.0
        || !chord_tolerance.is_finite()
        || chord_tolerance <= 0.0
        || maximum_segments < MINIMUM_SEGMENTS
    {
        return Err(CadCurveError::InvalidGeometry);
    }
    let cosine = (1.0 - chord_tolerance / radius).clamp(-1.0, 1.0);
    let angle = 2.0 * cosine.acos();
    if angle <= f64::EPSILON {
        return Err(CadCurveError::SegmentLimit);
    }
    let ceiling = maximum_segments.min(HARD_SEGMENT_LIMIT);
    let mut required = MINIMUM_SEGMENTS;
    while angle * f64::from(required) < std::f64::consts::TAU {
        required = required.checked_add(1).ok_or(CadCurveError::SegmentLimit)?;
        if required > ceiling {
            return Err(CadCurveError::SegmentLimit);
        }
    }
    Ok(required)
}

fn box_mesh(size: Vector3) -> TriangleMeshGeometry {
    let half = model_vec(size) * 0.5;
    let mut positions = Vec::with_capacity(24);
    let mut normals = Vec::with_capacity(24);
    let mut indices = Vec::with_capacity(36);
    let mut face = |corners: [DVec3; 4], normal: Vector3| {
        let base = u32::try_from(positions.len()).expect("box vertex count is bounded");
        positions.extend(corners.map(world_vec).map(|point| Vector3 {
            x: point.x,
            y: point.y,
            z: point.z,
        }));
        normals.extend([normal; 4]);
        indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
    };
    face(
        [
            DVec3::new(-half.x, -half.y, -half.z),
            DVec3::new(-half.x, half.y, -half.z),
            DVec3::new(half.x, half.y, -half.z),
            DVec3::new(half.x, -half.y, -half.z),
        ],
        Vector3 {
            x: 0.0,
            y: 0.0,
            z: -1.0,
        },
    );
    face(
        [
            DVec3::new(-half.x, -half.y, half.z),
            DVec3::new(half.x, -half.y, half.z),
            DVec3::new(half.x, half.y, half.z),
            DVec3::new(-half.x, half.y, half.z),
        ],
        Vector3 {
            x: 0.0,
            y: 0.0,
            z: 1.0,
        },
    );
    face(
        [
            DVec3::new(-half.x, -half.y, -half.z),
            DVec3::new(half.x, -half.y, -half.z),
            DVec3::new(half.x, -half.y, half.z),
            DVec3::new(-half.x, -half.y, half.z),
        ],
        Vector3 {
            x: 0.0,
            y: -1.0,
            z: 0.0,
        },
    );
    face(
        [
            DVec3::new(half.x, half.y, -half.z),
            DVec3::new(-half.x, half.y, -half.z),
            DVec3::new(-half.x, half.y, half.z),
            DVec3::new(half.x, half.y, half.z),
        ],
        Vector3 {
            x: 0.0,
            y: 1.0,
            z: 0.0,
        },
    );
    face(
        [
            DVec3::new(-half.x, half.y, -half.z),
            DVec3::new(-half.x, -half.y, -half.z),
            DVec3::new(-half.x, -half.y, half.z),
            DVec3::new(-half.x, half.y, half.z),
        ],
        Vector3 {
            x: -1.0,
            y: 0.0,
            z: 0.0,
        },
    );
    face(
        [
            DVec3::new(half.x, -half.y, -half.z),
            DVec3::new(half.x, half.y, -half.z),
            DVec3::new(half.x, half.y, half.z),
            DVec3::new(half.x, -half.y, half.z),
        ],
        Vector3 {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        },
    );
    inline_mesh(positions, indices, Some(normals))
}

fn sphere_mesh(radius: f64, segments: u32) -> Result<TriangleMeshGeometry, CadCurveError> {
    let stacks = (segments / 2).max(6);
    let vertex_count = 2_u64 + u64::from(stacks - 1) * u64::from(segments);
    if vertex_count > u64::from(u32::MAX) {
        return Err(CadCurveError::SegmentLimit);
    }
    let mut positions = Vec::with_capacity(usize::try_from(vertex_count).unwrap_or(usize::MAX));
    let mut normals = Vec::with_capacity(positions.capacity());
    positions.push(Vector3 {
        x: 0.0,
        y: 0.0,
        z: radius,
    });
    normals.push(Vector3 {
        x: 0.0,
        y: 0.0,
        z: 1.0,
    });
    for stack in 1..stacks {
        let theta = std::f64::consts::PI * f64::from(stack) / f64::from(stacks);
        for slice in 0..segments {
            let phi = std::f64::consts::TAU * f64::from(slice) / f64::from(segments);
            let normal = DVec3::new(
                theta.sin() * phi.cos(),
                theta.sin() * phi.sin(),
                theta.cos(),
            );
            positions.push(Vector3 {
                x: normal.x * radius,
                y: normal.y * radius,
                z: normal.z * radius,
            });
            normals.push(Vector3 {
                x: normal.x,
                y: normal.y,
                z: normal.z,
            });
        }
    }
    let bottom = u32::try_from(positions.len()).map_err(|_| CadCurveError::SegmentLimit)?;
    positions.push(Vector3 {
        x: 0.0,
        y: 0.0,
        z: -radius,
    });
    normals.push(Vector3 {
        x: 0.0,
        y: 0.0,
        z: -1.0,
    });
    let mut indices = Vec::new();
    for slice in 0..segments {
        let next = (slice + 1) % segments;
        indices.extend([0, 1 + slice, 1 + next]);
    }
    for stack in 0..stacks - 2 {
        let first = 1 + stack * segments;
        let next_ring = first + segments;
        for slice in 0..segments {
            let next = (slice + 1) % segments;
            let a = first + slice;
            let b = first + next;
            let c = next_ring + slice;
            let d = next_ring + next;
            indices.extend([a, c, b, b, c, d]);
        }
    }
    let last_ring = 1 + (stacks - 2) * segments;
    for slice in 0..segments {
        let next = (slice + 1) % segments;
        indices.extend([bottom, last_ring + next, last_ring + slice]);
    }
    Ok(inline_mesh(positions, indices, Some(normals)))
}

fn frustum_mesh(
    bottom_radius: f64,
    top_radius: f64,
    height: f64,
    segments: u32,
) -> Result<TriangleMeshGeometry, CadCurveError> {
    let capacity = usize::try_from(segments)
        .ok()
        .and_then(|segments| {
            segments
                .checked_mul(4)
                .and_then(|value| value.checked_add(6))
        })
        .ok_or(CadCurveError::SegmentLimit)?;
    let mut positions = Vec::with_capacity(capacity);
    let mut normals = Vec::with_capacity(capacity);
    let mut indices = Vec::new();
    for slice in 0..=segments {
        let phi = std::f64::consts::TAU * f64::from(slice % segments) / f64::from(segments);
        let normal = DVec3::new(
            height * phi.cos(),
            height * phi.sin(),
            bottom_radius - top_radius,
        )
        .normalize();
        positions.extend([
            Vector3 {
                x: bottom_radius * phi.cos(),
                y: bottom_radius * phi.sin(),
                z: 0.0,
            },
            Vector3 {
                x: top_radius * phi.cos(),
                y: top_radius * phi.sin(),
                z: height,
            },
        ]);
        let normal = Vector3 {
            x: normal.x,
            y: normal.y,
            z: normal.z,
        };
        normals.extend([normal; 2]);
    }
    for slice in 0..segments {
        let bottom = slice * 2;
        let top = bottom + 1;
        let next_bottom = bottom + 2;
        let next_top = bottom + 3;
        if top_radius <= f64::EPSILON {
            indices.extend([bottom, next_bottom, top]);
        } else if bottom_radius <= f64::EPSILON {
            indices.extend([bottom, next_top, top]);
        } else {
            indices.extend([bottom, next_bottom, top, next_bottom, next_top, top]);
        }
    }
    append_cap(
        &mut positions,
        &mut normals,
        &mut indices,
        bottom_radius,
        0.0,
        segments,
        false,
    )?;
    append_cap(
        &mut positions,
        &mut normals,
        &mut indices,
        top_radius,
        height,
        segments,
        true,
    )?;
    Ok(inline_mesh(positions, indices, Some(normals)))
}

fn append_cap(
    positions: &mut Vec<Vector3>,
    normals: &mut Vec<Vector3>,
    indices: &mut Vec<u32>,
    radius: f64,
    z: f64,
    segments: u32,
    top: bool,
) -> Result<(), CadCurveError> {
    if radius <= f64::EPSILON {
        return Ok(());
    }
    let center = u32::try_from(positions.len()).map_err(|_| CadCurveError::SegmentLimit)?;
    let normal = Vector3 {
        x: 0.0,
        y: 0.0,
        z: if top { 1.0 } else { -1.0 },
    };
    positions.push(Vector3 { x: 0.0, y: 0.0, z });
    normals.push(normal);
    for slice in 0..segments {
        let phi = std::f64::consts::TAU * f64::from(slice) / f64::from(segments);
        positions.push(Vector3 {
            x: radius * phi.cos(),
            y: radius * phi.sin(),
            z,
        });
        normals.push(normal);
    }
    for slice in 0..segments {
        let current = center + 1 + slice;
        let next = center + 1 + (slice + 1) % segments;
        if top {
            indices.extend([center, current, next]);
        } else {
            indices.extend([center, next, current]);
        }
    }
    Ok(())
}

pub(crate) fn extrusion_mesh(
    profile: &himmelcad_core::entity_model::AreaGeometry,
    direction: Vector3,
    curve_options: CurveTessellationOptions,
) -> Result<TriangleMeshGeometry, EntityCompilationError> {
    let area = tessellate_area(
        profile,
        curve_options,
        AreaFillMode::TriangulateResolved,
        |_id, _hash| None,
    )?;
    let fill = area.fill.ok_or(EntityCompilationError::Unsupported(
        "unresolved extrusion profile",
    ))?;
    let direction = model_vec(direction);
    let base_count = u32::try_from(fill.vertices.len()).map_err(|_| CadCurveError::SegmentLimit)?;
    let mut positions = Vec::with_capacity(
        fill.vertices
            .len()
            .saturating_mul(2)
            .saturating_add(area.boundary.segments.len().saturating_mul(4)),
    );
    positions.extend(fill.vertices.iter().map(|position| Vector3 {
        x: position.x,
        y: position.y,
        z: position.z,
    }));
    positions.extend(fill.vertices.iter().map(|position| {
        let position = world_dvec(*position) + direction;
        Vector3 {
            x: position.x,
            y: position.y,
            z: position.z,
        }
    }));
    let mut indices = Vec::with_capacity(
        fill.indices
            .len()
            .saturating_mul(2)
            .saturating_add(area.boundary.segments.len().saturating_mul(6)),
    );
    for triangle in fill.indices.chunks_exact(3) {
        indices.extend([triangle[0], triangle[2], triangle[1]]);
        indices.extend([
            triangle[0] + base_count,
            triangle[1] + base_count,
            triangle[2] + base_count,
        ]);
    }
    for segment in area.boundary.segments {
        let base = u32::try_from(positions.len()).map_err(|_| CadCurveError::SegmentLimit)?;
        let start = world_dvec(segment.start);
        let end = world_dvec(segment.end);
        positions.extend(
            [start, end, end + direction, start + direction].map(|position| Vector3 {
                x: position.x,
                y: position.y,
                z: position.z,
            }),
        );
        indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    Ok(inline_mesh(positions, indices, None))
}

fn inline_mesh(
    positions: Vec<Vector3>,
    indices: Vec<u32>,
    normals: Option<Vec<Vector3>>,
) -> TriangleMeshGeometry {
    TriangleMeshGeometry {
        storage: TriangleMeshStorage::Inline {
            positions,
            indices,
            normals,
            texture_coordinates: None,
        },
        closed_manifold: true,
        triangle_material_slots: None,
        materials: None,
    }
}

#[allow(clippy::cast_possible_truncation)]
fn mesh_part(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &str,
    pick_slot: u32,
    mesh: &TriangleMeshGeometry,
    transform: DMat4,
    options: &EntityCompilationOptions,
) -> Result<CompiledEntityPart, EntityCompilationError> {
    let TriangleMeshStorage::Inline {
        positions,
        indices,
        normals,
        texture_coordinates,
    } = &mesh.storage
    else {
        return Err(EntityCompilationError::Unsupported(
            "mesh resource provider",
        ));
    };
    let normal_matrix = DMat3::from_mat4(transform).inverse().transpose();
    let world_positions = positions
        .iter()
        .map(|position| transform_point(transform, model_vec(*position)))
        .map(world_vec)
        .collect::<Vec<_>>();
    let generated_normals = normals
        .is_none()
        .then(|| generated_vertex_normals(&world_positions, indices));
    let texture_coordinate_sets = texture_coordinates.as_deref().unwrap_or(&[]);
    let vertices = world_positions
        .iter()
        .enumerate()
        .map(|(index, position)| {
            let mut additional_tex_coords = [[0.0; 2]; 7];
            for (target, coordinates) in additional_tex_coords
                .iter_mut()
                .zip(texture_coordinate_sets.iter().skip(1))
            {
                if let Some(coordinates) = coordinates.get(index) {
                    *target = [coordinates[0] as f32, coordinates[1] as f32];
                }
            }
            GpuMeshVertexInput {
                position: options.floating_origin.world_to_render(*position),
                normal: normals
                    .as_ref()
                    .and_then(|normals| normals.get(index))
                    .map(|normal| {
                        let transformed = normal_matrix * model_vec(*normal);
                        let normalized = transformed.normalize_or_zero();
                        [
                            normalized.x as f32,
                            normalized.y as f32,
                            normalized.z as f32,
                        ]
                    })
                    .or_else(|| {
                        generated_normals
                            .as_ref()
                            .and_then(|generated| generated.get(index).copied())
                    })
                    .unwrap_or([0.0, 0.0, 1.0]),
                tex_coord: texture_coordinate_sets
                    .first()
                    .and_then(|coordinates| coordinates.get(index))
                    .map_or([0.0; 2], |coordinates| {
                        [coordinates[0] as f32, coordinates[1] as f32]
                    }),
                additional_tex_coords,
                color: [1.0; 4],
            }
        })
        .collect::<Vec<_>>();
    let material_slots = mesh
        .materials
        .as_ref()
        .map(|_| {
            mesh.triangle_material_slots
                .clone()
                .unwrap_or_else(|| vec![0; indices.len() / 3])
        })
        .unwrap_or_default();
    let mut material_batches = if material_slots.is_empty() {
        vec![GpuDrawBatch::new_indexed_mesh_with_queue(
            device,
            queue,
            label,
            pick_slot,
            0,
            &vertices,
            indices,
            options.style.opacity < 1.0,
        )?
        .with_declared_texture_coordinate_sets(
            u8::try_from(texture_coordinate_sets.len()).expect("validated UV-set count fits u8"),
        )]
    } else {
        compact_material_mesh_batches(
            device,
            queue,
            label,
            pick_slot,
            &vertices,
            indices,
            &material_slots,
            u8::try_from(texture_coordinate_sets.len()).expect("validated UV-set count fits u8"),
            options.style.opacity < 1.0,
        )?
    };
    let batch = material_batches.remove(0);
    let additional_batches = material_batches;
    let resident_vertex_count = vertices.len().saturating_add(
        additional_batches
            .iter()
            .map(GpuDrawBatch::vertex_count_usize)
            .sum::<usize>(),
    );
    let draw_calls = u32::try_from(1 + additional_batches.len()).unwrap_or(u32::MAX);
    Ok(part(
        RenderProxyKind::Triangles,
        bounds(world_positions.iter().copied())?,
        ResourceCost {
            gpu_buffer_bytes: u64::try_from(resident_vertex_count)
                .unwrap_or(u64::MAX)
                .saturating_mul(32),
            triangles: u64::try_from(indices.len() / 3).unwrap_or(u64::MAX),
            draw_calls,
            ..ResourceCost::default()
        },
        batch,
    )
    .with_additional_batches(additional_batches)
    .with_source_material_table(mesh.materials.clone()))
}

#[allow(clippy::too_many_arguments)]
fn compact_material_mesh_batches(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &str,
    pick_slot: u32,
    vertices: &[GpuMeshVertexInput],
    indices: &[u32],
    material_slots: &[u32],
    declared_texture_coordinate_sets: u8,
    transparent: bool,
) -> Result<Vec<GpuDrawBatch>, EntityCompilationError> {
    let mut groups = BTreeMap::<u32, (Vec<u32>, Vec<u32>)>::new();
    for (primitive_id, (triangle, material_slot)) in
        indices.chunks_exact(3).zip(material_slots).enumerate()
    {
        let primitive_id =
            u32::try_from(primitive_id).map_err(|_| GpuFrameError::TooManyVertices)?;
        let group = groups.entry(*material_slot).or_default();
        group.0.extend_from_slice(triangle);
        group.1.push(primitive_id);
    }
    let mut batches = Vec::with_capacity(groups.len());
    for (material_slot, (source_indices, primitive_ids)) in groups {
        let mut remap = BTreeMap::<u32, u32>::new();
        let mut compact_vertices = Vec::new();
        let mut compact_indices = Vec::with_capacity(source_indices.len());
        for source_index in source_indices {
            let compact_index = if let Some(index) = remap.get(&source_index) {
                *index
            } else {
                let index = u32::try_from(compact_vertices.len())
                    .map_err(|_| GpuFrameError::TooManyVertices)?;
                compact_vertices.push(
                    *vertices
                        .get(usize::try_from(source_index).expect("validated mesh index"))
                        .ok_or(GpuFrameError::InvalidMeshIndices)?,
                );
                remap.insert(source_index, index);
                index
            };
            compact_indices.push(compact_index);
        }
        batches.push(
            GpuDrawBatch::new_indexed_mesh_with_primitive_ids_with_queue(
                device,
                queue,
                &format!("{label}-material-{material_slot}"),
                pick_slot,
                &compact_vertices,
                &compact_indices,
                &primitive_ids,
                transparent,
            )?
            .with_declared_texture_coordinate_sets(declared_texture_coordinate_sets)
            .with_source_material_slot(material_slot),
        );
    }
    if batches.is_empty() {
        return Err(GpuFrameError::EmptyBatch.into());
    }
    Ok(batches)
}

#[allow(clippy::cast_possible_truncation)]
fn generated_vertex_normals(positions: &[WorldVec3], indices: &[u32]) -> Vec<[f32; 3]> {
    let mut normals = vec![DVec3::ZERO; positions.len()];
    for triangle in indices.chunks_exact(3) {
        let Some(a) = positions.get(triangle[0] as usize).copied() else {
            continue;
        };
        let Some(b) = positions.get(triangle[1] as usize).copied() else {
            continue;
        };
        let Some(c) = positions.get(triangle[2] as usize).copied() else {
            continue;
        };
        let normal = (world_dvec(b) - world_dvec(a)).cross(world_dvec(c) - world_dvec(a));
        for index in triangle {
            if let Some(accumulator) = normals.get_mut(*index as usize) {
                *accumulator += normal;
            }
        }
    }
    normals
        .into_iter()
        .map(|normal| {
            let normal = normal.normalize_or_zero();
            if normal == DVec3::ZERO {
                [0.0, 0.0, 1.0]
            } else {
                [normal.x as f32, normal.y as f32, normal.z as f32]
            }
        })
        .collect()
}

fn part(
    kind: RenderProxyKind,
    bounds: BoundingVolume,
    cost: ResourceCost,
    batch: GpuDrawBatch,
) -> CompiledEntityPart {
    CompiledEntityPart {
        kind,
        bounds,
        cost,
        batch,
        additional_batches: Vec::new(),
        source_material_table: None,
    }
}

impl CompiledEntityPart {
    fn with_additional_batches(mut self, batches: Vec<GpuDrawBatch>) -> Self {
        self.additional_batches = batches;
        self
    }

    fn with_source_material_table(mut self, table: Option<CanonicalResourceRef>) -> Self {
        self.source_material_table = table;
        self
    }
}

fn point_resource_cost(point_count: u64) -> ResourceCost {
    ResourceCost {
        gpu_buffer_bytes: point_count.saturating_mul(GPU_POINT_VERTEX_STRIDE_BYTES),
        points: point_count,
        draw_calls: u32::from(point_count != 0),
        ..ResourceCost::default()
    }
}

fn transformed_curve(mut curve: TessellatedCurve, transform: DMat4) -> TessellatedCurve {
    for segment in &mut curve.segments {
        segment.start = world_vec(transform_point(transform, world_dvec(segment.start)));
        segment.end = world_vec(transform_point(transform, world_dvec(segment.end)));
    }
    for semantic in &mut curve.semantic_snaps {
        semantic.position = world_vec(transform_point(transform, world_dvec(semantic.position)));
    }
    curve
}

/// Computes the checked content version required by an evaluated alignment slope.
///
/// Only inline f64 mesh geometry is accepted because an unresolved resource URI
/// is neither renderable here nor sufficient proof of immutable evaluated data.
pub fn alignment_slope_geometry_version(
    mesh: &TriangleMeshGeometry,
) -> Result<ObjectHash, EntityValidationError> {
    validate_geometry_object(&GeometryObject::Surface3d {
        mesh: Box::new(mesh.clone()),
    })?;
    if !matches!(mesh.storage, TriangleMeshStorage::Inline { .. }) {
        return Err(EntityValidationError::InvalidMesh);
    }
    let encoded = serde_json::to_vec(mesh).map_err(|_| EntityValidationError::InvalidMesh)?;
    Ok(ObjectHash::of_bytes(&encoded))
}

fn resolve_alignment_slopes<A>(
    alignment: &AlignmentGeometry,
    resolve_slope: &mut A,
) -> Result<Vec<ResolvedAlignmentSlopeGeometry>, EntityCompilationError>
where
    A: FnMut(&SlopeRule) -> Option<ResolvedAlignmentSlopeGeometry>,
{
    let mut rule_ids = BTreeSet::new();
    let band_ids = alignment
        .width_bands
        .iter()
        .map(|band| band.id.as_str())
        .collect::<BTreeSet<_>>();
    let mut resolved = Vec::with_capacity(alignment.slope_rules.len());
    for rule in &alignment.slope_rules {
        if !rule_ids.insert(rule.id.as_str()) {
            return Err(EntityCompilationError::InvalidAlignmentSlopeResolution {
                rule_id: rule.id.clone(),
                reason: "duplicate rule identifier",
            });
        }
        if !band_ids.contains(rule.source_band_id.as_str()) {
            return Err(EntityCompilationError::InvalidAlignmentSlopeResolution {
                rule_id: rule.id.clone(),
                reason: "source width band does not exist",
            });
        }
        let slope = resolve_slope(rule).ok_or_else(|| {
            EntityCompilationError::UnresolvedAlignmentSlope {
                rule_id: rule.id.clone(),
                target_surface: rule.target_surface.clone(),
            }
        })?;
        let invalid = if slope.rule_id != rule.id {
            Some("rule identifier mismatch")
        } else if slope.source_band_id != rule.source_band_id {
            Some("source width-band mismatch")
        } else if slope.target_surface != rule.target_surface {
            Some("target-surface mismatch")
        } else if !valid_sha256(slope.target_surface_version.as_str()) {
            Some("invalid target-surface version")
        } else if slope.mesh.closed_manifold {
            Some("derived slope surface must be an open mesh")
        } else {
            None
        };
        if let Some(reason) = invalid {
            return Err(EntityCompilationError::InvalidAlignmentSlopeResolution {
                rule_id: rule.id.clone(),
                reason,
            });
        }
        let geometry_version = alignment_slope_geometry_version(&slope.mesh).map_err(|_| {
            EntityCompilationError::InvalidAlignmentSlopeResolution {
                rule_id: rule.id.clone(),
                reason: "invalid or non-inline slope mesh",
            }
        })?;
        if geometry_version != slope.geometry_version {
            return Err(EntityCompilationError::InvalidAlignmentSlopeResolution {
                rule_id: rule.id.clone(),
                reason: "geometry content hash mismatch",
            });
        }
        resolved.push(slope);
    }
    Ok(resolved)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn tessellate_alignment(
    alignment: &AlignmentGeometry,
    options: CurveTessellationOptions,
) -> Result<TessellatedCurve, CadCurveError> {
    let horizontal = tessellate_curve(&alignment.horizontal, options)?;
    let path_count = 1 + alignment.width_bands.len().saturating_mul(2);
    let mut path_segments = vec![Vec::with_capacity(horizontal.segments.len()); path_count];
    let mut chainage = 0.0_f64;
    for segment in horizontal.segments {
        let start = world_dvec(segment.start);
        let end = world_dvec(segment.end);
        let delta = end - start;
        let plan_length = delta.x.hypot(delta.y);
        if !plan_length.is_finite() || plan_length <= f64::EPSILON {
            continue;
        }
        let start_station = alignment.station_origin + chainage;
        let end_station = start_station + plan_length;
        chainage += plan_length;
        let start_elevation = alignment_elevation(alignment, start_station).unwrap_or(start.z);
        let end_elevation = alignment_elevation(alignment, end_station).unwrap_or(end.z);
        let center_start = DVec3::new(start.x, start.y, start_elevation);
        let center_end = DVec3::new(end.x, end.y, end_elevation);
        push_alignment_segment(&mut path_segments[0], center_start, center_end);
        let left = DVec3::new(-delta.y / plan_length, delta.x / plan_length, 0.0);
        for (band_index, band) in alignment.width_bands.iter().enumerate() {
            for (edge_index, function) in [&band.inner_offset, &band.outer_offset]
                .into_iter()
                .enumerate()
            {
                let start_offset = station_value(function, start_station);
                let end_offset = station_value(function, end_station);
                let band_start = center_start
                    + left * start_offset
                    + DVec3::Z * crossfall_height(alignment, start_station, start_offset);
                let band_end = center_end
                    + left * end_offset
                    + DVec3::Z * crossfall_height(alignment, end_station, end_offset);
                let path_index = 1 + band_index * 2 + edge_index;
                push_alignment_segment(&mut path_segments[path_index], band_start, band_end);
            }
        }
    }
    let mut output = Vec::new();
    let mut paths = Vec::with_capacity(path_count);
    for path in path_segments.into_iter().filter(|path| !path.is_empty()) {
        let first_segment = u32::try_from(output.len()).map_err(|_| CadCurveError::SegmentLimit)?;
        for mut segment in path {
            segment.primitive_slot =
                u32::try_from(output.len()).map_err(|_| CadCurveError::SegmentLimit)?;
            output.push(segment);
        }
        paths.push(TessellatedCurvePath {
            first_segment,
            segment_count: u32::try_from(output.len()).map_err(|_| CadCurveError::SegmentLimit)?
                - first_segment,
            closed: false,
        });
    }
    if output.is_empty() {
        return Err(CadCurveError::InvalidGeometry);
    }
    Ok(TessellatedCurve {
        segments: output,
        semantic_snaps: Vec::new(),
        paths,
    })
}

fn push_alignment_segment(output: &mut Vec<TessellatedCurveSegment>, start: DVec3, end: DVec3) {
    output.push(TessellatedCurveSegment {
        start: world_vec(start),
        end: world_vec(end),
        primitive_slot: 0,
    });
}

fn alignment_elevation(alignment: &AlignmentGeometry, station: f64) -> Option<f64> {
    alignment
        .vertical
        .iter()
        .find_map(|segment| match *segment {
            VerticalAlignmentSegment::Grade {
                start_station,
                start_elevation,
                grade,
                length,
            } if (start_station..=start_station + length).contains(&station) => {
                Some((station - start_station).mul_add(grade, start_elevation))
            }
            VerticalAlignmentSegment::Parabolic {
                start_station,
                start_elevation,
                start_grade,
                end_grade,
                length,
            } if (start_station..=start_station + length).contains(&station) => {
                let distance = station - start_station;
                let curvature = (end_grade - start_grade) / length;
                Some(
                    (0.5 * curvature * distance)
                        .mul_add(distance, start_grade.mul_add(distance, start_elevation)),
                )
            }
            _ => None,
        })
}

fn station_value(function: &StationFunction, station: f64) -> f64 {
    let first = function
        .samples
        .first()
        .expect("canonical station function is non-empty");
    if station <= first.station {
        return first.value;
    }
    let last = function
        .samples
        .last()
        .expect("canonical station function is non-empty");
    if station >= last.station {
        return last.value;
    }
    let pair = function
        .samples
        .windows(2)
        .find(|pair| (pair[0].station..=pair[1].station).contains(&station))
        .expect("station lies inside validated sample range");
    let fraction = (station - pair[0].station) / (pair[1].station - pair[0].station);
    pair[0].value + (pair[1].value - pair[0].value) * fraction
}

fn crossfall_height(alignment: &AlignmentGeometry, station: f64, offset: f64) -> f64 {
    alignment
        .crossfall_bands
        .iter()
        .find_map(|band| {
            let from = station_value(&band.from_offset, station);
            let to = station_value(&band.to_offset, station);
            ((from.min(to)..=from.max(to)).contains(&offset))
                .then(|| (offset - from) * station_value(&band.crossfall, station))
        })
        .unwrap_or(0.0)
}

fn transformed_area(mut area: TessellatedArea, transform: DMat4) -> TessellatedArea {
    area.boundary = transformed_curve(area.boundary, transform);
    if let Some(fill) = &mut area.fill {
        for vertex in &mut fill.vertices {
            *vertex = world_vec(transform_point(transform, world_dvec(*vertex)));
        }
    }
    area
}

fn placement_matrix(placement: Option<Transform3d>) -> Result<DMat4, EntityCompilationError> {
    let matrix = DMat4::from_cols_array(&placement.unwrap_or(Transform3d::IDENTITY).0);
    if !matrix.is_finite() || matrix.determinant().abs() <= f64::EPSILON {
        return Err(EntityCompilationError::Unsupported(
            "non-invertible entity placement",
        ));
    }
    Ok(matrix)
}

fn resolve_height(
    height: Option<f64>,
    policy: UnresolvedHeightDisplay,
) -> Result<f64, EntityCompilationError> {
    height.map_or_else(
        || match policy {
            UnresolvedHeightDisplay::Reject => Err(EntityCompilationError::Unsupported(
                "unresolved point height display",
            )),
            UnresolvedHeightDisplay::ViewPlane { elevation } => Ok(elevation),
        },
        Ok,
    )
}

fn bounds(
    positions: impl IntoIterator<Item = WorldVec3>,
) -> Result<BoundingVolume, EntityCompilationError> {
    let mut positions = positions.into_iter();
    let first = positions
        .next()
        .ok_or(EntityCompilationError::Unsupported("empty render geometry"))?;
    let mut minimum = first;
    let mut maximum = first;
    for position in positions {
        minimum.x = minimum.x.min(position.x);
        minimum.y = minimum.y.min(position.y);
        minimum.z = minimum.z.min(position.z);
        maximum.x = maximum.x.max(position.x);
        maximum.y = maximum.y.max(position.y);
        maximum.z = maximum.z.max(position.z);
    }
    Ok(BoundingVolume::AxisAlignedBox {
        bounds: WorldAabb {
            min: minimum,
            max: maximum,
        },
    })
}

fn transform_point(transform: DMat4, point: DVec3) -> DVec3 {
    transform.transform_point3(point)
}

fn model_vec(value: Vector3) -> DVec3 {
    DVec3::new(value.x, value.y, value.z)
}

fn world_dvec(value: WorldVec3) -> DVec3 {
    DVec3::new(value.x, value.y, value.z)
}

fn world_vec(value: DVec3) -> WorldVec3 {
    WorldVec3 {
        x: value.x,
        y: value.y,
        z: value.z,
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::{
        alignment_slope_geometry_version, compile_entity_geometry,
        compile_entity_geometry_with_complete_resolvers, point_resource_cost, tessellate_alignment,
        tessellate_entity_strokes, tessellate_entity_strokes_with_associations,
        tessellate_entity_strokes_with_complete_resolvers, EntityCompilationError,
        EntityCompilationOptions, ResolvedAlignmentSlopeGeometry,
    };
    use crate::{
        FloatingOrigin, GpuSharedRenderer, RenderStyle, UnresolvedHeightDisplay, WorldVec3,
        GPU_POINT_VERTEX_STRIDE_BYTES,
    };
    use himmelcad_core::entity::EntityId;
    use himmelcad_core::entity_model::{
        AlignmentGeometry, AreaGeometry, CrossfallBand, CurveGeometry, CurveLoop, CurveUse,
        GeometryObject, PlaneDefinition, Position, SlopeRule, StationFunction, StationValue,
        Transform3d, TriangleMeshGeometry, TriangleMeshStorage, Vector3, VerticalAlignmentSegment,
        WidthBand,
    };
    use himmelcad_core::hash::ObjectHash;

    #[test]
    fn entity_point_cost_uses_the_uploaded_vertex_stride() {
        let cost = point_resource_cost(1);
        assert_eq!(cost.gpu_buffer_bytes, GPU_POINT_VERTEX_STRIDE_BYTES);
        assert_eq!(cost.points, 1);
        assert_eq!(cost.draw_calls, 1);
    }

    #[test]
    fn alignment_compiles_gradient_width_bands_and_crossfall() {
        let constant = |value| StationFunction {
            samples: vec![
                StationValue {
                    station: 1_000.0,
                    value,
                },
                StationValue {
                    station: 1_100.0,
                    value,
                },
            ],
        };
        let alignment = AlignmentGeometry {
            horizontal: CurveGeometry::LineSegment {
                start: Position {
                    x: 0.0,
                    y: 0.0,
                    z: None,
                },
                end: Position {
                    x: 100.0,
                    y: 0.0,
                    z: None,
                },
            },
            vertical: vec![VerticalAlignmentSegment::Grade {
                start_station: 1_000.0,
                start_elevation: 100.0,
                grade: 0.01,
                length: 100.0,
            }],
            station_origin: 1_000.0,
            width_bands: vec![WidthBand {
                id: "road".to_owned(),
                inner_offset: constant(2.0),
                outer_offset: constant(4.0),
            }],
            crossfall_bands: vec![CrossfallBand {
                id: "right-lane".to_owned(),
                from_offset: constant(0.0),
                to_offset: constant(4.0),
                crossfall: constant(-0.02),
            }],
            slope_rules: Vec::new(),
        };

        let curve = tessellate_alignment(
            &alignment,
            crate::CurveTessellationOptions {
                unresolved_height: UnresolvedHeightDisplay::ViewPlane { elevation: 0.0 },
                chord_tolerance: 0.001,
                maximum_segments: 128,
            },
        )
        .expect("alignment presentation");

        assert_eq!(curve.segments.len(), 3);
        assert_eq!(curve.segments[0].start.z, 100.0);
        assert_eq!(curve.segments[0].end.z, 101.0);
        assert_eq!(curve.segments[1].start.y, 2.0);
        assert!((curve.segments[1].start.z - 99.96).abs() < 1.0e-12);
        assert_eq!(curve.segments[2].end.y, 4.0);
        assert!((curve.segments[2].end.z - 100.92).abs() < 1.0e-12);
    }

    #[test]
    fn alignment_slope_rule_requires_an_authoritative_resolution() {
        let geometry = alignment_with_slope_rule();
        let error = tessellate_entity_strokes(&geometry, &entity_options())
            .expect_err("slope rules must never be silently ignored");
        assert!(matches!(
            error,
            EntityCompilationError::UnresolvedAlignmentSlope {
                rule_id,
                target_surface
            } if rule_id == "daylight-left" && target_surface == EntityId("design-ground".into())
        ));
    }

    #[test]
    fn alignment_slope_resolution_is_bound_to_the_target_tin_revision() {
        let geometry = alignment_with_slope_rule();
        let mesh = evaluated_slope_mesh();
        let geometry_version =
            alignment_slope_geometry_version(&mesh).expect("valid evaluated slope mesh");
        let target_version = ObjectHash::of_bytes(b"authoritative target TIN revision");
        let strokes = tessellate_entity_strokes_with_complete_resolvers(
            &geometry,
            &entity_options(),
            |_, _| None,
            |rule| {
                assert_eq!(rule.target_surface, EntityId("design-ground".into()));
                Some(ResolvedAlignmentSlopeGeometry {
                    rule_id: rule.id.clone(),
                    source_band_id: rule.source_band_id.clone(),
                    target_surface: rule.target_surface.clone(),
                    target_surface_version: target_version.clone(),
                    geometry_version: geometry_version.clone(),
                    mesh: mesh.clone(),
                })
            },
        )
        .expect("version-bound target TIN result");
        assert_eq!(strokes.len(), 1);
        assert_eq!(strokes[0].segments.len(), 3);
    }

    #[test]
    fn alignment_slope_resolution_rejects_wrong_target_and_stale_mesh_hash() {
        let geometry = alignment_with_slope_rule();
        let mesh = evaluated_slope_mesh();
        let target_version = ObjectHash::of_bytes(b"authoritative target TIN revision");
        let wrong_target = tessellate_entity_strokes_with_complete_resolvers(
            &geometry,
            &entity_options(),
            |_, _| None,
            |rule| {
                Some(ResolvedAlignmentSlopeGeometry {
                    rule_id: rule.id.clone(),
                    source_band_id: rule.source_band_id.clone(),
                    target_surface: EntityId("some-other-surface".into()),
                    target_surface_version: target_version.clone(),
                    geometry_version: alignment_slope_geometry_version(&mesh).expect("mesh hash"),
                    mesh: mesh.clone(),
                })
            },
        )
        .expect_err("a result for another target must be rejected");
        assert!(matches!(
            wrong_target,
            EntityCompilationError::InvalidAlignmentSlopeResolution {
                reason: "target-surface mismatch",
                ..
            }
        ));

        let stale_hash = tessellate_entity_strokes_with_complete_resolvers(
            &geometry,
            &entity_options(),
            |_, _| None,
            |rule| {
                Some(ResolvedAlignmentSlopeGeometry {
                    rule_id: rule.id.clone(),
                    source_band_id: rule.source_band_id.clone(),
                    target_surface: rule.target_surface.clone(),
                    target_surface_version: target_version.clone(),
                    geometry_version: ObjectHash::of_bytes(b"stale slope mesh"),
                    mesh: mesh.clone(),
                })
            },
        )
        .expect_err("stale evaluated geometry must be rejected");
        assert!(matches!(
            stale_hash,
            EntityCompilationError::InvalidAlignmentSlopeResolution {
                reason: "geometry content hash mismatch",
                ..
            }
        ));
    }

    #[tokio::test]
    async fn resolved_alignment_slope_compiles_as_its_own_mesh_pick_proxy() {
        let _native_test_guard = crate::test_sync::native_gpu_or_transcoder();
        let Some((device, queue)) = test_device().await else {
            return;
        };
        let renderer = GpuSharedRenderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
        let geometry = alignment_with_slope_rule();
        let mesh = evaluated_slope_mesh();
        let geometry_version =
            alignment_slope_geometry_version(&mesh).expect("valid evaluated slope mesh");
        let parts = compile_entity_geometry_with_complete_resolvers(
            &device,
            &queue,
            &renderer,
            "resolved-alignment-slope",
            &geometry,
            &[11, 12],
            &entity_options(),
            |_, _| None,
            |rule| {
                Some(ResolvedAlignmentSlopeGeometry {
                    rule_id: rule.id.clone(),
                    source_band_id: rule.source_band_id.clone(),
                    target_surface: rule.target_surface.clone(),
                    target_surface_version: ObjectHash::of_bytes(b"target TIN"),
                    geometry_version: geometry_version.clone(),
                    mesh: mesh.clone(),
                })
            },
        )
        .expect("compiled version-bound slope surface");

        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].kind, crate::RenderProxyKind::CadStroke);
        assert_eq!(parts[1].kind, crate::RenderProxyKind::Triangles);
        assert_eq!(parts[1].cost.triangles, 2);
    }

    fn alignment_with_slope_rule() -> GeometryObject {
        let constant = |value| StationFunction {
            samples: vec![
                StationValue {
                    station: 0.0,
                    value,
                },
                StationValue {
                    station: 10.0,
                    value,
                },
            ],
        };
        GeometryObject::Alignment {
            alignment: Box::new(AlignmentGeometry {
                horizontal: CurveGeometry::LineSegment {
                    start: Position {
                        x: 0.0,
                        y: 0.0,
                        z: Some(10.0),
                    },
                    end: Position {
                        x: 10.0,
                        y: 0.0,
                        z: Some(10.0),
                    },
                },
                vertical: Vec::new(),
                station_origin: 0.0,
                width_bands: vec![WidthBand {
                    id: "left-shoulder".into(),
                    inner_offset: constant(1.0),
                    outer_offset: constant(2.0),
                }],
                crossfall_bands: Vec::new(),
                slope_rules: vec![SlopeRule {
                    id: "daylight-left".into(),
                    source_band_id: "left-shoulder".into(),
                    target_surface: EntityId("design-ground".into()),
                    cut_ratio: 0.5,
                    fill_ratio: 0.5,
                }],
            }),
        }
    }

    fn evaluated_slope_mesh() -> TriangleMeshGeometry {
        TriangleMeshGeometry {
            storage: TriangleMeshStorage::Inline {
                positions: vec![
                    Vector3 {
                        x: 0.0,
                        y: 2.0,
                        z: 10.0,
                    },
                    Vector3 {
                        x: 10.0,
                        y: 2.0,
                        z: 10.0,
                    },
                    Vector3 {
                        x: 10.0,
                        y: 6.0,
                        z: 8.0,
                    },
                    Vector3 {
                        x: 0.0,
                        y: 6.0,
                        z: 8.0,
                    },
                ],
                indices: vec![0, 1, 2, 0, 2, 3],
                normals: None,
                texture_coordinates: None,
            },
            closed_manifold: false,
            triangle_material_slots: None,
            materials: None,
        }
    }

    fn entity_options() -> EntityCompilationOptions {
        EntityCompilationOptions {
            floating_origin: FloatingOrigin::from_selected(
                1_024.0,
                WorldVec3 {
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                },
            )
            .expect("origin"),
            unresolved_height: UnresolvedHeightDisplay::Reject,
            chord_tolerance: 0.001,
            maximum_curve_segments: 128,
            line_width: 1.0,
            plane_extent: 10.0,
            fill_areas: false,
            style: RenderStyle::default(),
            exaggeration_datum: 0.0,
            placement: None,
        }
    }

    #[test]
    fn associative_area_strokes_use_the_versioned_resident_curve() {
        let curve_id = EntityId("parcel-boundary".to_owned());
        let version = ObjectHash("a".repeat(64));
        let geometry = GeometryObject::Area {
            area: Box::new(AreaGeometry {
                outer: CurveLoop {
                    uses: vec![CurveUse::Associative {
                        entity_id: curve_id.clone(),
                        expected_version: Some(version.clone()),
                        reversed: false,
                    }],
                },
                holes: Vec::new(),
            }),
        };
        let options = EntityCompilationOptions {
            floating_origin: FloatingOrigin::from_selected(
                1_024.0,
                WorldVec3 {
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                },
            )
            .expect("origin"),
            unresolved_height: UnresolvedHeightDisplay::Reject,
            chord_tolerance: 0.001,
            maximum_curve_segments: 128,
            line_width: 1.0,
            plane_extent: 10.0,
            fill_areas: false,
            style: RenderStyle::default(),
            exaggeration_datum: 0.0,
            placement: None,
        };
        let strokes = tessellate_entity_strokes_with_associations(
            &geometry,
            &options,
            |requested_id, requested_version| {
                (requested_id == &curve_id && requested_version == Some(&version)).then(|| {
                    CurveGeometry::Polyline {
                        positions: vec![
                            Position {
                                x: 0.0,
                                y: 0.0,
                                z: Some(10.0),
                            },
                            Position {
                                x: 4.0,
                                y: 0.0,
                                z: Some(11.0),
                            },
                            Position {
                                x: 4.0,
                                y: 3.0,
                                z: Some(12.0),
                            },
                            Position {
                                x: 0.0,
                                y: 3.0,
                                z: Some(10.0),
                            },
                        ],
                        closed: true,
                    }
                })
            },
        )
        .expect("associative boundary");

        assert_eq!(strokes.len(), 1);
        assert_eq!(strokes[0].segments.len(), 4);
        assert_eq!(strokes[0].segments[0].start.z, 10.0);
        assert_eq!(strokes[0].segments[1].end.z, 12.0);
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn mixed_height_curve_compiles_with_explicit_view_plane_on_real_gpu() {
        let _native_test_guard = crate::test_sync::native_gpu_or_transcoder();
        let Some((device, queue)) = test_device().await else {
            return;
        };
        let renderer = GpuSharedRenderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
        let geometry = GeometryObject::Curve {
            curve: Box::new(CurveGeometry::Polyline {
                positions: vec![
                    Position {
                        x: 10.0,
                        y: 20.0,
                        z: Some(510.0),
                    },
                    Position {
                        x: 30.0,
                        y: 40.0,
                        z: None,
                    },
                ],
                closed: false,
            }),
        };
        let options = EntityCompilationOptions {
            floating_origin: FloatingOrigin::new(
                1_024.0,
                WorldVec3 {
                    x: 1_000_000.0,
                    y: 2_000_000.0,
                    z: 500.0,
                },
            )
            .expect("floating origin"),
            unresolved_height: UnresolvedHeightDisplay::ViewPlane { elevation: 505.0 },
            chord_tolerance: 0.001,
            maximum_curve_segments: 1_024,
            line_width: 3.0,
            plane_extent: 10.0,
            fill_areas: false,
            style: RenderStyle::default(),
            exaggeration_datum: 500.0,
            placement: Some(Transform3d([
                1.0,
                0.0,
                0.0,
                0.0,
                0.0,
                1.0,
                0.0,
                0.0,
                0.0,
                0.0,
                1.0,
                0.0,
                1_000_000.0,
                2_000_000.0,
                0.0,
                1.0,
            ])),
        };
        let parts = compile_entity_geometry(
            &device,
            &queue,
            &renderer,
            "canonical-mixed-height",
            &geometry,
            &[1],
            &options,
        )
        .expect("compiled entity");
        assert_eq!(parts.len(), 1);
        let crate::BoundingVolume::AxisAlignedBox { bounds } = parts[0].bounds else {
            panic!("curve AABB")
        };
        assert!((bounds.min.x - 1_000_010.0).abs() < f64::EPSILON);
        assert!((bounds.max.y - 2_000_040.0).abs() < f64::EPSILON);
        assert!((bounds.min.z - 505.0).abs() < f64::EPSILON);

        let plane = GeometryObject::Plane {
            plane: PlaneDefinition {
                origin: Vector3 {
                    x: 0.0,
                    y: 0.0,
                    z: 10.0,
                },
                normal: Vector3 {
                    x: 0.0,
                    y: 0.0,
                    z: 1.0,
                },
            },
        };
        let plane_parts = compile_entity_geometry(
            &device,
            &queue,
            &renderer,
            "construction-plane",
            &plane,
            &[2],
            &EntityCompilationOptions {
                placement: None,
                plane_extent: 25.0,
                ..options.clone()
            },
        )
        .expect("compiled construction plane");
        let crate::BoundingVolume::AxisAlignedBox { bounds } = plane_parts[0].bounds else {
            panic!("plane AABB")
        };
        assert!((bounds.min.x + 25.0).abs() < f64::EPSILON);
        assert!((bounds.max.y - 25.0).abs() < f64::EPSILON);
        assert!((bounds.min.z - 10.0).abs() < f64::EPSILON);

        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("canonical-compiler-test-color"),
            size: wgpu::Extent3d {
                width: 8,
                height: 8,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let targets = renderer.create_frame_targets(&device, 8, 8);
        renderer
            .update_frame(
                &queue,
                identity(),
                options.floating_origin.world(),
                &[],
                [8, 8],
            )
            .expect("frame");
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("canonical-compiler-test-frame"),
        });
        renderer.encode(
            &mut encoder,
            &target.create_view(&wgpu::TextureViewDescriptor::default()),
            &targets,
            &[&parts[0].batch],
            wgpu::Color::BLACK,
            false,
        );
        queue.submit([encoder.finish()]);
        device
            .poll(wgpu::PollType::wait_indefinitely())
            .expect("GPU completion");
    }

    async fn test_device() -> Option<(wgpu::Device, wgpu::Queue)> {
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = wgpu::Backends::PRIMARY;
        let instance = wgpu::Instance::new(descriptor);
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
            .ok()?;
        adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("canonical-compiler-test-device"),
                required_features: wgpu::Features::empty(),
                required_limits: adapter.limits(),
                ..wgpu::DeviceDescriptor::default()
            })
            .await
            .ok()
    }

    fn identity() -> [[f32; 4]; 4] {
        [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ]
    }
}
