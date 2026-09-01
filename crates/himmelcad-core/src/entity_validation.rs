//! Structural validation for canonical entity and geometry objects.

use std::collections::{BTreeMap, BTreeSet};

use thiserror::Error;

use crate::canonical_resources::{
    validate_canonical_resource_ref, BlockInstanceOverrides, BlockMemberAttributes,
    BlockMemberStyle, MATERIAL_TABLE_RESOURCE_SCHEMA_ID,
};
use crate::entity_model::{
    AlignmentGeometry, AnnotationAnchor, AreaGeometry, BuiltInEntityType, CameraModel,
    CanonicalEntity, CsgNode, CurveGeometry, CurveLoop, CurveUse, DepthSampling, DimensionGeometry,
    ElevationSurfaceGeometry, GeometryObject, GeometryResource, LabelGeometry, OrthoGridMapping,
    PanoramaGeometry, PlaneDefinition, PlaneFrame, Position, RasterConfidenceEncoding,
    RasterConnectivity, RasterImageGeometry, RasterInterpolation, RasterMapping, Representation,
    RepresentationAuthority, RepresentationRole, SolidGeometry, SolidPrimitive, StationFunction,
    StreamedGeometry, TextGeometry, Transform3d, TriangleMeshGeometry, TriangleMeshStorage,
    Vector3,
};
use crate::hash::ObjectHash;

const JAVASCRIPT_SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy)]
struct RasterConnectivityDimensions {
    width: u32,
    height: u32,
    horizontal_wrap: bool,
}

/// Reason a canonical object cannot enter authoritative storage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum EntityValidationError {
    /// A required identifier or versioned type identifier is malformed.
    #[error("canonical identifier is invalid")]
    InvalidIdentifier,
    /// A coordinate, parameter, transform or dimension is non-finite or out of range.
    #[error("canonical numeric value is invalid")]
    InvalidNumber,
    /// Curve structure or parameterization is invalid.
    #[error("canonical curve is invalid")]
    InvalidCurve,
    /// Area boundary structure is invalid.
    #[error("canonical area is invalid")]
    InvalidArea,
    /// Mesh topology or parallel vertex arrays are invalid.
    #[error("canonical mesh is invalid")]
    InvalidMesh,
    /// Raster resource, mapping, depth or connectivity metadata is invalid.
    #[error("canonical raster is invalid")]
    InvalidRaster,
    /// A solid fails its representation-specific volume preconditions.
    #[error("canonical solid is invalid")]
    InvalidSolid,
    /// Alignment station functions or corridor rules are invalid.
    #[error("canonical alignment is invalid")]
    InvalidAlignment,
    /// Text, label or dimension definition is invalid.
    #[error("canonical annotation is invalid")]
    InvalidAnnotation,
    /// Representation roles, authority or dependency declarations are inconsistent.
    #[error("canonical representation contract is invalid")]
    InvalidRepresentation,
    /// A built-in entity type cannot use the selected role/geometry combination.
    #[error("geometry is incompatible with the built-in entity type and representation role")]
    IncompatibleRepresentation,
    /// Resolved geometry bytes do not match the representation's content address.
    #[error("resolved geometry content hash does not match its representation")]
    GeometryHashMismatch,
    /// Entity fields do not match the stored version hash.
    #[error("canonical entity version hash does not match its content")]
    VersionHashMismatch,
}

/// Validates one stable entity envelope independently of referenced objects.
pub fn validate_canonical_entity(entity: &CanonicalEntity) -> Result<(), EntityValidationError> {
    if entity.revision > JAVASCRIPT_SAFE_INTEGER_MAX {
        return Err(EntityValidationError::InvalidNumber);
    }
    if entity.id.0.trim().is_empty()
        || entity.name.contains('\0')
        || !valid_type_id(&entity.type_id.0)
        || entity.schema_version == 0
        || !valid_hash(entity.components_ref.as_str())
        || !valid_hash(entity.attributes_ref.as_str())
        || !valid_hash(entity.relations_ref.as_str())
        || !valid_hash(entity.version_hash.as_str())
        || entity
            .style_ref
            .as_ref()
            .is_some_and(|hash| !valid_hash(hash.as_str()))
        || entity
            .placement
            .as_ref()
            .is_some_and(|placement| !valid_transform(*placement))
    {
        return Err(EntityValidationError::InvalidIdentifier);
    }
    if entity.owner.as_ref() == Some(&entity.id)
        || entity.layer_ids.iter().any(|layer| layer == &entity.id)
        || entity
            .representations
            .iter()
            .any(|representation| !valid_hash(representation.geometry_ref.as_str()))
    {
        return Err(EntityValidationError::InvalidIdentifier);
    }
    Ok(())
}

/// Computes the content address used by a resolved canonical geometry object.
///
/// The hash input is the compact JSON encoding of the validated Rust contract.
/// Tagged enums and struct field order are therefore part of the schema-versioned
/// content-addressing contract.
pub fn geometry_object_content_hash(
    geometry: &GeometryObject,
) -> Result<ObjectHash, EntityValidationError> {
    validate_geometry_object(geometry)?;
    let bytes = serde_json::to_vec(geometry).map_err(|_| EntityValidationError::InvalidNumber)?;
    Ok(ObjectHash::of_bytes(&bytes))
}

/// Computes an entity version hash from every serialized envelope field except
/// `versionHash` itself.
///
/// Geometry content is included transitively through each representation's
/// `geometryRef`; the geometry bytes are not duplicated in the envelope hash.
pub fn canonical_entity_version_hash(
    entity: &CanonicalEntity,
) -> Result<ObjectHash, EntityValidationError> {
    let mut value =
        serde_json::to_value(entity).map_err(|_| EntityValidationError::InvalidRepresentation)?;
    let object = value
        .as_object_mut()
        .ok_or(EntityValidationError::InvalidRepresentation)?;
    if object.remove("versionHash").is_none() {
        return Err(EntityValidationError::InvalidRepresentation);
    }
    let bytes =
        serde_json::to_vec(&value).map_err(|_| EntityValidationError::InvalidRepresentation)?;
    Ok(ObjectHash::of_bytes(&bytes))
}

/// Validates representation-set semantics and the entity's version hash.
///
/// Organizational built-ins carry no geometry. Every geometric built-in has
/// exactly one primary source: either an authoritative canonical
/// representation or an alternate imported fallback. Derived representations
/// always name their dependency hash and can never claim the canonical role.
pub fn validate_canonical_entity_semantics(
    entity: &CanonicalEntity,
) -> Result<(), EntityValidationError> {
    validate_canonical_entity(entity)?;
    validate_representation_set(entity)?;
    if canonical_entity_version_hash(entity)? != entity.version_hash {
        return Err(EntityValidationError::VersionHashMismatch);
    }
    Ok(())
}

/// Admission gate for a selected representation and its resolved geometry.
///
/// This is the boundary storage/import code should call before publishing a
/// built-in entity/geometry pair. It verifies the complete envelope contract,
/// selection membership, exact geometry content addressing, and semantic
/// compatibility between built-in type, representation role and geometry.
pub fn validate_resolved_representation(
    entity: &CanonicalEntity,
    selected: &Representation,
    geometry: &GeometryObject,
) -> Result<(), EntityValidationError> {
    validate_canonical_entity_semantics(entity)?;
    if !entity
        .representations
        .iter()
        .any(|representation| representation == selected)
    {
        return Err(EntityValidationError::InvalidRepresentation);
    }
    if geometry_object_content_hash(geometry)? != selected.geometry_ref {
        return Err(EntityValidationError::GeometryHashMismatch);
    }
    if let Some(entity_type) = BuiltInEntityType::from_type_id(&entity.type_id) {
        validate_built_in_compatibility(entity_type, selected, geometry)?;
    }
    Ok(())
}

fn validate_representation_set(entity: &CanonicalEntity) -> Result<(), EntityValidationError> {
    for representation in &entity.representations {
        let dependency_is_valid = representation
            .dependency_hash
            .as_ref()
            .is_none_or(|hash| valid_hash(hash.as_str()));
        let authority_is_valid = match representation.authority {
            RepresentationAuthority::Authoritative => representation.dependency_hash.is_none(),
            RepresentationAuthority::Derived => representation.dependency_hash.is_some(),
            RepresentationAuthority::ImportedFallback => {
                representation.role == RepresentationRole::Alternate
                    && representation.dependency_hash.is_none()
            }
        };
        if !dependency_is_valid
            || !authority_is_valid
            || (representation.role == RepresentationRole::Canonical
                && representation.authority != RepresentationAuthority::Authoritative)
        {
            return Err(EntityValidationError::InvalidRepresentation);
        }
    }

    let Some(entity_type) = BuiltInEntityType::from_type_id(&entity.type_id) else {
        return Ok(());
    };
    if entity_type.is_organizational() {
        return if entity.representations.is_empty() {
            Ok(())
        } else {
            Err(EntityValidationError::IncompatibleRepresentation)
        };
    }

    let primary_count = entity
        .representations
        .iter()
        .filter(|representation| {
            (representation.role == RepresentationRole::Canonical
                && representation.authority == RepresentationAuthority::Authoritative)
                || (representation.role == RepresentationRole::Alternate
                    && representation.authority == RepresentationAuthority::ImportedFallback)
        })
        .count();
    if primary_count != 1 {
        return Err(EntityValidationError::InvalidRepresentation);
    }
    Ok(())
}

fn validate_built_in_compatibility(
    entity_type: BuiltInEntityType,
    representation: &Representation,
    geometry: &GeometryObject,
) -> Result<(), EntityValidationError> {
    use BuiltInEntityType as EntityType;
    use GeometryObject as Geometry;
    use RepresentationRole as Role;

    let compatible = match representation.role {
        Role::Canonical => is_canonical_geometry(entity_type, geometry),
        Role::Body => {
            matches!(
                entity_type,
                EntityType::Area
                    | EntityType::ElevationSurface
                    | EntityType::Surface3d
                    | EntityType::Object3d
                    | EntityType::BimObject
                    | EntityType::Alignment
            ) && matches!(
                geometry,
                Geometry::ElevationSurface { .. }
                    | Geometry::Surface3d { .. }
                    | Geometry::Solid { .. }
            )
        }
        Role::Axis => {
            matches!(
                entity_type,
                EntityType::Curve
                    | EntityType::Object3d
                    | EntityType::BimObject
                    | EntityType::Alignment
            ) && matches!(geometry, Geometry::Curve { .. })
        }
        Role::Footprint => {
            matches!(
                entity_type,
                EntityType::Area
                    | EntityType::ElevationSurface
                    | EntityType::Surface3d
                    | EntityType::RasterImage
                    | EntityType::PointCloud
                    | EntityType::GaussianSplatCloud
                    | EntityType::Panorama
                    | EntityType::Object3d
                    | EntityType::BimObject
                    | EntityType::Alignment
                    | EntityType::Block
            ) && matches!(geometry, Geometry::Area { .. })
        }
        Role::Boundary => {
            matches!(
                entity_type,
                EntityType::Area
                    | EntityType::ElevationSurface
                    | EntityType::Surface3d
                    | EntityType::RasterImage
                    | EntityType::Object3d
                    | EntityType::BimObject
                    | EntityType::Alignment
            ) && matches!(geometry, Geometry::Curve { .. })
        }
        // Derived alternates may change representation form. Authoritative
        // alternates must retain the entity's primary geometry meaning, while
        // an imported fallback stays explicitly opaque.
        Role::Alternate => match representation.authority {
            RepresentationAuthority::Derived => {
                !matches!(entity_type, EntityType::Group | EntityType::Layer)
            }
            RepresentationAuthority::Authoritative => is_canonical_geometry(entity_type, geometry),
            RepresentationAuthority::ImportedFallback => {
                matches!(geometry, Geometry::Extension { .. })
            }
        },
    };
    if compatible {
        Ok(())
    } else {
        Err(EntityValidationError::IncompatibleRepresentation)
    }
}

fn is_canonical_geometry(entity_type: BuiltInEntityType, geometry: &GeometryObject) -> bool {
    use BuiltInEntityType as EntityType;
    use GeometryObject as Geometry;

    match entity_type {
        EntityType::Group | EntityType::Layer => false,
        EntityType::Point => matches!(geometry, Geometry::Point { .. }),
        EntityType::Curve => matches!(geometry, Geometry::Curve { .. }),
        EntityType::Area => matches!(geometry, Geometry::Area { .. }),
        EntityType::Plane => matches!(geometry, Geometry::Plane { .. }),
        EntityType::ElevationSurface => matches!(geometry, Geometry::ElevationSurface { .. }),
        EntityType::Surface3d => matches!(geometry, Geometry::Surface3d { .. }),
        EntityType::RasterImage => matches!(geometry, Geometry::RasterImage { .. }),
        EntityType::PointCloud => matches!(geometry, Geometry::PointCloud { .. }),
        EntityType::GaussianSplatCloud => {
            matches!(geometry, Geometry::GaussianSplatCloud { .. })
        }
        EntityType::Panorama => matches!(geometry, Geometry::Panorama { .. }),
        EntityType::Object3d | EntityType::BimObject => {
            matches!(geometry, Geometry::Solid { .. })
        }
        EntityType::Alignment => matches!(geometry, Geometry::Alignment { .. }),
        EntityType::Block => matches!(geometry, Geometry::Block { .. }),
        EntityType::Text => matches!(geometry, Geometry::Text { .. }),
        EntityType::Label => matches!(geometry, Geometry::Label { .. }),
        EntityType::Dimension => matches!(geometry, Geometry::Dimension { .. }),
    }
}

/// Validates one immutable geometry object before hashing and storage.
pub fn validate_geometry_object(geometry: &GeometryObject) -> Result<(), EntityValidationError> {
    match geometry {
        GeometryObject::Point { position } => validate_position(*position),
        GeometryObject::Curve { curve } => validate_curve(curve),
        GeometryObject::Area { area } => validate_area(area),
        GeometryObject::Plane { plane } => validate_plane(*plane),
        GeometryObject::ElevationSurface { surface } => validate_elevation_surface(surface),
        GeometryObject::Surface3d { mesh } => validate_mesh(mesh),
        GeometryObject::RasterImage { raster } => validate_raster(raster),
        GeometryObject::PointCloud { dataset } | GeometryObject::GaussianSplatCloud { dataset } => {
            validate_streamed(dataset)
        }
        GeometryObject::Panorama { panorama } => validate_panorama(panorama),
        GeometryObject::Solid { solid } => validate_solid(solid),
        GeometryObject::Alignment { alignment } => validate_alignment(alignment),
        GeometryObject::Block { instance } => {
            if instance.definition_id.trim().is_empty()
                || !valid_hash(instance.definition_hash.as_str())
                || !valid_transform(instance.placement)
            {
                Err(EntityValidationError::InvalidIdentifier)
            } else if let Some(overrides) = &instance.overrides {
                validate_block_instance_overrides(overrides)
            } else {
                Ok(())
            }
        }
        GeometryObject::Text { text } => validate_text(text),
        GeometryObject::Label { label } => validate_label(label),
        GeometryObject::Dimension { dimension } => validate_dimension(dimension),
        GeometryObject::Extension { type_id, payload } => {
            if valid_type_id(type_id) && valid_hash(payload.as_str()) {
                Ok(())
            } else {
                Err(EntityValidationError::InvalidIdentifier)
            }
        }
    }
}

fn validate_block_instance_overrides(
    overrides: &BlockInstanceOverrides,
) -> Result<(), EntityValidationError> {
    const MAX_BLOCK_MEMBER_OVERRIDES: usize = 1_000_000;

    if overrides.members.len() > MAX_BLOCK_MEMBER_OVERRIDES {
        return Err(EntityValidationError::InvalidIdentifier);
    }
    validate_block_member_style(&overrides.style)?;
    validate_block_member_attributes(&overrides.attributes)?;
    let mut member_ids = BTreeSet::new();
    for member in &overrides.members {
        if member.member_id.trim().is_empty() || !member_ids.insert(&member.member_id) {
            return Err(EntityValidationError::InvalidIdentifier);
        }
        validate_block_member_style(&member.style)?;
        validate_block_member_attributes(&member.attributes)?;
    }
    Ok(())
}

fn validate_block_member_style(style: &BlockMemberStyle) -> Result<(), EntityValidationError> {
    if let BlockMemberStyle::Resource { style } = style {
        validate_canonical_resource_ref(style)
            .map_err(|_| EntityValidationError::InvalidIdentifier)?;
    }
    Ok(())
}

fn validate_block_member_attributes(
    attributes: &BlockMemberAttributes,
) -> Result<(), EntityValidationError> {
    if let BlockMemberAttributes::Replace { attributes_ref } = attributes {
        if !valid_hash(attributes_ref.as_str()) {
            return Err(EntityValidationError::InvalidIdentifier);
        }
    }
    Ok(())
}

#[allow(clippy::too_many_lines)]
fn validate_curve(curve: &CurveGeometry) -> Result<(), EntityValidationError> {
    match curve {
        CurveGeometry::LineSegment { start, end } => {
            validate_position(*start)?;
            validate_position(*end)?;
            if same_position(*start, *end) {
                return Err(EntityValidationError::InvalidCurve);
            }
        }
        CurveGeometry::Polyline { positions, .. } => {
            if positions.len() < 2 {
                return Err(EntityValidationError::InvalidCurve);
            }
            for position in positions {
                validate_position(*position)?;
            }
        }
        CurveGeometry::CircularArc {
            start,
            point_on_arc,
            end,
        } => {
            for position in [start, point_on_arc, end] {
                validate_position(*position)?;
            }
            if same_position(*start, *point_on_arc)
                || same_position(*point_on_arc, *end)
                || same_position(*start, *end)
            {
                return Err(EntityValidationError::InvalidCurve);
            }
        }
        CurveGeometry::Circle {
            center,
            radius,
            plane,
        } => {
            validate_position(*center)?;
            positive(*radius)?;
            validate_optional_plane(*plane)?;
        }
        CurveGeometry::Ellipse {
            center,
            major_axis,
            minor_radius,
            plane,
        } => validate_ellipse(*center, *major_axis, *minor_radius, *plane)?,
        CurveGeometry::EllipticArc {
            center,
            major_axis,
            minor_radius,
            start_parameter,
            sweep_parameter,
            plane,
        } => {
            validate_ellipse(*center, *major_axis, *minor_radius, *plane)?;
            if !start_parameter.is_finite()
                || !sweep_parameter.is_finite()
                || sweep_parameter.abs() <= f64::EPSILON
            {
                return Err(EntityValidationError::InvalidCurve);
            }
        }
        CurveGeometry::ConicArc {
            start,
            control,
            end,
            control_weight,
        } => {
            for position in [start, control, end] {
                validate_position(*position)?;
            }
            if same_position(*start, *control)
                || same_position(*control, *end)
                || same_position(*start, *end)
                || conic_control_polygon_degenerate(*start, *control, *end)
                || !control_weight.is_finite()
                || *control_weight <= 0.0
            {
                return Err(EntityValidationError::InvalidCurve);
            }
        }
        CurveGeometry::Clothoid {
            start,
            start_tangent,
            start_curvature,
            end_curvature,
            length,
            plane,
        } => {
            validate_position(*start)?;
            validate_direction(*start_tangent)?;
            positive(*length)?;
            if !start_curvature.is_finite() || !end_curvature.is_finite() {
                return Err(EntityValidationError::InvalidNumber);
            }
            validate_optional_plane(*plane)?;
        }
        CurveGeometry::Spline {
            degree,
            control_points,
            knots,
            weights,
            ..
        } => {
            let degree = usize::from(*degree);
            if degree == 0
                || control_points.len() <= degree
                || knots.len() != control_points.len() + degree + 1
                || !knots.windows(2).all(|pair| pair[0] <= pair[1])
                || knots.iter().any(|value| !value.is_finite())
                || weights.as_ref().is_some_and(|weights| {
                    weights.len() != control_points.len()
                        || weights
                            .iter()
                            .any(|weight| !weight.is_finite() || *weight <= 0.0)
                })
            {
                return Err(EntityValidationError::InvalidCurve);
            }
            for position in control_points {
                validate_position(*position)?;
            }
        }
        CurveGeometry::Composite { segments } => {
            if segments.is_empty() {
                return Err(EntityValidationError::InvalidCurve);
            }
            for segment in segments {
                validate_curve(segment)?;
            }
        }
    }
    Ok(())
}

fn conic_control_polygon_degenerate(start: Position, control: Position, end: Position) -> bool {
    let first = [control.x - start.x, control.y - start.y];
    let second = [end.x - start.x, end.y - start.y];
    let xy_cross = first[0] * second[1] - first[1] * second[0];
    match (start.z, control.z, end.z) {
        (Some(start_z), Some(control_z), Some(end_z)) => {
            let first_z = control_z - start_z;
            let second_z = end_z - start_z;
            let cross = [
                first[1] * second_z - first_z * second[1],
                first_z * second[0] - first[0] * second_z,
                xy_cross,
            ];
            cross
                .iter()
                .map(|component| component * component)
                .sum::<f64>()
                <= f64::EPSILON
        }
        _ => xy_cross.abs() <= f64::EPSILON,
    }
}

fn validate_area(area: &AreaGeometry) -> Result<(), EntityValidationError> {
    validate_loop(&area.outer)?;
    for hole in &area.holes {
        validate_loop(hole)?;
    }
    Ok(())
}

fn validate_loop(curve_loop: &CurveLoop) -> Result<(), EntityValidationError> {
    if curve_loop.uses.is_empty() {
        return Err(EntityValidationError::InvalidArea);
    }
    for curve_use in &curve_loop.uses {
        match curve_use {
            CurveUse::Inline { curve, .. } => validate_curve(curve)?,
            CurveUse::Associative {
                entity_id,
                expected_version,
                ..
            } => {
                if entity_id.0.trim().is_empty()
                    || expected_version
                        .as_ref()
                        .is_some_and(|hash| !valid_hash(hash.as_str()))
                {
                    return Err(EntityValidationError::InvalidIdentifier);
                }
            }
        }
    }
    Ok(())
}

fn validate_mesh(mesh: &TriangleMeshGeometry) -> Result<(), EntityValidationError> {
    if let Some(materials) = &mesh.materials {
        if materials.schema_id != MATERIAL_TABLE_RESOURCE_SCHEMA_ID
            || validate_canonical_resource_ref(materials).is_err()
        {
            return Err(EntityValidationError::InvalidMesh);
        }
    }
    match &mesh.storage {
        TriangleMeshStorage::Resource { resource } => {
            if mesh.triangle_material_slots.is_some() {
                return Err(EntityValidationError::InvalidMesh);
            }
            validate_resource(resource)
        }
        TriangleMeshStorage::Inline {
            positions,
            indices,
            normals,
            texture_coordinates,
        } => {
            if positions.len() < 3
                || indices.is_empty()
                || !indices.len().is_multiple_of(3)
                || indices
                    .iter()
                    .any(|index| usize::try_from(*index).map_or(true, |i| i >= positions.len()))
                || normals
                    .as_ref()
                    .is_some_and(|normals| normals.len() != positions.len())
                || texture_coordinates.as_ref().is_some_and(|sets| {
                    sets.is_empty()
                        || sets.len() > 8
                        || sets
                            .iter()
                            .any(|coordinates| coordinates.len() != positions.len())
                })
                || mesh.triangle_material_slots.as_ref().is_some_and(|slots| {
                    slots.len() != indices.len() / 3 || mesh.materials.is_none()
                })
            {
                return Err(EntityValidationError::InvalidMesh);
            }
            for position in positions {
                validate_vector(*position)?;
            }
            if normals.as_ref().is_some_and(|normals| {
                normals
                    .iter()
                    .any(|normal| validate_direction(*normal).is_err())
            }) || texture_coordinates.as_ref().is_some_and(|sets| {
                sets.iter()
                    .flatten()
                    .flatten()
                    .any(|value| !value.is_finite())
            }) {
                return Err(EntityValidationError::InvalidMesh);
            }
            Ok(())
        }
    }
}

fn validate_elevation_surface(
    surface: &ElevationSurfaceGeometry,
) -> Result<(), EntityValidationError> {
    match surface {
        ElevationSurfaceGeometry::Tin { mesh, breaklines } => {
            validate_mesh(mesh)?;
            validate_elevation_tin_topology(mesh)?;
            for breakline in breaklines {
                validate_curve(breakline)?;
            }
            Ok(())
        }
        ElevationSurfaceGeometry::Grid {
            raster,
            mapping,
            sampling,
        } => {
            validate_resource(raster)?;
            validate_grid(*mapping)?;
            validate_depth_sampling(sampling, None)
        }
    }
}

fn validate_elevation_tin_topology(
    mesh: &TriangleMeshGeometry,
) -> Result<(), EntityValidationError> {
    let TriangleMeshStorage::Inline {
        positions, indices, ..
    } = &mesh.storage
    else {
        // The compact schema cannot inspect opaque resource bytes. A provider
        // admission gate must separately prove this 2.5D invariant.
        return Ok(());
    };

    let mut elevations_by_xy = BTreeMap::new();
    for position in positions {
        let xy = (
            canonical_zero_bits(position.x),
            canonical_zero_bits(position.y),
        );
        let elevation = canonical_zero_bits(position.z);
        if elevations_by_xy
            .insert(xy, elevation)
            .is_some_and(|existing| existing != elevation)
        {
            return Err(EntityValidationError::InvalidMesh);
        }
    }

    for triangle in indices.chunks_exact(3) {
        let a = positions[triangle[0] as usize];
        let b = positions[triangle[1] as usize];
        let c = positions[triangle[2] as usize];
        let projected_area_twice = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if projected_area_twice == 0.0 {
            return Err(EntityValidationError::InvalidMesh);
        }
    }
    Ok(())
}

fn canonical_zero_bits(value: f64) -> u64 {
    if value == 0.0 {
        0.0_f64.to_bits()
    } else {
        value.to_bits()
    }
}

fn validate_raster(raster: &RasterImageGeometry) -> Result<(), EntityValidationError> {
    if raster.width == 0 || raster.height == 0 {
        return Err(EntityValidationError::InvalidRaster);
    }
    validate_resource(&raster.pixels)?;
    match &raster.mapping {
        RasterMapping::OrthoGrid(mapping) => validate_grid(*mapping)?,
        RasterMapping::Planar { homography, frame } => {
            if homography.iter().any(|value| !value.is_finite())
                || homography_determinant(*homography).abs() <= f64::EPSILON
            {
                return Err(EntityValidationError::InvalidRaster);
            }
            validate_plane_frame(*frame)?;
        }
        RasterMapping::Camera { model, pose } => {
            validate_camera(model)?;
            if !valid_rigid_transform(*pose) {
                return Err(EntityValidationError::InvalidRaster);
            }
        }
    }
    let horizontal_wrap = matches!(
        &raster.mapping,
        RasterMapping::Camera {
            model: CameraModel::Equirectangular,
            ..
        }
    );
    if let Some(depth) = &raster.depth {
        validate_raster_depth_mapping(&raster.mapping, depth.sampling.semantics)?;
        validate_resource(&depth.values)?;
        if let Some(validity) = &depth.validity {
            validate_resource(&validity.resource)?;
            validate_known_resource_length(
                &validity.resource,
                bitset_byte_length(u64::from(raster.width) * u64::from(raster.height), 1)?,
            )?;
        }
        if let Some(confidence) = &depth.confidence {
            validate_resource(&confidence.resource)?;
            let bytes_per_sample = match confidence.encoding {
                RasterConfidenceEncoding::Unorm8 => 1,
                RasterConfidenceEncoding::Float32LittleEndian => 4,
            };
            let expected = u64::from(raster.width)
                .checked_mul(u64::from(raster.height))
                .and_then(|samples| samples.checked_mul(bytes_per_sample))
                .ok_or(EntityValidationError::InvalidRaster)?;
            validate_known_resource_length(&confidence.resource, expected)?;
        }
        validate_depth_sampling(
            &depth.sampling,
            Some(RasterConnectivityDimensions {
                width: raster.width,
                height: raster.height,
                horizontal_wrap,
            }),
        )?;
    }
    Ok(())
}

fn validate_raster_depth_mapping(
    mapping: &RasterMapping,
    semantics: crate::entity_model::DepthSemantics,
) -> Result<(), EntityValidationError> {
    use crate::entity_model::DepthSemantics;

    match (mapping, semantics) {
        (RasterMapping::OrthoGrid(_), DepthSemantics::ElevationZ)
        | (RasterMapping::Camera { .. }, DepthSemantics::RayDistance)
        | (
            RasterMapping::Camera {
                model: CameraModel::Pinhole { .. } | CameraModel::Extension { .. },
                ..
            },
            DepthSemantics::OpticalAxisDepth,
        )
        | (RasterMapping::Camera { .. }, DepthSemantics::ElevationZ) => Ok(()),
        (RasterMapping::OrthoGrid(_), _)
        | (RasterMapping::Planar { .. }, _)
        | (
            RasterMapping::Camera {
                model: CameraModel::Equirectangular,
                ..
            },
            DepthSemantics::OpticalAxisDepth,
        ) => Err(EntityValidationError::InvalidRaster),
    }
}

fn validate_solid(solid: &SolidGeometry) -> Result<(), EntityValidationError> {
    match solid {
        SolidGeometry::ClosedMesh { mesh } => {
            validate_mesh(mesh)?;
            if !mesh.closed_manifold {
                return Err(EntityValidationError::InvalidSolid);
            }
        }
        SolidGeometry::Brep { resource } => validate_resource(resource)?,
        SolidGeometry::Csg { root } => validate_csg(root)?,
        SolidGeometry::Extrusion { profile, direction } => {
            validate_area(profile)?;
            validate_direction(*direction)?;
        }
        SolidGeometry::Sweep { profile, path } => {
            validate_area(profile)?;
            validate_curve(path)?;
        }
        SolidGeometry::Extension {
            type_id,
            parameters,
        } => {
            if !valid_type_id(type_id) || !valid_hash(parameters.as_str()) {
                return Err(EntityValidationError::InvalidSolid);
            }
        }
    }
    Ok(())
}

fn validate_csg(node: &CsgNode) -> Result<(), EntityValidationError> {
    match node {
        CsgNode::Primitive {
            primitive,
            placement,
        } => {
            if !valid_transform(*placement) {
                return Err(EntityValidationError::InvalidSolid);
            }
            match primitive {
                SolidPrimitive::Box { size } => {
                    validate_vector(*size)?;
                    if size.x <= 0.0 || size.y <= 0.0 || size.z <= 0.0 {
                        return Err(EntityValidationError::InvalidSolid);
                    }
                }
                SolidPrimitive::Sphere { radius } | SolidPrimitive::Cylinder { radius, .. } => {
                    positive(*radius)?;
                }
                SolidPrimitive::Cone {
                    bottom_radius,
                    top_radius,
                    height,
                } => {
                    if !bottom_radius.is_finite()
                        || !top_radius.is_finite()
                        || *bottom_radius < 0.0
                        || *top_radius < 0.0
                        || (*bottom_radius <= 0.0 && *top_radius <= 0.0)
                    {
                        return Err(EntityValidationError::InvalidSolid);
                    }
                    positive(*height)?;
                }
            }
            if let SolidPrimitive::Cylinder { height, .. } = primitive {
                positive(*height)?;
            }
        }
        CsgNode::Boolean { left, right, .. } => {
            validate_csg(left)?;
            validate_csg(right)?;
        }
    }
    Ok(())
}

fn validate_alignment(alignment: &AlignmentGeometry) -> Result<(), EntityValidationError> {
    validate_curve(&alignment.horizontal)?;
    if !alignment.station_origin.is_finite() {
        return Err(EntityValidationError::InvalidAlignment);
    }
    for segment in &alignment.vertical {
        let (values, length) = match segment {
            crate::entity_model::VerticalAlignmentSegment::Grade {
                start_station,
                start_elevation,
                grade,
                length,
            } => ([*start_station, *start_elevation, *grade, 0.0], *length),
            crate::entity_model::VerticalAlignmentSegment::Parabolic {
                start_station,
                start_elevation,
                start_grade,
                end_grade,
                length,
            } => (
                [*start_station, *start_elevation, *start_grade, *end_grade],
                *length,
            ),
        };
        if values.iter().any(|value| !value.is_finite()) || !length.is_finite() || length <= 0.0 {
            return Err(EntityValidationError::InvalidAlignment);
        }
    }
    for band in &alignment.width_bands {
        if band.id.trim().is_empty() {
            return Err(EntityValidationError::InvalidAlignment);
        }
        validate_station_function(&band.inner_offset)?;
        validate_station_function(&band.outer_offset)?;
    }
    for band in &alignment.crossfall_bands {
        if band.id.trim().is_empty() {
            return Err(EntityValidationError::InvalidAlignment);
        }
        validate_station_function(&band.from_offset)?;
        validate_station_function(&band.to_offset)?;
        validate_station_function(&band.crossfall)?;
    }
    for rule in &alignment.slope_rules {
        if rule.id.trim().is_empty()
            || rule.source_band_id.trim().is_empty()
            || rule.target_surface.0.trim().is_empty()
            || !rule.cut_ratio.is_finite()
            || !rule.fill_ratio.is_finite()
            || rule.cut_ratio <= 0.0
            || rule.fill_ratio <= 0.0
        {
            return Err(EntityValidationError::InvalidAlignment);
        }
    }
    Ok(())
}

fn validate_text(text: &TextGeometry) -> Result<(), EntityValidationError> {
    validate_position(text.anchor)?;
    validate_resource(&text.font)?;
    if text.text.contains('\0') || !text.height.is_finite() || text.height <= 0.0 {
        Err(EntityValidationError::InvalidAnnotation)
    } else {
        Ok(())
    }
}

fn validate_label(label: &LabelGeometry) -> Result<(), EntityValidationError> {
    validate_anchor(&label.target)?;
    validate_text(&label.text)?;
    for position in &label.leader {
        validate_position(*position)?;
    }
    Ok(())
}

fn validate_dimension(dimension: &DimensionGeometry) -> Result<(), EntityValidationError> {
    if dimension.anchors.is_empty() {
        return Err(EntityValidationError::InvalidAnnotation);
    }
    for anchor in &dimension.anchors {
        validate_anchor(anchor)?;
    }
    validate_position(dimension.placement)?;
    validate_resource(&dimension.style)
}

fn validate_anchor(anchor: &AnnotationAnchor) -> Result<(), EntityValidationError> {
    match anchor {
        AnnotationAnchor::Position { position } => validate_position(*position),
        AnnotationAnchor::Entity {
            entity_id,
            expected_version,
            primitive_id,
            parameter,
        } => {
            if entity_id.0.trim().is_empty()
                || expected_version
                    .as_ref()
                    .is_some_and(|hash| !valid_hash(hash.as_str()))
                || primitive_id.is_some_and(|id| id > JAVASCRIPT_SAFE_INTEGER_MAX)
                || parameter.is_some_and(|value| !value.is_finite())
            {
                Err(EntityValidationError::InvalidAnnotation)
            } else {
                Ok(())
            }
        }
    }
}

fn validate_panorama(panorama: &PanoramaGeometry) -> Result<(), EntityValidationError> {
    validate_raster(&panorama.image)?;
    let RasterMapping::Camera { model, .. } = &panorama.image.mapping else {
        return Err(EntityValidationError::InvalidRaster);
    };
    if matches!(
        (model, panorama.image.depth.as_ref()),
        (
            CameraModel::Equirectangular,
            Some(crate::entity_model::DepthField {
                sampling: DepthSampling {
                    semantics: crate::entity_model::DepthSemantics::OpticalAxisDepth,
                    ..
                },
                ..
            })
        )
    ) {
        return Err(EntityValidationError::InvalidRaster);
    }
    if panorama
        .station_point_cloud
        .as_ref()
        .is_some_and(|entity| entity.0.trim().is_empty())
    {
        return Err(EntityValidationError::InvalidIdentifier);
    }
    Ok(())
}

fn validate_streamed(dataset: &StreamedGeometry) -> Result<(), EntityValidationError> {
    if dataset
        .element_count
        .is_some_and(|count| count > JAVASCRIPT_SAFE_INTEGER_MAX)
    {
        return Err(EntityValidationError::InvalidNumber);
    }
    if dataset.format_id.trim().is_empty() {
        return Err(EntityValidationError::InvalidIdentifier);
    }
    validate_resource(&dataset.metadata)
}

fn validate_depth_sampling(
    sampling: &DepthSampling,
    dimensions: Option<RasterConnectivityDimensions>,
) -> Result<(), EntityValidationError> {
    if matches!(sampling.interpolation, RasterInterpolation::Nearest)
        && !matches!(sampling.connectivity, RasterConnectivity::PixelSteps)
        || matches!(sampling.interpolation, RasterInterpolation::Bilinear)
            && matches!(sampling.connectivity, RasterConnectivity::PixelSteps)
    {
        return Err(EntityValidationError::InvalidRaster);
    }
    match &sampling.connectivity {
        RasterConnectivity::Continuous {
            maximum_height_jump,
            ..
        } if maximum_height_jump.is_some_and(|value| !value.is_finite() || value < 0.0) => {
            Err(EntityValidationError::InvalidRaster)
        }
        RasterConnectivity::Mask { resource, .. } => {
            validate_resource(resource)?;
            if let Some(dimensions) = dimensions {
                let cell_columns = if dimensions.horizontal_wrap {
                    dimensions.width
                } else {
                    dimensions.width.saturating_sub(1)
                };
                let cells = u64::from(cell_columns)
                    .checked_mul(u64::from(dimensions.height.saturating_sub(1)))
                    .ok_or(EntityValidationError::InvalidRaster)?;
                validate_known_resource_length(resource, bitset_byte_length(cells, 2)?)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn validate_camera(model: &CameraModel) -> Result<(), EntityValidationError> {
    match model {
        CameraModel::Pinhole {
            focal_x,
            focal_y,
            center_x,
            center_y,
            distortion_model,
            distortion_parameters,
        } => {
            if !focal_x.is_finite()
                || !focal_y.is_finite()
                || *focal_x <= 0.0
                || *focal_y <= 0.0
                || !center_x.is_finite()
                || !center_y.is_finite()
                || distortion_parameters.iter().any(|value| !value.is_finite())
                || distortion_model.is_none() && !distortion_parameters.is_empty()
                || distortion_model
                    .as_ref()
                    .is_some_and(|id| id.trim().is_empty())
            {
                return Err(EntityValidationError::InvalidRaster);
            }
        }
        CameraModel::Extension {
            model_id,
            parameters,
        } if model_id.trim().is_empty() || !valid_hash(parameters.as_str()) => {
            return Err(EntityValidationError::InvalidRaster);
        }
        CameraModel::Equirectangular | CameraModel::Extension { .. } => {}
    }
    Ok(())
}

fn validate_grid(mapping: OrthoGridMapping) -> Result<(), EntityValidationError> {
    validate_vector(mapping.origin)?;
    validate_direction(mapping.column_step)?;
    validate_direction(mapping.row_step)?;
    let cross = cross(mapping.column_step, mapping.row_step);
    if length_squared(cross) <= f64::EPSILON {
        Err(EntityValidationError::InvalidRaster)
    } else {
        Ok(())
    }
}

fn validate_ellipse(
    center: Position,
    major_axis: Vector3,
    minor_radius: f64,
    plane: Option<PlaneDefinition>,
) -> Result<(), EntityValidationError> {
    validate_position(center)?;
    validate_direction(major_axis)?;
    positive(minor_radius)?;
    validate_optional_plane(plane)
}

fn validate_optional_plane(plane: Option<PlaneDefinition>) -> Result<(), EntityValidationError> {
    if let Some(plane) = plane {
        validate_plane(plane)
    } else {
        Ok(())
    }
}

fn validate_plane(plane: PlaneDefinition) -> Result<(), EntityValidationError> {
    validate_vector(plane.origin)?;
    validate_direction(plane.normal)
}

fn validate_plane_frame(frame: PlaneFrame) -> Result<(), EntityValidationError> {
    validate_vector(frame.origin)?;
    validate_direction(frame.u_axis)?;
    validate_direction(frame.v_axis)?;
    if !approximately_one(length_squared(frame.u_axis))
        || !approximately_one(length_squared(frame.v_axis))
        || dot(frame.u_axis, frame.v_axis).abs() > 1.0e-9
        || !approximately_one(length_squared(cross(frame.u_axis, frame.v_axis)))
    {
        Err(EntityValidationError::InvalidRaster)
    } else {
        Ok(())
    }
}

fn validate_position(position: Position) -> Result<(), EntityValidationError> {
    if position.x.is_finite() && position.y.is_finite() && position.z.is_none_or(f64::is_finite) {
        Ok(())
    } else {
        Err(EntityValidationError::InvalidNumber)
    }
}

fn validate_vector(vector: Vector3) -> Result<(), EntityValidationError> {
    if vector.x.is_finite() && vector.y.is_finite() && vector.z.is_finite() {
        Ok(())
    } else {
        Err(EntityValidationError::InvalidNumber)
    }
}

fn validate_direction(direction: Vector3) -> Result<(), EntityValidationError> {
    validate_vector(direction)?;
    if length_squared(direction) <= f64::EPSILON {
        Err(EntityValidationError::InvalidNumber)
    } else {
        Ok(())
    }
}

fn validate_station_function(function: &StationFunction) -> Result<(), EntityValidationError> {
    if function.samples.is_empty()
        || function
            .samples
            .iter()
            .any(|sample| !sample.station.is_finite() || !sample.value.is_finite())
        || !function
            .samples
            .windows(2)
            .all(|pair| pair[0].station < pair[1].station)
    {
        Err(EntityValidationError::InvalidAlignment)
    } else {
        Ok(())
    }
}

fn validate_resource(resource: &GeometryResource) -> Result<(), EntityValidationError> {
    if resource
        .byte_length
        .is_some_and(|length| length > JAVASCRIPT_SAFE_INTEGER_MAX)
    {
        return Err(EntityValidationError::InvalidNumber);
    }
    if valid_hash(resource.object_hash.as_str()) && !resource.media_type.trim().is_empty() {
        Ok(())
    } else {
        Err(EntityValidationError::InvalidIdentifier)
    }
}

fn validate_known_resource_length(
    resource: &GeometryResource,
    expected: u64,
) -> Result<(), EntityValidationError> {
    if resource
        .byte_length
        .is_some_and(|actual| actual != expected)
    {
        Err(EntityValidationError::InvalidRaster)
    } else {
        Ok(())
    }
}

fn bitset_byte_length(elements: u64, bits_per_element: u64) -> Result<u64, EntityValidationError> {
    elements
        .checked_mul(bits_per_element)
        .and_then(|bits| bits.checked_add(7))
        .map(|bits| bits / 8)
        .ok_or(EntityValidationError::InvalidRaster)
}

fn positive(value: f64) -> Result<(), EntityValidationError> {
    if value.is_finite() && value > 0.0 {
        Ok(())
    } else {
        Err(EntityValidationError::InvalidNumber)
    }
}

fn same_position(left: Position, right: Position) -> bool {
    left.x.to_bits() == right.x.to_bits()
        && left.y.to_bits() == right.y.to_bits()
        && left.z.map(f64::to_bits) == right.z.map(f64::to_bits)
}

fn valid_type_id(value: &str) -> bool {
    let Some((name, version)) = value.rsplit_once('@') else {
        return false;
    };
    name.contains('.')
        && !name.starts_with('.')
        && !name.ends_with('.')
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-'))
        && !version.is_empty()
        && version.chars().all(|character| character.is_ascii_digit())
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_transform(transform: Transform3d) -> bool {
    transform.0.iter().all(|value| value.is_finite())
        && transform.0[3].abs() <= f64::EPSILON
        && transform.0[7].abs() <= f64::EPSILON
        && transform.0[11].abs() <= f64::EPSILON
        && (transform.0[15] - 1.0).abs() <= f64::EPSILON
}

fn valid_rigid_transform(transform: Transform3d) -> bool {
    if !valid_transform(transform) {
        return false;
    }
    let x = Vector3 {
        x: transform.0[0],
        y: transform.0[1],
        z: transform.0[2],
    };
    let y = Vector3 {
        x: transform.0[4],
        y: transform.0[5],
        z: transform.0[6],
    };
    let z = Vector3 {
        x: transform.0[8],
        y: transform.0[9],
        z: transform.0[10],
    };
    approximately_one(length_squared(x))
        && approximately_one(length_squared(y))
        && approximately_one(length_squared(z))
        && dot(x, y).abs() <= 1.0e-9
        && dot(x, z).abs() <= 1.0e-9
        && dot(y, z).abs() <= 1.0e-9
        && (dot(x, cross(y, z)) - 1.0).abs() <= 1.0e-9
}

fn homography_determinant(matrix: [f64; 9]) -> f64 {
    matrix[0] * (matrix[4] * matrix[8] - matrix[5] * matrix[7])
        - matrix[1] * (matrix[3] * matrix[8] - matrix[5] * matrix[6])
        + matrix[2] * (matrix[3] * matrix[7] - matrix[4] * matrix[6])
}

fn approximately_one(value: f64) -> bool {
    (value - 1.0).abs() <= 1.0e-9
}

fn length_squared(vector: Vector3) -> f64 {
    vector.x * vector.x + vector.y * vector.y + vector.z * vector.z
}

fn dot(left: Vector3, right: Vector3) -> f64 {
    left.x * right.x + left.y * right.y + left.z * right.z
}

fn cross(left: Vector3, right: Vector3) -> Vector3 {
    Vector3 {
        x: left.y * right.z - left.z * right.y,
        y: left.z * right.x - left.x * right.z,
        z: left.x * right.y - left.y * right.x,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_entity_version_hash, geometry_object_content_hash,
        validate_canonical_entity_semantics, validate_geometry_object,
        validate_resolved_representation, EntityValidationError,
    };
    use crate::canonical_resources::{CanonicalResourceRef, MATERIAL_TABLE_RESOURCE_SCHEMA_ID};
    use crate::entity::EntityId;
    use crate::entity_model::{
        built_in_type, AreaGeometry, CameraModel, CanonicalEntity, CurveGeometry, CurveLoop,
        CurveUse, DepthField, DepthSampling, DepthSemantics, ElevationSurfaceGeometry,
        EntityTypeId, GeometryObject, GeometryResource, OrthoGridMapping, PanoramaGeometry,
        PlaneFrame, Position, RasterCellDiagonal, RasterConfidenceBand, RasterConfidenceEncoding,
        RasterConnectivity, RasterImageGeometry, RasterInterpolation, RasterMapping,
        RasterTriangleMaskEncoding, RasterValidityEncoding, RasterValidityMask, Representation,
        RepresentationAuthority, RepresentationRole, SolidGeometry, Transform3d,
        TriangleMeshGeometry, TriangleMeshStorage, Vector3,
    };
    use crate::hash::ObjectHash;

    fn resource(seed: char, media_type: &str, byte_length: Option<u64>) -> GeometryResource {
        GeometryResource {
            object_hash: ObjectHash(seed.to_string().repeat(64)),
            media_type: media_type.to_owned(),
            byte_length,
        }
    }

    fn ortho_raster() -> RasterImageGeometry {
        RasterImageGeometry {
            pixels: resource('1', "image/rgba8", Some(3 * 3 * 4)),
            width: 3,
            height: 3,
            mapping: RasterMapping::OrthoGrid(OrthoGridMapping {
                origin: Vector3 {
                    x: 500_000.0,
                    y: 5_400_000.0,
                    z: 500.0,
                },
                column_step: Vector3 {
                    x: 0.05,
                    y: 0.0,
                    z: 0.0,
                },
                row_step: Vector3 {
                    x: 0.0,
                    y: -0.05,
                    z: 0.0,
                },
            }),
            depth: Some(DepthField {
                values: resource(
                    '2',
                    "application/vnd.himmelcad.depth-f64le",
                    Some(3 * 3 * 8),
                ),
                validity: Some(RasterValidityMask {
                    resource: resource(
                        '3',
                        "application/vnd.himmelcad.raster-validity+bitset",
                        Some(2),
                    ),
                    encoding: RasterValidityEncoding::BitsetLsb0,
                }),
                confidence: Some(RasterConfidenceBand {
                    resource: resource(
                        '4',
                        "application/vnd.himmelcad.raster-confidence+unorm8",
                        Some(9),
                    ),
                    encoding: RasterConfidenceEncoding::Unorm8,
                }),
                sampling: DepthSampling {
                    semantics: DepthSemantics::ElevationZ,
                    interpolation: RasterInterpolation::DiscontinuityAware,
                    connectivity: RasterConnectivity::Continuous {
                        maximum_height_jump: Some(0.25),
                        diagonal: RasterCellDiagonal::TopLeftToBottomRight,
                    },
                },
            }),
        }
    }

    fn camera_mapping(model: CameraModel, translation: Vector3) -> RasterMapping {
        let mut pose = Transform3d::IDENTITY;
        pose.0[12] = translation.x;
        pose.0[13] = translation.y;
        pose.0[14] = translation.z;
        RasterMapping::Camera { model, pose }
    }

    #[test]
    fn raster_masks_are_co_registered_and_have_exact_known_lengths() {
        let raster = ortho_raster();
        assert_eq!(
            validate_geometry_object(&GeometryObject::RasterImage {
                raster: Box::new(raster.clone()),
            }),
            Ok(())
        );

        let mut invalid_validity = raster.clone();
        invalid_validity
            .depth
            .as_mut()
            .expect("depth")
            .validity
            .as_mut()
            .expect("validity")
            .resource
            .byte_length = Some(1);
        assert_eq!(
            validate_geometry_object(&GeometryObject::RasterImage {
                raster: Box::new(invalid_validity),
            }),
            Err(EntityValidationError::InvalidRaster)
        );

        let mut invalid_confidence = raster;
        invalid_confidence
            .depth
            .as_mut()
            .expect("depth")
            .confidence
            .as_mut()
            .expect("confidence")
            .resource
            .byte_length = Some(8);
        assert_eq!(
            validate_geometry_object(&GeometryObject::RasterImage {
                raster: Box::new(invalid_confidence),
            }),
            Err(EntityValidationError::InvalidRaster)
        );
    }

    #[test]
    fn connectivity_mask_has_two_bits_per_cell_and_stable_diagonal() {
        let mut raster = ortho_raster();
        raster.depth.as_mut().expect("depth").sampling.connectivity = RasterConnectivity::Mask {
            resource: resource(
                '5',
                "application/vnd.himmelcad.raster-triangle-mask+2bit",
                Some(1),
            ),
            encoding: RasterTriangleMaskEncoding::TwoBitsPerCellLsb0,
            diagonal: RasterCellDiagonal::TopRightToBottomLeft,
        };
        assert_eq!(
            validate_geometry_object(&GeometryObject::RasterImage {
                raster: Box::new(raster.clone()),
            }),
            Ok(())
        );

        if let RasterConnectivity::Mask { resource, .. } =
            &mut raster.depth.as_mut().expect("depth").sampling.connectivity
        {
            resource.byte_length = Some(2);
        }
        assert_eq!(
            validate_geometry_object(&GeometryObject::RasterImage {
                raster: Box::new(raster),
            }),
            Err(EntityValidationError::InvalidRaster)
        );
    }

    #[test]
    fn equirectangular_connectivity_mask_includes_horizontal_seam_cells() {
        let station = Vector3 {
            x: 100.0,
            y: 200.0,
            z: 300.0,
        };
        let mut raster = ortho_raster();
        raster.mapping = camera_mapping(CameraModel::Equirectangular, station);
        let depth = raster.depth.as_mut().expect("depth");
        depth.sampling.semantics = DepthSemantics::RayDistance;
        depth.sampling.connectivity = RasterConnectivity::Mask {
            // 3 columns * 2 cell rows * 2 bits = 12 bits = 2 bytes.
            resource: resource(
                '6',
                "application/vnd.himmelcad.raster-triangle-mask+2bit",
                Some(2),
            ),
            encoding: RasterTriangleMaskEncoding::TwoBitsPerCellLsb0,
            diagonal: RasterCellDiagonal::TopLeftToBottomRight,
        };
        assert_eq!(
            validate_geometry_object(&GeometryObject::RasterImage {
                raster: Box::new(raster.clone()),
            }),
            Ok(())
        );

        if let RasterConnectivity::Mask { resource, .. } =
            &mut raster.depth.as_mut().expect("depth").sampling.connectivity
        {
            // The non-wrapping 3x3 size would be only one byte and must fail.
            resource.byte_length = Some(1);
        }
        assert_eq!(
            validate_geometry_object(&GeometryObject::RasterImage {
                raster: Box::new(raster),
            }),
            Err(EntityValidationError::InvalidRaster)
        );
    }

    #[test]
    fn planar_raster_requires_an_invertible_homography_and_orthonormal_frame() {
        let mut raster = ortho_raster();
        raster.depth = None;
        raster.mapping = RasterMapping::Planar {
            homography: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            frame: PlaneFrame {
                origin: Vector3 {
                    x: 10.0,
                    y: 20.0,
                    z: 30.0,
                },
                u_axis: Vector3 {
                    x: 1.0,
                    y: 0.0,
                    z: 0.0,
                },
                v_axis: Vector3 {
                    x: 0.0,
                    y: 0.0,
                    z: 1.0,
                },
            },
        };
        assert_eq!(
            validate_geometry_object(&GeometryObject::RasterImage {
                raster: Box::new(raster.clone()),
            }),
            Ok(())
        );

        if let RasterMapping::Planar { homography, .. } = &mut raster.mapping {
            *homography = [0.0; 9];
        }
        assert_eq!(
            validate_geometry_object(&GeometryObject::RasterImage {
                raster: Box::new(raster.clone()),
            }),
            Err(EntityValidationError::InvalidRaster)
        );
        if let RasterMapping::Planar { homography, frame } = &mut raster.mapping {
            *homography = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
            frame.v_axis = frame.u_axis;
        }
        assert_eq!(
            validate_geometry_object(&GeometryObject::RasterImage {
                raster: Box::new(raster),
            }),
            Err(EntityValidationError::InvalidRaster)
        );
    }

    #[test]
    fn camera_pose_is_a_proper_rigid_camera_to_entity_local_transform() {
        let mut raster = ortho_raster();
        raster.depth = None;
        raster.mapping = camera_mapping(
            CameraModel::Pinhole {
                focal_x: 1_200.0,
                focal_y: 1_205.0,
                center_x: 1_000.0,
                center_y: 750.0,
                distortion_model: None,
                distortion_parameters: Vec::new(),
            },
            Vector3 {
                x: 4.0,
                y: 5.0,
                z: 6.0,
            },
        );
        assert_eq!(
            validate_geometry_object(&GeometryObject::RasterImage {
                raster: Box::new(raster.clone()),
            }),
            Ok(())
        );

        let RasterMapping::Camera { pose, .. } = &mut raster.mapping else {
            unreachable!("camera fixture")
        };
        pose.0[0] = 2.0;
        assert_eq!(
            validate_geometry_object(&GeometryObject::RasterImage {
                raster: Box::new(raster),
            }),
            Err(EntityValidationError::InvalidRaster)
        );
    }

    #[test]
    fn raster_depth_semantics_require_a_geometrically_defined_mapping() {
        let mut raster = ortho_raster();
        raster.depth.as_mut().expect("depth").sampling.semantics = DepthSemantics::OpticalAxisDepth;
        assert_eq!(
            validate_geometry_object(&GeometryObject::RasterImage {
                raster: Box::new(raster.clone()),
            }),
            Err(EntityValidationError::InvalidRaster)
        );

        raster.depth.as_mut().expect("depth").sampling.semantics = DepthSemantics::ElevationZ;
        raster.mapping = RasterMapping::Planar {
            homography: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            frame: PlaneFrame {
                origin: Vector3 {
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                },
                u_axis: Vector3 {
                    x: 1.0,
                    y: 0.0,
                    z: 0.0,
                },
                v_axis: Vector3 {
                    x: 0.0,
                    y: 1.0,
                    z: 0.0,
                },
            },
        };
        assert_eq!(
            validate_geometry_object(&GeometryObject::RasterImage {
                raster: Box::new(raster.clone()),
            }),
            Err(EntityValidationError::InvalidRaster)
        );

        raster.mapping = camera_mapping(
            CameraModel::Equirectangular,
            Vector3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
        );
        raster.depth.as_mut().expect("depth").sampling.semantics = DepthSemantics::OpticalAxisDepth;
        assert_eq!(
            validate_geometry_object(&GeometryObject::RasterImage {
                raster: Box::new(raster.clone()),
            }),
            Err(EntityValidationError::InvalidRaster)
        );

        if let RasterMapping::Camera { model, .. } = &mut raster.mapping {
            *model = CameraModel::Pinhole {
                focal_x: 1_000.0,
                focal_y: 1_000.0,
                center_x: 1.0,
                center_y: 1.0,
                distortion_model: None,
                distortion_parameters: Vec::new(),
            };
        }
        assert_eq!(
            validate_geometry_object(&GeometryObject::RasterImage {
                raster: Box::new(raster),
            }),
            Ok(())
        );
    }

    #[test]
    fn panorama_depth_and_station_live_only_on_the_camera_raster() {
        let station = Vector3 {
            x: 100.0,
            y: 200.0,
            z: 300.0,
        };
        let mut raster = ortho_raster();
        raster.mapping = camera_mapping(CameraModel::Equirectangular, station);
        raster.depth.as_mut().expect("depth").sampling.semantics = DepthSemantics::RayDistance;
        let mut panorama = PanoramaGeometry {
            image: raster,
            station_point_cloud: None,
        };
        assert_eq!(
            validate_geometry_object(&GeometryObject::Panorama {
                panorama: Box::new(panorama.clone()),
            }),
            Ok(())
        );
        let mut legacy = serde_json::to_value(&panorama).expect("panorama JSON");
        legacy
            .as_object_mut()
            .expect("panorama object")
            .insert("depth".to_owned(), serde_json::Value::Null);
        assert!(serde_json::from_value::<PanoramaGeometry>(legacy).is_err());

        let mut duplicate_station = serde_json::to_value(&panorama).expect("panorama JSON");
        duplicate_station
            .as_object_mut()
            .expect("panorama object")
            .insert(
                "station".to_owned(),
                serde_json::json!({ "x": station.x, "y": station.y, "z": station.z }),
            );
        assert!(serde_json::from_value::<PanoramaGeometry>(duplicate_station).is_err());
        panorama
            .image
            .depth
            .as_mut()
            .expect("depth")
            .sampling
            .semantics = DepthSemantics::OpticalAxisDepth;
        assert_eq!(
            validate_geometry_object(&GeometryObject::Panorama {
                panorama: Box::new(panorama),
            }),
            Err(EntityValidationError::InvalidRaster)
        );
    }

    #[test]
    fn mixed_xy_xyz_area_is_valid_plan_geometry() {
        let geometry = GeometryObject::Area {
            area: Box::new(AreaGeometry {
                outer: CurveLoop {
                    uses: vec![CurveUse::Inline {
                        curve: CurveGeometry::Polyline {
                            positions: vec![
                                Position {
                                    x: 0.0,
                                    y: 0.0,
                                    z: Some(500.0),
                                },
                                Position {
                                    x: 10.0,
                                    y: 0.0,
                                    z: None,
                                },
                                Position {
                                    x: 0.0,
                                    y: 10.0,
                                    z: None,
                                },
                            ],
                            closed: true,
                        },
                        reversed: false,
                    }],
                },
                holes: Vec::new(),
            }),
        };

        assert_eq!(validate_geometry_object(&geometry), Ok(()));
    }

    #[test]
    fn rational_quadratic_conic_requires_a_positive_finite_control_weight() {
        let conic = |control_weight| GeometryObject::Curve {
            curve: Box::new(CurveGeometry::ConicArc {
                start: Position {
                    x: 0.0,
                    y: 0.0,
                    z: Some(5.0),
                },
                control: Position {
                    x: 2.0,
                    y: 3.0,
                    z: Some(5.0),
                },
                end: Position {
                    x: 4.0,
                    y: 0.0,
                    z: Some(5.0),
                },
                control_weight,
            }),
        };

        assert_eq!(validate_geometry_object(&conic(0.5)), Ok(()));
        assert_eq!(validate_geometry_object(&conic(1.0)), Ok(()));
        assert_eq!(validate_geometry_object(&conic(2.0)), Ok(()));
        assert_eq!(
            validate_geometry_object(&conic(0.0)),
            Err(EntityValidationError::InvalidCurve)
        );
        assert_eq!(
            validate_geometry_object(&conic(f64::INFINITY)),
            Err(EntityValidationError::InvalidCurve)
        );
        let degenerate = GeometryObject::Curve {
            curve: Box::new(CurveGeometry::ConicArc {
                start: Position {
                    x: 0.0,
                    y: 0.0,
                    z: None,
                },
                control: Position {
                    x: 1.0,
                    y: 1.0,
                    z: None,
                },
                end: Position {
                    x: 2.0,
                    y: 2.0,
                    z: None,
                },
                control_weight: 1.0,
            }),
        };
        assert_eq!(
            validate_geometry_object(&degenerate),
            Err(EntityValidationError::InvalidCurve)
        );
    }

    #[test]
    fn open_mesh_cannot_claim_to_be_a_solid() {
        let geometry = GeometryObject::Solid {
            solid: Box::new(SolidGeometry::ClosedMesh {
                mesh: TriangleMeshGeometry {
                    storage: TriangleMeshStorage::Inline {
                        positions: vec![
                            Vector3 {
                                x: 0.0,
                                y: 0.0,
                                z: 0.0,
                            },
                            Vector3 {
                                x: 1.0,
                                y: 0.0,
                                z: 0.0,
                            },
                            Vector3 {
                                x: 0.0,
                                y: 1.0,
                                z: 0.0,
                            },
                        ],
                        indices: vec![0, 1, 2],
                        normals: None,
                        texture_coordinates: None,
                    },
                    closed_manifold: false,
                    triangle_material_slots: None,
                    materials: None,
                },
            }),
        };

        assert_eq!(
            validate_geometry_object(&geometry),
            Err(EntityValidationError::InvalidSolid)
        );
    }

    #[test]
    fn inline_triangle_material_slots_must_match_topology_and_have_a_table() {
        let mesh = TriangleMeshGeometry {
            storage: TriangleMeshStorage::Inline {
                positions: vec![
                    Vector3 {
                        x: 0.0,
                        y: 0.0,
                        z: 0.0,
                    },
                    Vector3 {
                        x: 1.0,
                        y: 0.0,
                        z: 0.0,
                    },
                    Vector3 {
                        x: 0.0,
                        y: 1.0,
                        z: 0.0,
                    },
                ],
                indices: vec![0, 1, 2],
                normals: None,
                texture_coordinates: None,
            },
            closed_manifold: false,
            triangle_material_slots: Some(vec![7]),
            materials: Some(CanonicalResourceRef {
                resource_id: "road-materials".to_owned(),
                schema_id: MATERIAL_TABLE_RESOURCE_SCHEMA_ID.to_owned(),
                content_hash: ObjectHash("7".repeat(64)),
            }),
        };
        assert_eq!(
            validate_geometry_object(&GeometryObject::Surface3d {
                mesh: Box::new(mesh.clone()),
            }),
            Ok(())
        );

        let mut wrong_count = mesh.clone();
        wrong_count.triangle_material_slots = Some(vec![7, 8]);
        assert_eq!(
            validate_geometry_object(&GeometryObject::Surface3d {
                mesh: Box::new(wrong_count),
            }),
            Err(EntityValidationError::InvalidMesh)
        );

        let mut missing_table = mesh;
        missing_table.materials = None;
        assert_eq!(
            validate_geometry_object(&GeometryObject::Surface3d {
                mesh: Box::new(missing_table),
            }),
            Err(EntityValidationError::InvalidMesh)
        );
    }

    #[test]
    fn inline_mesh_accepts_eight_complete_finite_uv_sets_and_rejects_drift() {
        let geometry = |texture_coordinates| GeometryObject::Surface3d {
            mesh: Box::new(TriangleMeshGeometry {
                storage: TriangleMeshStorage::Inline {
                    positions: vec![
                        Vector3 {
                            x: 0.0,
                            y: 0.0,
                            z: 0.0,
                        },
                        Vector3 {
                            x: 1.0,
                            y: 0.0,
                            z: 0.0,
                        },
                        Vector3 {
                            x: 0.0,
                            y: 1.0,
                            z: 0.0,
                        },
                    ],
                    indices: vec![0, 1, 2],
                    normals: None,
                    texture_coordinates,
                },
                closed_manifold: false,
                triangle_material_slots: None,
                materials: None,
            }),
        };
        let uv0 = vec![[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]];
        let uv1 = vec![[0.1, 0.2], [0.9, 0.2], [0.1, 0.8]];
        let eight_sets = (0..8)
            .map(|index| if index == 1 { uv1.clone() } else { uv0.clone() })
            .collect::<Vec<_>>();

        assert_eq!(
            validate_geometry_object(&geometry(Some(eight_sets.clone()))),
            Ok(())
        );
        assert_eq!(
            validate_geometry_object(&geometry(Some(vec![uv0.clone(), vec![[0.0, 0.0]; 2]]))),
            Err(EntityValidationError::InvalidMesh)
        );
        assert_eq!(
            validate_geometry_object(&geometry(Some(
                eight_sets.into_iter().chain([uv1]).collect()
            ))),
            Err(EntityValidationError::InvalidMesh)
        );
    }

    #[test]
    fn elevation_tin_rejects_vertical_triangles_but_surface_3d_accepts_them() {
        let mesh = TriangleMeshGeometry {
            storage: TriangleMeshStorage::Inline {
                positions: vec![
                    Vector3 {
                        x: 0.0,
                        y: 0.0,
                        z: 0.0,
                    },
                    Vector3 {
                        x: 0.0,
                        y: 0.0,
                        z: 5.0,
                    },
                    Vector3 {
                        x: 0.0,
                        y: 2.0,
                        z: 1.0,
                    },
                ],
                indices: vec![0, 1, 2],
                normals: None,
                texture_coordinates: None,
            },
            closed_manifold: false,
            triangle_material_slots: None,
            materials: None,
        };

        assert_eq!(
            validate_geometry_object(&GeometryObject::ElevationSurface {
                surface: Box::new(ElevationSurfaceGeometry::Tin {
                    mesh: mesh.clone(),
                    breaklines: Vec::new(),
                }),
            }),
            Err(EntityValidationError::InvalidMesh)
        );
        assert_eq!(
            validate_geometry_object(&GeometryObject::Surface3d {
                mesh: Box::new(mesh),
            }),
            Ok(())
        );
    }

    #[test]
    fn elevation_tin_rejects_two_heights_at_one_xy_coordinate() {
        let mesh = TriangleMeshGeometry {
            storage: TriangleMeshStorage::Inline {
                positions: vec![
                    Vector3 {
                        x: 0.0,
                        y: 0.0,
                        z: 1.0,
                    },
                    Vector3 {
                        x: 2.0,
                        y: 0.0,
                        z: 2.0,
                    },
                    Vector3 {
                        x: 0.0,
                        y: 2.0,
                        z: 3.0,
                    },
                    Vector3 {
                        x: -0.0,
                        y: 0.0,
                        z: 4.0,
                    },
                    Vector3 {
                        x: -2.0,
                        y: 0.0,
                        z: 2.0,
                    },
                    Vector3 {
                        x: 0.0,
                        y: -2.0,
                        z: 3.0,
                    },
                ],
                indices: vec![0, 1, 2, 3, 4, 5],
                normals: None,
                texture_coordinates: None,
            },
            closed_manifold: false,
            triangle_material_slots: None,
            materials: None,
        };

        assert_eq!(
            validate_geometry_object(&GeometryObject::ElevationSurface {
                surface: Box::new(ElevationSurfaceGeometry::Tin {
                    mesh,
                    breaklines: Vec::new(),
                }),
            }),
            Err(EntityValidationError::InvalidMesh)
        );
    }

    #[test]
    fn elevation_tin_accepts_a_sloped_single_valued_height_field() {
        let mesh = TriangleMeshGeometry {
            storage: TriangleMeshStorage::Inline {
                positions: vec![
                    Vector3 {
                        x: 0.0,
                        y: 0.0,
                        z: 1.0,
                    },
                    Vector3 {
                        x: 2.0,
                        y: 0.0,
                        z: 2.0,
                    },
                    Vector3 {
                        x: 2.0,
                        y: 2.0,
                        z: 4.0,
                    },
                    Vector3 {
                        x: 0.0,
                        y: 2.0,
                        z: 3.0,
                    },
                ],
                indices: vec![0, 1, 2, 0, 2, 3],
                normals: None,
                texture_coordinates: None,
            },
            closed_manifold: false,
            triangle_material_slots: None,
            materials: None,
        };

        assert_eq!(
            validate_geometry_object(&GeometryObject::ElevationSurface {
                surface: Box::new(ElevationSurfaceGeometry::Tin {
                    mesh,
                    breaklines: Vec::new(),
                }),
            }),
            Ok(())
        );
    }

    fn canonical_entity(type_id: &str, geometry: &GeometryObject) -> CanonicalEntity {
        let representation = Representation {
            role: RepresentationRole::Canonical,
            geometry_ref: geometry_object_content_hash(geometry).expect("valid fixture geometry"),
            authority: RepresentationAuthority::Authoritative,
            dependency_hash: None,
        };
        let mut entity = CanonicalEntity {
            id: EntityId("entity-1".to_owned()),
            revision: 3,
            type_id: EntityTypeId(type_id.to_owned()),
            name: "Fixture".to_owned(),
            owner: None,
            layer_ids: Vec::new(),
            placement: None,
            representations: vec![representation],
            components_ref: ObjectHash::of_bytes(b"components"),
            attributes_ref: ObjectHash::of_bytes(b"attributes"),
            relations_ref: ObjectHash::of_bytes(b"relations"),
            style_ref: None,
            schema_version: 1,
            version_hash: ObjectHash::of_bytes(b"uninitialized"),
        };
        entity.version_hash =
            canonical_entity_version_hash(&entity).expect("fixture entity must hash");
        entity
    }

    fn point(x: f64) -> GeometryObject {
        GeometryObject::Point {
            position: Position { x, y: 2.0, z: None },
        }
    }

    fn line() -> GeometryObject {
        GeometryObject::Curve {
            curve: Box::new(CurveGeometry::LineSegment {
                start: Position {
                    x: 0.0,
                    y: 0.0,
                    z: None,
                },
                end: Position {
                    x: 1.0,
                    y: 0.0,
                    z: Some(4.0),
                },
            }),
        }
    }

    #[test]
    fn valid_point_and_curve_built_ins_pass_the_resolved_gate() {
        for (type_id, geometry) in [
            (built_in_type::POINT, point(1.0)),
            (built_in_type::CURVE, line()),
        ] {
            let entity = canonical_entity(type_id, &geometry);
            assert_eq!(
                validate_resolved_representation(
                    &entity,
                    entity.representations.first().expect("representation"),
                    &geometry,
                ),
                Ok(())
            );
        }
    }

    #[test]
    fn built_in_type_rejects_a_wrong_but_well_hashed_geometry_kind() {
        let geometry = line();
        let entity = canonical_entity(built_in_type::POINT, &geometry);

        assert_eq!(
            validate_resolved_representation(
                &entity,
                entity.representations.first().expect("representation"),
                &geometry,
            ),
            Err(EntityValidationError::IncompatibleRepresentation)
        );
    }

    #[test]
    fn derived_and_imported_authority_require_explicit_role_contracts() {
        let geometry = point(1.0);
        let mut entity = canonical_entity(built_in_type::POINT, &geometry);
        entity.representations.push(Representation {
            role: RepresentationRole::Alternate,
            geometry_ref: geometry_object_content_hash(&geometry).expect("geometry hash"),
            authority: RepresentationAuthority::Derived,
            dependency_hash: None,
        });
        entity.version_hash = canonical_entity_version_hash(&entity).expect("entity hash");
        assert_eq!(
            validate_canonical_entity_semantics(&entity),
            Err(EntityValidationError::InvalidRepresentation)
        );

        entity.representations.pop();
        entity.representations[0].role = RepresentationRole::Canonical;
        entity.representations[0].authority = RepresentationAuthority::ImportedFallback;
        entity.version_hash = canonical_entity_version_hash(&entity).expect("entity hash");
        assert_eq!(
            validate_canonical_entity_semantics(&entity),
            Err(EntityValidationError::InvalidRepresentation)
        );
    }

    #[test]
    fn content_and_entity_version_hashes_are_checked_independently() {
        let geometry = point(1.0);
        let mut entity = canonical_entity(built_in_type::POINT, &geometry);
        assert_eq!(
            validate_resolved_representation(
                &entity,
                entity.representations.first().expect("representation"),
                &point(9.0),
            ),
            Err(EntityValidationError::GeometryHashMismatch)
        );

        entity.name.push_str(" changed without rehash");
        assert_eq!(
            validate_canonical_entity_semantics(&entity),
            Err(EntityValidationError::VersionHashMismatch)
        );
    }

    #[test]
    fn geometry_hash_survives_json_roundtrip_for_survey_coordinates() {
        let geometry = GeometryObject::Curve {
            curve: Box::new(CurveGeometry::LineSegment {
                start: Position {
                    x: 90_830.419_027_269_59,
                    y: 67_266.875_151_353_3,
                    z: Some(0.0),
                },
                end: Position {
                    x: 90_829.459_359_580_91,
                    y: 67_263.736_219_780_91,
                    z: Some(0.0),
                },
            }),
        };
        let expected = geometry_object_content_hash(&geometry).expect("geometry hash");
        let bytes = serde_json::to_vec(&geometry).expect("serialize geometry");
        let decoded: GeometryObject = serde_json::from_slice(&bytes).expect("parse geometry");
        assert_eq!(
            geometry_object_content_hash(&decoded).expect("roundtrip geometry hash"),
            expected
        );
    }

    #[test]
    fn organizational_built_ins_reject_representations() {
        let geometry = point(1.0);
        let mut entity = canonical_entity(built_in_type::GROUP, &geometry);
        assert_eq!(
            validate_canonical_entity_semantics(&entity),
            Err(EntityValidationError::IncompatibleRepresentation)
        );

        entity.representations.clear();
        entity.version_hash = canonical_entity_version_hash(&entity).expect("entity hash");
        assert_eq!(validate_canonical_entity_semantics(&entity), Ok(()));
    }

    #[test]
    fn numeric_wire_fields_must_fit_javascript_safe_integers() {
        let geometry = point(1.0);
        let mut entity = canonical_entity(built_in_type::POINT, &geometry);
        entity.revision = 9_007_199_254_740_992;
        entity.version_hash = canonical_entity_version_hash(&entity).expect("entity hash");
        assert_eq!(
            validate_canonical_entity_semantics(&entity),
            Err(EntityValidationError::InvalidNumber)
        );
    }
}
