//! Atomic catalog for immutable canonical presentation resources.
//!
//! Stable resource IDs are intentionally not lookup keys on their own.  Every
//! consumer resolves an exact `(schemaId, resourceId, contentHash)` revision so
//! an older entity or block keeps its authored presentation after a newer
//! revision is published.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::canonical_resources::{
    validate_annotation_style_resource, validate_hatch_pattern_resource,
    validate_line_type_resource, validate_material_resource, validate_material_table_resource,
    validate_texture_resource, AnnotationStyleResource, CanonicalResourceRef,
    CanonicalResourceValidationError, HatchPatternResource, LineTypeResource, MaterialResource,
    MaterialTableResource, TextureResource, ANNOTATION_STYLE_RESOURCE_SCHEMA_ID,
    HATCH_PATTERN_RESOURCE_SCHEMA_ID, LINE_TYPE_RESOURCE_SCHEMA_ID, MATERIAL_RESOURCE_SCHEMA_ID,
    MATERIAL_TABLE_RESOURCE_SCHEMA_ID, TEXTURE_RESOURCE_SCHEMA_ID,
};
type ResourceKey = (String, String);

/// One atomic publication unit. Dependencies may refer to resources already
/// resident in the catalog or to another resource in the same unit.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalPresentationResourceSet {
    /// Immutable texture revisions published before dependent materials.
    pub textures: Vec<TextureResource>,
    /// Immutable material revisions whose texture references resolve exactly.
    pub materials: Vec<MaterialResource>,
    /// Ordered mesh material tables whose material references resolve exactly.
    pub material_tables: Vec<MaterialTableResource>,
    /// Immutable analytic hatch-pattern revisions.
    pub hatch_patterns: Vec<HatchPatternResource>,
    /// Immutable vector line-type revisions.
    pub line_types: Vec<LineTypeResource>,
    /// Immutable annotation-style revisions published after line types.
    pub annotation_styles: Vec<AnnotationStyleResource>,
}

/// Immutable, exact-revision presentation resource authority.
#[derive(Debug, Clone, Default)]
pub struct CanonicalPresentationResourceCatalog {
    textures: BTreeMap<ResourceKey, TextureResource>,
    materials: BTreeMap<ResourceKey, MaterialResource>,
    material_tables: BTreeMap<ResourceKey, MaterialTableResource>,
    hatch_patterns: BTreeMap<ResourceKey, HatchPatternResource>,
    line_types: BTreeMap<ResourceKey, LineTypeResource>,
    annotation_styles: BTreeMap<ResourceKey, AnnotationStyleResource>,
}

/// Failure to publish or resolve an immutable presentation resource.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CanonicalPresentationCatalogError {
    #[error(transparent)]
    Validation(#[from] CanonicalResourceValidationError),
    #[error("canonical presentation resource revision is already published")]
    DuplicateExactRevision(CanonicalResourceRef),
}

impl CanonicalPresentationResourceCatalog {
    /// Validates a complete publication against one snapshot and commits it
    /// only after every exact dependency has resolved.
    pub fn publish(
        &mut self,
        resources: CanonicalPresentationResourceSet,
    ) -> Result<(), CanonicalPresentationCatalogError> {
        let CanonicalPresentationResourceSet {
            textures,
            materials,
            material_tables,
            hatch_patterns,
            line_types,
            annotation_styles,
        } = resources;
        validate_material_graph(self, &textures, &materials, &material_tables)?;
        validate_hatch_revisions(self, &hatch_patterns)?;
        validate_annotation_graph(self, &line_types, &annotation_styles)?;

        commit_exact(&mut self.textures, textures, TextureResource::resource_ref);
        commit_exact(
            &mut self.materials,
            materials,
            MaterialResource::resource_ref,
        );
        commit_exact(
            &mut self.material_tables,
            material_tables,
            MaterialTableResource::resource_ref,
        );
        commit_exact(
            &mut self.hatch_patterns,
            hatch_patterns,
            HatchPatternResource::resource_ref,
        );
        commit_exact(
            &mut self.line_types,
            line_types,
            LineTypeResource::resource_ref,
        );
        commit_exact(
            &mut self.annotation_styles,
            annotation_styles,
            AnnotationStyleResource::resource_ref,
        );
        Ok(())
    }

    #[must_use]
    pub fn texture(&self, reference: &CanonicalResourceRef) -> Option<&TextureResource> {
        resolve_exact(&self.textures, reference, TEXTURE_RESOURCE_SCHEMA_ID)
    }

    #[must_use]
    pub fn material(&self, reference: &CanonicalResourceRef) -> Option<&MaterialResource> {
        resolve_exact(&self.materials, reference, MATERIAL_RESOURCE_SCHEMA_ID)
    }

    #[must_use]
    pub fn material_table(
        &self,
        reference: &CanonicalResourceRef,
    ) -> Option<&MaterialTableResource> {
        resolve_exact(
            &self.material_tables,
            reference,
            MATERIAL_TABLE_RESOURCE_SCHEMA_ID,
        )
    }

    #[must_use]
    pub fn hatch_pattern(&self, reference: &CanonicalResourceRef) -> Option<&HatchPatternResource> {
        resolve_exact(
            &self.hatch_patterns,
            reference,
            HATCH_PATTERN_RESOURCE_SCHEMA_ID,
        )
    }

    #[must_use]
    pub fn line_type(&self, reference: &CanonicalResourceRef) -> Option<&LineTypeResource> {
        resolve_exact(&self.line_types, reference, LINE_TYPE_RESOURCE_SCHEMA_ID)
    }

    #[must_use]
    pub fn annotation_style(
        &self,
        reference: &CanonicalResourceRef,
    ) -> Option<&AnnotationStyleResource> {
        resolve_exact(
            &self.annotation_styles,
            reference,
            ANNOTATION_STYLE_RESOURCE_SCHEMA_ID,
        )
    }

    /// Exact immutable revision count across every presentation family.
    #[must_use]
    pub fn len(&self) -> usize {
        self.textures.len()
            + self.materials.len()
            + self.material_tables.len()
            + self.hatch_patterns.len()
            + self.line_types.len()
            + self.annotation_styles.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

fn validate_material_graph(
    catalog: &CanonicalPresentationResourceCatalog,
    textures: &[TextureResource],
    materials: &[MaterialResource],
    material_tables: &[MaterialTableResource],
) -> Result<(), CanonicalPresentationCatalogError> {
    for texture in textures {
        validate_texture_resource(texture)?;
    }
    let staged_texture_keys = ensure_new_exact_revisions(
        &catalog.textures,
        textures.iter().map(TextureResource::resource_ref),
    )?;
    for material in materials {
        let texture_refs = exact_dependency_refs(
            &catalog.textures,
            &staged_texture_keys,
            material
                .texture_bindings
                .iter()
                .map(|binding| &binding.texture),
        )?;
        validate_material_resource(material, &texture_refs)?;
    }
    let staged_material_keys = ensure_new_exact_revisions(
        &catalog.materials,
        materials.iter().map(MaterialResource::resource_ref),
    )?;
    for table in material_tables {
        let material_refs = exact_dependency_refs(
            &catalog.materials,
            &staged_material_keys,
            table.materials.iter(),
        )?;
        validate_material_table_resource(table, &material_refs)?;
    }
    ensure_new_exact_revisions(
        &catalog.material_tables,
        material_tables
            .iter()
            .map(MaterialTableResource::resource_ref),
    )?;
    Ok(())
}

fn validate_hatch_revisions(
    catalog: &CanonicalPresentationResourceCatalog,
    hatch_patterns: &[HatchPatternResource],
) -> Result<(), CanonicalPresentationCatalogError> {
    for hatch in hatch_patterns {
        validate_hatch_pattern_resource(hatch)?;
    }
    ensure_new_exact_revisions(
        &catalog.hatch_patterns,
        hatch_patterns
            .iter()
            .map(HatchPatternResource::resource_ref),
    )?;
    Ok(())
}

fn validate_annotation_graph(
    catalog: &CanonicalPresentationResourceCatalog,
    line_types: &[LineTypeResource],
    annotation_styles: &[AnnotationStyleResource],
) -> Result<(), CanonicalPresentationCatalogError> {
    for line_type in line_types {
        validate_line_type_resource(line_type)?;
    }
    let staged_line_type_keys = ensure_new_exact_revisions(
        &catalog.line_types,
        line_types.iter().map(LineTypeResource::resource_ref),
    )?;
    for style in annotation_styles {
        let line_type_refs = exact_dependency_refs(
            &catalog.line_types,
            &staged_line_type_keys,
            style.line_type.iter(),
        )?;
        validate_annotation_style_resource(style, &line_type_refs)?;
    }
    ensure_new_exact_revisions(
        &catalog.annotation_styles,
        annotation_styles
            .iter()
            .map(AnnotationStyleResource::resource_ref),
    )?;
    Ok(())
}

fn ensure_new_exact_revisions<T>(
    index: &BTreeMap<ResourceKey, T>,
    references: impl IntoIterator<Item = CanonicalResourceRef>,
) -> Result<BTreeSet<ResourceKey>, CanonicalPresentationCatalogError> {
    let mut staged = BTreeSet::new();
    for reference in references {
        let key = resource_key(&reference);
        if index.contains_key(&key) || !staged.insert(key) {
            return Err(CanonicalPresentationCatalogError::DuplicateExactRevision(
                reference,
            ));
        }
    }
    Ok(staged)
}

fn exact_dependency_refs<'a, T>(
    index: &BTreeMap<ResourceKey, T>,
    staged: &BTreeSet<ResourceKey>,
    references: impl IntoIterator<Item = &'a CanonicalResourceRef>,
) -> Result<Vec<CanonicalResourceRef>, CanonicalPresentationCatalogError> {
    let mut exact = BTreeMap::<ResourceKey, CanonicalResourceRef>::new();
    for reference in references {
        let key = resource_key(reference);
        if !index.contains_key(&key) && !staged.contains(&key) {
            let stable_id_exists = index
                .keys()
                .chain(staged.iter())
                .any(|(resource_id, _)| resource_id == &reference.resource_id);
            return Err(CanonicalPresentationCatalogError::Validation(
                if stable_id_exists {
                    CanonicalResourceValidationError::ReferenceVersionMismatch
                } else {
                    CanonicalResourceValidationError::MissingReference
                },
            ));
        }
        exact.entry(key).or_insert_with(|| reference.clone());
    }
    Ok(exact.into_values().collect())
}

fn commit_exact<T>(
    index: &mut BTreeMap<ResourceKey, T>,
    resources: impl IntoIterator<Item = T>,
    reference: impl Fn(&T) -> CanonicalResourceRef,
) {
    for resource in resources {
        let key = resource_key(&reference(&resource));
        debug_assert!(!index.contains_key(&key));
        index.insert(key, resource);
    }
}

fn resource_key(reference: &CanonicalResourceRef) -> ResourceKey {
    (
        reference.resource_id.clone(),
        reference.content_hash.as_str().to_owned(),
    )
}

fn resolve_exact<'a, T>(
    index: &'a BTreeMap<ResourceKey, T>,
    reference: &CanonicalResourceRef,
    schema_id: &str,
) -> Option<&'a T> {
    (reference.schema_id == schema_id)
        .then(|| index.get(&resource_key(reference)))
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::{
        CanonicalPresentationCatalogError, CanonicalPresentationResourceCatalog,
        CanonicalPresentationResourceSet,
    };
    use crate::canonical_resources::{
        CanonicalResourceRef, LinearRgba, MaterialAlphaMode, MaterialResource,
        MaterialTableResource, MaterialTextureSlot, TextureColorSpace, TextureFilter,
        TextureResource, TextureResourceBinding, TextureWrapMode, MATERIAL_RESOURCE_SCHEMA_ID,
        MATERIAL_TABLE_RESOURCE_SCHEMA_ID, TEXTURE_RESOURCE_SCHEMA_ID,
    };
    use crate::entity_model::GeometryResource;
    use crate::hash::ObjectHash;

    fn texture(name: &str, bytes: &[u8]) -> TextureResource {
        TextureResource {
            schema_id: TEXTURE_RESOURCE_SCHEMA_ID.to_owned(),
            resource_id: name.to_owned(),
            content_hash: ObjectHash::of_bytes(b"unsealed"),
            pixels: GeometryResource {
                object_hash: ObjectHash::of_bytes(bytes),
                media_type: "image/png".to_owned(),
                byte_length: Some(u64::try_from(bytes.len()).unwrap()),
            },
            color_space: TextureColorSpace::Srgb,
            wrap_u: TextureWrapMode::Repeat,
            wrap_v: TextureWrapMode::Repeat,
            mag_filter: TextureFilter::Linear,
            min_filter: TextureFilter::Linear,
        }
        .seal()
        .unwrap()
    }

    fn material(name: &str, texture: CanonicalResourceRef) -> MaterialResource {
        MaterialResource {
            schema_id: MATERIAL_RESOURCE_SCHEMA_ID.to_owned(),
            resource_id: name.to_owned(),
            content_hash: ObjectHash::of_bytes(b"unsealed"),
            name: None,
            base_color: LinearRgba {
                red: 1.0,
                green: 1.0,
                blue: 1.0,
                alpha: 1.0,
            },
            emissive: [0.0; 3],
            metallic: 0.0,
            roughness: 1.0,
            alpha_mode: MaterialAlphaMode::Opaque,
            alpha_cutoff: None,
            double_sided: false,
            texture_bindings: vec![TextureResourceBinding {
                slot: MaterialTextureSlot::BaseColor,
                texture,
                texture_coordinate_set: 0,
                transform: None,
            }],
        }
        .seal()
        .unwrap()
    }

    fn material_table(name: &str, materials: Vec<CanonicalResourceRef>) -> MaterialTableResource {
        MaterialTableResource {
            schema_id: MATERIAL_TABLE_RESOURCE_SCHEMA_ID.to_owned(),
            resource_id: name.to_owned(),
            content_hash: ObjectHash::of_bytes(b"unsealed"),
            materials,
        }
        .seal()
        .unwrap()
    }

    #[test]
    fn retains_multiple_revisions_of_one_stable_resource_id() {
        let old = texture("survey-ortho", b"old");
        let current = texture("survey-ortho", b"current");
        let historic_material = material("historic-road", old.resource_ref());
        let historic_material_ref = historic_material.resource_ref();
        let mut catalog = CanonicalPresentationResourceCatalog::default();
        catalog
            .publish(CanonicalPresentationResourceSet {
                textures: vec![old.clone(), current.clone()],
                materials: vec![historic_material.clone()],
                ..CanonicalPresentationResourceSet::default()
            })
            .unwrap();

        assert_eq!(catalog.texture(&old.resource_ref()), Some(&old));
        assert_eq!(catalog.texture(&current.resource_ref()), Some(&current));
        assert_eq!(
            catalog.material(&historic_material_ref),
            Some(&historic_material)
        );
        assert_eq!(catalog.len(), 3);
    }

    #[test]
    fn unresolved_dependency_rolls_back_the_complete_publication() {
        let staged_texture = texture("staged", b"staged-pixels");
        let unpublished = texture("unpublished", b"missing-pixels");
        let bad_material = material("road", unpublished.resource_ref());
        let mut catalog = CanonicalPresentationResourceCatalog::default();
        let result = catalog.publish(CanonicalPresentationResourceSet {
            textures: vec![staged_texture],
            materials: vec![bad_material],
            ..CanonicalPresentationResourceSet::default()
        });

        assert!(matches!(
            result,
            Err(CanonicalPresentationCatalogError::Validation(_))
        ));
        assert!(catalog.is_empty());
    }

    #[test]
    fn resolves_dependencies_published_in_the_same_atomic_set() {
        let pixels = texture("ortho", b"pixels");
        let road = material("road", pixels.resource_ref());
        let road_ref = road.resource_ref();
        let mut catalog = CanonicalPresentationResourceCatalog::default();
        catalog
            .publish(CanonicalPresentationResourceSet {
                textures: vec![pixels],
                materials: vec![road.clone()],
                ..CanonicalPresentationResourceSet::default()
            })
            .unwrap();

        assert_eq!(catalog.material(&road_ref), Some(&road));
    }

    #[test]
    fn material_table_resolves_exact_same_transaction_material_revisions() {
        let pixels = texture("facade", b"pixels");
        let old = material("concrete", pixels.resource_ref());
        let mut current = old.clone();
        current.roughness = 0.4;
        current = current.seal().unwrap();
        let table = material_table(
            "mesh-materials",
            vec![
                old.resource_ref(),
                current.resource_ref(),
                old.resource_ref(),
            ],
        );
        let table_ref = table.resource_ref();
        let mut catalog = CanonicalPresentationResourceCatalog::default();

        catalog
            .publish(CanonicalPresentationResourceSet {
                textures: vec![pixels],
                materials: vec![old, current],
                material_tables: vec![table.clone()],
                ..CanonicalPresentationResourceSet::default()
            })
            .unwrap();

        assert_eq!(catalog.material_table(&table_ref), Some(&table));
        assert_eq!(catalog.len(), 4);
    }

    #[test]
    fn unresolved_material_table_revision_rolls_back_prior_resources() {
        let pixels = texture("staged-table-texture", b"pixels");
        let staged_material = material("staged-table-material", pixels.resource_ref());
        let missing_material = material("missing-table-material", pixels.resource_ref());
        let table = material_table("invalid-table", vec![missing_material.resource_ref()]);
        let mut catalog = CanonicalPresentationResourceCatalog::default();

        let result = catalog.publish(CanonicalPresentationResourceSet {
            textures: vec![pixels],
            materials: vec![staged_material],
            material_tables: vec![table],
            ..CanonicalPresentationResourceSet::default()
        });

        assert!(matches!(
            result,
            Err(CanonicalPresentationCatalogError::Validation(_))
        ));
        assert!(catalog.is_empty());
    }
}
