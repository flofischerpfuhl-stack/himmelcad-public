use himmelcad_model::entity_model::GeometryResource;
use himmelcad_model::geometry_representation_registry::{
    SectionIndexComponentType, SectionPositionComponentType, SectionTopologyPartitionManifest,
};
use himmelcad_model::hash::ObjectHash;
use himmelcad_model::typed_artifact::{
    ArtifactAffineDecode, ArtifactElementType, TypedArtifactLayout,
};

fn named_resource(name: &[u8], length: u64) -> GeometryResource {
    GeometryResource {
        object_hash: ObjectHash::of_bytes(name),
        media_type: "application/octet-stream".to_owned(),
        byte_length: Some(length),
    }
}

#[test]
fn section_topology_maps_to_dense_position_index_and_material_arrays() {
    let topology = SectionTopologyPartitionManifest {
        schema_version: SectionTopologyPartitionManifest::SCHEMA_VERSION,
        origin: [100.0, 200.0, 300.0],
        positions: named_resource(b"positions", 24),
        position_component_type: SectionPositionComponentType::Float32,
        vertex_count: 2,
        indices: named_resource(b"indices", 6),
        index_component_type: SectionIndexComponentType::Uint16,
        index_count: 3,
        material_slots: Some(named_resource(b"materials", 4)),
    };
    let descriptors = topology
        .typed_artifact_descriptors()
        .expect("typed topology");
    assert_eq!(descriptors.len(), 3);
    assert!(matches!(
        &descriptors[0].layout,
        TypedArtifactLayout::DenseArray {
            element_type: ArtifactElementType::Float32,
            shape,
            decode: Some(ArtifactAffineDecode { offset, .. }),
            ..
        } if shape == &[2, 3] && offset == &[100.0, 200.0, 300.0]
    ));
    assert!(matches!(
        &descriptors[1].layout,
        TypedArtifactLayout::DenseArray {
            element_type: ArtifactElementType::Uint16,
            shape,
            ..
        } if shape == &[3]
    ));
    assert!(matches!(
        &descriptors[2].layout,
        TypedArtifactLayout::DenseArray {
            element_type: ArtifactElementType::Uint32,
            shape,
            ..
        } if shape == &[1]
    ));
}
