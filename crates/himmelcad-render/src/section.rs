//! Exact f64 plane sections for closed indexed triangle boundaries.

use std::collections::{BTreeMap, HashMap};
use std::error::Error;
use std::fmt::{Display, Formatter};

use earcut::Earcut;
use glam::{DMat4, DVec2, DVec3};
use himmelcad_core::entity_model::{
    CsgNode, ElevationSurfaceGeometry, GeometryObject, SolidGeometry, Transform3d,
    TriangleMeshGeometry, TriangleMeshStorage,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    entity_compiler::{extrusion_mesh, primitive_mesh},
    CurveTessellationOptions, FloatingOrigin, GpuDrawBatch, GpuFrameError, GpuMeshVertexInput,
    UnresolvedHeightDisplay, WorldTransform, WorldVec3,
};

/// Plane used to derive one exact section product.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionPlane {
    /// Point on the plane.
    pub origin: WorldVec3,
    /// Non-zero plane normal.
    pub normal: WorldVec3,
}

/// Indexed closed mesh and optional per-triangle material assignment.
#[derive(Debug, Clone, Copy)]
pub struct SectionMeshInput<'a> {
    /// Project-world vertex positions.
    pub positions: &'a [WorldVec3],
    /// Triangle-list indices.
    pub indices: &'a [u32],
    /// One material slot per triangle; absent means slot zero.
    pub material_slots: Option<&'a [u32]>,
    /// Whether authoritative validation proved a closed two-manifold boundary.
    pub closed_manifold: bool,
}

/// One raw triangle/plane intersection edge.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionSegment {
    /// First endpoint on the section plane.
    pub start: WorldVec3,
    /// Second endpoint on the section plane.
    pub end: WorldVec3,
    /// Source material slot.
    pub material_slot: u32,
}

/// Closed section contour without a duplicated final point.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionContour {
    /// Ordered project-world points lying on the section plane.
    pub points: Vec<WorldVec3>,
}

/// One triangulated material region with optional interior voids.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionRegion {
    /// Material slot used to resolve color or vector hatch resources.
    pub material_slot: u32,
    /// Exterior contour.
    pub outer: SectionContour,
    /// Direct interior void contours.
    pub holes: Vec<SectionContour>,
    /// Flattened outer and hole vertices used by `indices`.
    pub vertices: Vec<WorldVec3>,
    /// Triangle-list cap indices.
    pub indices: Vec<u32>,
}

/// Exact cross-section output retained independently from the interactive clip pass.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionProduct {
    /// Raw intersection segments for diagnostics and contour export.
    pub segments: Vec<SectionSegment>,
    /// Closed triangulated regions grouped by material.
    pub regions: Vec<SectionRegion>,
}

/// Current wire version of an authoritative cross-tile section product.
pub const AUTHORITATIVE_SECTION_PRODUCT_SCHEMA_VERSION: u32 = 2;

/// One immutable topology partition consumed by an authoritative section evaluator.
///
/// Part identity describes source topology, not renderer residency. A provider may
/// therefore name prepared mesh tiles here without requiring those tiles to remain
/// resident while the evaluated section is displayed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SectionTopologyPart {
    /// Stable provider-owned partition identity.
    pub part_id: String,
    /// Content hash of the authoritative topology partition.
    pub topology_hash: String,
    /// Optional exact representation-local/source AABB used for section culling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds: Option<SectionTopologyBounds>,
}

/// Representation-local/source bounds of one immutable topology partition.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SectionTopologyBounds {
    /// Inclusive minimum XYZ.
    pub minimum: [f64; 3],
    /// Inclusive maximum XYZ.
    pub maximum: [f64; 3],
}

/// Immutable source snapshot from which a cross-tile product was evaluated.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthoritativeSectionSource {
    /// Canonical entity owning the source geometry.
    pub entity_id: String,
    /// Dataset identity for streamed geometry; absent for an evaluated inline solid.
    pub dataset_id: Option<String>,
    /// Canonical entity version required by this product.
    pub version_hash: String,
    /// Content hash of the complete topology snapshot, independent of tile residency.
    pub topology_hash: String,
    /// Whether the complete source topology is a closed two-manifold.
    ///
    /// Open topology produces exact intersection traces without inventing cap regions.
    pub closed_manifold: bool,
    /// Deterministically ordered authoritative partitions contributing to the snapshot.
    pub parts: Vec<SectionTopologyPart>,
}

/// Stable material identity for one triangulated section region.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SectionMaterialRegionBinding {
    /// Index into [`SectionProduct::regions`].
    pub region_index: u32,
    /// Stable evaluator-owned region identity, independent of triangulation order.
    pub region_id: String,
    /// Stable canonical material identity used to resolve hatches and appearance.
    pub material_key: String,
}

/// Exact immutable product emitted by an authoritative topology/section provider.
///
/// The renderer consumes this product as a whole. It never stitches independently
/// resident render tiles, because tile boundaries are not authoritative topology.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthoritativeSectionProduct {
    /// Wire contract version. Must equal
    /// [`AUTHORITATIVE_SECTION_PRODUCT_SCHEMA_VERSION`].
    pub schema_version: u32,
    /// Immutable source entity/topology snapshot.
    pub source: AuthoritativeSectionSource,
    /// Exact world-space plane used by the evaluator.
    pub plane: SectionPlane,
    /// Exact evaluator tolerance used to construct topology and contours.
    pub tolerance: f64,
    /// One stable material binding for every triangulated region.
    pub material_regions: Vec<SectionMaterialRegionBinding>,
    /// Complete cross-tile section output.
    pub product: SectionProduct,
}

/// One authoritative topology partition supplied to the section evaluator.
///
/// Partitions need not be closed individually. Their union must describe the
/// complete closed source snapshot declared by the evaluation request.
#[derive(Debug, Clone, Copy)]
pub struct AuthoritativeSectionPartInput<'a> {
    /// Stable provider-owned identity, independent of renderer tile residency.
    pub part_id: &'a str,
    /// Content hash of this exact topology partition.
    pub topology_hash: &'a str,
    /// Representation-local/source positions.
    pub positions: &'a [WorldVec3],
    /// Triangle-list source indices.
    pub indices: &'a [u32],
    /// Optional canonical material slot for every source triangle.
    pub material_slots: Option<&'a [u32]>,
}

/// Complete immutable input for an authoritative cross-partition evaluation.
#[derive(Debug, Clone, Copy)]
pub struct AuthoritativeSectionEvaluation<'a> {
    /// Canonical entity owning the source topology.
    pub entity_id: &'a str,
    /// Streamed dataset identity, absent for an inline topology store.
    pub dataset_id: Option<&'a str>,
    /// Canonical entity version evaluated by the provider.
    pub version_hash: &'a str,
    /// Content hash of the complete topology snapshot.
    pub topology_hash: &'a str,
    /// Complete topology partitions. Renderer residency is irrelevant.
    pub parts: &'a [AuthoritativeSectionPartInput<'a>],
    /// Canonical material keys indexed by source material slot.
    pub material_keys: &'a BTreeMap<u32, String>,
    /// Exact project-world evaluation plane.
    pub plane: SectionPlane,
    /// Evaluator topology tolerance.
    pub tolerance: f64,
    /// Authoritative assertion that the union is a closed two-manifold boundary.
    pub closed_manifold: bool,
}

/// An authoritative topology snapshot could not be evaluated safely.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthoritativeSectionEvaluationError {
    /// Source identity, partitions or hashes are incomplete or ambiguous.
    InvalidSource,
    /// The representation-local/source to project-world transform is invalid.
    InvalidSourceToProject,
    /// A cap product cannot be derived from an open topology snapshot.
    OpenTopology,
    /// A source partition could not be intersected exactly.
    Section(SectionError),
    /// One resulting region has no canonical material identity.
    MissingMaterial,
    /// The generated envelope failed its own consumer-side validation.
    InvalidProduct(AuthoritativeSectionProductError),
}

impl Display for AuthoritativeSectionEvaluationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidSource => formatter.write_str("authoritative section source is invalid"),
            Self::InvalidSourceToProject => formatter.write_str(
                "authoritative section source-to-project transform is not a finite invertible affine transform",
            ),
            Self::OpenTopology => {
                formatter.write_str("authoritative section topology is not a closed manifold")
            }
            Self::Section(error) => write!(formatter, "authoritative section failed: {error}"),
            Self::MissingMaterial => {
                formatter.write_str("authoritative section material identity is missing")
            }
            Self::InvalidProduct(error) => {
                write!(
                    formatter,
                    "authoritative section product is invalid: {error}"
                )
            }
        }
    }
}

impl Error for AuthoritativeSectionEvaluationError {}

/// Invalid authoritative product contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthoritativeSectionProductError {
    /// The schema version is unsupported.
    UnsupportedSchema,
    /// Source identity, version or topology snapshot is incomplete.
    InvalidSource,
    /// Plane or tolerance is invalid.
    InvalidEvaluation,
    /// Section geometry is malformed.
    InvalidProduct,
    /// Stable material-region coverage is incomplete or ambiguous.
    InvalidMaterialRegions,
}

impl Display for AuthoritativeSectionProductError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::UnsupportedSchema => "authoritative section product schema is unsupported",
            Self::InvalidSource => "authoritative section source snapshot is invalid",
            Self::InvalidEvaluation => "authoritative section plane or tolerance is invalid",
            Self::InvalidProduct => "authoritative section geometry is invalid",
            Self::InvalidMaterialRegions => {
                "authoritative section material-region bindings are invalid"
            }
        })
    }
}

impl Error for AuthoritativeSectionProductError {}

/// Validates a complete cross-tile product before it enters renderer residency.
pub fn validate_authoritative_section_product(
    evaluated: &AuthoritativeSectionProduct,
) -> Result<(), AuthoritativeSectionProductError> {
    if evaluated.schema_version != AUTHORITATIVE_SECTION_PRODUCT_SCHEMA_VERSION {
        return Err(AuthoritativeSectionProductError::UnsupportedSchema);
    }
    let source = &evaluated.source;
    if source.entity_id.is_empty()
        || source.version_hash.is_empty()
        || source.topology_hash.is_empty()
        || source.dataset_id.as_ref().is_some_and(String::is_empty)
        || source.parts.is_empty()
        || source.parts.iter().any(|part| {
            part.part_id.is_empty()
                || part.topology_hash.is_empty()
                || part.bounds.is_some_and(|bounds| {
                    bounds.minimum.iter().any(|value| !value.is_finite())
                        || bounds.maximum.iter().any(|value| !value.is_finite())
                        || (0..3).any(|axis| bounds.minimum[axis] > bounds.maximum[axis])
                })
        })
        || source
            .parts
            .windows(2)
            .any(|pair| pair[0].part_id >= pair[1].part_id)
    {
        return Err(AuthoritativeSectionProductError::InvalidSource);
    }
    if !vector(evaluated.plane.origin).is_finite()
        || vector(evaluated.plane.normal)
            .try_normalize()
            .filter(|normal| normal.is_finite())
            .is_none()
        || !evaluated.tolerance.is_finite()
        || evaluated.tolerance <= 0.0
    {
        return Err(AuthoritativeSectionProductError::InvalidEvaluation);
    }
    let plane_origin = vector(evaluated.plane.origin);
    let plane_normal = vector(evaluated.plane.normal)
        .try_normalize()
        .expect("validated non-zero finite section normal");
    let on_plane = |position: WorldVec3| {
        plane_normal.dot(vector(position) - plane_origin).abs() <= evaluated.tolerance
    };
    if evaluated.product.segments.iter().any(|segment| {
        !vector(segment.start).is_finite()
            || !vector(segment.end).is_finite()
            || vector(segment.start).distance_squared(vector(segment.end)) <= f64::EPSILON
            || !on_plane(segment.start)
            || !on_plane(segment.end)
    }) || evaluated.product.regions.iter().any(|region| {
        region.outer.points.len() < 3
            || region.holes.iter().any(|hole| hole.points.len() < 3)
            || region.vertices.len() < 3
            || region.indices.is_empty()
            || !region.indices.len().is_multiple_of(3)
            || region
                .outer
                .points
                .iter()
                .chain(region.holes.iter().flat_map(|hole| &hole.points))
                .chain(&region.vertices)
                .any(|position| !vector(*position).is_finite() || !on_plane(*position))
            || region.indices.iter().any(|index| {
                usize::try_from(*index).map_or(true, |index| index >= region.vertices.len())
            })
    }) {
        return Err(AuthoritativeSectionProductError::InvalidProduct);
    }
    if evaluated.material_regions.len() != evaluated.product.regions.len() {
        return Err(AuthoritativeSectionProductError::InvalidMaterialRegions);
    }
    if !source.closed_manifold
        && (!evaluated.product.regions.is_empty() || !evaluated.material_regions.is_empty())
    {
        return Err(AuthoritativeSectionProductError::InvalidProduct);
    }
    let mut region_ids = std::collections::BTreeSet::new();
    for (expected_index, binding) in evaluated.material_regions.iter().enumerate() {
        if usize::try_from(binding.region_index).ok() != Some(expected_index)
            || binding.region_id.is_empty()
            || binding.material_key.is_empty()
            || !region_ids.insert(&binding.region_id)
        {
            return Err(AuthoritativeSectionProductError::InvalidMaterialRegions);
        }
    }
    Ok(())
}

/// Tests whether an evaluated product belongs to one exact canonical source
/// revision and evaluation request.
#[must_use]
pub fn authoritative_section_product_matches(
    evaluated: &AuthoritativeSectionProduct,
    entity_id: &str,
    dataset_id: Option<&str>,
    version_hash: &str,
    plane: SectionPlane,
    tolerance: f64,
) -> bool {
    evaluated.source.entity_id == entity_id
        && evaluated.source.dataset_id.as_deref() == dataset_id
        && evaluated.source.version_hash == version_hash
        && evaluated.plane == plane
        && evaluated.tolerance == tolerance
}

/// Evaluates one exact section product from a complete partitioned topology snapshot.
///
/// Each partition is intersected independently in f64, but contour construction
/// happens once over the combined segment set. Seams between provider partitions
/// therefore disappear without making the result depend on resident render tiles.
/// Closed topology additionally produces cap regions; open topology deliberately
/// remains an exact segment trace suitable for DGMs and other Civil surfaces.
pub fn evaluate_authoritative_section_product(
    evaluation: AuthoritativeSectionEvaluation<'_>,
) -> Result<AuthoritativeSectionProduct, AuthoritativeSectionEvaluationError> {
    evaluate_authoritative_section_product_with_transform(evaluation, WorldTransform::IDENTITY)
}

/// Evaluates one exact section after placing source topology in project world.
pub fn evaluate_authoritative_section_product_with_transform(
    evaluation: AuthoritativeSectionEvaluation<'_>,
    source_to_project: WorldTransform,
) -> Result<AuthoritativeSectionProduct, AuthoritativeSectionEvaluationError> {
    if !source_to_project.is_invertible_affine() {
        return Err(AuthoritativeSectionEvaluationError::InvalidSourceToProject);
    }
    if evaluation.entity_id.is_empty()
        || evaluation.version_hash.is_empty()
        || evaluation.topology_hash.is_empty()
        || evaluation.dataset_id.is_some_and(str::is_empty)
        || evaluation.parts.is_empty()
    {
        return Err(AuthoritativeSectionEvaluationError::InvalidSource);
    }
    let mut parts = evaluation.parts.to_vec();
    parts.sort_unstable_by(|left, right| left.part_id.cmp(right.part_id));
    if parts.iter().any(|part| {
        part.part_id.is_empty()
            || part.topology_hash.is_empty()
            || part.positions.is_empty()
            || part.indices.is_empty()
    }) || parts
        .windows(2)
        .any(|pair| pair[0].part_id == pair[1].part_id)
    {
        return Err(AuthoritativeSectionEvaluationError::InvalidSource);
    }

    let mut segments = Vec::new();
    for part in &parts {
        let mut project_positions = Vec::new();
        let positions = if source_to_project == WorldTransform::IDENTITY {
            part.positions
        } else {
            project_positions.extend_from_slice(part.positions);
            transform_section_positions_in_place(&mut project_positions, source_to_project)
                .map_err(AuthoritativeSectionEvaluationError::Section)?;
            &project_positions
        };
        let product = section_open_mesh(
            SectionMeshInput {
                positions,
                indices: part.indices,
                material_slots: part.material_slots,
                closed_manifold: false,
            },
            evaluation.plane,
            evaluation.tolerance,
        )
        .map_err(AuthoritativeSectionEvaluationError::Section)?;
        segments.extend(product.segments);
    }

    finish_authoritative_section_product(
        evaluation.entity_id,
        evaluation.dataset_id,
        evaluation.version_hash,
        evaluation.topology_hash,
        parts
            .into_iter()
            .map(|part| SectionTopologyPart {
                part_id: part.part_id.to_owned(),
                topology_hash: part.topology_hash.to_owned(),
                bounds: None,
            })
            .collect(),
        evaluation.material_keys,
        evaluation.plane,
        evaluation.tolerance,
        segments,
        evaluation.closed_manifold,
    )
}

pub(crate) fn transform_section_positions_in_place(
    positions: &mut [WorldVec3],
    source_to_project: WorldTransform,
) -> Result<(), SectionError> {
    if !source_to_project.is_invertible_affine() {
        return Err(SectionError::InvalidMesh);
    }
    let transform = DMat4::from_cols_array(&source_to_project.0);
    for position in positions {
        let project = transform.transform_point3(DVec3::new(position.x, position.y, position.z));
        if !project.is_finite() {
            return Err(SectionError::InvalidMesh);
        }
        *position = WorldVec3 {
            x: project.x,
            y: project.y,
            z: project.z,
        };
    }
    Ok(())
}

#[allow(
    clippy::too_many_arguments,
    reason = "section finalization validates a complete provenance record at one boundary"
)]
pub(crate) fn finish_authoritative_section_product(
    entity_id: &str,
    dataset_id: Option<&str>,
    version_hash: &str,
    topology_hash: &str,
    parts: Vec<SectionTopologyPart>,
    material_keys: &BTreeMap<u32, String>,
    plane: SectionPlane,
    tolerance: f64,
    segments: Vec<SectionSegment>,
    closed_manifold: bool,
) -> Result<AuthoritativeSectionProduct, AuthoritativeSectionEvaluationError> {
    if entity_id.is_empty()
        || version_hash.is_empty()
        || topology_hash.is_empty()
        || dataset_id.is_some_and(str::is_empty)
        || parts.is_empty()
    {
        return Err(AuthoritativeSectionEvaluationError::InvalidSource);
    }

    let normal = vector(plane.normal)
        .try_normalize()
        .filter(|normal| normal.is_finite())
        .ok_or(AuthoritativeSectionEvaluationError::Section(
            SectionError::InvalidPlane,
        ))?;
    let regions = if closed_manifold {
        regions_from_segments(&segments, vector(plane.origin), normal, tolerance)
            .map_err(AuthoritativeSectionEvaluationError::Section)?
    } else {
        Vec::new()
    };
    let product = SectionProduct { segments, regions };

    let mut material_regions = Vec::with_capacity(product.regions.len());
    for (region_index, region) in product.regions.iter().enumerate() {
        let material_key = material_keys
            .get(&region.material_slot)
            .filter(|key| !key.is_empty())
            .ok_or(AuthoritativeSectionEvaluationError::MissingMaterial)?;
        material_regions.push(SectionMaterialRegionBinding {
            region_index: u32::try_from(region_index)
                .map_err(|_| AuthoritativeSectionEvaluationError::InvalidSource)?,
            region_id: stable_section_region_id(topology_hash, material_key, region),
            material_key: material_key.clone(),
        });
    }

    let evaluated = AuthoritativeSectionProduct {
        schema_version: AUTHORITATIVE_SECTION_PRODUCT_SCHEMA_VERSION,
        source: AuthoritativeSectionSource {
            entity_id: entity_id.to_owned(),
            dataset_id: dataset_id.map(str::to_owned),
            version_hash: version_hash.to_owned(),
            topology_hash: topology_hash.to_owned(),
            closed_manifold,
            parts,
        },
        plane,
        tolerance,
        material_regions,
        product,
    };
    validate_authoritative_section_product(&evaluated)
        .map_err(AuthoritativeSectionEvaluationError::InvalidProduct)?;
    Ok(evaluated)
}

fn stable_section_region_id(
    topology_hash: &str,
    material_key: &str,
    region: &SectionRegion,
) -> String {
    let mut triangles = region
        .indices
        .chunks_exact(3)
        .map(|triangle| {
            let point_bits = |index: u32| {
                let point = region.vertices[usize::try_from(index).expect("validated index")];
                [point.x.to_bits(), point.y.to_bits(), point.z.to_bits()]
            };
            let mut vertices = [
                point_bits(triangle[0]),
                point_bits(triangle[1]),
                point_bits(triangle[2]),
            ];
            vertices.sort_unstable();
            vertices
        })
        .collect::<Vec<_>>();
    triangles.sort_unstable();

    let mut digest = Sha256::new();
    digest.update(b"himmelcad-authoritative-section-region-v1\0");
    digest.update(topology_hash.as_bytes());
    digest.update([0]);
    digest.update(material_key.as_bytes());
    for triangle in triangles {
        for point in triangle {
            for component in point {
                digest.update(component.to_le_bytes());
            }
        }
    }
    format!("section-region:{:x}", digest.finalize())
}

/// GPU addressing, placement and appearance for one generated cap region.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SectionBatchOptions {
    /// Non-zero render-proxy pick slot.
    pub proxy_slot: u32,
    /// First proxy-local triangle ID.
    pub primitive_base: u32,
    /// Stable origin used by resident geometry buffers.
    pub floating_origin: FloatingOrigin,
    /// Section plane normal used for cap lighting.
    pub plane_normal: WorldVec3,
    /// Linear base RGBA before optional hatch styling.
    pub linear_color: [f32; 4],
}

/// Mesh or plane cannot produce an unambiguous closed exact section.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SectionError {
    /// Plane values or tolerance are invalid.
    InvalidPlane,
    /// Mesh indices, materials or positions are invalid.
    InvalidMesh,
    /// Exact cap generation requires a validated closed two-manifold mesh.
    OpenMesh,
    /// A triangle is coplanar with the requested plane and needs topology-aware handling.
    CoplanarTriangle,
    /// Intersection segments do not form closed non-branching contours.
    OpenContour,
    /// A closed contour could not be triangulated.
    Triangulation,
    /// Geometry is not a closed triangle boundary that can produce an exact cap.
    UnsupportedGeometry,
}

impl Display for SectionError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidPlane => "section plane or tolerance is invalid",
            Self::InvalidMesh => "section mesh topology or attributes are invalid",
            Self::OpenMesh => "exact section cap requires a closed manifold mesh",
            Self::CoplanarTriangle => "section plane is coplanar with a mesh triangle",
            Self::OpenContour => "section edges do not form closed contours",
            Self::Triangulation => "section region triangulation failed",
            Self::UnsupportedGeometry => "geometry has no inline closed triangle boundary",
        })
    }
}

impl Error for SectionError {}

/// Resolves one canonical inline closed mesh and applies entity placement before sectioning.
pub fn section_geometry_object(
    geometry: &GeometryObject,
    placement: Option<Transform3d>,
    plane: SectionPlane,
    tolerance: f64,
) -> Result<SectionProduct, SectionError> {
    let generated;
    let mut effective_placement = placement;
    let mesh = match geometry {
        GeometryObject::Surface3d { mesh } => mesh.as_ref(),
        GeometryObject::ElevationSurface { surface } => match surface.as_ref() {
            ElevationSurfaceGeometry::Tin { mesh, .. } => mesh,
            ElevationSurfaceGeometry::Grid { .. } => return Err(SectionError::UnsupportedGeometry),
        },
        GeometryObject::Solid { solid } => match solid.as_ref() {
            SolidGeometry::ClosedMesh { mesh } => mesh,
            SolidGeometry::Csg {
                root:
                    CsgNode::Primitive {
                        primitive,
                        placement: primitive_placement,
                    },
            } => {
                generated = primitive_mesh(primitive, tolerance, 65_536)
                    .map_err(|_| SectionError::UnsupportedGeometry)?;
                effective_placement = Some(compose_placements(placement, *primitive_placement)?);
                &generated
            }
            SolidGeometry::Extrusion { profile, direction } => {
                generated = extrusion_mesh(
                    profile,
                    *direction,
                    CurveTessellationOptions {
                        unresolved_height: UnresolvedHeightDisplay::Reject,
                        chord_tolerance: tolerance,
                        maximum_segments: 65_536,
                    },
                )
                .map_err(|_| SectionError::UnsupportedGeometry)?;
                &generated
            }
            _ => return Err(SectionError::UnsupportedGeometry),
        },
        _ => return Err(SectionError::UnsupportedGeometry),
    };
    section_placed_mesh(mesh, effective_placement, plane, tolerance)
}

fn compose_placements(
    outer: Option<Transform3d>,
    inner: Transform3d,
) -> Result<Transform3d, SectionError> {
    let outer = glam::DMat4::from_cols_array(&outer.unwrap_or(Transform3d::IDENTITY).0);
    let inner = glam::DMat4::from_cols_array(&inner.0);
    let composed = outer * inner;
    if !composed.is_finite() || composed.determinant().abs() <= f64::EPSILON {
        return Err(SectionError::InvalidMesh);
    }
    Ok(Transform3d(composed.to_cols_array()))
}

fn section_placed_mesh(
    mesh: &TriangleMeshGeometry,
    placement: Option<Transform3d>,
    plane: SectionPlane,
    tolerance: f64,
) -> Result<SectionProduct, SectionError> {
    let TriangleMeshStorage::Inline {
        positions, indices, ..
    } = &mesh.storage
    else {
        return Err(SectionError::UnsupportedGeometry);
    };
    let transform = glam::DMat4::from_cols_array(&placement.unwrap_or(Transform3d::IDENTITY).0);
    if !transform.is_finite() || transform.determinant().abs() <= f64::EPSILON {
        return Err(SectionError::InvalidMesh);
    }
    let world_positions = positions
        .iter()
        .map(|position| {
            let world = transform.transform_point3(DVec3::new(position.x, position.y, position.z));
            WorldVec3 {
                x: world.x,
                y: world.y,
                z: world.z,
            }
        })
        .collect::<Vec<_>>();
    let input = SectionMeshInput {
        positions: &world_positions,
        indices,
        material_slots: mesh.triangle_material_slots.as_deref(),
        closed_manifold: mesh.closed_manifold,
    };
    if mesh.closed_manifold {
        section_closed_mesh(input, plane, tolerance)
    } else {
        section_open_mesh(input, plane, tolerance)
    }
}

/// Intersects an open surface mesh without inventing a solid cap.
///
/// The returned raw segments retain triangle material identity and can be
/// displayed as an exact DGM/profile trace. `regions` is deliberately empty.
pub fn section_open_mesh(
    mesh: SectionMeshInput<'_>,
    plane: SectionPlane,
    tolerance: f64,
) -> Result<SectionProduct, SectionError> {
    let normal = vector(plane.normal)
        .try_normalize()
        .filter(|normal| normal.is_finite())
        .ok_or(SectionError::InvalidPlane)?;
    if !vector(plane.origin).is_finite() || !tolerance.is_finite() || tolerance <= 0.0 {
        return Err(SectionError::InvalidPlane);
    }
    validate_mesh(mesh)?;
    let segments = intersect_triangles(mesh, vector(plane.origin), normal, tolerance)?;
    Ok(SectionProduct {
        segments,
        regions: Vec::new(),
    })
}

/// Intersects a validated closed mesh, stitches contours and triangulates caps.
pub fn section_closed_mesh(
    mesh: SectionMeshInput<'_>,
    plane: SectionPlane,
    tolerance: f64,
) -> Result<SectionProduct, SectionError> {
    let normal = vector(plane.normal)
        .try_normalize()
        .filter(|normal| normal.is_finite())
        .ok_or(SectionError::InvalidPlane)?;
    if !vector(plane.origin).is_finite() || !tolerance.is_finite() || tolerance <= 0.0 {
        return Err(SectionError::InvalidPlane);
    }
    validate_mesh(mesh)?;
    if !mesh.closed_manifold {
        return Err(SectionError::OpenMesh);
    }
    let segments = intersect_triangles(mesh, vector(plane.origin), normal, tolerance)?;
    if segments.is_empty() {
        return Ok(SectionProduct {
            segments,
            regions: Vec::new(),
        });
    }
    let regions = regions_from_segments(&segments, vector(plane.origin), normal, tolerance)?;
    Ok(SectionProduct { segments, regions })
}

fn regions_from_segments(
    segments: &[SectionSegment],
    plane_origin: DVec3,
    plane_normal: DVec3,
    tolerance: f64,
) -> Result<Vec<SectionRegion>, SectionError> {
    if segments.is_empty() {
        return Ok(Vec::new());
    }
    let basis = plane_basis(plane_normal);
    let mut by_material = BTreeMap::<u32, Vec<SectionSegment>>::new();
    for segment in segments {
        by_material
            .entry(segment.material_slot)
            .or_default()
            .push(*segment);
    }
    let mut regions = Vec::new();
    for (material_slot, material_segments) in by_material {
        let contours = stitch_contours(&material_segments, tolerance)?;
        regions.extend(triangulate_contours(
            material_slot,
            &contours,
            plane_origin,
            basis,
        )?);
    }
    Ok(regions)
}

/// Uploads one exact section region into the shared depth, clip and pick paths.
pub fn build_section_region_batch(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &str,
    options: SectionBatchOptions,
    region: &SectionRegion,
) -> Result<GpuDrawBatch, GpuFrameError> {
    let normal = vector(options.plane_normal)
        .try_normalize()
        .filter(|normal| normal.is_finite())
        .ok_or(GpuFrameError::NonFiniteFrameValue)?;
    #[allow(clippy::cast_possible_truncation)]
    let normal = [normal.x as f32, normal.y as f32, normal.z as f32];
    let vertices = region
        .vertices
        .iter()
        .map(|position| GpuMeshVertexInput {
            position: options.floating_origin.world_to_render(*position),
            normal,
            tex_coord: [0.0; 2],
            additional_tex_coords: [[0.0; 2]; 7],
            color: options.linear_color,
        })
        .collect::<Vec<_>>();
    GpuDrawBatch::new_indexed_mesh_with_queue(
        device,
        queue,
        label,
        options.proxy_slot,
        options.primitive_base,
        &vertices,
        &region.indices,
        options.linear_color[3] < 1.0,
    )
}

fn validate_mesh(mesh: SectionMeshInput<'_>) -> Result<(), SectionError> {
    let minimum_positions = if mesh.closed_manifold { 4 } else { 3 };
    if mesh.positions.len() < minimum_positions
        || mesh.indices.is_empty()
        || !mesh.indices.len().is_multiple_of(3)
        || mesh.indices.iter().any(|index| {
            usize::try_from(*index).map_or(true, |index| index >= mesh.positions.len())
        })
        || mesh
            .positions
            .iter()
            .any(|position| !vector(*position).is_finite())
        || mesh
            .material_slots
            .is_some_and(|slots| slots.len() != mesh.indices.len() / 3)
    {
        Err(SectionError::InvalidMesh)
    } else {
        Ok(())
    }
}

fn intersect_triangles(
    mesh: SectionMeshInput<'_>,
    plane_origin: DVec3,
    normal: DVec3,
    tolerance: f64,
) -> Result<Vec<SectionSegment>, SectionError> {
    let mut segments = Vec::new();
    for (triangle_index, triangle) in mesh.indices.chunks_exact(3).enumerate() {
        let points: [DVec3; 3] = std::array::from_fn(|corner| {
            let index = usize::try_from(triangle[corner]).expect("validated mesh index");
            vector(mesh.positions[index])
        });
        let distances = points.map(|point| normal.dot(point - plane_origin));
        if distances.iter().all(|distance| distance.abs() <= tolerance) {
            return Err(SectionError::CoplanarTriangle);
        }
        let mut intersections = Vec::with_capacity(3);
        for [first, second] in [[0, 1], [1, 2], [2, 0]] {
            let first_distance = distances[first];
            let second_distance = distances[second];
            if first_distance.abs() <= tolerance {
                push_unique(&mut intersections, points[first], tolerance);
            }
            if (first_distance > tolerance && second_distance < -tolerance)
                || (first_distance < -tolerance && second_distance > tolerance)
            {
                let parameter = first_distance / (first_distance - second_distance);
                push_unique(
                    &mut intersections,
                    points[first].lerp(points[second], parameter),
                    tolerance,
                );
            }
        }
        match intersections.as_slice() {
            [start, end] if start.distance(*end) > tolerance => segments.push(SectionSegment {
                start: world(*start),
                end: world(*end),
                material_slot: mesh.material_slots.map_or(0, |slots| slots[triangle_index]),
            }),
            [] | [_] | [_, _] => {}
            _ => return Err(SectionError::CoplanarTriangle),
        }
    }
    Ok(segments)
}

fn push_unique(points: &mut Vec<DVec3>, point: DVec3, tolerance: f64) {
    if points
        .iter()
        .all(|existing| existing.distance(point) > tolerance)
    {
        points.push(point);
    }
}

fn stitch_contours(
    segments: &[SectionSegment],
    tolerance: f64,
) -> Result<Vec<SectionContour>, SectionError> {
    #[derive(Clone, Copy)]
    struct Endpoint {
        segment: usize,
        reverse: bool,
    }

    let cell_size = tolerance * 2.0;
    let mut endpoints = HashMap::<[i128; 3], Vec<Endpoint>>::new();
    for (segment, value) in segments.iter().enumerate() {
        endpoints
            .entry(endpoint_cell(value.start, cell_size))
            .or_default()
            .push(Endpoint {
                segment,
                reverse: false,
            });
        endpoints
            .entry(endpoint_cell(value.end, cell_size))
            .or_default()
            .push(Endpoint {
                segment,
                reverse: true,
            });
    }
    let mut unused = vec![true; segments.len()];
    let mut contours = Vec::new();
    while let Some(first_index) = unused.iter().rposition(|unused| *unused) {
        unused[first_index] = false;
        let first = segments[first_index];
        let mut points = vec![first.start, first.end];
        while distance(*points.last().expect("two points"), points[0]) > tolerance {
            let end = *points.last().expect("two points");
            let cell = endpoint_cell(end, cell_size);
            let mut next = None;
            for dz in -1_i128..=1 {
                for dy in -1_i128..=1 {
                    for dx in -1_i128..=1 {
                        let key = [
                            cell[0].saturating_add(dx),
                            cell[1].saturating_add(dy),
                            cell[2].saturating_add(dz),
                        ];
                        for candidate in endpoints.get(&key).into_iter().flatten() {
                            if !unused[candidate.segment] {
                                continue;
                            }
                            let segment = segments[candidate.segment];
                            let endpoint = if candidate.reverse {
                                segment.end
                            } else {
                                segment.start
                            };
                            if distance(endpoint, end) <= tolerance
                                && next.is_none_or(|current: Endpoint| {
                                    (candidate.segment, candidate.reverse)
                                        < (current.segment, current.reverse)
                                })
                            {
                                next = Some(*candidate);
                            }
                        }
                    }
                }
            }
            let Some(next) = next else {
                return Err(SectionError::OpenContour);
            };
            unused[next.segment] = false;
            let segment = segments[next.segment];
            points.push(if next.reverse {
                segment.start
            } else {
                segment.end
            });
            if points.len() > segments.len() + 1 {
                return Err(SectionError::OpenContour);
            }
        }
        points.pop();
        if points.len() < 3 {
            return Err(SectionError::OpenContour);
        }
        contours.push(SectionContour { points });
    }
    Ok(contours)
}

fn endpoint_cell(point: WorldVec3, cell_size: f64) -> [i128; 3] {
    [point.x, point.y, point.z].map(|value| (value / cell_size).floor() as i128)
}

fn triangulate_contours(
    material_slot: u32,
    contours: &[SectionContour],
    plane_origin: DVec3,
    basis: (DVec3, DVec3),
) -> Result<Vec<SectionRegion>, SectionError> {
    let projected = contours
        .iter()
        .map(|contour| {
            contour
                .points
                .iter()
                .map(|point| project(vector(*point), plane_origin, basis))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let areas = projected
        .iter()
        .map(|polygon| signed_area(polygon).abs())
        .collect::<Vec<_>>();
    if areas.iter().any(|area| *area <= f64::EPSILON) {
        return Err(SectionError::Triangulation);
    }
    let parents = (0..contours.len())
        .map(|index| {
            (0..contours.len())
                .filter(|candidate| {
                    *candidate != index
                        && areas[*candidate] > areas[index]
                        && point_in_polygon(projected[index][0], &projected[*candidate])
                })
                .min_by(|left, right| areas[*left].total_cmp(&areas[*right]))
        })
        .collect::<Vec<_>>();
    let depths = (0..contours.len())
        .map(|index| contour_depth(index, &parents))
        .collect::<Result<Vec<_>, _>>()?;
    let mut regions = Vec::new();
    for outer_index in 0..contours.len() {
        if !depths[outer_index].is_multiple_of(2) {
            continue;
        }
        let hole_indices = (0..contours.len())
            .filter(|index| parents[*index] == Some(outer_index) && depths[*index] % 2 == 1)
            .collect::<Vec<_>>();
        let outer = contours[outer_index].clone();
        let holes = hole_indices
            .iter()
            .map(|index| contours[*index].clone())
            .collect::<Vec<_>>();
        regions.push(triangulate_region(
            material_slot,
            outer,
            holes,
            plane_origin,
            basis,
        )?);
    }
    Ok(regions)
}

fn triangulate_region(
    material_slot: u32,
    outer: SectionContour,
    holes: Vec<SectionContour>,
    plane_origin: DVec3,
    basis: (DVec3, DVec3),
) -> Result<SectionRegion, SectionError> {
    let mut vertices = outer.points.clone();
    let mut hole_starts = Vec::with_capacity(holes.len());
    for hole in &holes {
        hole_starts.push(u32::try_from(vertices.len()).map_err(|_| SectionError::Triangulation)?);
        vertices.extend_from_slice(&hole.points);
    }
    let coordinates = vertices
        .iter()
        .map(|point| {
            let projected = project(vector(*point), plane_origin, basis);
            [projected.x, projected.y]
        })
        .collect::<Vec<_>>();
    let mut indices = Vec::new();
    Earcut::<f64>::new().earcut(coordinates, &hole_starts, &mut indices);
    if indices.is_empty() || !indices.len().is_multiple_of(3) {
        return Err(SectionError::Triangulation);
    }
    Ok(SectionRegion {
        material_slot,
        outer,
        holes,
        vertices,
        indices,
    })
}

fn contour_depth(index: usize, parents: &[Option<usize>]) -> Result<usize, SectionError> {
    let mut depth = 0;
    let mut current = parents[index];
    while let Some(parent) = current {
        depth += 1;
        if depth > parents.len() {
            return Err(SectionError::Triangulation);
        }
        current = parents[parent];
    }
    Ok(depth)
}

fn plane_basis(normal: DVec3) -> (DVec3, DVec3) {
    let reference = if normal.z.abs() < 0.9 {
        DVec3::Z
    } else {
        DVec3::X
    };
    let axis_x = reference.cross(normal).normalize();
    (axis_x, normal.cross(axis_x).normalize())
}

fn project(point: DVec3, origin: DVec3, basis: (DVec3, DVec3)) -> DVec2 {
    let relative = point - origin;
    DVec2::new(relative.dot(basis.0), relative.dot(basis.1))
}

fn signed_area(polygon: &[DVec2]) -> f64 {
    polygon
        .iter()
        .zip(polygon.iter().cycle().skip(1))
        .map(|(left, right)| left.x * right.y - right.x * left.y)
        .sum::<f64>()
        * 0.5
}

fn point_in_polygon(point: DVec2, polygon: &[DVec2]) -> bool {
    let mut inside = false;
    for (first, second) in polygon.iter().zip(polygon.iter().cycle().skip(1)) {
        if (first.y > point.y) != (second.y > point.y) {
            let crossing_x =
                (second.x - first.x) * (point.y - first.y) / (second.y - first.y) + first.x;
            if point.x < crossing_x {
                inside = !inside;
            }
        }
    }
    inside
}

fn distance(left: WorldVec3, right: WorldVec3) -> f64 {
    vector(left).distance(vector(right))
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

#[cfg(test)]
mod tests {
    use super::{
        authoritative_section_product_matches, evaluate_authoritative_section_product,
        evaluate_authoritative_section_product_with_transform, section_closed_mesh,
        section_geometry_object, section_open_mesh, stitch_contours,
        validate_authoritative_section_product, AuthoritativeSectionEvaluation,
        AuthoritativeSectionEvaluationError, AuthoritativeSectionPartInput,
        AuthoritativeSectionProduct, AuthoritativeSectionProductError, AuthoritativeSectionSource,
        SectionMaterialRegionBinding, SectionMeshInput, SectionPlane, SectionSegment,
        SectionTopologyBounds, SectionTopologyPart, AUTHORITATIVE_SECTION_PRODUCT_SCHEMA_VERSION,
    };
    use crate::{WorldTransform, WorldVec3};
    use himmelcad_core::canonical_resources::{
        CanonicalResourceRef, MATERIAL_TABLE_RESOURCE_SCHEMA_ID,
    };
    use himmelcad_core::entity_model::{
        CsgNode, GeometryObject, SolidGeometry, SolidPrimitive, Transform3d, TriangleMeshGeometry,
        TriangleMeshStorage, Vector3,
    };
    use himmelcad_core::hash::ObjectHash;
    use std::collections::BTreeMap;

    #[test]
    fn cube_section_produces_closed_material_cap_with_known_area() {
        let positions = cube_positions();
        let indices = cube_indices();
        let product = section_closed_mesh(
            SectionMeshInput {
                positions: &positions,
                indices: &indices,
                material_slots: Some(&[7; 12]),
                closed_manifold: true,
            },
            SectionPlane {
                origin: point(0.0, 0.0, 0.0),
                normal: point(0.0, 0.0, 1.0),
            },
            1.0e-9,
        )
        .expect("cube section");

        assert_eq!(product.regions.len(), 1);
        assert_eq!(product.regions[0].material_slot, 7);
        assert_eq!(product.regions[0].holes.len(), 0);
        let area = triangle_area(&product.regions[0]);
        assert!((area - 4.0).abs() < 1.0e-9);
    }

    #[test]
    fn nested_closed_shells_preserve_section_hole() {
        let mut positions = cube_positions().to_vec();
        positions.extend(
            cube_positions().map(|position| point(position.x * 0.5, position.y * 0.5, position.z)),
        );
        let mut indices = cube_indices().to_vec();
        indices.extend(cube_indices().map(|index| index + 8));
        let product = section_closed_mesh(
            SectionMeshInput {
                positions: &positions,
                indices: &indices,
                material_slots: Some(&[3; 24]),
                closed_manifold: true,
            },
            SectionPlane {
                origin: point(0.0, 0.0, 0.0),
                normal: point(0.0, 0.0, 1.0),
            },
            1.0e-9,
        )
        .expect("hollow section");

        assert_eq!(product.regions.len(), 1);
        assert_eq!(product.regions[0].holes.len(), 1);
        let area = triangle_area(&product.regions[0]);
        assert!((area - 3.0).abs() < 1.0e-9);
    }

    #[test]
    fn canonical_closed_mesh_section_applies_entity_placement_in_f64() {
        let geometry = GeometryObject::Solid {
            solid: Box::new(SolidGeometry::ClosedMesh {
                mesh: TriangleMeshGeometry {
                    storage: TriangleMeshStorage::Inline {
                        positions: cube_positions()
                            .map(|point| Vector3 {
                                x: point.x,
                                y: point.y,
                                z: point.z,
                            })
                            .to_vec(),
                        indices: cube_indices().to_vec(),
                        normals: None,
                        texture_coordinates: None,
                    },
                    closed_manifold: true,
                    triangle_material_slots: Some(vec![7; cube_indices().len() / 3]),
                    materials: Some(CanonicalResourceRef {
                        resource_id: "cube-materials".to_owned(),
                        schema_id: MATERIAL_TABLE_RESOURCE_SCHEMA_ID.to_owned(),
                        content_hash: ObjectHash("7".repeat(64)),
                    }),
                },
            }),
        };
        let product = section_geometry_object(
            &geometry,
            Some(Transform3d([
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
                500_000.0,
                5_400_000.0,
                100.0,
                1.0,
            ])),
            SectionPlane {
                origin: point(500_000.0, 5_400_000.0, 100.0),
                normal: point(0.0, 0.0, 1.0),
            },
            1.0e-9,
        )
        .expect("placed canonical section");
        assert_eq!(product.regions.len(), 1);
        assert_eq!(product.regions[0].material_slot, 7);
        assert!((triangle_area(&product.regions[0]) - 4.0).abs() < 1.0e-9);
    }

    #[test]
    fn parametric_box_section_composes_primitive_and_entity_placement() {
        let geometry = GeometryObject::Solid {
            solid: Box::new(SolidGeometry::Csg {
                root: CsgNode::Primitive {
                    primitive: SolidPrimitive::Box {
                        size: Vector3 {
                            x: 2.0,
                            y: 4.0,
                            z: 6.0,
                        },
                    },
                    placement: translation(10.0, 20.0, 30.0),
                },
            }),
        };
        let product = section_geometry_object(
            &geometry,
            Some(translation(100.0, 200.0, 300.0)),
            SectionPlane {
                origin: point(110.0, 220.0, 330.0),
                normal: point(0.0, 0.0, 1.0),
            },
            1.0e-6,
        )
        .expect("parametric box section");

        assert_eq!(product.regions.len(), 1);
        assert!((triangle_area(&product.regions[0]) - 8.0).abs() < 1.0e-9);
    }

    #[test]
    fn open_tin_section_returns_exact_trace_without_inventing_a_cap() {
        let positions = [
            point(-1.0, -1.0, -1.0),
            point(1.0, -1.0, 1.0),
            point(1.0, 1.0, 1.0),
            point(-1.0, 1.0, -1.0),
        ];
        let product = section_open_mesh(
            SectionMeshInput {
                positions: &positions,
                indices: &[0, 1, 2, 0, 2, 3],
                material_slots: Some(&[2, 2]),
                closed_manifold: false,
            },
            SectionPlane {
                origin: point(0.0, 0.0, 0.0),
                normal: point(0.0, 0.0, 1.0),
            },
            1.0e-9,
        )
        .expect("open TIN trace");

        assert!(product.regions.is_empty());
        assert_eq!(product.segments.len(), 2);
        assert!(product
            .segments
            .iter()
            .all(|segment| segment.material_slot == 2));
        let length = product
            .segments
            .iter()
            .map(|segment| {
                let start = glam::DVec3::new(segment.start.x, segment.start.y, segment.start.z);
                let end = glam::DVec3::new(segment.end.x, segment.end.y, segment.end.z);
                start.distance(end)
            })
            .sum::<f64>();
        assert!((length - 2.0).abs() < 1.0e-9);
    }

    #[test]
    fn one_triangle_is_a_valid_open_tin_partition() {
        let positions = [
            point(-1.0, -1.0, -1.0),
            point(1.0, -1.0, 1.0),
            point(0.0, 1.0, 0.0),
        ];
        let product = section_open_mesh(
            SectionMeshInput {
                positions: &positions,
                indices: &[0, 1, 2],
                material_slots: None,
                closed_manifold: false,
            },
            SectionPlane {
                origin: point(0.0, 0.0, 0.0),
                normal: point(0.0, 0.0, 1.0),
            },
            1.0e-9,
        )
        .expect("single open TIN triangle");

        assert_eq!(product.segments.len(), 1);
        assert!(product.regions.is_empty());
    }

    #[test]
    fn authoritative_two_tile_product_is_one_residency_independent_material_region() {
        let positions = cube_positions();
        let product = section_closed_mesh(
            SectionMeshInput {
                positions: &positions,
                indices: &cube_indices(),
                material_slots: Some(&[12; 12]),
                closed_manifold: true,
            },
            SectionPlane {
                origin: point(0.0, 0.0, 0.0),
                normal: point(0.0, 0.0, 1.0),
            },
            1.0e-9,
        )
        .expect("whole-topology section");
        let evaluated = AuthoritativeSectionProduct {
            schema_version: AUTHORITATIVE_SECTION_PRODUCT_SCHEMA_VERSION,
            source: AuthoritativeSectionSource {
                entity_id: "building-shell".to_owned(),
                dataset_id: Some("building-tileset".to_owned()),
                version_hash: "entity-v7".to_owned(),
                topology_hash: "whole-shell-topology-v7".to_owned(),
                closed_manifold: true,
                parts: vec![
                    SectionTopologyPart {
                        part_id: "tile-left".to_owned(),
                        topology_hash: "left-topology-v7".to_owned(),
                        bounds: None,
                    },
                    SectionTopologyPart {
                        part_id: "tile-right".to_owned(),
                        topology_hash: "right-topology-v7".to_owned(),
                        bounds: None,
                    },
                ],
            },
            plane: SectionPlane {
                origin: point(0.0, 0.0, 0.0),
                normal: point(0.0, 0.0, 1.0),
            },
            tolerance: 1.0e-9,
            material_regions: vec![SectionMaterialRegionBinding {
                region_index: 0,
                region_id: "wall-core:outer-shell".to_owned(),
                material_key: "material:reinforced-concrete".to_owned(),
            }],
            product,
        };

        validate_authoritative_section_product(&evaluated).expect("valid two-tile product");
        assert!(evaluated.product.regions[0]
            .vertices
            .iter()
            .any(|point| point.x < 0.0));
        assert!(evaluated.product.regions[0]
            .vertices
            .iter()
            .any(|point| point.x > 0.0));
        let decoded: AuthoritativeSectionProduct = serde_json::from_slice(
            &serde_json::to_vec(&evaluated).expect("serialize evaluated section"),
        )
        .expect("deserialize evaluated section");
        assert_eq!(decoded, evaluated);
        assert!(authoritative_section_product_matches(
            &evaluated,
            "building-shell",
            Some("building-tileset"),
            "entity-v7",
            evaluated.plane,
            evaluated.tolerance,
        ));
        assert!(!authoritative_section_product_matches(
            &evaluated,
            "building-shell",
            Some("building-tileset"),
            "entity-v8",
            evaluated.plane,
            evaluated.tolerance,
        ));
        let mut invalid_bounds = evaluated.clone();
        invalid_bounds.source.parts[0].bounds = Some(SectionTopologyBounds {
            minimum: [2.0, 0.0, 0.0],
            maximum: [1.0, 1.0, 1.0],
        });
        assert_eq!(
            validate_authoritative_section_product(&invalid_bounds),
            Err(AuthoritativeSectionProductError::InvalidSource)
        );
    }

    #[test]
    fn authoritative_product_rejects_tile_local_or_incomplete_material_identity() {
        let mut evaluated = AuthoritativeSectionProduct {
            schema_version: AUTHORITATIVE_SECTION_PRODUCT_SCHEMA_VERSION,
            source: AuthoritativeSectionSource {
                entity_id: "building-shell".to_owned(),
                dataset_id: Some("building-tileset".to_owned()),
                version_hash: "entity-v7".to_owned(),
                topology_hash: "whole-shell-topology-v7".to_owned(),
                closed_manifold: true,
                parts: vec![SectionTopologyPart {
                    part_id: "tile-left".to_owned(),
                    topology_hash: "left-topology-v7".to_owned(),
                    bounds: None,
                }],
            },
            plane: SectionPlane {
                origin: point(0.0, 0.0, 0.0),
                normal: point(0.0, 0.0, 1.0),
            },
            tolerance: 1.0e-9,
            material_regions: Vec::new(),
            product: section_closed_mesh(
                SectionMeshInput {
                    positions: &cube_positions(),
                    indices: &cube_indices(),
                    material_slots: Some(&[12; 12]),
                    closed_manifold: true,
                },
                SectionPlane {
                    origin: point(0.0, 0.0, 0.0),
                    normal: point(0.0, 0.0, 1.0),
                },
                1.0e-9,
            )
            .expect("whole-topology section"),
        };
        assert_eq!(
            validate_authoritative_section_product(&evaluated),
            Err(AuthoritativeSectionProductError::InvalidMaterialRegions)
        );
        evaluated
            .material_regions
            .push(SectionMaterialRegionBinding {
                region_index: 0,
                region_id: "wall-core:outer-shell".to_owned(),
                material_key: String::new(),
            });
        assert_eq!(
            validate_authoritative_section_product(&evaluated),
            Err(AuthoritativeSectionProductError::InvalidMaterialRegions)
        );
    }

    #[test]
    fn authoritative_evaluator_stitches_non_resident_partitions_deterministically() {
        let positions = cube_positions();
        let indices = cube_indices();
        let left_indices = &indices[..18];
        let right_indices = &indices[18..];
        let left_materials = [12; 6];
        let right_materials = [12; 6];
        let left = AuthoritativeSectionPartInput {
            part_id: "tile-left",
            topology_hash: "left-v7",
            positions: &positions,
            indices: left_indices,
            material_slots: Some(&left_materials),
        };
        let right = AuthoritativeSectionPartInput {
            part_id: "tile-right",
            topology_hash: "right-v7",
            positions: &positions,
            indices: right_indices,
            material_slots: Some(&right_materials),
        };
        let material_keys = BTreeMap::from([(12, "material:reinforced-concrete".to_owned())]);
        let plane = SectionPlane {
            origin: point(0.0, 0.0, 0.0),
            normal: point(0.0, 0.0, 1.0),
        };
        let evaluate = |parts: &[AuthoritativeSectionPartInput<'_>]| {
            evaluate_authoritative_section_product(AuthoritativeSectionEvaluation {
                entity_id: "building-shell",
                dataset_id: Some("building-tileset"),
                version_hash: "entity-v7",
                topology_hash: "whole-shell-v7",
                parts,
                material_keys: &material_keys,
                plane,
                tolerance: 1.0e-9,
                closed_manifold: true,
            })
            .expect("authoritative section")
        };

        let forward = evaluate(&[left, right]);
        let reversed = evaluate(&[right, left]);
        assert_eq!(forward, reversed);
        assert_eq!(forward.source.parts[0].part_id, "tile-left");
        assert_eq!(forward.source.parts[1].part_id, "tile-right");
        assert_eq!(forward.product.regions.len(), 1);
        assert_eq!(forward.material_regions.len(), 1);
        assert_eq!(
            forward.material_regions[0].material_key,
            "material:reinforced-concrete"
        );
        assert!(forward.material_regions[0]
            .region_id
            .starts_with("section-region:"));
        assert!((triangle_area(&forward.product.regions[0]) - 4.0).abs() < 1.0e-9);
        assert!(forward.product.regions[0]
            .vertices
            .iter()
            .any(|point| point.x < 0.0));
        assert!(forward.product.regions[0]
            .vertices
            .iter()
            .any(|point| point.x > 0.0));
    }

    #[test]
    fn authoritative_full_evaluator_places_source_topology_in_project_world() {
        let positions = cube_positions();
        let indices = cube_indices();
        let materials = [12; 12];
        let parts = [AuthoritativeSectionPartInput {
            part_id: "whole",
            topology_hash: "whole-v1",
            positions: &positions,
            indices: &indices,
            material_slots: Some(&materials),
        }];
        let material_keys = BTreeMap::from([(12, "material:concrete".to_owned())]);
        let product = evaluate_authoritative_section_product_with_transform(
            AuthoritativeSectionEvaluation {
                entity_id: "placed-solid",
                dataset_id: Some("placed-solid-dataset"),
                version_hash: "entity-v1",
                topology_hash: "whole-v1",
                parts: &parts,
                material_keys: &material_keys,
                plane: SectionPlane {
                    origin: point(0.0, 0.0, 10.0),
                    normal: point(0.0, 0.0, 1.0),
                },
                tolerance: 1.0e-9,
                closed_manifold: true,
            },
            WorldTransform([
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 10.0, 1.0,
            ]),
        )
        .expect("placed full authoritative section");

        assert_eq!(product.product.regions.len(), 1);
        assert!((triangle_area(&product.product.regions[0]) - 4.0).abs() < 1.0e-9);
        assert!(product.product.segments.iter().all(|segment| {
            (segment.start.z - 10.0).abs() < 1.0e-9 && (segment.end.z - 10.0).abs() < 1.0e-9
        }));
    }

    #[test]
    fn authoritative_evaluator_emits_open_trace_and_rejects_missing_cap_material_key() {
        let positions = cube_positions();
        let indices = cube_indices();
        let materials = [7; 12];
        let part = AuthoritativeSectionPartInput {
            part_id: "whole",
            topology_hash: "whole-topology",
            positions: &positions,
            indices: &indices,
            material_slots: Some(&materials),
        };
        let parts = [part];
        let material_keys = BTreeMap::new();
        let base = AuthoritativeSectionEvaluation {
            entity_id: "solid",
            dataset_id: None,
            version_hash: "v1",
            topology_hash: "whole-topology",
            parts: &parts,
            material_keys: &material_keys,
            plane: SectionPlane {
                origin: point(0.0, 0.0, 0.0),
                normal: point(0.0, 0.0, 1.0),
            },
            tolerance: 1.0e-9,
            closed_manifold: false,
        };
        let trace = evaluate_authoritative_section_product(base).expect("open topology trace");
        assert!(!trace.source.closed_manifold);
        assert!(!trace.product.segments.is_empty());
        assert!(trace.product.regions.is_empty());
        assert!(trace.material_regions.is_empty());
        assert_eq!(
            evaluate_authoritative_section_product(AuthoritativeSectionEvaluation {
                closed_manifold: true,
                ..base
            }),
            Err(AuthoritativeSectionEvaluationError::MissingMaterial)
        );
    }

    fn translation(x: f64, y: f64, z: f64) -> Transform3d {
        Transform3d([
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, x, y, z, 1.0,
        ])
    }

    fn triangle_area(region: &super::SectionRegion) -> f64 {
        region
            .indices
            .chunks_exact(3)
            .map(|triangle| {
                let index = |corner| usize::try_from(triangle[corner]).expect("index");
                let a = region.vertices[index(0)];
                let b = region.vertices[index(1)];
                let c = region.vertices[index(2)];
                ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)).abs() * 0.5
            })
            .sum()
    }

    fn point(x: f64, y: f64, z: f64) -> WorldVec3 {
        WorldVec3 { x, y, z }
    }

    fn cube_positions() -> [WorldVec3; 8] {
        [
            point(-1.0, -1.0, -1.0),
            point(1.0, -1.0, -1.0),
            point(1.0, 1.0, -1.0),
            point(-1.0, 1.0, -1.0),
            point(-1.0, -1.0, 1.0),
            point(1.0, -1.0, 1.0),
            point(1.0, 1.0, 1.0),
            point(-1.0, 1.0, 1.0),
        ]
    }

    fn cube_indices() -> [u32; 36] {
        [
            0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7,
            6, 3, 0, 4, 3, 4, 7,
        ]
    }

    #[test]
    fn endpoint_index_stitches_a_large_scrambled_contour() {
        let count = 20_000_usize;
        let ordered = (0..count)
            .map(|index| {
                let angle = |value: usize| std::f64::consts::TAU * value as f64 / count as f64;
                let start = point(angle(index).cos(), angle(index).sin(), 0.0);
                let end = point(
                    angle((index + 1) % count).cos(),
                    angle((index + 1) % count).sin(),
                    0.0,
                );
                if index % 2 == 0 {
                    SectionSegment {
                        start,
                        end,
                        material_slot: 0,
                    }
                } else {
                    SectionSegment {
                        start: end,
                        end: start,
                        material_slot: 0,
                    }
                }
            })
            .collect::<Vec<_>>();
        let scrambled = (0..count)
            .map(|index| ordered[(index * 7_919) % count])
            .collect::<Vec<_>>();
        let contours = stitch_contours(&scrambled, 1.0e-9).expect("closed indexed contour");
        assert_eq!(contours.len(), 1);
        assert_eq!(contours[0].points.len(), count);
    }
}
