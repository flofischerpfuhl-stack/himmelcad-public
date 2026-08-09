//! Content-addressed residency for immutable external asset blobs.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use sha2::{Digest, Sha256};

use super::{AssetBundleLimits, AssetResolverError, ResolvedAssetBundle, ResolvedAssetEntry};

/// Stable byte-integrity identity for one immutable packed asset allocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AssetContentIdentity {
    digest: [u8; 32],
    byte_length: u64,
}

impl AssetContentIdentity {
    /// Computes SHA-256 plus an explicit checked byte length.
    #[must_use]
    pub fn for_bytes(bytes: &[u8]) -> Self {
        Self {
            digest: Sha256::digest(bytes).into(),
            byte_length: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
        }
    }

    /// SHA-256 digest bytes.
    #[must_use]
    pub const fn digest(self) -> [u8; 32] {
        self.digest
    }

    /// Encoded allocation length included in the identity.
    #[must_use]
    pub const fn byte_length(self) -> u64 {
        self.byte_length
    }
}

/// Validated bundle prepared without changing resident refcounts.
#[derive(Debug, Clone)]
pub struct PreparedAssetBundle {
    identities: BTreeSet<AssetContentIdentity>,
    resources: BTreeMap<AssetContentIdentity, Arc<[u8]>>,
    bundle: ResolvedAssetBundle,
}

impl PreparedAssetBundle {
    /// Validated alias table and immutable bytes used during decoding.
    #[must_use]
    pub const fn bundle(&self) -> &ResolvedAssetBundle {
        &self.bundle
    }

    /// Distinct content identities that will be committed for the stream owner.
    pub fn identities(&self) -> impl Iterator<Item = AssetContentIdentity> + '_ {
        self.identities.iter().copied()
    }

    /// Globally deduplicated encoded bytes referenced by this bundle.
    #[must_use]
    pub fn unique_compressed_bytes(&self) -> u64 {
        self.identities.iter().fold(0_u64, |total, identity| {
            total.saturating_add(identity.byte_length())
        })
    }
}

#[derive(Debug)]
struct ResidentBlob {
    bytes: Arc<[u8]>,
    ref_count: usize,
}

/// One kernel/viewer-wide cache of immutable external resources.
///
/// URI aliases stay in each bundle; only bytes with equal SHA-256 and length
/// share an allocation. Preparing is side-effect free, while commit replaces
/// one owner's reference as a single infallible mutation.
#[derive(Debug, Default)]
pub struct SharedAssetBlobCache {
    blobs: BTreeMap<AssetContentIdentity, ResidentBlob>,
    owners: BTreeMap<String, BTreeSet<AssetContentIdentity>>,
    resident_bytes: u64,
}

impl SharedAssetBlobCache {
    /// Creates an empty cache.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Validates a packed bundle and reuses resident bytes when integrity matches.
    pub fn prepare_packed(
        &self,
        entries: Vec<ResolvedAssetEntry>,
        blob: Vec<u8>,
        limits: AssetBundleLimits,
    ) -> Result<PreparedAssetBundle, AssetResolverError> {
        let mut bundle = ResolvedAssetBundle::from_packed(entries, blob, limits)?;
        let mut identities = BTreeSet::new();
        let mut resources: BTreeMap<AssetContentIdentity, Arc<[u8]>> = BTreeMap::new();
        let bundle_resources = bundle
            .shared_resources()
            .map(|(uri, bytes)| (uri.to_owned(), bytes))
            .collect::<Vec<_>>();
        for (resolved_uri, decoded_bytes) in bundle_resources {
            let identity = AssetContentIdentity::for_bytes(&decoded_bytes);
            let shared = if let Some(prepared) = resources.get(&identity) {
                if prepared.as_ref() != decoded_bytes.as_ref() {
                    return Err(AssetResolverError::ConflictingResolvedAsset(
                        "SHA-256 content identity collision".to_owned(),
                    ));
                }
                Arc::clone(prepared)
            } else if let Some(resident) = self.blobs.get(&identity) {
                // A cryptographic identity is still never trusted without comparing
                // the bytes already in this address space.
                if resident.bytes.as_ref() != decoded_bytes.as_ref() {
                    return Err(AssetResolverError::ConflictingResolvedAsset(
                        "SHA-256 content identity collision".to_owned(),
                    ));
                }
                Arc::clone(&resident.bytes)
            } else {
                decoded_bytes
            };
            bundle.replace_shared_resource(&resolved_uri, Arc::clone(&shared));
            identities.insert(identity);
            resources.insert(identity, shared);
        }
        Ok(PreparedAssetBundle {
            identities,
            resources,
            bundle,
        })
    }

    /// Atomically replaces one stable stream owner's resident reference.
    pub fn commit(&mut self, owner: String, prepared: &PreparedAssetBundle) {
        if self.owners.get(&owner) == Some(&prepared.identities) {
            return;
        }
        let previous = self.owners.get(&owner).cloned().unwrap_or_default();
        for identity in prepared.identities.difference(&previous).copied() {
            let bytes = prepared
                .resources
                .get(&identity)
                .expect("prepared identity retains immutable bytes");
            let entry = self.blobs.entry(identity).or_insert_with(|| {
                self.resident_bytes = self.resident_bytes.saturating_add(identity.byte_length());
                ResidentBlob {
                    bytes: Arc::clone(bytes),
                    ref_count: 0,
                }
            });
            debug_assert_eq!(entry.bytes.as_ref(), bytes.as_ref());
            entry.ref_count = entry.ref_count.saturating_add(1);
        }
        for identity in previous.difference(&prepared.identities).copied() {
            self.release_identity(identity);
        }
        if prepared.identities.is_empty() {
            self.owners.remove(&owner);
        } else {
            self.owners.insert(owner, prepared.identities.clone());
        }
    }

    /// Releases one owner and drops its allocation exactly at the last reference.
    pub fn evict(&mut self, owner: &str) -> bool {
        let Some(identities) = self.owners.remove(owner) else {
            return false;
        };
        for identity in identities {
            self.release_identity(identity);
        }
        true
    }

    /// Number of distinct resident packed allocations.
    #[must_use]
    pub fn allocation_count(&self) -> usize {
        self.blobs.len()
    }

    /// Explicit owner references to one byte-integrity identity.
    #[must_use]
    pub fn ref_count(&self, identity: AssetContentIdentity) -> usize {
        self.blobs.get(&identity).map_or(0, |entry| entry.ref_count)
    }

    /// Globally deduplicated encoded bytes retained by resident owners.
    #[must_use]
    pub const fn resident_bytes(&self) -> u64 {
        self.resident_bytes
    }

    fn release_identity(&mut self, identity: AssetContentIdentity) {
        let remove = if let Some(entry) = self.blobs.get_mut(&identity) {
            entry.ref_count = entry.ref_count.saturating_sub(1);
            entry.ref_count == 0
        } else {
            false
        };
        if remove {
            self.blobs.remove(&identity);
            self.resident_bytes = self.resident_bytes.saturating_sub(identity.byte_length());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::ResolvedAssetKind;

    fn entry(owner: &str, length: usize) -> ResolvedAssetEntry {
        ResolvedAssetEntry {
            owner_uri: owner.to_owned(),
            source_uri: "model.glb".to_owned(),
            resolved_uri: "https://assets.test/model.glb".to_owned(),
            kind: ResolvedAssetKind::GltfDocument,
            byte_offset: 0,
            byte_length: length,
        }
    }

    #[test]
    fn equal_bytes_share_one_allocation_across_different_uri_owners() {
        let mut cache = SharedAssetBlobCache::new();
        let first = cache
            .prepare_packed(
                vec![entry("tile-a.i3dm", 4)],
                vec![1, 2, 3, 4],
                AssetBundleLimits::default(),
            )
            .expect("first bundle");
        cache.commit("stream-a".to_owned(), &first);
        let second = cache
            .prepare_packed(
                vec![entry("tile-b.i3dm", 4)],
                vec![1, 2, 3, 4],
                AssetBundleLimits::default(),
            )
            .expect("second bundle");
        let first_bytes = first
            .bundle
            .bytes(first.bundle.entries().first().expect("first entry"))
            .expect("first bytes");
        let second_bytes = second
            .bundle
            .bytes(second.bundle.entries().first().expect("second entry"))
            .expect("second bytes");
        assert!(std::ptr::eq(first_bytes.as_ptr(), second_bytes.as_ptr()));
        cache.commit("stream-b".to_owned(), &second);
        assert_eq!(cache.allocation_count(), 1);
        let identity = first.identities().next().expect("model identity");
        assert_eq!(cache.ref_count(identity), 2);
        assert_eq!(cache.resident_bytes(), 4);
    }

    #[test]
    fn equal_uri_with_different_bytes_never_shares_identity() {
        let mut cache = SharedAssetBlobCache::new();
        let first = cache
            .prepare_packed(
                vec![entry("tile.i3dm", 3)],
                vec![1, 2, 3],
                AssetBundleLimits::default(),
            )
            .expect("first bundle");
        let second = cache
            .prepare_packed(
                vec![entry("tile.i3dm", 3)],
                vec![3, 2, 1],
                AssetBundleLimits::default(),
            )
            .expect("second bundle");
        assert_ne!(
            first.identities().collect::<Vec<_>>(),
            second.identities().collect::<Vec<_>>()
        );
        cache.commit("stream-a".to_owned(), &first);
        cache.commit("stream-b".to_owned(), &second);
        assert_eq!(cache.allocation_count(), 2);
        assert_eq!(cache.resident_bytes(), 6);
    }

    #[test]
    fn replacement_and_last_owner_eviction_update_cost_atomically() {
        let mut cache = SharedAssetBlobCache::new();
        let old = cache
            .prepare_packed(
                vec![entry("old.i3dm", 3)],
                vec![1, 2, 3],
                AssetBundleLimits::default(),
            )
            .expect("old bundle");
        let replacement = cache
            .prepare_packed(
                vec![entry("new.i3dm", 5)],
                vec![4, 5, 6, 7, 8],
                AssetBundleLimits::default(),
            )
            .expect("replacement bundle");
        cache.commit("stream".to_owned(), &old);
        cache.commit("stream".to_owned(), &replacement);
        let old_identity = old.identities().next().expect("old identity");
        let replacement_identity = replacement
            .identities()
            .next()
            .expect("replacement identity");
        assert_eq!(cache.ref_count(old_identity), 0);
        assert_eq!(cache.ref_count(replacement_identity), 1);
        assert_eq!(cache.resident_bytes(), 5);
        assert!(cache.evict("stream"));
        assert_eq!(cache.resident_bytes(), 0);
        assert_eq!(cache.allocation_count(), 0);
        assert!(!cache.evict("stream"));
    }

    #[test]
    fn uncommitted_preparation_never_changes_residency() {
        let cache = SharedAssetBlobCache::new();
        let _prepared = cache
            .prepare_packed(
                vec![entry("tile.i3dm", 3)],
                vec![1, 2, 3],
                AssetBundleLimits::default(),
            )
            .expect("prepared bundle");
        assert_eq!(cache.resident_bytes(), 0);
        assert_eq!(cache.allocation_count(), 0);
    }

    #[test]
    fn replacing_cached_content_with_non_asset_provider_releases_last_owner() {
        let mut cache = SharedAssetBlobCache::new();
        let bundle = cache
            .prepare_packed(
                vec![entry("tile.i3dm", 3)],
                vec![1, 2, 3],
                AssetBundleLimits::default(),
            )
            .expect("asset bundle");
        cache.commit("provider-slot".to_owned(), &bundle);
        assert_eq!(cache.resident_bytes(), 3);

        assert!(cache.evict("provider-slot"));
        assert_eq!(cache.resident_bytes(), 0);
        assert_eq!(cache.allocation_count(), 0);
    }

    #[test]
    fn one_shared_image_is_deduplicated_across_different_model_bundles() {
        let mut cache = SharedAssetBlobCache::new();
        let make_entries = |owner: &str| {
            vec![
                ResolvedAssetEntry {
                    owner_uri: owner.to_owned(),
                    source_uri: "model.bin".to_owned(),
                    resolved_uri: format!("https://assets.test/{owner}.bin"),
                    kind: ResolvedAssetKind::Buffer,
                    byte_offset: 0,
                    byte_length: 2,
                },
                ResolvedAssetEntry {
                    owner_uri: owner.to_owned(),
                    source_uri: "shared.png".to_owned(),
                    resolved_uri: "https://assets.test/shared.png".to_owned(),
                    kind: ResolvedAssetKind::Image,
                    byte_offset: 2,
                    byte_length: 3,
                },
            ]
        };
        let first = cache
            .prepare_packed(
                make_entries("first"),
                vec![1, 1, 7, 8, 9],
                AssetBundleLimits::default(),
            )
            .expect("first mixed bundle");
        cache.commit("stream-a".to_owned(), &first);
        let second = cache
            .prepare_packed(
                make_entries("second"),
                vec![2, 2, 7, 8, 9],
                AssetBundleLimits::default(),
            )
            .expect("second mixed bundle");
        cache.commit("stream-b".to_owned(), &second);

        assert_eq!(cache.allocation_count(), 3);
        assert_eq!(cache.resident_bytes(), 7);
        let shared_image = AssetContentIdentity::for_bytes(&[7, 8, 9]);
        assert_eq!(cache.ref_count(shared_image), 2);
    }
}
