//! Compatibility exports for prepared triangle-mesh production and IO packaging.

pub use himmelcad_io::package_prepared_triangle_mesh;
pub use himmelcad_prepared_build::prepared_triangle_mesh::*;

#[cfg(test)]
mod render_contract_tests {
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use himmelcad_model::geometry_representation_registry::SectionTopologyPartitionManifest;
    use himmelcad_process::jobs::CancellationToken;
    use himmelcad_render::{section_open_mesh, SectionMeshInput, SectionPlane, WorldVec3};

    use super::{build_prepared_triangle_mesh, PreparedTriangleMeshOptions, TriangleRecord};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "himmelcad-prepared-triangle-{label}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn exact_section_crosses_spatial_partition_without_a_trace_gap() {
        let root = TestDirectory::new("section");
        let output = root.0.join("prepared");
        let product = build_prepared_triangle_mesh(
            [
                TriangleRecord {
                    positions: [[-1.0, -1.0, 0.0], [0.0, -1.0, 0.0], [0.0, 1.0, 0.0]],
                    material_slot: None,
                    texture_coordinates: None,
                },
                TriangleRecord {
                    positions: [[-1.0, -1.0, 0.0], [0.0, 1.0, 0.0], [-1.0, 1.0, 0.0]],
                    material_slot: None,
                    texture_coordinates: None,
                },
                TriangleRecord {
                    positions: [[0.0, -1.0, 0.0], [1.0, -1.0, 0.0], [1.0, 1.0, 0.0]],
                    material_slot: None,
                    texture_coordinates: None,
                },
                TriangleRecord {
                    positions: [[0.0, -1.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]],
                    material_slot: None,
                    texture_coordinates: None,
                },
            ],
            &output,
            PreparedTriangleMeshOptions {
                max_triangles_per_partition: 2,
                internal_proxy_triangle_budget: 64,
                closed_manifold: false,
            },
            &CancellationToken::new(),
        )
        .unwrap();
        let topology = product.section_topology.unwrap();
        assert_eq!(topology.parts.len(), 2);
        let mut segments = Vec::new();
        for part in topology.parts {
            let manifest: SectionTopologyPartitionManifest =
                serde_json::from_slice(&fs::read(output.join(&part.manifest_url)).unwrap())
                    .unwrap();
            let position_bytes = fs::read(output.join(&part.position_url)).unwrap();
            let positions = position_bytes
                .chunks_exact(24)
                .map(|xyz| WorldVec3 {
                    x: f64::from_le_bytes(xyz[0..8].try_into().unwrap()),
                    y: f64::from_le_bytes(xyz[8..16].try_into().unwrap()),
                    z: f64::from_le_bytes(xyz[16..24].try_into().unwrap()),
                })
                .collect::<Vec<_>>();
            let index_bytes = fs::read(output.join(&part.index_url)).unwrap();
            let indices = index_bytes
                .chunks_exact(4)
                .map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()))
                .collect::<Vec<_>>();
            assert_eq!(manifest.origin, [0.0; 3]);
            segments.extend(
                section_open_mesh(
                    SectionMeshInput {
                        positions: &positions,
                        indices: &indices,
                        material_slots: None,
                        closed_manifold: false,
                    },
                    SectionPlane {
                        origin: WorldVec3 {
                            x: 0.0,
                            y: 0.0,
                            z: 0.0,
                        },
                        normal: WorldVec3 {
                            x: 0.0,
                            y: 1.0,
                            z: 0.0,
                        },
                    },
                    1e-12,
                )
                .unwrap()
                .segments,
            );
        }
        let mut minimum = f64::INFINITY;
        let mut maximum = f64::NEG_INFINITY;
        for segment in &segments {
            minimum = minimum.min(segment.start.x).min(segment.end.x);
            maximum = maximum.max(segment.start.x).max(segment.end.x);
        }
        assert_eq!((minimum, maximum), (-1.0, 1.0));
    }
}
