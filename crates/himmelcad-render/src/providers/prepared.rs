//! Validated provider-neutral prepared hierarchy manifest.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{BoundingVolume, DatasetId, HierarchySource, TileDescriptor, TileId, WorldTransform};

/// Prepared hierarchy parse or topology failure.
#[derive(Debug, Error)]
pub enum PreparedHierarchyError {
    /// Manifest JSON is malformed.
    #[error("invalid prepared hierarchy JSON: {0}")]
    Json(#[from] serde_json::Error),
    /// A manifest field violates the permanent hierarchy contract.
    #[error("invalid prepared hierarchy field: {0}")]
    InvalidField(&'static str),
}

/// Provider-neutral serialized root for one prepared tile hierarchy.
///
/// Producers use this exact type as well as consumers, preventing manifest
/// writers in importers and native preparation workers from drifting away
/// from the render-core validation contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedHierarchyManifest {
    /// Exact prepared-hierarchy schema version.
    pub schema_version: u32,
    /// Complete set of roots visible without loading another hierarchy page.
    pub roots: Vec<TileId>,
    /// Complete descriptors embedded in this root manifest.
    pub tiles: Vec<TileDescriptor>,
}

impl PreparedHierarchyManifest {
    /// Serializes only after the consumer parser accepts the exact result.
    pub fn to_validated_json(&self) -> Result<Vec<u8>, PreparedHierarchyError> {
        let bytes = serde_json::to_vec(self)?;
        PreparedHierarchySource::from_json(
            DatasetId("prepared-manifest-validation".to_owned()),
            "hcad://prepared/manifest.json",
            &bytes,
        )?;
        Ok(bytes)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HierarchyPage {
    schema_version: u32,
    owner: TileId,
    roots: Vec<TileId>,
    tiles: Vec<TileDescriptor>,
}

/// Fully validated explicit hierarchy for prepared raster, splat or extension content.
#[derive(Clone, Debug)]
pub struct PreparedHierarchySource {
    dataset_id: DatasetId,
    roots: Vec<TileId>,
    tiles: BTreeMap<TileId, TileDescriptor>,
    generation: u64,
}

impl PreparedHierarchySource {
    /// Parses, resolves and validates one `himmelcad-prepared-hierarchy@1` manifest.
    pub fn from_json(
        dataset_id: DatasetId,
        manifest_uri: &str,
        json: &[u8],
    ) -> Result<Self, PreparedHierarchyError> {
        let mut manifest: PreparedHierarchyManifest = serde_json::from_slice(json)?;
        if manifest.schema_version != 1 {
            return Err(PreparedHierarchyError::InvalidField("schemaVersion"));
        }
        if manifest.roots.is_empty() || manifest.tiles.is_empty() {
            return Err(PreparedHierarchyError::InvalidField("roots/tiles"));
        }
        let base = base_uri(manifest_uri);
        let mut tiles = BTreeMap::new();
        for mut tile in manifest.tiles.drain(..) {
            validate_tile(&tile)?;
            resolve_tile_uris(&mut tile, base);
            if tiles.insert(tile.id.clone(), tile).is_some() {
                return Err(PreparedHierarchyError::InvalidField("duplicate tile id"));
            }
        }
        let root_count = manifest.roots.len();
        let roots = manifest.roots.into_iter().collect::<BTreeSet<_>>();
        if roots.len() != root_count {
            return Err(PreparedHierarchyError::InvalidField("duplicate root"));
        }
        for root in &roots {
            let tile = tiles
                .get(root)
                .ok_or(PreparedHierarchyError::InvalidField("unknown root"))?;
            if tile.parent.is_some() {
                return Err(PreparedHierarchyError::InvalidField("root parent"));
            }
        }
        validate_topology(&tiles, &roots)?;
        Ok(Self {
            dataset_id,
            roots: roots.into_iter().collect(),
            tiles,
            generation: 0,
        })
    }

    /// Monotonic hierarchy generation. Failed or stale page merges do not change it.
    #[must_use]
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Attaches one previously requested hierarchy page atomically.
    ///
    /// The owner and exact resolved URI must still match the owner's pending
    /// `child_page`. This rejects duplicate and stale completions before they can
    /// replace resident descriptors. Page-local and complete merged topology are
    /// validated on a clone; `self` changes only after every check succeeds.
    pub fn apply_hierarchy_page(
        &mut self,
        owner: &TileId,
        page_uri: &str,
        json: &[u8],
    ) -> Result<u64, PreparedHierarchyError> {
        let owner_tile = self
            .tiles
            .get(owner)
            .ok_or(PreparedHierarchyError::InvalidField("hierarchy page owner"))?;
        let pending =
            owner_tile
                .child_page
                .as_ref()
                .ok_or(PreparedHierarchyError::InvalidField(
                    "hierarchy page is not pending",
                ))?;
        if pending.uri != page_uri {
            return Err(PreparedHierarchyError::InvalidField("hierarchy page URI"));
        }

        let mut page: HierarchyPage = serde_json::from_slice(json)?;
        if page.schema_version != 1 {
            return Err(PreparedHierarchyError::InvalidField(
                "hierarchy page schemaVersion",
            ));
        }
        if page.owner != *owner || page.roots.is_empty() || page.tiles.is_empty() {
            return Err(PreparedHierarchyError::InvalidField(
                "hierarchy page owner/roots/tiles",
            ));
        }

        let base = base_uri(page_uri);
        let mut page_tiles = BTreeMap::new();
        for mut tile in page.tiles.drain(..) {
            validate_tile(&tile)?;
            resolve_tile_uris(&mut tile, base);
            if self.tiles.contains_key(&tile.id)
                || page_tiles.insert(tile.id.clone(), tile).is_some()
            {
                return Err(PreparedHierarchyError::InvalidField(
                    "hierarchy page duplicate tile id",
                ));
            }
        }
        let root_count = page.roots.len();
        let page_roots = page.roots.into_iter().collect::<BTreeSet<_>>();
        if page_roots.len() != root_count {
            return Err(PreparedHierarchyError::InvalidField(
                "hierarchy page duplicate root",
            ));
        }
        validate_page_topology(&page_tiles, &page_roots, owner)?;
        if owner_tile
            .children
            .iter()
            .any(|child| !self.tiles.contains_key(child) && !page_roots.contains(child))
        {
            return Err(PreparedHierarchyError::InvalidField(
                "hierarchy page missing known child",
            ));
        }
        let next_generation = self
            .generation
            .checked_add(1)
            .ok_or(PreparedHierarchyError::InvalidField("hierarchy generation"))?;

        // Every fallible operation ends above. Publishing the already validated
        // page is therefore atomic without cloning the complete resident tree.
        let next_owner = self
            .tiles
            .get_mut(owner)
            .expect("validated hierarchy retains page owner");
        for root in &page_roots {
            if !next_owner.children.contains(root) {
                next_owner.children.push(root.clone());
            }
        }
        next_owner.child_page = None;
        self.tiles.extend(page_tiles);
        self.generation = next_generation;
        Ok(next_generation)
    }
}

impl HierarchySource for PreparedHierarchySource {
    type Error = PreparedHierarchyError;

    fn dataset_id(&self) -> &DatasetId {
        &self.dataset_id
    }

    fn roots(&self) -> &[TileId] {
        &self.roots
    }

    fn tile(&mut self, id: &TileId) -> Result<Option<TileDescriptor>, Self::Error> {
        Ok(self.tiles.get(id).cloned())
    }
}

fn validate_tile(tile: &TileDescriptor) -> Result<(), PreparedHierarchyError> {
    if tile.id.0.is_empty()
        || !tile.geometric_error.is_finite()
        || tile.geometric_error < 0.0
        || !valid_transform(tile.content_transform)
        || !valid_bounds(&tile.bounds)
    {
        return Err(PreparedHierarchyError::InvalidField("tile"));
    }
    let children = tile.children.iter().collect::<BTreeSet<_>>();
    if children.len() != tile.children.len() || children.contains(&tile.id) {
        return Err(PreparedHierarchyError::InvalidField("children"));
    }
    for content in &tile.contents {
        if content.uri.is_empty()
            || content.byte_offset.is_some() != content.byte_length.is_some()
            || content.byte_length == Some(0)
            || content.primitive_count == Some(0)
        {
            return Err(PreparedHierarchyError::InvalidField("content"));
        }
    }
    if let Some(page) = &tile.child_page {
        if page.uri.is_empty()
            || page.byte_offset.is_some() != page.byte_length.is_some()
            || page.byte_length == Some(0)
            || page
                .content_hash
                .as_ref()
                .is_some_and(|hash| !is_canonical_sha256(hash))
        {
            return Err(PreparedHierarchyError::InvalidField("childPage"));
        }
    }
    Ok(())
}

fn is_canonical_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn resolve_tile_uris(tile: &mut TileDescriptor, base: &str) {
    for content in &mut tile.contents {
        content.uri = resolve_uri(base, &content.uri);
    }
    if let Some(page) = &mut tile.child_page {
        page.uri = resolve_uri(base, &page.uri);
    }
}

fn validate_topology(
    tiles: &BTreeMap<TileId, TileDescriptor>,
    roots: &BTreeSet<TileId>,
) -> Result<(), PreparedHierarchyError> {
    for tile in tiles.values() {
        for child in &tile.children {
            if let Some(child_tile) = tiles.get(child) {
                if child_tile.parent.as_ref() != Some(&tile.id) {
                    return Err(PreparedHierarchyError::InvalidField("child parent"));
                }
            } else if tile.child_page.is_none() {
                return Err(PreparedHierarchyError::InvalidField("unknown child"));
            }
        }
        if let Some(parent) = &tile.parent {
            let parent_tile = tiles
                .get(parent)
                .ok_or(PreparedHierarchyError::InvalidField("unknown parent"))?;
            if !parent_tile.children.contains(&tile.id) {
                return Err(PreparedHierarchyError::InvalidField("parent children"));
            }
        } else if !roots.contains(&tile.id) {
            return Err(PreparedHierarchyError::InvalidField("unlisted root"));
        }
    }
    let mut visited = BTreeSet::new();
    let mut pending = roots.iter().cloned().collect::<Vec<_>>();
    while let Some(id) = pending.pop() {
        if !visited.insert(id.clone()) {
            return Err(PreparedHierarchyError::InvalidField("cycle/shared child"));
        }
        pending.extend(
            tiles
                .get(&id)
                .expect("root and child existence validated")
                .children
                .iter()
                .filter(|child| tiles.contains_key(*child))
                .cloned(),
        );
    }
    if visited.len() != tiles.len() {
        return Err(PreparedHierarchyError::InvalidField("unreachable tile"));
    }
    Ok(())
}

fn validate_page_topology(
    tiles: &BTreeMap<TileId, TileDescriptor>,
    roots: &BTreeSet<TileId>,
    owner: &TileId,
) -> Result<(), PreparedHierarchyError> {
    for root in roots {
        let tile = tiles.get(root).ok_or(PreparedHierarchyError::InvalidField(
            "hierarchy page unknown root",
        ))?;
        if tile.parent.as_ref() != Some(owner) {
            return Err(PreparedHierarchyError::InvalidField(
                "hierarchy page root parent",
            ));
        }
    }
    for tile in tiles.values() {
        if roots.contains(&tile.id) {
            if tile.parent.as_ref() != Some(owner) {
                return Err(PreparedHierarchyError::InvalidField(
                    "hierarchy page root parent",
                ));
            }
        } else {
            let parent = tile
                .parent
                .as_ref()
                .and_then(|parent| tiles.get(parent))
                .ok_or(PreparedHierarchyError::InvalidField(
                    "hierarchy page parent",
                ))?;
            if !parent.children.contains(&tile.id) {
                return Err(PreparedHierarchyError::InvalidField(
                    "hierarchy page parent children",
                ));
            }
        }
        for child in &tile.children {
            if let Some(child_tile) = tiles.get(child) {
                if child_tile.parent.as_ref() != Some(&tile.id) {
                    return Err(PreparedHierarchyError::InvalidField(
                        "hierarchy page child parent",
                    ));
                }
            } else if tile.child_page.is_none() {
                return Err(PreparedHierarchyError::InvalidField(
                    "hierarchy page unknown child",
                ));
            }
        }
    }

    let mut visited = BTreeSet::new();
    let mut pending = roots.iter().cloned().collect::<Vec<_>>();
    while let Some(id) = pending.pop() {
        if !visited.insert(id.clone()) {
            return Err(PreparedHierarchyError::InvalidField(
                "hierarchy page cycle/shared child",
            ));
        }
        pending.extend(
            tiles
                .get(&id)
                .expect("page root and child existence validated")
                .children
                .iter()
                .filter(|child| tiles.contains_key(*child))
                .cloned(),
        );
    }
    if visited.len() != tiles.len() {
        return Err(PreparedHierarchyError::InvalidField(
            "hierarchy page unreachable tile",
        ));
    }
    Ok(())
}

fn valid_transform(transform: WorldTransform) -> bool {
    let values = transform.0;
    values.iter().all(|value| value.is_finite())
        && values[3].abs() <= f64::EPSILON
        && values[7].abs() <= f64::EPSILON
        && values[11].abs() <= f64::EPSILON
        && (values[15] - 1.0).abs() <= f64::EPSILON
}

fn valid_bounds(bounds: &BoundingVolume) -> bool {
    match bounds {
        BoundingVolume::AxisAlignedBox { bounds } => {
            let min = bounds.min;
            let max = bounds.max;
            [min.x, min.y, min.z, max.x, max.y, max.z]
                .iter()
                .all(|value| value.is_finite())
                && min.x <= max.x
                && min.y <= max.y
                && min.z <= max.z
        }
        BoundingVolume::OrientedBox { center, half_axes } => [center.x, center.y, center.z]
            .into_iter()
            .chain(half_axes.iter().flat_map(|axis| [axis.x, axis.y, axis.z]))
            .all(f64::is_finite),
        BoundingVolume::Sphere { center, radius } => {
            [center.x, center.y, center.z, *radius]
                .iter()
                .all(|value| value.is_finite())
                && *radius >= 0.0
        }
        BoundingVolume::GeodeticRegion {
            west,
            south,
            east,
            north,
            minimum_height,
            maximum_height,
        } => {
            [
                *west,
                *south,
                *east,
                *north,
                *minimum_height,
                *maximum_height,
            ]
            .iter()
            .all(|value| value.is_finite())
                && west <= east
                && south <= north
                && minimum_height <= maximum_height
        }
    }
}

fn base_uri(uri: &str) -> &str {
    uri.rsplit_once('/')
        .map_or("", |(base, _)| &uri[..=base.len()])
}

fn resolve_uri(base: &str, uri: &str) -> String {
    if uri.contains("://") || uri.starts_with('/') {
        uri.to_owned()
    } else {
        format!("{base}{uri}")
    }
}

#[cfg(test)]
mod tests {
    use super::{PreparedHierarchyError, PreparedHierarchySource};
    use crate::{ContentKind, DatasetId, HierarchySource, TileId};

    #[test]
    fn validates_and_resolves_mixed_prepared_content() {
        let json = br#"{
          "schemaVersion":1,
          "roots":["r"],
          "tiles":[{
            "id":"r","parent":null,"children":["r0"],
            "bounds":{"kind":"sphere","center":{"x":0,"y":0,"z":0},"radius":10},
            "contentTransform":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
            "geometricError":4,"refinement":"add","contents":[],"childPage":null
          },{
            "id":"r0","parent":"r","children":[],
            "bounds":{"kind":"sphere","center":{"x":0,"y":0,"z":0},"radius":5},
            "contentTransform":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
            "geometricError":0,"refinement":"add",
            "contents":[{"kind":"gaussianSplats","uri":"tiles/r0.ply","byteOffset":null,"byteLength":null,"primitiveCount":42,"contentHash":null}],
            "childPage":null
          }]
        }"#;
        let mut source = PreparedHierarchySource::from_json(
            DatasetId("splats".to_owned()),
            "https://example.test/model/manifest.json",
            json,
        )
        .expect("valid hierarchy");
        let child = source
            .tile(&TileId("r0".to_owned()))
            .expect("lookup")
            .expect("child");
        assert_eq!(child.contents[0].kind, ContentKind::GaussianSplats);
        assert_eq!(
            child.contents[0].uri,
            "https://example.test/model/tiles/r0.ply"
        );
    }

    #[test]
    fn rejects_unreachable_or_shared_tiles() {
        let json = br#"{
          "schemaVersion":1,"roots":["r"],"tiles":[{
            "id":"r","parent":null,"children":[],
            "bounds":{"kind":"sphere","center":{"x":0,"y":0,"z":0},"radius":1},
            "contentTransform":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
            "geometricError":0,"refinement":"replace","contents":[],"childPage":null
          },{
            "id":"lost","parent":null,"children":[],
            "bounds":{"kind":"sphere","center":{"x":0,"y":0,"z":0},"radius":1},
            "contentTransform":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
            "geometricError":0,"refinement":"replace","contents":[],"childPage":null
          }]
        }"#;
        assert!(PreparedHierarchySource::from_json(
            DatasetId("bad".to_owned()),
            "manifest.json",
            json,
        )
        .is_err());
    }

    #[test]
    fn applies_nested_pages_atomically_and_resolves_page_relative_uris() {
        let mut source = paged_source();
        let root = TileId("r".to_owned());
        assert_eq!(source.generation(), 0);

        let malformed = br#"{
          "schemaVersion":1,"owner":"r","roots":["r0"],"tiles":[]
        }"#;
        assert!(source
            .apply_hierarchy_page(
                &root,
                "https://example.test/model/pages/level-1.json",
                malformed,
            )
            .is_err());
        assert_eq!(source.generation(), 0);
        assert!(source
            .tile(&root)
            .expect("lookup")
            .expect("root")
            .child_page
            .is_some());
        assert!(source
            .tile(&TileId("r0".to_owned()))
            .expect("lookup")
            .is_none());

        let first_page = br#"{
          "schemaVersion":1,"owner":"r","roots":["r0"],"tiles":[{
            "id":"r0","parent":"r","children":["r00"],
            "bounds":{"kind":"sphere","center":{"x":0,"y":0,"z":0},"radius":5},
            "contentTransform":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
            "geometricError":2,"refinement":"replace",
            "contents":[{"kind":"gaussianSplats","uri":"tiles/r0.ply","byteOffset":null,"byteLength":null,"primitiveCount":32,"contentHash":null}],
            "childPage":{"uri":"nested/level-2.json","byteOffset":null,"byteLength":null}
          }]
        }"#;
        assert_eq!(
            source
                .apply_hierarchy_page(
                    &root,
                    "https://example.test/model/pages/level-1.json",
                    first_page,
                )
                .expect("first page"),
            1
        );
        let first = source
            .tile(&TileId("r0".to_owned()))
            .expect("lookup")
            .expect("first page root");
        assert_eq!(
            first.contents[0].uri,
            "https://example.test/model/pages/tiles/r0.ply"
        );
        assert_eq!(
            first.child_page.expect("nested page").uri,
            "https://example.test/model/pages/nested/level-2.json"
        );

        let second_page = br#"{
          "schemaVersion":1,"owner":"r0","roots":["r00"],"tiles":[{
            "id":"r00","parent":"r0","children":[],
            "bounds":{"kind":"sphere","center":{"x":0,"y":0,"z":0},"radius":2},
            "contentTransform":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
            "geometricError":0,"refinement":"replace",
            "contents":[{"kind":"raster","uri":"r00.png","byteOffset":null,"byteLength":null,"primitiveCount":16,"contentHash":null}],
            "childPage":null
          }]
        }"#;
        assert_eq!(
            source
                .apply_hierarchy_page(
                    &TileId("r0".to_owned()),
                    "https://example.test/model/pages/nested/level-2.json",
                    second_page,
                )
                .expect("second page"),
            2
        );
        let leaf = source
            .tile(&TileId("r00".to_owned()))
            .expect("lookup")
            .expect("nested leaf");
        assert_eq!(
            leaf.contents[0].uri,
            "https://example.test/model/pages/nested/r00.png"
        );
    }

    #[test]
    fn rejects_stale_wrong_owner_and_colliding_pages_without_mutation() {
        let mut source = paged_source();
        let root = TileId("r".to_owned());
        let valid_page = br#"{
          "schemaVersion":1,"owner":"r","roots":["r0"],"tiles":[{
            "id":"r0","parent":"r","children":[],
            "bounds":{"kind":"sphere","center":{"x":0,"y":0,"z":0},"radius":5},
            "contentTransform":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
            "geometricError":0,"refinement":"replace","contents":[],"childPage":null
          }]
        }"#;

        assert!(source
            .apply_hierarchy_page(
                &root,
                "https://example.test/model/pages/stale.json",
                valid_page,
            )
            .is_err());
        let wrong_owner = valid_page.to_vec();
        let wrong_owner = String::from_utf8(wrong_owner)
            .expect("utf8")
            .replace("\"owner\":\"r\"", "\"owner\":\"other\"");
        assert!(source
            .apply_hierarchy_page(
                &root,
                "https://example.test/model/pages/level-1.json",
                wrong_owner.as_bytes(),
            )
            .is_err());
        let collision = br#"{
          "schemaVersion":1,"owner":"r","roots":["r"],"tiles":[{
            "id":"r","parent":"r","children":[],
            "bounds":{"kind":"sphere","center":{"x":0,"y":0,"z":0},"radius":1},
            "contentTransform":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
            "geometricError":0,"refinement":"replace","contents":[],"childPage":null
          }]
        }"#;
        assert!(source
            .apply_hierarchy_page(
                &root,
                "https://example.test/model/pages/level-1.json",
                collision,
            )
            .is_err());
        let missing_known_child = br#"{
          "schemaVersion":1,"owner":"r","roots":["r1"],"tiles":[{
            "id":"r1","parent":"r","children":[],
            "bounds":{"kind":"sphere","center":{"x":0,"y":0,"z":0},"radius":1},
            "contentTransform":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
            "geometricError":0,"refinement":"replace","contents":[],"childPage":null
          }]
        }"#;
        assert!(source
            .apply_hierarchy_page(
                &root,
                "https://example.test/model/pages/level-1.json",
                missing_known_child,
            )
            .is_err());
        assert_eq!(source.generation(), 0);

        source
            .apply_hierarchy_page(
                &root,
                "https://example.test/model/pages/level-1.json",
                valid_page,
            )
            .expect("valid page");
        assert_eq!(source.generation(), 1);
        assert!(source
            .apply_hierarchy_page(
                &root,
                "https://example.test/model/pages/level-1.json",
                valid_page,
            )
            .is_err());
        assert_eq!(source.generation(), 1);
    }

    #[test]
    fn rejects_noncanonical_lazy_page_hash() {
        let manifest = br#"{
          "schemaVersion":1,"roots":["r"],"tiles":[{
            "id":"r","parent":null,"children":["r0"],
            "bounds":{"kind":"sphere","center":{"x":0,"y":0,"z":0},"radius":5},
            "contentTransform":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
            "geometricError":1,"refinement":"replace","contents":[],
            "childPage":{"uri":"pages/level-1.json","byteOffset":null,"byteLength":null,"contentHash":"ABC"}
          }]
        }"#;
        assert!(matches!(
            PreparedHierarchySource::from_json(
                DatasetId("prepared".to_owned()),
                "https://example.test/model/manifest.json",
                manifest,
            ),
            Err(PreparedHierarchyError::InvalidField("childPage"))
        ));
    }

    fn paged_source() -> PreparedHierarchySource {
        let manifest = br#"{
          "schemaVersion":1,"roots":["r"],"tiles":[{
            "id":"r","parent":null,"children":["r0"],
            "bounds":{"kind":"sphere","center":{"x":0,"y":0,"z":0},"radius":10},
            "contentTransform":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
            "geometricError":4,"refinement":"replace","contents":[],
            "childPage":{"uri":"pages/level-1.json","byteOffset":null,"byteLength":null}
          }]
        }"#;
        PreparedHierarchySource::from_json(
            DatasetId("paged".to_owned()),
            "https://example.test/model/manifest.json",
            manifest,
        )
        .expect("paged hierarchy")
    }
}
