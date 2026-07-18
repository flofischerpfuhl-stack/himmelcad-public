//! Atomic owner lifetime for immutable GPU texture/sampler allocations.

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{Display, Formatter};

use crate::GpuTextureResourceIdentity;

/// Immutable GPU allocation accepted by [`GpuTextureResourceCache`].
///
/// Implementations must return the same process-local allocation key from all
/// clones retaining the same underlying texture/sampler allocation.
pub trait ImmutableGpuTextureResource: Clone {
    /// Process-local key of the retained immutable GPU allocation.
    fn allocation_key(&self) -> usize;

    /// GPU bytes charged once while at least one committed owner exists.
    fn resident_bytes(&self) -> u64;
}

/// Detached, validated resources for one future owner publication.
#[derive(Debug, Clone)]
pub struct GpuTextureResourceStage<R> {
    resources: BTreeMap<GpuTextureResourceIdentity, R>,
}

impl<R: ImmutableGpuTextureResource> GpuTextureResourceStage<R> {
    /// Validates a detached stage without changing cache ownership or cost.
    pub fn prepare(
        resources: impl IntoIterator<Item = (GpuTextureResourceIdentity, R)>,
    ) -> Result<Self, GpuTextureResourceCacheError> {
        let mut prepared = BTreeMap::<GpuTextureResourceIdentity, R>::new();
        for (identity, resource) in resources {
            if let Some(previous) = prepared.get(&identity) {
                if previous.allocation_key() != resource.allocation_key()
                    || previous.resident_bytes() != resource.resident_bytes()
                {
                    return Err(GpuTextureResourceCacheError::ConflictingStageIdentity(
                        identity,
                    ));
                }
                continue;
            }
            prepared.insert(identity, resource);
        }
        Ok(Self {
            resources: prepared,
        })
    }

    /// Number of distinct immutable identities in this detached stage.
    #[must_use]
    pub fn len(&self) -> usize {
        self.resources.len()
    }

    /// Whether the detached stage contains no resources.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.resources.is_empty()
    }
}

#[derive(Debug, Clone)]
struct CachedTextureResource<R> {
    resource: R,
    staged_refs: usize,
    resident_refs: usize,
    resident_bytes: u64,
}

/// Diagnostics for global immutable texture/sampler residency.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GpuTextureResourceCacheStats {
    /// Allocations retained by committed or staged owners.
    pub allocation_count: usize,
    /// Allocations charged to global committed residency.
    pub resident_allocation_count: usize,
    /// Committed owner count.
    pub owner_count: usize,
    /// Owners with a prepared but uncommitted replacement.
    pub staged_owner_count: usize,
    /// Globally charged immutable GPU bytes.
    pub resident_bytes: u64,
}

/// Validation failure before a stage changes cache state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuTextureResourceCacheError {
    /// One detached stage assigned incompatible allocations to one identity.
    ConflictingStageIdentity(GpuTextureResourceIdentity),
    /// An existing cache identity has a different byte cost, violating the
    /// exact-upload identity contract.
    ConflictingResidentIdentity(GpuTextureResourceIdentity),
}

impl Display for GpuTextureResourceCacheError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ConflictingStageIdentity(identity) => write!(
                formatter,
                "detached GPU texture stage conflicts for identity {:?}",
                identity.digest()
            ),
            Self::ConflictingResidentIdentity(identity) => write!(
                formatter,
                "cached GPU texture byte cost conflicts for identity {:?}",
                identity.digest()
            ),
        }
    }
}

impl Error for GpuTextureResourceCacheError {}

/// Kernel/viewer-wide immutable texture/sampler cache.
///
/// Staging never changes committed owners or global residency cost. Commit is
/// infallible after validation and atomically replaces the owner's previous
/// identity set. Resources with neither staged nor committed owners are
/// dropped immediately.
#[derive(Debug)]
pub struct GpuTextureResourceCache<R> {
    resources: BTreeMap<GpuTextureResourceIdentity, CachedTextureResource<R>>,
    owners: BTreeMap<String, BTreeSet<GpuTextureResourceIdentity>>,
    staged_owners: BTreeMap<String, BTreeSet<GpuTextureResourceIdentity>>,
    resident_bytes: u64,
}

impl<R> Default for GpuTextureResourceCache<R> {
    fn default() -> Self {
        Self {
            resources: BTreeMap::new(),
            owners: BTreeMap::new(),
            staged_owners: BTreeMap::new(),
            resident_bytes: 0,
        }
    }
}

impl<R: ImmutableGpuTextureResource> GpuTextureResourceCache<R> {
    /// Looks up an allocation retained by any staged or committed owner.
    #[must_use]
    pub fn resource(&self, identity: GpuTextureResourceIdentity) -> Option<R> {
        self.resources
            .get(&identity)
            .map(|entry| entry.resource.clone())
    }

    /// Resolves an existing allocation before invoking an upload factory.
    ///
    /// Callers must derive `identity` exclusively through
    /// `GpuTextureResourceIdentity::for_uploaded_texture` from the exact bytes
    /// they would submit. The SHA-256 identity is the byte-equivalence proof;
    /// the cache intentionally does not retain a second CPU copy merely to
    /// compare bytes after upload. URI-derived or caller-invented digests are
    /// outside this contract.
    pub fn resolve_or_create<E>(
        &self,
        identity: GpuTextureResourceIdentity,
        create: impl FnOnce() -> Result<R, E>,
    ) -> Result<R, E> {
        self.resource(identity).map_or_else(create, Ok)
    }

    /// Atomically installs a detached stage for `owner`. An earlier uncommitted
    /// stage is replaced only after every incoming identity is validated.
    pub fn stage_owner(
        &mut self,
        owner: impl Into<String>,
        stage: GpuTextureResourceStage<R>,
    ) -> Result<(), GpuTextureResourceCacheError> {
        for (identity, resource) in &stage.resources {
            if let Some(cached) = self.resources.get(identity) {
                if cached.resident_bytes != resource.resident_bytes() {
                    return Err(GpuTextureResourceCacheError::ConflictingResidentIdentity(
                        *identity,
                    ));
                }
            }
        }

        let owner = owner.into();
        self.release_staged(&owner);
        let identities = stage.resources.keys().copied().collect::<BTreeSet<_>>();
        for (identity, resource) in stage.resources {
            let entry = self
                .resources
                .entry(identity)
                .or_insert_with(|| CachedTextureResource {
                    resident_bytes: resource.resident_bytes(),
                    resource,
                    staged_refs: 0,
                    resident_refs: 0,
                });
            entry.staged_refs = entry.staged_refs.saturating_add(1);
        }
        self.staged_owners.insert(owner, identities);
        Ok(())
    }

    /// Returns the prepared immutable allocations for `owner` without
    /// publishing them. Existing cached allocations win over redundant staged
    /// uploads with the same exact identity.
    #[must_use]
    pub fn staged_for_owner(&self, owner: &str) -> BTreeMap<GpuTextureResourceIdentity, R> {
        self.staged_owners
            .get(owner)
            .into_iter()
            .flatten()
            .filter_map(|identity| {
                self.resources
                    .get(identity)
                    .map(|entry| (*identity, entry.resource.clone()))
            })
            .collect()
    }

    /// Commits a prepared stage and atomically replaces the owner's previous
    /// references. Returns `false` when no stage exists for the owner.
    pub fn commit_staged(&mut self, owner: &str) -> bool {
        let Some(staged) = self.staged_owners.remove(owner) else {
            return false;
        };
        let previous = self.owners.remove(owner).unwrap_or_default();

        for identity in previous.difference(&staged).copied() {
            self.release_resident_identity(identity);
        }
        for identity in &staged {
            let entry = self
                .resources
                .get_mut(identity)
                .expect("staged GPU texture resource remains retained");
            entry.staged_refs = entry.staged_refs.saturating_sub(1);
            if !previous.contains(identity) {
                if entry.resident_refs == 0 {
                    self.resident_bytes = self.resident_bytes.saturating_add(entry.resident_bytes);
                }
                entry.resident_refs = entry.resident_refs.saturating_add(1);
            }
        }
        if !staged.is_empty() {
            self.owners.insert(owner.to_owned(), staged);
        }
        self.prune_unused();
        true
    }

    /// Drops an uncommitted stage without changing the committed owner.
    pub fn release_staged(&mut self, owner: &str) -> bool {
        let Some(identities) = self.staged_owners.remove(owner) else {
            return false;
        };
        for identity in identities {
            if let Some(entry) = self.resources.get_mut(&identity) {
                entry.staged_refs = entry.staged_refs.saturating_sub(1);
            }
        }
        self.prune_unused();
        true
    }

    /// Evicts one committed owner. The last owner drops the allocation and its
    /// global cost, while unrelated staged replacements remain valid.
    pub fn evict(&mut self, owner: &str) -> bool {
        let Some(identities) = self.owners.remove(owner) else {
            return false;
        };
        for identity in identities {
            self.release_resident_identity(identity);
        }
        self.prune_unused();
        true
    }

    /// Returns committed immutable allocations retained by one owner.
    #[must_use]
    pub fn resident_for_owner(&self, owner: &str) -> BTreeMap<GpuTextureResourceIdentity, R> {
        self.owners
            .get(owner)
            .into_iter()
            .flatten()
            .filter_map(|identity| {
                self.resources
                    .get(identity)
                    .map(|entry| (*identity, entry.resource.clone()))
            })
            .collect()
    }

    /// Bytes newly entering global residency if the selected stages commit.
    #[must_use]
    pub fn staged_resident_bytes<'a>(&self, owners: impl IntoIterator<Item = &'a str>) -> u64 {
        owners
            .into_iter()
            .filter_map(|owner| self.staged_owners.get(owner))
            .flatten()
            .copied()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .fold(0_u64, |bytes, identity| {
                bytes.saturating_add(self.resources.get(&identity).map_or(0, |entry| {
                    if entry.resident_refs == 0 {
                        entry.resident_bytes
                    } else {
                        0
                    }
                }))
            })
    }

    /// Current global cost and owner/allocation counters.
    #[must_use]
    pub fn stats(&self) -> GpuTextureResourceCacheStats {
        GpuTextureResourceCacheStats {
            allocation_count: self.resources.len(),
            resident_allocation_count: self
                .resources
                .values()
                .filter(|entry| entry.resident_refs != 0)
                .count(),
            owner_count: self.owners.len(),
            staged_owner_count: self.staged_owners.len(),
            resident_bytes: self.resident_bytes,
        }
    }

    fn release_resident_identity(&mut self, identity: GpuTextureResourceIdentity) {
        if let Some(entry) = self.resources.get_mut(&identity) {
            entry.resident_refs = entry.resident_refs.saturating_sub(1);
            if entry.resident_refs == 0 {
                self.resident_bytes = self.resident_bytes.saturating_sub(entry.resident_bytes);
            }
        }
    }

    fn prune_unused(&mut self) {
        self.resources
            .retain(|_, entry| entry.staged_refs != 0 || entry.resident_refs != 0);
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::sync::Arc;

    use super::*;
    use crate::{
        GpuTextureColorSpace, GpuTextureSamplerIdentity, GpuTextureUploadFormat,
        GpuTextureUploadLayout, GpuUploadedTextureIdentityInput,
    };

    #[derive(Debug, Clone)]
    struct FakeResource {
        allocation: Arc<()>,
        bytes: u64,
    }

    impl FakeResource {
        fn new(bytes: u64) -> Self {
            Self {
                allocation: Arc::new(()),
                bytes,
            }
        }
    }

    impl ImmutableGpuTextureResource for FakeResource {
        fn allocation_key(&self) -> usize {
            Arc::as_ptr(&self.allocation) as usize
        }

        fn resident_bytes(&self) -> u64 {
            self.bytes
        }
    }

    fn identity(bytes: &[u8]) -> GpuTextureResourceIdentity {
        GpuTextureResourceIdentity::for_uploaded_texture(GpuUploadedTextureIdentityInput {
            width: 1,
            height: 1,
            mip_level_count: 1,
            format: GpuTextureUploadFormat::Rgba8UnormSrgb,
            layout: GpuTextureUploadLayout::MipMajorTightlyPacked,
            color_space: GpuTextureColorSpace::Srgb,
            sampler: GpuTextureSamplerIdentity::REPEAT_LINEAR,
            decoder_revision: 1,
            data: bytes,
        })
    }

    #[test]
    fn two_owners_share_one_allocation_and_one_global_cost_with_separate_styles() {
        let key = identity(&[10, 20, 30, 255]);
        let factory_calls = Cell::new(0_u32);
        let mut cache = GpuTextureResourceCache::default();
        let uploaded = cache
            .resolve_or_create(key, || {
                factory_calls.set(factory_calls.get() + 1);
                Ok::<_, ()>(FakeResource::new(4))
            })
            .unwrap();

        cache
            .stage_owner(
                "tile-a",
                GpuTextureResourceStage::prepare([(key, uploaded.clone())]).unwrap(),
            )
            .unwrap();
        assert_eq!(cache.stats().resident_bytes, 0);
        assert!(cache.commit_staged("tile-a"));
        let reused = cache
            .resolve_or_create(key, || {
                factory_calls.set(factory_calls.get() + 1);
                Ok::<_, ()>(FakeResource::new(4))
            })
            .unwrap();
        cache
            .stage_owner(
                "tile-b",
                GpuTextureResourceStage::prepare([(key, reused)]).unwrap(),
            )
            .unwrap();
        assert!(cache.commit_staged("tile-b"));
        assert_eq!(factory_calls.get(), 1);

        #[derive(Debug)]
        struct TileStyle {
            texture: FakeResource,
            opacity: f32,
        }
        let first = TileStyle {
            texture: cache.resident_for_owner("tile-a")[&key].clone(),
            opacity: 0.25,
        };
        let second = TileStyle {
            texture: cache.resident_for_owner("tile-b")[&key].clone(),
            opacity: 0.9,
        };
        assert_eq!(first.texture.allocation_key(), uploaded.allocation_key());
        assert_eq!(second.texture.allocation_key(), uploaded.allocation_key());
        assert_ne!(first.opacity, second.opacity);
        assert_eq!(
            cache.stats(),
            GpuTextureResourceCacheStats {
                allocation_count: 1,
                resident_allocation_count: 1,
                owner_count: 2,
                staged_owner_count: 0,
                resident_bytes: 4,
            }
        );
    }

    #[test]
    fn replacement_rollback_and_last_owner_eviction_are_atomic() {
        let first_key = identity(&[1, 2, 3, 4]);
        let replacement_key = identity(&[5, 6, 7, 8]);
        let mut cache = GpuTextureResourceCache::default();
        cache
            .stage_owner(
                "tile",
                GpuTextureResourceStage::prepare([(first_key, FakeResource::new(4))]).unwrap(),
            )
            .unwrap();
        cache.commit_staged("tile");

        cache
            .stage_owner(
                "tile",
                GpuTextureResourceStage::prepare([(replacement_key, FakeResource::new(8))])
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(cache.stats().resident_bytes, 4);
        assert!(cache.release_staged("tile"));
        assert!(cache.resident_for_owner("tile").contains_key(&first_key));
        assert_eq!(cache.stats().allocation_count, 1);

        cache
            .stage_owner(
                "tile",
                GpuTextureResourceStage::prepare([(replacement_key, FakeResource::new(8))])
                    .unwrap(),
            )
            .unwrap();
        assert!(cache.commit_staged("tile"));
        assert_eq!(cache.stats().resident_bytes, 8);
        assert!(!cache.resident_for_owner("tile").contains_key(&first_key));
        assert!(cache.evict("tile"));
        assert_eq!(cache.stats(), GpuTextureResourceCacheStats::default());
    }

    #[test]
    fn staged_resident_bytes_deduplicate_new_identities_and_ignore_resident_ones() {
        let resident_key = identity(&[1, 1, 1, 255]);
        let staged_key = identity(&[2, 2, 2, 255]);
        let mut cache = GpuTextureResourceCache::default();
        cache
            .stage_owner(
                "resident",
                GpuTextureResourceStage::prepare([(resident_key, FakeResource::new(4))]).unwrap(),
            )
            .unwrap();
        cache.commit_staged("resident");
        for owner in ["tile-a", "tile-b"] {
            cache
                .stage_owner(
                    owner,
                    GpuTextureResourceStage::prepare([
                        (resident_key, cache.resource(resident_key).unwrap()),
                        (staged_key, FakeResource::new(8)),
                    ])
                    .unwrap(),
                )
                .unwrap();
        }
        assert_eq!(cache.staged_resident_bytes(["tile-a", "tile-b"]), 8);
        assert_eq!(cache.staged_resident_bytes(["resident"]), 0);
    }

    #[test]
    fn redundant_equal_identity_stage_keeps_the_cached_allocation() {
        let key = identity(&[12, 34, 56, 255]);
        let first = FakeResource::new(4);
        let redundant = FakeResource::new(4);
        assert_ne!(first.allocation_key(), redundant.allocation_key());
        let mut cache = GpuTextureResourceCache::default();
        cache
            .stage_owner(
                "tile-a",
                GpuTextureResourceStage::prepare([(key, first.clone())]).unwrap(),
            )
            .unwrap();
        cache.commit_staged("tile-a");
        cache
            .stage_owner(
                "tile-b",
                GpuTextureResourceStage::prepare([(key, redundant)]).unwrap(),
            )
            .unwrap();
        cache.commit_staged("tile-b");

        assert_eq!(
            cache.resident_for_owner("tile-b")[&key].allocation_key(),
            first.allocation_key()
        );
        assert_eq!(cache.stats().allocation_count, 1);
        assert_eq!(cache.stats().resident_bytes, 4);
    }

    #[test]
    fn invalid_restage_leaves_previous_stage_unchanged() {
        let key = identity(&[9, 8, 7, 6]);
        let mut cache = GpuTextureResourceCache::default();
        cache
            .stage_owner(
                "tile",
                GpuTextureResourceStage::prepare([(key, FakeResource::new(4))]).unwrap(),
            )
            .unwrap();
        let error = cache
            .stage_owner(
                "tile",
                GpuTextureResourceStage::prepare([(key, FakeResource::new(5))]).unwrap(),
            )
            .unwrap_err();
        assert_eq!(
            error,
            GpuTextureResourceCacheError::ConflictingResidentIdentity(key)
        );
        assert_eq!(cache.staged_for_owner("tile")[&key].resident_bytes(), 4);
        assert_eq!(cache.stats().staged_owner_count, 1);
    }
}
