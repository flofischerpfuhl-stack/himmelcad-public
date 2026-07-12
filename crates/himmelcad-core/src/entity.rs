use serde::{Deserialize, Serialize};

use crate::hash::ObjectHash;

/// Stable semantic identity for an entity. Survives renames, edits, and
/// derivations. Generated server-side; never reused.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EntityId(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EntityKind {
    ProjectRoot,
    Group,
    Layer,
    Survey,
    ImageCollection,
    CameraImage,
    CameraCalibration,
    ProcessingSet,
    AlignmentRun,
    DepthMap,
    GroundControlPoint,
    Orthomosaic,
    DigitalElevationModel,
    PointCloud,
    PointCloudSegment,
    SinglePoint,
    Polyline3D,
    Mesh,
    TexturedMesh,
    Surface,
    Solid,
    Object,
    GaussianSplatCloud,
    Text,
    Axis,
    AlignmentElement,
    IfcElement,
    Pipe,
    Manhole,
    SimulationOverlay,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Bounds3 {
    pub min: Vec3,
    pub max: Vec3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct VisibilityState {
    pub visible: bool,
    pub locked: bool,
}

impl Default for VisibilityState {
    fn default() -> Self {
        Self {
            visible: true,
            locked: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitySnapshot {
    pub id: EntityId,
    pub kind: EntityKind,
    pub name: String,
    pub parent: Option<EntityId>,
    pub children: Vec<EntityId>,
    pub visibility: VisibilityState,
    pub version_hash: ObjectHash,
    pub bounds: Option<Bounds3>,
}
