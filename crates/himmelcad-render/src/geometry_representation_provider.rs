//! Authoritative entity/geometry/evaluated-mesh binding independent of render residency.

use std::collections::{BTreeMap, HashMap};
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::sync::Arc;

use himmelcad_core::entity_model::{
    CanonicalEntity, ElevationSurfaceGeometry, GeometryObject, Representation, SolidGeometry,
};
use himmelcad_core::entity_validation::{validate_resolved_representation, EntityValidationError};
pub use himmelcad_core::geometry_representation_registry::GeometryRepresentationKey;
use himmelcad_core::geometry_representation_registry::{
    CanonicalRepresentationAdmission, GeometryRepresentationBindingRef,
    GeometryRepresentationSlotKey,
};
use himmelcad_core::hash::ObjectHash;
use serde::Serialize;

use crate::{
    AuthoritativeSectionProduct, AuthoritativeSectionTopologyStore, SectionPlane,
    SectionTopologyLoadError, SectionTopologyPart, SectionTopologyPartitionData,
    SectionTopologySnapshot, SectionTopologySnapshotKey, SectionTopologyStoreError,
};

const EVALUATED_MESH_MANIFEST_SCHEMA_VERSION: u32 = 1;
const REPRESENTATION_BINDING_SCHEMA_VERSION: u32 = 1;
const JAVASCRIPT_SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;

/// Immutable recipe that produced an evaluated mesh from canonical geometry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluatedMeshRecipe {
    /// Namespaced evaluator/provider identity.
    pub provider_id: String,
    /// Exact implementation or format-contract version.
    pub provider_version: String,
    /// Optional immutable tessellation/evaluation parameter object.
    pub parameters_ref: Option<ObjectHash>,
}

/// Immutable evaluated mesh manifest, without resident triangle buffers.
///
/// Its topology hash is computed by [`Self::new`] from the source geometry,
/// recipe, complete partition list, material table and closed/open assertion.
/// Callers cannot attach an unrelated, manually supplied evaluated-mesh hash.
#[derive(Debug, Clone, PartialEq)]
pub struct EvaluatedMeshRepresentation {
    source_geometry_ref: ObjectHash,
    render_geometry_ref: ObjectHash,
    recipe: EvaluatedMeshRecipe,
    topology: SectionTopologySnapshot,
}

impl EvaluatedMeshRepresentation {
    /// Builds one content-addressed evaluated mesh and its complete section snapshot.
    pub fn new(
        source_geometry_ref: ObjectHash,
        render_geometry_ref: ObjectHash,
        recipe: EvaluatedMeshRecipe,
        snapshot_key: SectionTopologySnapshotKey,
        mut parts: Vec<SectionTopologyPart>,
        material_keys: BTreeMap<u32, String>,
        closed_manifold: bool,
    ) -> Result<Self, GeometryRepresentationRegistryError> {
        validate_hash(&source_geometry_ref)?;
        validate_hash(&render_geometry_ref)?;
        validate_recipe(&recipe)?;
        parts.sort_unstable_by(|left, right| left.part_id.cmp(&right.part_id));
        validate_manifest_parts(&parts)?;

        let topology_hash = evaluated_mesh_manifest_hash(
            &source_geometry_ref,
            &render_geometry_ref,
            &recipe,
            &snapshot_key,
            &parts,
            &material_keys,
            closed_manifold,
        )?;
        let topology = SectionTopologySnapshot::new(
            snapshot_key,
            topology_hash.0,
            parts,
            material_keys,
            closed_manifold,
        )
        .map_err(GeometryRepresentationRegistryError::Topology)?;
        Ok(Self {
            source_geometry_ref,
            render_geometry_ref,
            recipe,
            topology,
        })
    }

    /// Canonical geometry content address from which this mesh was evaluated.
    #[must_use]
    pub const fn source_geometry_ref(&self) -> &ObjectHash {
        &self.source_geometry_ref
    }

    /// Canonical content hash of the exact triangle geometry sent to the renderer.
    #[must_use]
    pub const fn render_geometry_ref(&self) -> &ObjectHash {
        &self.render_geometry_ref
    }

    /// Exact evaluator identity and immutable parameters.
    #[must_use]
    pub const fn recipe(&self) -> &EvaluatedMeshRecipe {
        &self.recipe
    }

    /// Complete residency-independent topology manifest and material table.
    #[must_use]
    pub const fn topology(&self) -> &SectionTopologySnapshot {
        &self.topology
    }

    fn validate(&self) -> Result<(), GeometryRepresentationRegistryError> {
        validate_hash(&self.source_geometry_ref)?;
        validate_hash(&self.render_geometry_ref)?;
        validate_recipe(&self.recipe)?;
        validate_manifest_parts(self.topology.parts())?;
        let expected = evaluated_mesh_manifest_hash(
            &self.source_geometry_ref,
            &self.render_geometry_ref,
            &self.recipe,
            self.topology.key(),
            self.topology.parts(),
            self.topology.material_keys(),
            self.topology.closed_manifold(),
        )?;
        if expected.as_str() != self.topology.topology_hash() {
            return Err(GeometryRepresentationRegistryError::EvaluatedMeshHashMismatch);
        }
        Ok(())
    }
}

/// Provider result staged before registry admission.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedGeometryRepresentation {
    geometry: Arc<GeometryObject>,
    evaluated_mesh: Option<EvaluatedMeshRepresentation>,
}

/// One fully resolved admission used by the concrete provider/section registry.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedGeometryRepresentationAdmission {
    /// Shared serializable canonical admission contract.
    pub canonical: CanonicalRepresentationAdmission,
    /// Optional authoritative evaluated-mesh/section manifest.
    pub evaluated_mesh: Option<EvaluatedMeshRepresentation>,
}

impl From<CanonicalRepresentationAdmission> for ResolvedGeometryRepresentationAdmission {
    fn from(canonical: CanonicalRepresentationAdmission) -> Self {
        Self {
            canonical,
            evaluated_mesh: None,
        }
    }
}

impl ResolvedGeometryRepresentation {
    /// Creates a resolved canonical object with an optional evaluated mesh manifest.
    #[must_use]
    pub fn new(
        geometry: GeometryObject,
        evaluated_mesh: Option<EvaluatedMeshRepresentation>,
    ) -> Self {
        Self {
            geometry: Arc::new(geometry),
            evaluated_mesh,
        }
    }

    /// Resolved canonical geometry object.
    #[must_use]
    pub fn geometry(&self) -> &GeometryObject {
        self.geometry.as_ref()
    }

    /// Optional immutable evaluated mesh manifest.
    #[must_use]
    pub const fn evaluated_mesh(&self) -> Option<&EvaluatedMeshRepresentation> {
        self.evaluated_mesh.as_ref()
    }
}

/// Provider diagnostic kept independent from a provider's internal error type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeometryRepresentationProviderError {
    /// Stable diagnostic suitable for project logs.
    pub message: String,
}

impl Display for GeometryRepresentationProviderError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for GeometryRepresentationProviderError {}

/// Project/import boundary for resolving canonical and large evaluated geometry.
///
/// Large topology remains behind `load_evaluated_mesh_part`; the registry stores
/// only immutable descriptors and never treats renderer-resident tiles as source
/// authority.
pub trait GeometryRepresentationProvider {
    /// Resolves the selected content-addressed canonical geometry and optional mesh manifest.
    fn resolve_representation(
        &mut self,
        entity: &CanonicalEntity,
        representation_slot: &str,
        selected: &Representation,
    ) -> Result<ResolvedGeometryRepresentation, GeometryRepresentationProviderError>;

    /// Loads one exact evaluated-mesh partition for a transient section operation.
    fn load_evaluated_mesh_part(
        &mut self,
        key: &GeometryRepresentationKey,
        part: &SectionTopologyPart,
    ) -> Result<SectionTopologyPartitionData, GeometryRepresentationProviderError>;
}

/// Fully validated immutable entity/representation/geometry binding.
#[derive(Debug, Clone, PartialEq)]
pub struct GeometryRepresentationBinding {
    key: GeometryRepresentationKey,
    entity: CanonicalEntity,
    selected: Representation,
    resolved: ResolvedGeometryRepresentation,
    binding_hash: ObjectHash,
}

impl GeometryRepresentationBinding {
    /// Exact immutable registry key.
    #[must_use]
    pub const fn key(&self) -> &GeometryRepresentationKey {
        &self.key
    }

    /// Validated canonical entity envelope.
    #[must_use]
    pub const fn entity(&self) -> &CanonicalEntity {
        &self.entity
    }

    /// Selected representation proven to be a member of the entity envelope.
    #[must_use]
    pub const fn selected(&self) -> &Representation {
        &self.selected
    }

    /// Hash-exact resolved canonical geometry and optional evaluated mesh.
    #[must_use]
    pub const fn resolved(&self) -> &ResolvedGeometryRepresentation {
        &self.resolved
    }

    /// Automatically computed hash of the complete binding contract.
    #[must_use]
    pub const fn binding_hash(&self) -> &ObjectHash {
        &self.binding_hash
    }
}

/// Current generation and immutable binding for one representation slot.
#[derive(Debug, Clone, PartialEq)]
pub struct RegisteredGeometryRepresentation {
    /// Optimistic-concurrency generation of this slot.
    pub generation: u64,
    /// Immutable validated binding.
    pub binding: GeometryRepresentationBinding,
}

/// Exact removal result including the generation-bearing tombstone.
#[derive(Debug, Clone, PartialEq)]
pub struct RetiredGeometryRepresentation {
    /// Immutable binding that was retired.
    pub binding: GeometryRepresentationBinding,
    /// Stable slot/revision reference carrying the new tombstone generation.
    pub tombstone: GeometryRepresentationBindingRef,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct EntitySlotState {
    current: BTreeMap<String, (GeometryRepresentationKey, u64)>,
    tombstones: BTreeMap<String, u64>,
    high_water: BTreeMap<String, u64>,
    revision_high_water: Option<(u64, ObjectHash)>,
}

type TouchedEntityObservation = EntitySlotState;

#[derive(Debug)]
struct PreparedEntityMutation {
    entity_id: String,
    revision: u64,
    version_hash: ObjectHash,
    observation: TouchedEntityObservation,
    complete_replace: bool,
    publications: Vec<RegisteredGeometryRepresentation>,
    retirements: Vec<(GeometryRepresentationKey, u64)>,
}

/// Validated touched-entity overlay; commit performs CAS without cloning the registry.
#[derive(Debug)]
pub struct PreparedGeometryRepresentationOverlay {
    entities: Vec<PreparedEntityMutation>,
    geometries: HashMap<ObjectHash, Arc<GeometryObject>>,
}

/// Small registry diagnostics; triangle buffers are deliberately not counted here.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GeometryRepresentationRegistryStats {
    /// Number of immutable revision bindings retained for exact lookup.
    pub immutable_bindings: usize,
    /// Number of current entity/representation slots.
    pub current_slots: usize,
    /// Deduplicated canonical geometry objects.
    pub geometry_objects: usize,
    /// Retained generation-bearing deleted slots.
    pub tombstones: usize,
}

/// Admission, concurrency or exact section evaluation failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GeometryRepresentationRegistryError {
    /// Canonical entity/representation/geometry validation failed.
    EntityValidation(EntityValidationError),
    /// Representation-slot identity is empty or otherwise invalid.
    InvalidRepresentationSlot,
    /// A supplied content address is not lowercase SHA-256 hexadecimal.
    InvalidContentHash,
    /// Evaluated-mesh recipe or manifest is incomplete.
    InvalidEvaluatedMesh,
    /// Evaluated mesh names a different canonical geometry revision.
    EvaluatedMeshGeometryMismatch,
    /// Evaluated topology names a different entity or entity version.
    EvaluatedMeshEntityVersionMismatch,
    /// Evaluated closed/open semantics do not match the canonical geometry.
    EvaluatedMeshTopologyMismatch,
    /// Computed evaluated-mesh manifest identity no longer matches its snapshot.
    EvaluatedMeshHashMismatch,
    /// The expected slot generation does not match current state.
    GenerationConflict,
    /// A touched entity changed after prepare and before commit.
    StaleOverlay,
    /// One atomic entity batch contains inconsistent revision/version envelopes.
    MixedEntityRevision,
    /// The slot generation cannot be incremented without overflow.
    GenerationExhausted,
    /// A replacement attempts to publish an older or equal non-identical entity revision.
    StaleEntityRevision,
    /// Exact immutable key already exists with different binding content.
    ImmutableKeyCollision,
    /// No current binding matches the exact immutable key.
    BindingNotFound,
    /// Project/import provider failed to resolve immutable data.
    Provider(GeometryRepresentationProviderError),
    /// Topology snapshot construction or section evaluation failed.
    Topology(SectionTopologyStoreError),
    /// Internal serialization of a schema-versioned manifest failed.
    ManifestSerialization,
}

impl Display for GeometryRepresentationRegistryError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EntityValidation(error) => write!(formatter, "entity validation failed: {error}"),
            Self::InvalidRepresentationSlot => {
                formatter.write_str("representation slot is invalid")
            }
            Self::InvalidContentHash => formatter.write_str("content hash is invalid"),
            Self::InvalidEvaluatedMesh => formatter.write_str("evaluated mesh manifest is invalid"),
            Self::EvaluatedMeshGeometryMismatch => {
                formatter.write_str("evaluated mesh belongs to different geometry")
            }
            Self::EvaluatedMeshEntityVersionMismatch => {
                formatter.write_str("evaluated mesh belongs to different entity version")
            }
            Self::EvaluatedMeshTopologyMismatch => {
                formatter.write_str("evaluated mesh open/closed semantics do not match geometry")
            }
            Self::EvaluatedMeshHashMismatch => {
                formatter.write_str("evaluated mesh manifest hash mismatch")
            }
            Self::GenerationConflict => formatter.write_str("representation generation conflict"),
            Self::StaleOverlay => formatter.write_str("prepared representation overlay is stale"),
            Self::MixedEntityRevision => {
                formatter.write_str("atomic entity admission contains mixed revisions")
            }
            Self::GenerationExhausted => {
                formatter.write_str("representation generation is exhausted")
            }
            Self::StaleEntityRevision => formatter.write_str("stale canonical entity revision"),
            Self::ImmutableKeyCollision => {
                formatter.write_str("immutable representation key collision")
            }
            Self::BindingNotFound => {
                formatter.write_str("geometry representation binding was not found")
            }
            Self::Provider(error) => write!(formatter, "geometry provider failed: {error}"),
            Self::Topology(error) => write!(formatter, "section topology failed: {error}"),
            Self::ManifestSerialization => formatter.write_str("manifest serialization failed"),
        }
    }
}

impl Error for GeometryRepresentationRegistryError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::EntityValidation(error) => Some(error),
            Self::Provider(error) => Some(error),
            Self::Topology(error) => Some(error),
            _ => None,
        }
    }
}

impl From<EntityValidationError> for GeometryRepresentationRegistryError {
    fn from(error: EntityValidationError) -> Self {
        Self::EntityValidation(error)
    }
}

/// Project-owned immutable geometry representation registry.
#[derive(Debug, Default)]
pub struct GeometryRepresentationRegistry {
    immutable: HashMap<GeometryRepresentationKey, GeometryRepresentationBinding>,
    entity_slots: HashMap<String, EntitySlotState>,
    geometries: HashMap<ObjectHash, Arc<GeometryObject>>,
    #[cfg(test)]
    observed_slot_visits: std::cell::Cell<usize>,
}

impl GeometryRepresentationRegistry {
    /// Creates an empty registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Resolves through a provider, validates completely, then atomically publishes.
    pub fn publish_from_provider<P: GeometryRepresentationProvider>(
        &mut self,
        entity: CanonicalEntity,
        representation_slot: String,
        selected: Representation,
        expected_generation: Option<u64>,
        provider: &mut P,
    ) -> Result<RegisteredGeometryRepresentation, GeometryRepresentationRegistryError> {
        let resolved = provider
            .resolve_representation(&entity, &representation_slot, &selected)
            .map_err(GeometryRepresentationRegistryError::Provider)?;
        self.publish(
            entity,
            representation_slot,
            selected,
            resolved,
            expected_generation,
        )
    }

    /// Validates completely, then atomically publishes or replaces one current slot.
    pub fn publish(
        &mut self,
        entity: CanonicalEntity,
        representation_slot: String,
        selected: Representation,
        resolved: ResolvedGeometryRepresentation,
        expected_generation: Option<u64>,
    ) -> Result<RegisteredGeometryRepresentation, GeometryRepresentationRegistryError> {
        let canonical = CanonicalRepresentationAdmission {
            entity,
            selected,
            representation_slot,
            expected_generation,
            resolved_geometry: resolved.geometry().clone(),
        };
        let overlay = self.prepare_atomic(vec![ResolvedGeometryRepresentationAdmission {
            canonical,
            evaluated_mesh: resolved.evaluated_mesh,
        }])?;
        self.commit_atomic(overlay)?
            .into_iter()
            .next()
            .ok_or(GeometryRepresentationRegistryError::BindingNotFound)
    }

    /// Validates a touched-entity overlay without cloning or mutating registry state.
    pub fn prepare_atomic(
        &self,
        admissions: Vec<ResolvedGeometryRepresentationAdmission>,
    ) -> Result<PreparedGeometryRepresentationOverlay, GeometryRepresentationRegistryError> {
        if admissions.is_empty() {
            return Err(GeometryRepresentationRegistryError::BindingNotFound);
        }
        let mut grouped =
            BTreeMap::<String, Vec<(GeometryRepresentationBinding, Option<u64>)>>::new();
        let mut geometries = HashMap::<ObjectHash, Arc<GeometryObject>>::new();
        for admission in admissions {
            let canonical = admission.canonical;
            let resolved = ResolvedGeometryRepresentation::new(
                canonical.resolved_geometry,
                admission.evaluated_mesh,
            );
            let binding = validate_binding(
                canonical.entity,
                canonical.representation_slot,
                canonical.selected,
                resolved,
            )?;
            grouped
                .entry(binding.key.slot.entity_id.0.clone())
                .or_default()
                .push((binding, canonical.expected_generation));
        }

        let mut entities = Vec::with_capacity(grouped.len());
        for (entity_id, mut group) in grouped {
            group.sort_unstable_by(|left, right| {
                left.0
                    .key
                    .slot
                    .representation_slot
                    .cmp(&right.0.key.slot.representation_slot)
            });
            if group.windows(2).any(|pair| {
                pair[0].0.key.slot.representation_slot == pair[1].0.key.slot.representation_slot
            }) {
                return Err(GeometryRepresentationRegistryError::InvalidRepresentationSlot);
            }
            let revision = group[0].0.key.entity_revision;
            let version_hash = group[0].0.key.entity_version_hash.clone();
            if group.iter().any(|(binding, _)| {
                binding.key.entity_revision != revision
                    || binding.key.entity_version_hash != version_hash
            }) {
                return Err(GeometryRepresentationRegistryError::MixedEntityRevision);
            }
            let observation = self.observe_entity(&entity_id);
            if let Some((high_revision, high_hash)) = &observation.revision_high_water {
                if revision < *high_revision
                    || (revision == *high_revision && version_hash != *high_hash)
                {
                    return Err(GeometryRepresentationRegistryError::StaleEntityRevision);
                }
            }
            let current_version = observation
                .current
                .values()
                .next()
                .map(|(key, _)| (key.entity_revision, key.entity_version_hash.clone()));
            if observation.current.values().any(|(key, _)| {
                current_version.as_ref()
                    != Some(&(key.entity_revision, key.entity_version_hash.clone()))
            }) {
                return Err(GeometryRepresentationRegistryError::MixedEntityRevision);
            }
            let complete_replace = current_version
                .as_ref()
                .is_some_and(|current| current.0 != revision || current.1 != version_hash);
            let admitted_slots = group
                .iter()
                .map(|(binding, _)| binding.key.slot.representation_slot.clone())
                .collect::<std::collections::BTreeSet<_>>();
            let mut retirements = Vec::new();
            if complete_replace {
                for (slot, (key, _)) in &observation.current {
                    if !admitted_slots.contains(slot) {
                        retirements.push((
                            key.clone(),
                            next_registry_generation(observation.high_water.get(slot).copied())?,
                        ));
                    }
                }
            }

            let mut publications = Vec::with_capacity(group.len());
            for (mut binding, expected_generation) in group {
                let slot_name = binding.key.slot.representation_slot.clone();
                let current = observation.current.get(&slot_name);
                let tombstone = observation.tombstones.get(&slot_name).copied();
                match (current, tombstone, expected_generation) {
                    (None, None, None) if !observation.high_water.contains_key(&slot_name) => {}
                    (Some((_, actual)), None, Some(expected)) if *actual == expected => {}
                    (None, Some(actual), Some(expected)) if actual == expected => {}
                    _ => return Err(GeometryRepresentationRegistryError::GenerationConflict),
                }
                if let Some(existing) = self.immutable.get(&binding.key) {
                    if existing.binding_hash != binding.binding_hash {
                        return Err(GeometryRepresentationRegistryError::ImmutableKeyCollision);
                    }
                }
                let generation = if let Some((current_key, current_generation)) = current {
                    let current_binding = self
                        .immutable
                        .get(current_key)
                        .ok_or(GeometryRepresentationRegistryError::BindingNotFound)?;
                    if current_binding.binding_hash == binding.binding_hash {
                        *current_generation
                    } else {
                        next_registry_generation(observation.high_water.get(&slot_name).copied())?
                    }
                } else {
                    next_registry_generation(observation.high_water.get(&slot_name).copied())?
                };
                if let Some(existing) = self.geometries.get(&binding.key.geometry_ref) {
                    if existing.as_ref() != binding.resolved.geometry() {
                        return Err(GeometryRepresentationRegistryError::ImmutableKeyCollision);
                    }
                    binding.resolved.geometry = Arc::clone(existing);
                } else if let Some(existing) = geometries.get(&binding.key.geometry_ref) {
                    if existing.as_ref() != binding.resolved.geometry() {
                        return Err(GeometryRepresentationRegistryError::ImmutableKeyCollision);
                    }
                    binding.resolved.geometry = Arc::clone(existing);
                } else {
                    geometries.insert(
                        binding.key.geometry_ref.clone(),
                        Arc::clone(&binding.resolved.geometry),
                    );
                }
                publications.push(RegisteredGeometryRepresentation {
                    generation,
                    binding,
                });
            }
            entities.push(PreparedEntityMutation {
                entity_id,
                revision,
                version_hash,
                observation,
                complete_replace,
                publications,
                retirements,
            });
        }
        Ok(PreparedGeometryRepresentationOverlay {
            entities,
            geometries,
        })
    }

    /// Validates complete, exact entity retirements without mutating registry state.
    ///
    /// Every supplied entity must name all of its current slots with their exact
    /// immutable key and generation. This prevents a loose entity id or a stale
    /// asynchronous client from retiring a newer canonical revision.
    pub fn prepare_retire_atomic(
        &self,
        bindings: Vec<GeometryRepresentationBindingRef>,
    ) -> Result<
        (
            PreparedGeometryRepresentationOverlay,
            Vec<GeometryRepresentationBindingRef>,
        ),
        GeometryRepresentationRegistryError,
    > {
        if bindings.is_empty() {
            return Err(GeometryRepresentationRegistryError::BindingNotFound);
        }
        let mut grouped =
            BTreeMap::<String, BTreeMap<String, GeometryRepresentationBindingRef>>::new();
        for binding in bindings {
            let entity_id = binding.key.slot.entity_id.0.clone();
            let slot = binding.key.slot.representation_slot.clone();
            if grouped
                .entry(entity_id)
                .or_default()
                .insert(slot, binding)
                .is_some()
            {
                return Err(GeometryRepresentationRegistryError::InvalidRepresentationSlot);
            }
        }

        let mut entities = Vec::with_capacity(grouped.len());
        let mut tombstones = Vec::new();
        for (entity_id, supplied) in grouped {
            let observation = self.observe_entity(&entity_id);
            if observation.current.is_empty() || supplied.len() != observation.current.len() {
                return Err(GeometryRepresentationRegistryError::GenerationConflict);
            }
            for (slot, supplied_binding) in &supplied {
                let Some((current_key, current_generation)) = observation.current.get(slot) else {
                    return Err(GeometryRepresentationRegistryError::GenerationConflict);
                };
                if current_key != &supplied_binding.key
                    || *current_generation != supplied_binding.generation
                {
                    return Err(GeometryRepresentationRegistryError::GenerationConflict);
                }
            }
            let (revision, version_hash) = observation
                .revision_high_water
                .clone()
                .ok_or(GeometryRepresentationRegistryError::BindingNotFound)?;
            let mut retirements = Vec::with_capacity(observation.current.len());
            for (slot, (key, _)) in &observation.current {
                let tombstone_generation =
                    next_registry_generation(observation.high_water.get(slot).copied())?;
                retirements.push((key.clone(), tombstone_generation));
                tombstones.push(GeometryRepresentationBindingRef {
                    key: key.clone(),
                    generation: tombstone_generation,
                });
            }
            entities.push(PreparedEntityMutation {
                entity_id,
                revision,
                version_hash,
                observation,
                complete_replace: true,
                publications: Vec::new(),
                retirements,
            });
        }
        tombstones.sort_unstable_by(|left, right| {
            (
                &left.key.slot.entity_id.0,
                &left.key.slot.representation_slot,
            )
                .cmp(&(
                    &right.key.slot.entity_id.0,
                    &right.key.slot.representation_slot,
                ))
        });
        Ok((
            PreparedGeometryRepresentationOverlay {
                entities,
                geometries: HashMap::new(),
            },
            tombstones,
        ))
    }

    /// Commits one prepared overlay after touched-entity CAS revalidation.
    pub fn commit_atomic(
        &mut self,
        mut overlay: PreparedGeometryRepresentationOverlay,
    ) -> Result<Vec<RegisteredGeometryRepresentation>, GeometryRepresentationRegistryError> {
        for entity in &overlay.entities {
            if self.observe_entity(&entity.entity_id) != entity.observation {
                return Err(GeometryRepresentationRegistryError::StaleOverlay);
            }
        }
        for entity in &mut overlay.entities {
            for registration in &mut entity.publications {
                if let Some(existing) = self.geometries.get(&registration.binding.key.geometry_ref)
                {
                    if existing.as_ref() != registration.binding.resolved.geometry() {
                        return Err(GeometryRepresentationRegistryError::ImmutableKeyCollision);
                    }
                    registration.binding.resolved.geometry = Arc::clone(existing);
                }
            }
        }
        let mut published = Vec::new();
        for entity in overlay.entities {
            let state = self.entity_slots.entry(entity.entity_id).or_default();
            if entity.complete_replace {
                for (key, tombstone_generation) in entity.retirements {
                    let slot = key.slot.representation_slot;
                    state.current.remove(&slot);
                    state.tombstones.insert(slot.clone(), tombstone_generation);
                    state.high_water.insert(slot, tombstone_generation);
                }
            }
            state.revision_high_water = Some((entity.revision, entity.version_hash));
            for registration in entity.publications {
                let slot = registration.binding.key.slot.representation_slot.clone();
                self.immutable
                    .entry(registration.binding.key.clone())
                    .or_insert_with(|| registration.binding.clone());
                state.current.insert(
                    slot.clone(),
                    (registration.binding.key.clone(), registration.generation),
                );
                state.tombstones.remove(&slot);
                state.high_water.insert(slot, registration.generation);
                published.push(registration);
            }
        }
        for (geometry_ref, geometry) in overlay.geometries {
            self.geometries.entry(geometry_ref).or_insert(geometry);
        }
        Ok(published)
    }

    /// Returns the exact immutable binding, including historical revisions.
    #[must_use]
    pub fn get(&self, key: &GeometryRepresentationKey) -> Option<&GeometryRepresentationBinding> {
        self.immutable.get(key)
    }

    /// Returns the current generation and exact key for one explicit slot.
    #[must_use]
    pub fn current_key(
        &self,
        entity_id: &str,
        representation_slot: &str,
    ) -> Option<(&GeometryRepresentationKey, u64)> {
        self.entity_slots
            .get(entity_id)?
            .current
            .get(representation_slot)
            .map(|(key, generation)| (key, *generation))
    }

    /// Retires one exact current binding when both key and generation still match.
    ///
    /// The immutable object remains available through [`Self::get`]; physical
    /// content-addressed garbage collection is intentionally outside this registry.
    pub fn remove(
        &mut self,
        key: &GeometryRepresentationKey,
        expected_generation: u64,
    ) -> Result<RetiredGeometryRepresentation, GeometryRepresentationRegistryError> {
        let entity_id = key.slot.entity_id.0.clone();
        let slot = key.slot.representation_slot.clone();
        let Some((current_key, generation)) = self
            .entity_slots
            .get(&entity_id)
            .and_then(|state| state.current.get(&slot))
        else {
            return Err(GeometryRepresentationRegistryError::BindingNotFound);
        };
        if current_key != key || *generation != expected_generation {
            return Err(GeometryRepresentationRegistryError::GenerationConflict);
        }
        let binding = self
            .immutable
            .get(key)
            .cloned()
            .ok_or(GeometryRepresentationRegistryError::BindingNotFound)?;
        let tombstone_generation = next_registry_generation(Some(*generation))?;
        let state = self
            .entity_slots
            .get_mut(&entity_id)
            .ok_or(GeometryRepresentationRegistryError::BindingNotFound)?;
        state.current.remove(&slot);
        state.tombstones.insert(slot.clone(), tombstone_generation);
        state.high_water.insert(slot, tombstone_generation);
        Ok(RetiredGeometryRepresentation {
            binding,
            tombstone: GeometryRepresentationBindingRef {
                key: key.clone(),
                generation: tombstone_generation,
            },
        })
    }

    /// Retires every current binding and publishes generation-bearing tombstones atomically.
    ///
    /// Immutable bindings and deduplicated canonical geometry remain retained until an
    /// explicit content-addressed garbage-collection boundary is introduced.
    pub fn clear(
        &mut self,
    ) -> Result<Vec<RetiredGeometryRepresentation>, GeometryRepresentationRegistryError> {
        let mut retirements = Vec::new();
        for (entity_id, state) in &self.entity_slots {
            for (representation_slot, (key, generation)) in &state.current {
                let binding = self
                    .immutable
                    .get(key)
                    .cloned()
                    .ok_or(GeometryRepresentationRegistryError::BindingNotFound)?;
                let tombstone_generation = next_registry_generation(Some(*generation))?;
                retirements.push((
                    (entity_id.clone(), representation_slot.clone()),
                    RetiredGeometryRepresentation {
                        binding,
                        tombstone: GeometryRepresentationBindingRef {
                            key: key.clone(),
                            generation: tombstone_generation,
                        },
                    },
                ));
            }
        }
        retirements.sort_unstable_by(|left, right| left.0.cmp(&right.0));
        for ((entity_id, slot), retirement) in &retirements {
            let state = self
                .entity_slots
                .get_mut(entity_id)
                .ok_or(GeometryRepresentationRegistryError::BindingNotFound)?;
            state.current.remove(slot);
            state
                .tombstones
                .insert(slot.clone(), retirement.tombstone.generation);
            state
                .high_water
                .insert(slot.clone(), retirement.tombstone.generation);
        }
        Ok(retirements
            .into_iter()
            .map(|(_, retirement)| retirement)
            .collect())
    }

    /// Evaluates an authoritative section by transiently loading manifest partitions.
    pub fn evaluate_section<P: GeometryRepresentationProvider>(
        &self,
        key: &GeometryRepresentationKey,
        plane: SectionPlane,
        tolerance: f64,
        provider: &mut P,
    ) -> Result<AuthoritativeSectionProduct, GeometryRepresentationRegistryError> {
        let binding = self
            .immutable
            .get(key)
            .ok_or(GeometryRepresentationRegistryError::BindingNotFound)?;
        let evaluated = binding
            .resolved
            .evaluated_mesh
            .as_ref()
            .ok_or(GeometryRepresentationRegistryError::InvalidEvaluatedMesh)?;
        let mut store = AuthoritativeSectionTopologyStore::new();
        store.publish(evaluated.topology.clone());
        store
            .evaluate(evaluated.topology.key(), plane, tolerance, |part| {
                provider
                    .load_evaluated_mesh_part(key, part)
                    .map_err(|error| SectionTopologyLoadError {
                        message: error.message,
                    })
            })
            .map_err(GeometryRepresentationRegistryError::Topology)
    }

    /// Returns descriptor-level registry counts.
    #[must_use]
    pub fn stats(&self) -> GeometryRepresentationRegistryStats {
        GeometryRepresentationRegistryStats {
            immutable_bindings: self.immutable.len(),
            current_slots: self
                .entity_slots
                .values()
                .map(|state| state.current.len())
                .sum(),
            geometry_objects: self.geometries.len(),
            tombstones: self
                .entity_slots
                .values()
                .map(|state| state.tombstones.len())
                .sum(),
        }
    }

    fn observe_entity(&self, entity_id: &str) -> TouchedEntityObservation {
        let observation = self
            .entity_slots
            .get(entity_id)
            .cloned()
            .unwrap_or_default();
        #[cfg(test)]
        self.observed_slot_visits.set(
            self.observed_slot_visits.get()
                + observation.current.len()
                + observation.tombstones.len()
                + observation.high_water.len(),
        );
        observation
    }
}

fn next_registry_generation(
    previous: Option<u64>,
) -> Result<u64, GeometryRepresentationRegistryError> {
    let generation = previous
        .unwrap_or(0)
        .checked_add(1)
        .ok_or(GeometryRepresentationRegistryError::GenerationExhausted)?;
    if generation > JAVASCRIPT_SAFE_INTEGER_MAX {
        return Err(GeometryRepresentationRegistryError::GenerationExhausted);
    }
    Ok(generation)
}

fn validate_binding(
    entity: CanonicalEntity,
    representation_slot: String,
    selected: Representation,
    resolved: ResolvedGeometryRepresentation,
) -> Result<GeometryRepresentationBinding, GeometryRepresentationRegistryError> {
    if representation_slot.trim().is_empty() || representation_slot.contains('\0') {
        return Err(GeometryRepresentationRegistryError::InvalidRepresentationSlot);
    }
    validate_resolved_representation(&entity, &selected, &resolved.geometry)?;
    if let Some(evaluated) = &resolved.evaluated_mesh {
        evaluated.validate()?;
        if evaluated.source_geometry_ref != selected.geometry_ref {
            return Err(GeometryRepresentationRegistryError::EvaluatedMeshGeometryMismatch);
        }
        let topology_key = evaluated.topology.key();
        if topology_key.entity_id != entity.id.0
            || topology_key.version_hash != entity.version_hash.0
        {
            return Err(GeometryRepresentationRegistryError::EvaluatedMeshEntityVersionMismatch);
        }
        if let Some(expected_closed) = evaluated_mesh_closed_semantics(&resolved.geometry) {
            if evaluated.topology.closed_manifold() != expected_closed {
                return Err(GeometryRepresentationRegistryError::EvaluatedMeshTopologyMismatch);
            }
        } else if !matches!(resolved.geometry.as_ref(), GeometryObject::Extension { .. }) {
            return Err(GeometryRepresentationRegistryError::InvalidEvaluatedMesh);
        }
    }

    let key = GeometryRepresentationKey {
        slot: GeometryRepresentationSlotKey {
            entity_id: entity.id.clone(),
            representation_slot,
        },
        entity_revision: entity.revision,
        entity_version_hash: entity.version_hash.clone(),
        geometry_ref: selected.geometry_ref.clone(),
    };
    let binding_hash = representation_binding_hash(&key, resolved.evaluated_mesh.as_ref())?;
    Ok(GeometryRepresentationBinding {
        key,
        entity,
        selected,
        resolved,
        binding_hash,
    })
}

fn evaluated_mesh_closed_semantics(geometry: &GeometryObject) -> Option<bool> {
    match geometry {
        GeometryObject::Surface3d { mesh } => Some(mesh.closed_manifold),
        GeometryObject::ElevationSurface { surface } => match surface.as_ref() {
            ElevationSurfaceGeometry::Tin { mesh, .. } => Some(mesh.closed_manifold),
            ElevationSurfaceGeometry::Grid { .. } => None,
        },
        GeometryObject::Solid { solid } => match solid.as_ref() {
            SolidGeometry::ClosedMesh { .. }
            | SolidGeometry::Brep { .. }
            | SolidGeometry::Csg { .. }
            | SolidGeometry::Extrusion { .. }
            | SolidGeometry::Sweep { .. }
            | SolidGeometry::Extension { .. } => Some(true),
        },
        _ => None,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EvaluatedMeshManifest<'a> {
    schema_version: u32,
    source_geometry_ref: &'a ObjectHash,
    render_geometry_ref: &'a ObjectHash,
    recipe: &'a EvaluatedMeshRecipe,
    snapshot_key: &'a SectionTopologySnapshotKey,
    parts: &'a [SectionTopologyPart],
    material_keys: &'a BTreeMap<u32, String>,
    closed_manifold: bool,
}

fn evaluated_mesh_manifest_hash(
    source_geometry_ref: &ObjectHash,
    render_geometry_ref: &ObjectHash,
    recipe: &EvaluatedMeshRecipe,
    snapshot_key: &SectionTopologySnapshotKey,
    parts: &[SectionTopologyPart],
    material_keys: &BTreeMap<u32, String>,
    closed_manifold: bool,
) -> Result<ObjectHash, GeometryRepresentationRegistryError> {
    let manifest = EvaluatedMeshManifest {
        schema_version: EVALUATED_MESH_MANIFEST_SCHEMA_VERSION,
        source_geometry_ref,
        render_geometry_ref,
        recipe,
        snapshot_key,
        parts,
        material_keys,
        closed_manifold,
    };
    serde_json::to_vec(&manifest)
        .map(|bytes| ObjectHash::of_bytes(&bytes))
        .map_err(|_| GeometryRepresentationRegistryError::ManifestSerialization)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepresentationBindingManifest<'a> {
    schema_version: u32,
    key: &'a GeometryRepresentationKey,
    evaluated_topology_hash: Option<&'a str>,
    evaluated_render_geometry_ref: Option<&'a ObjectHash>,
}

fn representation_binding_hash(
    key: &GeometryRepresentationKey,
    evaluated: Option<&EvaluatedMeshRepresentation>,
) -> Result<ObjectHash, GeometryRepresentationRegistryError> {
    let manifest = RepresentationBindingManifest {
        schema_version: REPRESENTATION_BINDING_SCHEMA_VERSION,
        key,
        evaluated_topology_hash: evaluated.map(|mesh| mesh.topology.topology_hash()),
        evaluated_render_geometry_ref: evaluated.map(|mesh| &mesh.render_geometry_ref),
    };
    serde_json::to_vec(&manifest)
        .map(|bytes| ObjectHash::of_bytes(&bytes))
        .map_err(|_| GeometryRepresentationRegistryError::ManifestSerialization)
}

fn validate_recipe(
    recipe: &EvaluatedMeshRecipe,
) -> Result<(), GeometryRepresentationRegistryError> {
    if recipe.provider_id.trim().is_empty()
        || recipe.provider_id.contains('\0')
        || recipe.provider_version.trim().is_empty()
        || recipe.provider_version.contains('\0')
    {
        return Err(GeometryRepresentationRegistryError::InvalidEvaluatedMesh);
    }
    if let Some(parameters_ref) = &recipe.parameters_ref {
        validate_hash(parameters_ref)?;
    }
    Ok(())
}

fn validate_manifest_parts(
    parts: &[SectionTopologyPart],
) -> Result<(), GeometryRepresentationRegistryError> {
    if parts.is_empty()
        || parts.iter().any(|part| {
            part.part_id.trim().is_empty()
                || part.part_id.contains('\0')
                || !valid_sha256(&part.topology_hash)
        })
    {
        return Err(GeometryRepresentationRegistryError::InvalidEvaluatedMesh);
    }
    Ok(())
}

fn validate_hash(hash: &ObjectHash) -> Result<(), GeometryRepresentationRegistryError> {
    if valid_sha256(hash.as_str()) {
        Ok(())
    } else {
        Err(GeometryRepresentationRegistryError::InvalidContentHash)
    }
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::{
        EvaluatedMeshRecipe, EvaluatedMeshRepresentation, GeometryRepresentationProvider,
        GeometryRepresentationProviderError, GeometryRepresentationRegistry,
        GeometryRepresentationRegistryError, ResolvedGeometryRepresentation,
    };
    use crate::{
        GeometryRepresentationKey, SectionTopologyPart, SectionTopologyPartitionData,
        SectionTopologySnapshotKey,
    };
    use himmelcad_core::entity::EntityId;
    use himmelcad_core::entity_model::{
        built_in_type, CanonicalEntity, EntityTypeId, GeometryObject, GeometryResource,
        Representation, RepresentationAuthority, RepresentationRole, SolidGeometry,
        TriangleMeshGeometry, TriangleMeshStorage, Vector3,
    };
    use himmelcad_core::entity_validation::{
        canonical_entity_version_hash, geometry_object_content_hash, EntityValidationError,
    };
    use himmelcad_core::geometry_representation_registry::{
        CanonicalRepresentationAdmission, GeometryRepresentationBindingRef,
    };
    use himmelcad_core::hash::ObjectHash;
    use std::collections::BTreeMap;
    use std::sync::Arc;

    fn hash(bytes: &[u8]) -> ObjectHash {
        ObjectHash::of_bytes(bytes)
    }

    fn canonical_entity(
        revision: u64,
        type_id: &str,
        geometry: &GeometryObject,
    ) -> CanonicalEntity {
        canonical_entity_with_id("entity-1", revision, type_id, geometry)
    }

    fn canonical_entity_with_id(
        entity_id: &str,
        revision: u64,
        type_id: &str,
        geometry: &GeometryObject,
    ) -> CanonicalEntity {
        let representation = Representation {
            role: RepresentationRole::Canonical,
            geometry_ref: geometry_object_content_hash(geometry).expect("valid geometry"),
            authority: RepresentationAuthority::Authoritative,
            dependency_hash: None,
        };
        let mut entity = CanonicalEntity {
            id: EntityId(entity_id.to_owned()),
            revision,
            type_id: EntityTypeId(type_id.to_owned()),
            name: format!("Fixture {revision}"),
            owner: None,
            layer_ids: Vec::new(),
            placement: None,
            representations: vec![representation],
            components_ref: hash(b"components"),
            attributes_ref: hash(b"attributes"),
            relations_ref: hash(b"relations"),
            style_ref: None,
            schema_version: 1,
            version_hash: hash(b"uninitialized"),
        };
        entity.version_hash = canonical_entity_version_hash(&entity).expect("entity hash");
        entity
    }

    fn admission(
        entity: &CanonicalEntity,
        slot: &str,
        geometry: GeometryObject,
        expected_generation: Option<u64>,
    ) -> super::ResolvedGeometryRepresentationAdmission {
        super::ResolvedGeometryRepresentationAdmission {
            canonical: CanonicalRepresentationAdmission {
                entity: entity.clone(),
                selected: entity.representations[0].clone(),
                representation_slot: slot.to_owned(),
                expected_generation,
                resolved_geometry: geometry,
            },
            evaluated_mesh: None,
        }
    }

    fn brep() -> GeometryObject {
        GeometryObject::Solid {
            solid: Box::new(SolidGeometry::Brep {
                resource: GeometryResource {
                    object_hash: hash(b"brep-resource"),
                    media_type: "model/step".to_owned(),
                    byte_length: Some(4096),
                },
            }),
        }
    }

    fn open_mesh(x: f64) -> GeometryObject {
        GeometryObject::Surface3d {
            mesh: Box::new(TriangleMeshGeometry {
                storage: TriangleMeshStorage::Inline {
                    positions: vec![
                        Vector3 { x, y: 0.0, z: 0.0 },
                        Vector3 {
                            x: x + 1.0,
                            y: 0.0,
                            z: 0.0,
                        },
                        Vector3 { x, y: 1.0, z: 0.0 },
                    ],
                    indices: vec![0, 1, 2],
                    normals: None,
                    texture_coordinates: None,
                },
                closed_manifold: false,
                triangle_material_slots: None,
                materials: None,
            }),
        }
    }

    fn evaluated(
        entity: &CanonicalEntity,
        geometry_ref: ObjectHash,
        version_hash: String,
    ) -> EvaluatedMeshRepresentation {
        evaluated_variant(entity, geometry_ref, version_hash, "1.0.0")
    }

    fn evaluated_variant(
        entity: &CanonicalEntity,
        geometry_ref: ObjectHash,
        version_hash: String,
        provider_version: &str,
    ) -> EvaluatedMeshRepresentation {
        evaluated_render_variant(
            entity,
            geometry_ref,
            hash(b"evaluated-render-mesh"),
            version_hash,
            provider_version,
        )
    }

    fn evaluated_render_variant(
        entity: &CanonicalEntity,
        geometry_ref: ObjectHash,
        render_geometry_ref: ObjectHash,
        version_hash: String,
        provider_version: &str,
    ) -> EvaluatedMeshRepresentation {
        EvaluatedMeshRepresentation::new(
            geometry_ref,
            render_geometry_ref,
            EvaluatedMeshRecipe {
                provider_id: "hcad.test-brep-tessellator".to_owned(),
                provider_version: provider_version.to_owned(),
                parameters_ref: Some(hash(b"tessellation-parameters")),
            },
            SectionTopologySnapshotKey {
                entity_id: entity.id.0.clone(),
                dataset_id: Some("evaluated-body".to_owned()),
                version_hash,
            },
            vec![SectionTopologyPart {
                part_id: "body-0".to_owned(),
                topology_hash: hash(b"evaluated-part").0,
                bounds: None,
            }],
            BTreeMap::from([(0, "material:default".to_owned())]),
            true,
        )
        .expect("evaluated manifest")
    }

    #[derive(Clone)]
    struct FixtureProvider {
        resolved: ResolvedGeometryRepresentation,
    }

    impl GeometryRepresentationProvider for FixtureProvider {
        fn resolve_representation(
            &mut self,
            _entity: &CanonicalEntity,
            _representation_slot: &str,
            _selected: &Representation,
        ) -> Result<ResolvedGeometryRepresentation, GeometryRepresentationProviderError> {
            Ok(self.resolved.clone())
        }

        fn load_evaluated_mesh_part(
            &mut self,
            _key: &GeometryRepresentationKey,
            _part: &SectionTopologyPart,
        ) -> Result<SectionTopologyPartitionData, GeometryRepresentationProviderError> {
            Err(GeometryRepresentationProviderError {
                message: "not needed by admission test".to_owned(),
            })
        }
    }

    #[test]
    fn admits_direct_mesh_and_brep_evaluated_by_provider() {
        let direct_geometry = open_mesh(0.0);
        let direct_entity = canonical_entity(1, built_in_type::SURFACE_3D, &direct_geometry);
        let mut registry = GeometryRepresentationRegistry::new();
        let direct = registry
            .publish(
                direct_entity.clone(),
                "body".to_owned(),
                direct_entity.representations[0].clone(),
                ResolvedGeometryRepresentation::new(direct_geometry, None),
                None,
            )
            .expect("direct canonical mesh");
        assert_eq!(direct.generation, 1);
        assert!(direct.binding.resolved().evaluated_mesh().is_none());

        let brep_geometry = brep();
        let brep_entity = canonical_entity(1, built_in_type::OBJECT_3D, &brep_geometry);
        let mesh = evaluated(
            &brep_entity,
            brep_entity.representations[0].geometry_ref.clone(),
            brep_entity.version_hash.0.clone(),
        );
        let expected_topology_hash = mesh.topology().topology_hash().to_owned();
        let mut provider = FixtureProvider {
            resolved: ResolvedGeometryRepresentation::new(brep_geometry, Some(mesh)),
        };
        let mut provider_registry = GeometryRepresentationRegistry::new();
        let registered = provider_registry
            .publish_from_provider(
                brep_entity.clone(),
                "body".to_owned(),
                brep_entity.representations[0].clone(),
                None,
                &mut provider,
            )
            .expect("provider evaluated BRep");
        assert_eq!(registered.generation, 1);
        assert_eq!(
            registered
                .binding
                .resolved()
                .evaluated_mesh()
                .expect("evaluated mesh")
                .topology()
                .topology_hash(),
            expected_topology_hash
        );
        assert_eq!(registry.stats().current_slots, 1);
        assert_eq!(provider_registry.stats().current_slots, 1);
    }

    #[test]
    fn admits_namespaced_extension_with_explicit_evaluated_mesh_topology() {
        let geometry = GeometryObject::Extension {
            type_id: "de.himmelcad.test-custom-volume@1".to_owned(),
            payload: hash(b"extension-payload"),
        };
        let entity = canonical_entity(1, "de.himmelcad.test-extension@1", &geometry);
        let mesh = evaluated(
            &entity,
            entity.representations[0].geometry_ref.clone(),
            entity.version_hash.0.clone(),
        );
        let mut registry = GeometryRepresentationRegistry::new();
        let published = registry
            .publish(
                entity.clone(),
                "body".to_owned(),
                entity.representations[0].clone(),
                ResolvedGeometryRepresentation::new(geometry, Some(mesh)),
                None,
            )
            .expect("extension evaluated mesh");

        assert!(published.binding.resolved().evaluated_mesh().is_some());
        assert_eq!(registry.stats().current_slots, 1);
    }

    #[test]
    fn evaluated_render_geometry_is_part_of_manifest_and_immutable_binding_identity() {
        let geometry = brep();
        let entity = canonical_entity(1, built_in_type::OBJECT_3D, &geometry);
        let first_mesh = evaluated_render_variant(
            &entity,
            entity.representations[0].geometry_ref.clone(),
            hash(b"render-mesh-a"),
            entity.version_hash.0.clone(),
            "1.0.0",
        );
        let second_mesh = evaluated_render_variant(
            &entity,
            entity.representations[0].geometry_ref.clone(),
            hash(b"render-mesh-b"),
            entity.version_hash.0.clone(),
            "1.0.0",
        );
        assert_ne!(
            first_mesh.topology().topology_hash(),
            second_mesh.topology().topology_hash()
        );
        assert_ne!(
            first_mesh.render_geometry_ref(),
            second_mesh.render_geometry_ref()
        );

        let mut registry = GeometryRepresentationRegistry::new();
        let first = registry
            .publish(
                entity.clone(),
                "body".to_owned(),
                entity.representations[0].clone(),
                ResolvedGeometryRepresentation::new(geometry.clone(), Some(first_mesh)),
                None,
            )
            .expect("first evaluated render geometry");
        let error = registry
            .publish(
                entity.clone(),
                "body".to_owned(),
                entity.representations[0].clone(),
                ResolvedGeometryRepresentation::new(geometry, Some(second_mesh)),
                Some(first.generation),
            )
            .expect_err("same immutable key cannot change render geometry");
        assert_eq!(
            error,
            GeometryRepresentationRegistryError::ImmutableKeyCollision
        );
    }

    #[test]
    fn rejects_stale_valid_entity_revision() {
        let geometry = open_mesh(0.0);
        let newer = canonical_entity(2, built_in_type::SURFACE_3D, &geometry);
        let older = canonical_entity(1, built_in_type::SURFACE_3D, &geometry);
        let mut registry = GeometryRepresentationRegistry::new();
        let current = registry
            .publish(
                newer.clone(),
                "body".to_owned(),
                newer.representations[0].clone(),
                ResolvedGeometryRepresentation::new(geometry.clone(), None),
                None,
            )
            .expect("new revision");
        let error = registry
            .publish(
                older.clone(),
                "body".to_owned(),
                older.representations[0].clone(),
                ResolvedGeometryRepresentation::new(geometry, None),
                Some(current.generation),
            )
            .expect_err("stale revision");
        assert_eq!(
            error,
            GeometryRepresentationRegistryError::StaleEntityRevision
        );
    }

    #[test]
    fn rejects_geometry_that_does_not_match_selected_geometry_ref() {
        let selected_geometry = open_mesh(0.0);
        let wrong_geometry = open_mesh(5.0);
        let entity = canonical_entity(1, built_in_type::SURFACE_3D, &selected_geometry);
        let error = GeometryRepresentationRegistry::new()
            .publish(
                entity.clone(),
                "body".to_owned(),
                entity.representations[0].clone(),
                ResolvedGeometryRepresentation::new(wrong_geometry, None),
                None,
            )
            .expect_err("wrong geometry ref");
        assert_eq!(
            error,
            GeometryRepresentationRegistryError::EntityValidation(
                EntityValidationError::GeometryHashMismatch
            )
        );
    }

    #[test]
    fn rejects_topology_snapshot_from_another_entity_revision() {
        let geometry = brep();
        let entity = canonical_entity(1, built_in_type::OBJECT_3D, &geometry);
        let evaluated = evaluated(
            &entity,
            entity.representations[0].geometry_ref.clone(),
            hash(b"different-entity-version").0,
        );
        let error = GeometryRepresentationRegistry::new()
            .publish(
                entity.clone(),
                "body".to_owned(),
                entity.representations[0].clone(),
                ResolvedGeometryRepresentation::new(geometry, Some(evaluated)),
                None,
            )
            .expect_err("topology version mismatch");
        assert_eq!(
            error,
            GeometryRepresentationRegistryError::EvaluatedMeshEntityVersionMismatch
        );
    }

    #[test]
    fn failed_replacement_is_atomic_and_leaves_current_binding_unchanged() {
        let geometry = brep();
        let first_entity = canonical_entity(1, built_in_type::OBJECT_3D, &geometry);
        let first_mesh = evaluated(
            &first_entity,
            first_entity.representations[0].geometry_ref.clone(),
            first_entity.version_hash.0.clone(),
        );
        let mut registry = GeometryRepresentationRegistry::new();
        let first = registry
            .publish(
                first_entity.clone(),
                "body".to_owned(),
                first_entity.representations[0].clone(),
                ResolvedGeometryRepresentation::new(geometry.clone(), Some(first_mesh)),
                None,
            )
            .expect("first binding");

        let second_entity = canonical_entity(2, built_in_type::OBJECT_3D, &geometry);
        let mismatched_mesh = evaluated(
            &second_entity,
            second_entity.representations[0].geometry_ref.clone(),
            first_entity.version_hash.0.clone(),
        );
        let error = registry
            .publish(
                second_entity.clone(),
                "body".to_owned(),
                second_entity.representations[0].clone(),
                ResolvedGeometryRepresentation::new(geometry, Some(mismatched_mesh)),
                Some(first.generation),
            )
            .expect_err("invalid replacement");
        assert_eq!(
            error,
            GeometryRepresentationRegistryError::EvaluatedMeshEntityVersionMismatch
        );
        let (current_key, generation) = registry
            .current_key("entity-1", "body")
            .expect("old current binding");
        assert_eq!(current_key, first.binding.key());
        assert_eq!(generation, first.generation);
        assert_eq!(registry.stats().immutable_bindings, 1);
    }

    #[test]
    fn retiring_current_keeps_immutable_key_and_rejects_conflicting_republish() {
        let geometry = brep();
        let entity = canonical_entity(1, built_in_type::OBJECT_3D, &geometry);
        let first_mesh = evaluated(
            &entity,
            entity.representations[0].geometry_ref.clone(),
            entity.version_hash.0.clone(),
        );
        let mut registry = GeometryRepresentationRegistry::new();
        let first = registry
            .publish(
                entity.clone(),
                "body".to_owned(),
                entity.representations[0].clone(),
                ResolvedGeometryRepresentation::new(geometry.clone(), Some(first_mesh)),
                None,
            )
            .expect("first binding");
        let key = first.binding.key().clone();

        let retired = registry
            .remove(&key, first.generation)
            .expect("retire current slot");
        assert_eq!(retired.binding.binding_hash(), first.binding.binding_hash());
        assert_eq!(retired.tombstone.generation, first.generation + 1);
        assert!(registry.current_key("entity-1", "body").is_none());
        assert_eq!(registry.get(&key), Some(&first.binding));

        let absent_create_error = registry
            .publish(
                entity.clone(),
                "body".to_owned(),
                entity.representations[0].clone(),
                first.binding.resolved().clone(),
                None,
            )
            .expect_err("retired slot is not a never-created slot");
        assert_eq!(
            absent_create_error,
            GeometryRepresentationRegistryError::GenerationConflict
        );

        let conflicting_mesh = evaluated_variant(
            &entity,
            entity.representations[0].geometry_ref.clone(),
            entity.version_hash.0.clone(),
            "2.0.0",
        );
        let error = registry
            .publish(
                entity.clone(),
                "body".to_owned(),
                entity.representations[0].clone(),
                ResolvedGeometryRepresentation::new(geometry, Some(conflicting_mesh)),
                Some(retired.tombstone.generation),
            )
            .expect_err("immutable exact key collision");
        assert_eq!(
            error,
            GeometryRepresentationRegistryError::ImmutableKeyCollision
        );
        assert_eq!(registry.get(&key), Some(&first.binding));

        let republished = registry
            .publish(
                entity.clone(),
                "body".to_owned(),
                entity.representations[0].clone(),
                first.binding.resolved().clone(),
                Some(retired.tombstone.generation),
            )
            .expect("republish exact immutable binding");
        assert_eq!(republished.generation, retired.tombstone.generation + 1);
        assert_eq!(
            registry.remove(&key, first.generation),
            Err(GeometryRepresentationRegistryError::GenerationConflict)
        );
    }

    #[test]
    fn exact_atomic_entity_retirement_requires_every_current_binding() {
        let geometry = open_mesh(0.0);
        let entity = canonical_entity(1, built_in_type::SURFACE_3D, &geometry);
        let mut registry = GeometryRepresentationRegistry::new();
        let published = registry
            .prepare_atomic(vec![
                admission(&entity, "body", geometry.clone(), None),
                admission(&entity, "outline", geometry, None),
            ])
            .and_then(|overlay| registry.commit_atomic(overlay))
            .expect("initial complete entity publication");
        let bindings = published
            .iter()
            .map(|registration| GeometryRepresentationBindingRef {
                key: registration.binding.key().clone(),
                generation: registration.generation,
            })
            .collect::<Vec<_>>();

        let before = registry.stats();
        assert!(matches!(
            registry.prepare_retire_atomic(vec![bindings[0].clone()]),
            Err(GeometryRepresentationRegistryError::GenerationConflict)
        ));
        assert_eq!(registry.stats(), before);

        let (overlay, tombstones) = registry
            .prepare_retire_atomic(bindings)
            .expect("prepare exact complete retirement");
        assert_eq!(tombstones.len(), 2);
        assert!(tombstones.iter().all(|binding| binding.generation == 2));
        assert!(registry.current_key("entity-1", "body").is_some());
        assert!(registry.current_key("entity-1", "outline").is_some());

        let published = registry
            .commit_atomic(overlay)
            .expect("commit exact complete retirement");
        assert!(published.is_empty());
        assert!(registry.current_key("entity-1", "body").is_none());
        assert!(registry.current_key("entity-1", "outline").is_none());
        assert_eq!(registry.stats().tombstones, 2);
    }

    #[test]
    fn atomic_entity_revision_never_exposes_mixed_slots_and_retires_omissions() {
        let geometry = open_mesh(0.0);
        let revision_one = canonical_entity(1, built_in_type::SURFACE_3D, &geometry);
        let mut registry = GeometryRepresentationRegistry::new();
        let first = registry
            .prepare_atomic(vec![
                admission(&revision_one, "body", geometry.clone(), None),
                admission(&revision_one, "outline", geometry.clone(), None),
                admission(&revision_one, "legacy", geometry.clone(), None),
            ])
            .and_then(|overlay| registry.commit_atomic(overlay))
            .expect("initial complete entity publication");
        assert!(first
            .iter()
            .all(|registration| registration.generation == 1));

        let revision_two = canonical_entity(2, built_in_type::SURFACE_3D, &geometry);
        let overlay = registry
            .prepare_atomic(vec![
                admission(&revision_two, "body", geometry.clone(), Some(1)),
                admission(&revision_two, "outline", geometry.clone(), Some(1)),
            ])
            .expect("prepare complete replacement");

        for slot in ["body", "outline", "legacy"] {
            let (key, generation) = registry
                .current_key("entity-1", slot)
                .expect("old entity remains visible before commit");
            assert_eq!(key.entity_revision, 1);
            assert_eq!(generation, 1);
        }

        let second = registry
            .commit_atomic(overlay)
            .expect("commit complete replacement");
        assert_eq!(second.len(), 2);
        for slot in ["body", "outline"] {
            let (key, generation) = registry
                .current_key("entity-1", slot)
                .expect("new entity slot");
            assert_eq!(key.entity_revision, 2);
            assert_eq!(key.entity_version_hash, revision_two.version_hash);
            assert_eq!(generation, 2);
        }
        assert!(registry.current_key("entity-1", "legacy").is_none());
        let state = registry.entity_slots.get("entity-1").expect("entity state");
        assert_eq!(state.tombstones.get("legacy"), Some(&2));
        assert_eq!(registry.stats().current_slots, 2);
    }

    #[test]
    fn stale_overlay_commit_has_no_partial_mutation() {
        let geometry = open_mesh(0.0);
        let revision_one = canonical_entity(1, built_in_type::SURFACE_3D, &geometry);
        let mut registry = GeometryRepresentationRegistry::new();
        let first = registry
            .publish(
                revision_one.clone(),
                "body".to_owned(),
                revision_one.representations[0].clone(),
                ResolvedGeometryRepresentation::new(geometry.clone(), None),
                None,
            )
            .expect("initial slot");
        let revision_two = canonical_entity(2, built_in_type::SURFACE_3D, &geometry);
        let overlay = registry
            .prepare_atomic(vec![admission(
                &revision_two,
                "body",
                geometry,
                Some(first.generation),
            )])
            .expect("prepared replacement");

        registry
            .remove(first.binding.key(), first.generation)
            .expect("intervening retire");
        let before = registry.stats();
        assert_eq!(
            registry.commit_atomic(overlay),
            Err(GeometryRepresentationRegistryError::StaleOverlay)
        );
        assert_eq!(registry.stats(), before);
        assert!(registry.current_key("entity-1", "body").is_none());
    }

    #[test]
    fn invalid_later_admission_rolls_back_the_whole_prepare() {
        let geometry = open_mesh(0.0);
        let wrong_geometry = open_mesh(10.0);
        let first =
            canonical_entity_with_id("entity-first", 1, built_in_type::SURFACE_3D, &geometry);
        let second =
            canonical_entity_with_id("entity-second", 1, built_in_type::SURFACE_3D, &geometry);
        let registry = GeometryRepresentationRegistry::new();
        let before = registry.stats();
        let error = registry
            .prepare_atomic(vec![
                admission(&first, "body", geometry, None),
                admission(&second, "body", wrong_geometry, None),
            ])
            .expect_err("second admission invalidates complete overlay");
        assert_eq!(
            error,
            GeometryRepresentationRegistryError::EntityValidation(
                EntityValidationError::GeometryHashMismatch
            )
        );
        assert_eq!(registry.stats(), before);
    }

    #[test]
    fn clear_tombstones_every_slot_and_prevents_aba_recreation() {
        let geometry = open_mesh(0.0);
        let entity = canonical_entity(1, built_in_type::SURFACE_3D, &geometry);
        let mut registry = GeometryRepresentationRegistry::new();
        registry
            .prepare_atomic(vec![
                admission(&entity, "body", geometry.clone(), None),
                admission(&entity, "outline", geometry.clone(), None),
            ])
            .and_then(|overlay| registry.commit_atomic(overlay))
            .expect("initial slots");

        let retired = registry.clear().expect("atomic clear");
        assert_eq!(retired.len(), 2);
        assert!(retired
            .iter()
            .all(|retirement| retirement.tombstone.generation == 2));
        assert_eq!(registry.stats().current_slots, 0);
        assert_eq!(registry.stats().tombstones, 2);

        let none_error = registry
            .publish(
                entity.clone(),
                "body".to_owned(),
                entity.representations[0].clone(),
                ResolvedGeometryRepresentation::new(geometry.clone(), None),
                None,
            )
            .expect_err("cleared slot is not new");
        assert_eq!(
            none_error,
            GeometryRepresentationRegistryError::GenerationConflict
        );
        let reinserted = registry
            .publish(
                entity.clone(),
                "body".to_owned(),
                entity.representations[0].clone(),
                ResolvedGeometryRepresentation::new(geometry, None),
                Some(2),
            )
            .expect("CAS against clear tombstone");
        assert_eq!(reinserted.generation, 3);
    }

    #[test]
    fn canonical_geometry_is_physically_shared_by_content_hash() {
        let geometry = open_mesh(0.0);
        let first_entity =
            canonical_entity_with_id("entity-first", 1, built_in_type::SURFACE_3D, &geometry);
        let second_entity =
            canonical_entity_with_id("entity-second", 1, built_in_type::SURFACE_3D, &geometry);
        let mut registry = GeometryRepresentationRegistry::new();
        let first_overlay = registry
            .prepare_atomic(vec![admission(
                &first_entity,
                "body",
                geometry.clone(),
                None,
            )])
            .expect("first prepared geometry");
        let second_overlay = registry
            .prepare_atomic(vec![admission(&second_entity, "body", geometry, None)])
            .expect("concurrently prepared geometry");
        let first = registry
            .commit_atomic(first_overlay)
            .expect("first geometry commit")
            .remove(0);
        let second = registry
            .commit_atomic(second_overlay)
            .expect("second geometry commit")
            .remove(0);

        assert_eq!(registry.stats().geometry_objects, 1);
        assert!(Arc::ptr_eq(
            &first.binding.resolved.geometry,
            &second.binding.resolved.geometry
        ));
    }

    #[test]
    fn touched_entity_observation_does_not_visit_foreign_slots() {
        let geometry = open_mesh(0.0);
        let mut registry = GeometryRepresentationRegistry::new();
        for index in 0..128 {
            let entity = canonical_entity_with_id(
                &format!("foreign-{index}"),
                1,
                built_in_type::SURFACE_3D,
                &geometry,
            );
            registry
                .publish(
                    entity.clone(),
                    "body".to_owned(),
                    entity.representations[0].clone(),
                    ResolvedGeometryRepresentation::new(geometry.clone(), None),
                    None,
                )
                .expect("foreign slot");
        }
        let target_one =
            canonical_entity_with_id("target", 1, built_in_type::SURFACE_3D, &geometry);
        let target = registry
            .publish(
                target_one.clone(),
                "body".to_owned(),
                target_one.representations[0].clone(),
                ResolvedGeometryRepresentation::new(geometry.clone(), None),
                None,
            )
            .expect("target slot");

        registry.observed_slot_visits.set(0);
        let target_two =
            canonical_entity_with_id("target", 2, built_in_type::SURFACE_3D, &geometry);
        let overlay = registry
            .prepare_atomic(vec![admission(
                &target_two,
                "body",
                geometry,
                Some(target.generation),
            )])
            .expect("target-only prepare");
        registry.commit_atomic(overlay).expect("target-only commit");

        assert_eq!(registry.observed_slot_visits.get(), 4);
        assert_eq!(registry.stats().current_slots, 129);
    }
}
