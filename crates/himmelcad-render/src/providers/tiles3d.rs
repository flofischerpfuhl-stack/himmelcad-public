//! 3D Tiles 1.1 tileset hierarchy provider.

use std::collections::BTreeMap;

use glam::{DAffine3, DMat4, DVec3};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    BoundingVolume, ContentKind, ContentReference, DatasetId, HierarchyPageReference,
    HierarchySource, RefinementMode, TileDescriptor, TileId, WorldTransform, WorldVec3,
};

/// 3D Tiles JSON or hierarchy validation failure.
#[derive(Debug, Error)]
pub enum ThreeDTilesHierarchyError {
    /// Tileset JSON is malformed.
    #[error("invalid 3D Tiles JSON: {0}")]
    Json(#[from] serde_json::Error),
    /// A tile contains an invalid transform, bounding volume or error.
    #[error("invalid 3D Tiles field: {0}")]
    InvalidField(&'static str),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tileset {
    asset: Asset,
    root: JsonTile,
    #[serde(default)]
    schema: Option<serde_json::Value>,
    #[serde(default)]
    schema_uri: Option<String>,
    #[serde(default)]
    metadata: Option<serde_json::Value>,
    #[serde(default)]
    groups: Vec<serde_json::Value>,
    #[serde(default)]
    statistics: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct Asset {
    version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonTile {
    bounding_volume: JsonBoundingVolume,
    geometric_error: f64,
    #[serde(default)]
    refine: Option<JsonRefine>,
    #[serde(default)]
    transform: Option<[f64; 16]>,
    #[serde(default)]
    content: Option<JsonContent>,
    #[serde(default)]
    contents: Vec<JsonContent>,
    #[serde(default)]
    children: Vec<JsonTile>,
    #[serde(default)]
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
enum JsonRefine {
    Add,
    Replace,
}

#[derive(Debug, Deserialize)]
struct JsonBoundingVolume {
    #[serde(default, rename = "box")]
    oriented_box: Option<[f64; 12]>,
    #[serde(default)]
    sphere: Option<[f64; 4]>,
    #[serde(default)]
    region: Option<[f64; 6]>,
}

#[derive(Debug, Deserialize)]
struct JsonContent {
    #[serde(default)]
    uri: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    group: Option<u32>,
    #[serde(default)]
    metadata: Option<serde_json::Value>,
}

/// Tileset-wide 3D Metadata retained independently from hierarchy traversal.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreeDTilesMetadataCatalog {
    /// Embedded metadata schema, when the tileset does not use `schemaUri`.
    pub schema: Option<serde_json::Value>,
    /// Fully resolved external schema URI.
    pub schema_uri: Option<String>,
    /// Metadata entity assigned to the tileset itself.
    pub tileset: Option<serde_json::Value>,
    /// Group metadata entities addressed by `content.group`.
    pub groups: Vec<serde_json::Value>,
    /// Optional class-level aggregate statistics.
    pub statistics: Option<serde_json::Value>,
}

/// Fully parsed explicit 3D Tiles hierarchy.
#[derive(Clone, Debug)]
pub struct ThreeDTilesHierarchySource {
    dataset_id: DatasetId,
    roots: Vec<TileId>,
    tiles: BTreeMap<TileId, TileDescriptor>,
    metadata: ThreeDTilesMetadataCatalog,
}

impl ThreeDTilesHierarchySource {
    /// Parses one explicit tileset. External tilesets remain lazy child pages.
    pub fn from_json(
        dataset_id: DatasetId,
        tileset_uri: &str,
        json: &[u8],
    ) -> Result<Self, ThreeDTilesHierarchyError> {
        let tileset: Tileset = serde_json::from_slice(json)?;
        validate_asset_version(&tileset.asset.version)?;
        let base = base_uri(tileset_uri);
        let metadata = metadata_catalog(
            tileset.schema,
            tileset.schema_uri,
            tileset.metadata,
            tileset.groups,
            tileset.statistics,
            base,
        )?;
        let groups = metadata.groups.clone();
        let mut source = Self {
            dataset_id,
            roots: vec![TileId("r".to_owned())],
            tiles: BTreeMap::new(),
            metadata,
        };
        source.add_tile(
            &TileId("r".to_owned()),
            None,
            tileset.root,
            DMat4::IDENTITY,
            RefinementMode::Replace,
            TileParseContext {
                base,
                groups: &groups,
            },
        )?;
        Ok(source)
    }

    /// Returns the tileset-wide schema, metadata, groups and statistics without
    /// coupling the global scheduler to their application semantics.
    #[must_use]
    pub fn metadata(&self) -> &ThreeDTilesMetadataCatalog {
        &self.metadata
    }

    /// Attaches a previously requested external tileset below its owning tile.
    ///
    /// Parsing and hierarchy construction are transactional: malformed pages do
    /// not clear the lazy page reference or leave a partially inserted subtree.
    pub fn apply_external_tileset(
        &mut self,
        owner: &TileId,
        tileset_uri: &str,
        json: &[u8],
    ) -> Result<(), ThreeDTilesHierarchyError> {
        let owner_tile = self
            .tiles
            .get(owner)
            .ok_or(ThreeDTilesHierarchyError::InvalidField(
                "external tileset owner",
            ))?;
        let expected_uri = owner_tile
            .child_page
            .as_ref()
            .ok_or(ThreeDTilesHierarchyError::InvalidField(
                "external tileset page",
            ))?
            .uri
            .as_str();
        if expected_uri != tileset_uri {
            return Err(ThreeDTilesHierarchyError::InvalidField(
                "external tileset URI",
            ));
        }

        let tileset: Tileset = serde_json::from_slice(json)?;
        validate_asset_version(&tileset.asset.version)?;
        let base = base_uri(tileset_uri);
        let external_metadata = metadata_catalog(
            tileset.schema,
            tileset.schema_uri,
            tileset.metadata,
            tileset.groups,
            tileset.statistics,
            base,
        )?;
        let external_root = TileId(format!("{}/external", owner.0));
        if self.tiles.contains_key(&external_root) {
            return Err(ThreeDTilesHierarchyError::InvalidField(
                "external tileset already applied",
            ));
        }

        let parent_transform = DMat4::from_cols_array(&owner_tile.content_transform.0);
        let inherited_refinement = owner_tile.refinement;
        let mut next = self.clone();
        next.add_tile(
            &external_root,
            Some(owner.clone()),
            tileset.root,
            parent_transform,
            inherited_refinement,
            TileParseContext {
                base,
                groups: &external_metadata.groups,
            },
        )?;
        let next_owner = next
            .tiles
            .get_mut(owner)
            .expect("cloned hierarchy retains external page owner");
        next_owner.children.push(external_root);
        next_owner.child_page = None;
        *self = next;
        Ok(())
    }

    fn add_tile(
        &mut self,
        id: &TileId,
        parent: Option<TileId>,
        tile: JsonTile,
        parent_transform: DMat4,
        inherited_refinement: RefinementMode,
        context: TileParseContext<'_>,
    ) -> Result<(), ThreeDTilesHierarchyError> {
        if !tile.geometric_error.is_finite() || tile.geometric_error < 0.0 {
            return Err(ThreeDTilesHierarchyError::InvalidField("geometricError"));
        }
        if tile.content.is_some() && !tile.contents.is_empty() {
            return Err(ThreeDTilesHierarchyError::InvalidField(
                "content and contents are mutually exclusive",
            ));
        }
        let local_transform = tile.transform.map_or(Ok(DMat4::IDENTITY), |values| {
            if values.iter().any(|value| !value.is_finite()) {
                Err(ThreeDTilesHierarchyError::InvalidField("transform"))
            } else {
                Ok(DMat4::from_cols_array(&values))
            }
        })?;
        let transform = parent_transform * local_transform;
        let refinement = match tile.refine {
            Some(JsonRefine::Add) => RefinementMode::Add,
            Some(JsonRefine::Replace) => RefinementMode::Replace,
            None => inherited_refinement,
        };
        let bounds = transform_bounds(&tile.bounding_volume, transform)?;
        let provider_metadata = tile.metadata;
        let mut json_contents = tile.contents;
        if let Some(content) = tile.content {
            json_contents.insert(0, content);
        }
        let mut contents = Vec::new();
        let mut child_page = None;
        for content in json_contents {
            let decoder_parameters =
                content_metadata(content.metadata.as_ref(), content.group, context.groups)?;
            let uri = content
                .uri
                .or(content.url)
                .ok_or(ThreeDTilesHierarchyError::InvalidField("content.uri"))?;
            let resolved = resolve_uri(context.base, &uri);
            if is_external_tileset(&uri) {
                child_page = Some(HierarchyPageReference {
                    uri: resolved,
                    byte_offset: None,
                    byte_length: None,
                    content_hash: None,
                    decoder_parameters,
                });
            } else {
                contents.push(ContentReference {
                    kind: content_kind(&uri),
                    uri: resolved,
                    byte_offset: None,
                    byte_length: None,
                    primitive_count: None,
                    content_hash: None,
                    decoder_parameters,
                });
            }
        }
        let scale = maximum_scale(transform);
        let geometric_error = tile.geometric_error * scale;
        let children: Vec<TileId> = (0..tile.children.len())
            .map(|index| TileId(format!("{}/{index}", id.0)))
            .collect();
        let child_tiles = tile.children;
        self.tiles.insert(
            id.clone(),
            TileDescriptor {
                id: id.clone(),
                parent,
                children: children.clone(),
                bounds,
                content_transform: WorldTransform(transform.to_cols_array()),
                geometric_error,
                refinement,
                contents,
                child_page,
                provider_metadata,
            },
        );
        for (child_id, child) in children.into_iter().zip(child_tiles) {
            self.add_tile(
                &child_id,
                Some(id.clone()),
                child,
                transform,
                refinement,
                context,
            )?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
struct TileParseContext<'a> {
    base: &'a str,
    groups: &'a [serde_json::Value],
}

impl HierarchySource for ThreeDTilesHierarchySource {
    type Error = ThreeDTilesHierarchyError;

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

fn validate_asset_version(version: &str) -> Result<(), ThreeDTilesHierarchyError> {
    if version == "1.0" || version == "1.1" {
        Ok(())
    } else {
        Err(ThreeDTilesHierarchyError::InvalidField("asset.version"))
    }
}

fn metadata_catalog(
    schema: Option<serde_json::Value>,
    schema_uri: Option<String>,
    tileset: Option<serde_json::Value>,
    groups: Vec<serde_json::Value>,
    statistics: Option<serde_json::Value>,
    base: &str,
) -> Result<ThreeDTilesMetadataCatalog, ThreeDTilesHierarchyError> {
    if schema.is_some() && schema_uri.is_some() {
        return Err(ThreeDTilesHierarchyError::InvalidField(
            "schema and schemaUri are mutually exclusive",
        ));
    }
    if schema.as_ref().is_some_and(|value| !value.is_object()) {
        return Err(ThreeDTilesHierarchyError::InvalidField("schema"));
    }
    if tileset.as_ref().is_some_and(|value| !value.is_object()) {
        return Err(ThreeDTilesHierarchyError::InvalidField("metadata"));
    }
    if groups.iter().any(|value| !value.is_object()) {
        return Err(ThreeDTilesHierarchyError::InvalidField("groups"));
    }
    if statistics.as_ref().is_some_and(|value| !value.is_object()) {
        return Err(ThreeDTilesHierarchyError::InvalidField("statistics"));
    }
    let schema_uri = schema_uri
        .map(|uri| {
            if uri.trim().is_empty() {
                Err(ThreeDTilesHierarchyError::InvalidField("schemaUri"))
            } else {
                Ok(resolve_uri(base, &uri))
            }
        })
        .transpose()?;
    Ok(ThreeDTilesMetadataCatalog {
        schema,
        schema_uri,
        tileset,
        groups,
        statistics,
    })
}

fn content_metadata(
    metadata: Option<&serde_json::Value>,
    group: Option<u32>,
    groups: &[serde_json::Value],
) -> Result<Option<serde_json::Value>, ThreeDTilesHierarchyError> {
    if metadata.as_ref().is_some_and(|value| !value.is_object()) {
        return Err(ThreeDTilesHierarchyError::InvalidField("content.metadata"));
    }
    let group_metadata = group
        .map(|index| {
            usize::try_from(index)
                .ok()
                .and_then(|index| groups.get(index))
                .cloned()
                .ok_or(ThreeDTilesHierarchyError::InvalidField("content.group"))
        })
        .transpose()?;
    if metadata.is_none() && group.is_none() {
        return Ok(None);
    }
    Ok(Some(serde_json::json!({
        "threeDTiles": {
            "metadata": metadata,
            "group": group,
            "groupMetadata": group_metadata,
        }
    })))
}

fn transform_bounds(
    bounds: &JsonBoundingVolume,
    transform: DMat4,
) -> Result<BoundingVolume, ThreeDTilesHierarchyError> {
    let count = usize::from(bounds.oriented_box.is_some())
        + usize::from(bounds.sphere.is_some())
        + usize::from(bounds.region.is_some());
    if count != 1 {
        return Err(ThreeDTilesHierarchyError::InvalidField("boundingVolume"));
    }
    if let Some(values) = bounds.oriented_box {
        if values.iter().any(|value| !value.is_finite()) {
            return Err(ThreeDTilesHierarchyError::InvalidField(
                "boundingVolume.box",
            ));
        }
        let center = transform.transform_point3(DVec3::new(values[0], values[1], values[2]));
        let axes = [
            transform.transform_vector3(DVec3::new(values[3], values[4], values[5])),
            transform.transform_vector3(DVec3::new(values[6], values[7], values[8])),
            transform.transform_vector3(DVec3::new(values[9], values[10], values[11])),
        ];
        return Ok(BoundingVolume::OrientedBox {
            center: world_vec(center),
            half_axes: axes.map(world_vec),
        });
    }
    if let Some(values) = bounds.sphere {
        if values.iter().any(|value| !value.is_finite()) || values[3] < 0.0 {
            return Err(ThreeDTilesHierarchyError::InvalidField(
                "boundingVolume.sphere",
            ));
        }
        return Ok(BoundingVolume::Sphere {
            center: world_vec(
                transform.transform_point3(DVec3::new(values[0], values[1], values[2])),
            ),
            radius: values[3] * maximum_scale(transform),
        });
    }
    let values = bounds.region.expect("exactly one bounding volume");
    if values.iter().any(|value| !value.is_finite()) {
        return Err(ThreeDTilesHierarchyError::InvalidField(
            "boundingVolume.region",
        ));
    }
    Ok(BoundingVolume::GeodeticRegion {
        west: values[0],
        south: values[1],
        east: values[2],
        north: values[3],
        minimum_height: values[4],
        maximum_height: values[5],
    })
}

fn maximum_scale(transform: DMat4) -> f64 {
    let affine = DAffine3::from_mat4(transform);
    let axes = affine.matrix3;
    axes.x_axis
        .length()
        .max(axes.y_axis.length())
        .max(axes.z_axis.length())
}

fn world_vec(value: DVec3) -> WorldVec3 {
    WorldVec3 {
        x: value.x,
        y: value.y,
        z: value.z,
    }
}

fn content_kind(uri: &str) -> ContentKind {
    if matches!(file_extension(uri), Some(extension) if extension.eq_ignore_ascii_case("glb") || extension.eq_ignore_ascii_case("gltf"))
    {
        ContentKind::Gltf
    } else {
        ContentKind::ThreeDTilesContainer
    }
}

fn is_external_tileset(uri: &str) -> bool {
    matches!(file_extension(uri), Some(extension) if extension.eq_ignore_ascii_case("json"))
}

fn file_extension(uri: &str) -> Option<&str> {
    uri.split(['?', '#'])
        .next()
        .and_then(|path| path.rsplit_once('.'))
        .map(|(_, extension)| extension)
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
    use super::ThreeDTilesHierarchySource;
    use crate::{BoundingVolume, ContentKind, DatasetId, HierarchySource, RefinementMode, TileId};

    #[test]
    fn parses_transforms_refinement_and_mixed_content() {
        let json = br#"{
          "asset":{"version":"1.1"},
          "root":{
            "boundingVolume":{"box":[0,0,0, 1,0,0, 0,2,0, 0,0,3]},
            "geometricError":16,
            "refine":"ADD",
            "transform":[1,0,0,0, 0,1,0,0, 0,0,1,0, 100,200,300,1],
            "content":{"uri":"root.glb"},
            "children":[{
              "boundingVolume":{"sphere":[0,0,0,5]},
              "geometricError":8,
              "content":{"uri":"legacy.b3dm"}
            }]
          }
        }"#;
        let mut source = ThreeDTilesHierarchySource::from_json(
            DatasetId("city".to_owned()),
            "https://example.test/city/tileset.json",
            json,
        )
        .expect("valid tileset");

        let root = source
            .tile(&TileId("r".to_owned()))
            .expect("lookup")
            .expect("root");
        assert_eq!(root.refinement, RefinementMode::Add);
        assert_eq!(root.contents[0].kind, ContentKind::Gltf);
        assert_eq!(root.contents[0].uri, "https://example.test/city/root.glb");
        let BoundingVolume::OrientedBox { center, .. } = root.bounds else {
            panic!("expected box");
        };
        assert_close(center.x, 100.0);
        assert_close(center.y, 200.0);
        assert_close(center.z, 300.0);

        let child = source
            .tile(&TileId("r/0".to_owned()))
            .expect("lookup")
            .expect("child");
        assert_eq!(child.refinement, RefinementMode::Add);
        assert_eq!(child.contents[0].kind, ContentKind::ThreeDTilesContainer);
        let BoundingVolume::Sphere { center, radius } = child.bounds else {
            panic!("expected sphere");
        };
        assert_close(center.x, 100.0);
        assert_close(center.y, 200.0);
        assert_close(center.z, 300.0);
        assert_close(radius, 5.0);
    }

    #[test]
    fn retains_tileset_tile_content_and_group_metadata() {
        let json = br#"{
          "asset":{"version":"1.1"},
          "schemaUri":"metadata/city.schema.json",
          "metadata":{"class":"city","properties":{"surveyEpoch":2025.5}},
          "groups":[{"class":"discipline","properties":{"name":"terrain"}}],
          "statistics":{"classes":{"city":{"count":1}}},
          "root":{
            "boundingVolume":{"sphere":[0,0,0,1]},
            "geometricError":0,
            "metadata":{"class":"tile","properties":{"quality":"surveyed"}},
            "content":{
              "uri":"terrain.glb",
              "group":0,
              "metadata":{"class":"content","properties":{"triangles":42}}
            }
          }
        }"#;
        let mut source = ThreeDTilesHierarchySource::from_json(
            DatasetId("metadata".to_owned()),
            "https://example.test/city/tileset.json",
            json,
        )
        .expect("metadata tileset");
        assert_eq!(
            source.metadata().schema_uri.as_deref(),
            Some("https://example.test/city/metadata/city.schema.json")
        );
        assert_eq!(
            source
                .metadata()
                .tileset
                .as_ref()
                .and_then(|value| value["class"].as_str()),
            Some("city")
        );
        assert_eq!(source.metadata().groups.len(), 1);

        let root = source
            .tile(&TileId("r".to_owned()))
            .expect("lookup")
            .expect("root");
        assert_eq!(
            root.provider_metadata
                .as_ref()
                .and_then(|value| value["properties"]["quality"].as_str()),
            Some("surveyed")
        );
        let parameters = root.contents[0]
            .decoder_parameters
            .as_ref()
            .expect("content metadata");
        assert_eq!(parameters["threeDTiles"]["group"], 0);
        assert_eq!(
            parameters["threeDTiles"]["metadata"]["properties"]["triangles"],
            42
        );
        assert_eq!(
            parameters["threeDTiles"]["groupMetadata"]["properties"]["name"],
            "terrain"
        );
    }

    #[test]
    fn external_tilesets_attach_transactionally_with_composed_transforms() {
        let root_json = br#"{
          "asset":{"version":"1.1"},
          "groups":[{"class":"discipline","properties":{"name":"structures"}}],
          "root":{
            "boundingVolume":{"sphere":[0,0,0,10]},
            "geometricError":32,
            "refine":"ADD",
            "transform":[1,0,0,0, 0,1,0,0, 0,0,1,0, 100,200,300,1],
            "content":{
              "uri":"nested/tileset.json",
              "group":0,
              "metadata":{"class":"externalLink","properties":{"phase":"design"}}
            }
          }
        }"#;
        let external_json = br#"{
          "asset":{"version":"1.0"},
          "root":{
            "boundingVolume":{"sphere":[0,0,0,2]},
            "geometricError":4,
            "transform":[2,0,0,0, 0,2,0,0, 0,0,2,0, 5,6,7,1],
            "content":{"uri":"mesh.glb"}
          }
        }"#;
        let mut source = ThreeDTilesHierarchySource::from_json(
            DatasetId("city".to_owned()),
            "https://example.test/city/tileset.json",
            root_json,
        )
        .expect("root tileset");
        let owner = TileId("r".to_owned());
        let page_parameters = source
            .tile(&owner)
            .expect("lookup")
            .expect("owner")
            .child_page
            .expect("external page")
            .decoder_parameters
            .expect("external page metadata");
        assert_eq!(
            page_parameters["threeDTiles"]["metadata"]["properties"]["phase"],
            "design"
        );
        assert_eq!(
            page_parameters["threeDTiles"]["groupMetadata"]["properties"]["name"],
            "structures"
        );

        let malformed = br#"{"asset":{"version":"1.1"}}"#;
        assert!(source
            .apply_external_tileset(
                &owner,
                "https://example.test/city/nested/tileset.json",
                malformed,
            )
            .is_err());
        assert!(source
            .tile(&owner)
            .expect("lookup")
            .expect("owner")
            .child_page
            .is_some());

        source
            .apply_external_tileset(
                &owner,
                "https://example.test/city/nested/tileset.json",
                external_json,
            )
            .expect("external tileset");
        let owner_tile = source.tile(&owner).expect("lookup").expect("owner");
        assert!(owner_tile.child_page.is_none());
        assert_eq!(owner_tile.children, [TileId("r/external".to_owned())]);

        let external = source
            .tile(&TileId("r/external".to_owned()))
            .expect("lookup")
            .expect("external root");
        assert_eq!(external.refinement, RefinementMode::Add);
        assert_eq!(
            external.contents[0].uri,
            "https://example.test/city/nested/mesh.glb"
        );
        let BoundingVolume::Sphere { center, radius } = external.bounds else {
            panic!("expected sphere");
        };
        assert_close(center.x, 105.0);
        assert_close(center.y, 206.0);
        assert_close(center.z, 307.0);
        assert_close(radius, 4.0);
    }

    fn assert_close(actual: f64, expected: f64) {
        assert!((actual - expected).abs() < 1.0e-12);
    }
}
