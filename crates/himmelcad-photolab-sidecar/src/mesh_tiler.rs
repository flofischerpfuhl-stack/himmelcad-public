//! Compatibility exports and upper-layer reader tests for prepared DEM meshes.

pub use himmelcad_prepared_build::mesh_tiler::*;

#[cfg(test)]
mod render_contract_tests {
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    use himmelcad_model::{
        geometry_representation_registry::SectionTopologyPartitionManifest, hash::ObjectHash,
    };
    use himmelcad_prepared::raster::{
        GdalAudit, RasterBounds, RasterBuildSummary, RasterCrs, RasterGrid, RasterLevelSummary,
        RasterNoDataValue,
    };
    use himmelcad_process::jobs::CancellationToken;
    use image::RgbaImage;

    use super::*;

    fn raster_summary(columns: u32, rows: u32, gsd: f64) -> RasterBuildSummary {
        let bounds = RasterBounds {
            minimum_east: 0.0,
            minimum_north: 0.0,
            maximum_east: f64::from(columns) * 512.0 * gsd,
            maximum_north: f64::from(rows) * 512.0 * gsd,
        };
        RasterBuildSummary {
            output_directory: "x".into(),
            cog_path: "x".into(),
            pyramid_manifest_path: "x".into(),
            levels: vec![RasterLevelSummary {
                level: 0,
                columns,
                rows,
                tile_count: u64::from(columns) * u64::from(rows),
                bounds,
                gsd,
                relative_directory: "pyramid/L00".into(),
                metric_tile_url_template: String::new(),
                view_layers: vec![],
            }],
            crs: RasterCrs {
                horizontal: "x".into(),
                vertical: None,
                gdal_srs: "x".into(),
                canonical_wkt_sha256: ObjectHash::of_bytes(b"x"),
            },
            grid: RasterGrid {
                bounds,
                width_pixels: columns * 512,
                height_pixels: rows * 512,
                gsd,
                no_data: RasterNoDataValue::Numeric(-1.0),
            },
            audit: GdalAudit {
                version: "x".into(),
                executable_sha256: Default::default(),
                raster_drivers: vec![],
                vector_drivers: vec![],
                network_enabled: false,
            },
        }
    }

    #[test]
    fn prepared_dem_emits_content_addressed_open_section_topology() {
        use himmelcad_render::{
            decode_gltf_intrinsic_with_resources, inspect_gltf_dependencies, resolve_asset_uri,
            AssetBundleLimits, DatasetId, HierarchySource, PreparedHierarchySource,
            ResolvedAssetBundle, ResolvedAssetInput, TileId,
        };
        let root = std::env::temp_dir().join(format!("hcad-mesh-topology-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("dem/view/height/L00/0")).unwrap();
        fs::create_dir_all(root.join("ortho/view/rgba/L00/0")).unwrap();
        RgbaImage::from_pixel(512, 512, image::Rgba([30, 90, 160, 255]))
            .save(root.join("ortho/view/rgba/L00/0/0.png"))
            .unwrap();
        let heights = (0..512 * 512)
            .flat_map(|index| ((index / 512) as f32 * 0.01).to_le_bytes())
            .collect::<Vec<_>>();
        fs::write(root.join("dem/view/height/L00/0/0.f32"), heights).unwrap();
        let summary = raster_summary(1, 1, 1.0);
        let prepared = build_tiled_dem_mesh(
            &root.join("dem"),
            &summary,
            &root.join("mesh"),
            Some(&root.join("ortho")),
            Some(&summary),
            2,
            false,
            2048,
            &CancellationToken::new(),
        )
        .expect("prepared DGM");

        let section_topology = prepared
            .section_topology
            .as_ref()
            .expect("section topology");
        assert!(!section_topology.closed_manifold);
        assert_eq!(section_topology.parts.len(), 1);
        let part = &section_topology.parts[0];
        assert_eq!(part.part_id, "root");
        let manifest_bytes = fs::read(root.join("mesh").join(&part.manifest_url)).unwrap();
        assert_eq!(ObjectHash::of_bytes(&manifest_bytes).0, part.topology_hash);
        let manifest: SectionTopologyPartitionManifest =
            serde_json::from_slice(&manifest_bytes).unwrap();
        assert_eq!(manifest.content_hash().unwrap().0, part.topology_hash);
        let positions = fs::read(root.join("mesh").join(&part.position_url)).unwrap();
        let indices = fs::read(root.join("mesh").join(&part.index_url)).unwrap();
        assert_eq!(
            ObjectHash::of_bytes(&positions),
            manifest.positions.object_hash
        );
        assert_eq!(ObjectHash::of_bytes(&indices), manifest.indices.object_hash);
        assert_eq!(manifest.vertex_count, 512 * 512);
        assert_eq!(manifest.index_count, 6 * 511 * 511);
        for position in positions.chunks_exact(12) {
            for axis in 0..3 {
                let start = axis * 4;
                let local = f32::from_le_bytes(position[start..start + 4].try_into().unwrap());
                let decoded = manifest.origin[axis] + f64::from(local);
                assert!(decoded >= part.bounds.minimum[axis]);
                assert!(decoded <= part.bounds.maximum[axis]);
            }
        }
        assert!(root
            .join("mesh")
            .join(&section_topology.manifest_relative_path)
            .is_file());
        let kernel_manifest_relative_path = prepared
            .kernel_manifest_relative_path
            .as_ref()
            .expect("kernel manifest path");
        let kernel_manifest_bytes =
            fs::read(root.join("mesh").join(kernel_manifest_relative_path)).unwrap();
        assert_eq!(
            ObjectHash::of_bytes(&kernel_manifest_bytes),
            prepared
                .kernel_manifest_resource
                .as_ref()
                .expect("kernel manifest resource")
                .object_hash
        );
        let kernel_manifest: serde_json::Value =
            serde_json::from_slice(&kernel_manifest_bytes).unwrap();
        let kernel_tile = &kernel_manifest["tiles"][0];
        assert_eq!(kernel_tile["contents"][0]["kind"], "gltf");
        assert_eq!(kernel_tile["contents"][0]["primitiveCount"], 2);
        assert_eq!(kernel_tile["contentTransform"][12], manifest.origin[0]);
        assert_eq!(kernel_tile["contentTransform"][13], manifest.origin[1]);
        assert_eq!(kernel_tile["contentTransform"][14], manifest.origin[2]);
        let gltf_url = kernel_tile["contents"][0]["uri"].as_str().unwrap();
        let gltf_bytes = fs::read(root.join("mesh").join(gltf_url)).unwrap();
        assert_eq!(
            ObjectHash::of_bytes(&gltf_bytes).0,
            kernel_tile["contents"][0]["contentHash"]
        );
        let gltf: serde_json::Value = serde_json::from_slice(&gltf_bytes).unwrap();
        gltf::Gltf::from_slice(&gltf_bytes).expect("kernel glTF contract");
        assert_eq!(gltf["asset"]["version"], "2.0");
        assert_eq!(gltf["accessors"][0]["count"], 4);
        assert_eq!(gltf["accessors"][1]["count"], 4);
        assert_eq!(gltf["accessors"][2]["count"], 6);
        let immutable_assets = kernel_tile["contents"][0]["decoderParameters"]["immutableAssets"]
            .as_array()
            .expect("immutable glTF resources");
        assert_eq!(immutable_assets.len(), 4);
        let gltf_parent = Path::new(gltf_url).parent().unwrap();
        for asset in immutable_assets {
            let uri = asset["uri"].as_str().unwrap();
            let bytes = fs::read(root.join("mesh").join(gltf_parent).join(uri)).unwrap();
            assert_eq!(asset["byteLength"].as_u64(), Some(bytes.len() as u64));
            assert_eq!(asset["contentHash"], ObjectHash::of_bytes(&bytes).0);
        }

        let kernel_manifest_uri = "https://example.test/dgm/kernel-manifest.json";
        let mut hierarchy = PreparedHierarchySource::from_json(
            DatasetId("road-dgm".to_owned()),
            kernel_manifest_uri,
            &kernel_manifest_bytes,
        )
        .expect("kernel hierarchy contract");
        let root_tile = hierarchy
            .tile(&TileId("root".to_owned()))
            .expect("root lookup")
            .expect("root descriptor");
        let content = &root_tile.contents[0];
        let limits = AssetBundleLimits::default();
        let dependencies = inspect_gltf_dependencies(&content.uri, &gltf_bytes, limits)
            .expect("generated glTF dependencies");
        let mut declared_uris = immutable_assets
            .iter()
            .map(|asset| asset["uri"].as_str().unwrap())
            .collect::<Vec<_>>();
        declared_uris.sort_unstable();
        let mut dependency_uris = dependencies
            .dependencies()
            .iter()
            .map(|dependency| dependency.source_uri.as_str())
            .collect::<Vec<_>>();
        dependency_uris.sort_unstable();
        assert_eq!(declared_uris, dependency_uris);
        let owned_resources = dependencies
            .dependencies()
            .iter()
            .map(|dependency| {
                let resolved = resolve_asset_uri(
                    &dependency.owner_uri,
                    &dependency.source_uri,
                    limits.max_uri_bytes,
                )
                .expect("resolved generated dependency");
                let bytes = fs::read(root.join("mesh/tiles").join(&dependency.source_uri))
                    .expect("generated dependency bytes");
                (dependency.clone(), resolved, bytes)
            })
            .collect::<Vec<_>>();
        let inputs = owned_resources
            .iter()
            .map(|(dependency, resolved, bytes)| ResolvedAssetInput {
                owner_uri: &dependency.owner_uri,
                source_uri: &dependency.source_uri,
                resolved_uri: resolved,
                kind: dependency.kind,
                bytes,
            })
            .collect::<Vec<_>>();
        let bundle =
            ResolvedAssetBundle::build(&inputs, limits).expect("generated glTF resource bundle");
        let decoded = decode_gltf_intrinsic_with_resources(
            &content.uri,
            &gltf_bytes,
            &bundle,
            root_tile.content_transform,
        )
        .expect("kernel decoder accepts generated DGM tile");
        assert_eq!(decoded.primitives.len(), 1);
        assert_eq!(decoded.primitives[0].indices.len(), 6);
        assert_eq!(decoded.images.len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn multi_tile_dgm_keeps_distinct_textured_root_and_leaf_lods() {
        let root = std::env::temp_dir().join(format!("hcad-mesh-root-lod-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for path in [
            "dem/view/height/L00/0",
            "dem/view/height/L00/1",
            "dem/view/height/L01/0",
            "ortho/view/rgba/L00/0",
            "ortho/view/rgba/L00/1",
        ] {
            fs::create_dir_all(root.join(path)).unwrap();
        }
        let height_bytes = vec![10.0_f32; 512 * 512]
            .into_iter()
            .flat_map(f32::to_le_bytes)
            .collect::<Vec<_>>();
        for path in [
            "dem/view/height/L00/0/0.f32",
            "dem/view/height/L00/1/0.f32",
            "dem/view/height/L01/0/0.f32",
        ] {
            fs::write(root.join(path), &height_bytes).unwrap();
        }
        RgbaImage::from_pixel(512, 512, image::Rgba([220, 20, 20, 255]))
            .save(root.join("ortho/view/rgba/L00/0/0.png"))
            .unwrap();
        RgbaImage::from_pixel(512, 512, image::Rgba([20, 40, 220, 255]))
            .save(root.join("ortho/view/rgba/L00/1/0.png"))
            .unwrap();
        let mut summary = raster_summary(2, 1, 1.0);
        summary.levels.push(RasterLevelSummary {
            level: 1,
            columns: 1,
            rows: 1,
            tile_count: 1,
            bounds: summary.grid.bounds,
            gsd: 2.0,
            relative_directory: "pyramid/L01".into(),
            metric_tile_url_template: String::new(),
            view_layers: vec![],
        });
        let prepared = build_tiled_dem_mesh(
            &root.join("dem"),
            &summary,
            &root.join("mesh"),
            Some(&root.join("ortho")),
            Some(&summary),
            6,
            false,
            2048,
            &CancellationToken::new(),
        )
        .expect("multi-tile textured DGM");
        let manifest: serde_json::Value = serde_json::from_slice(
            &fs::read(root.join("mesh").join(&prepared.manifest_relative_path)).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["tiles"][0]["textureUrl"], "textures/root.png");
        assert_eq!(manifest["tiles"][1]["textureUrl"], "textures/0/0.png");
        assert_eq!(manifest["tiles"][2]["textureUrl"], "textures/1/0.png");
        let overview = image::open(root.join("mesh/textures/root.png"))
            .unwrap()
            .to_rgba8();
        assert_eq!(overview.get_pixel(64, 128).0, [220, 20, 20, 255]);
        assert_eq!(overview.get_pixel(448, 128).0, [20, 40, 220, 255]);
        assert_eq!(
            image::open(root.join("mesh/textures/0/0.png"))
                .unwrap()
                .to_rgba8()
                .get_pixel(256, 256)
                .0,
            [220, 20, 20, 255]
        );
        let topology = prepared.section_topology.as_ref().unwrap();
        assert_eq!(topology.parts.len(), 2);
        let left: SectionTopologyPartitionManifest = serde_json::from_slice(
            &fs::read(root.join("mesh").join(&topology.parts[0].manifest_url)).unwrap(),
        )
        .unwrap();
        let right: SectionTopologyPartitionManifest = serde_json::from_slice(
            &fs::read(root.join("mesh").join(&topology.parts[1].manifest_url)).unwrap(),
        )
        .unwrap();
        assert_eq!(left.vertex_count, 513 * 512);
        assert_eq!(left.index_count, 6 * 512 * 511);
        assert_eq!(right.vertex_count, 512 * 512);
        assert_eq!(right.index_count, 6 * 511 * 511);
        let trace_length = topology
            .parts
            .iter()
            .map(|part| {
                use himmelcad_render::{
                    section_open_mesh, SectionMeshInput, SectionPlane, WorldVec3,
                };
                let manifest: SectionTopologyPartitionManifest = serde_json::from_slice(
                    &fs::read(root.join("mesh").join(&part.manifest_url)).unwrap(),
                )
                .unwrap();
                let positions = fs::read(root.join("mesh").join(&part.position_url))
                    .unwrap()
                    .chunks_exact(12)
                    .map(|xyz| WorldVec3 {
                        x: manifest.origin[0]
                            + f64::from(f32::from_le_bytes(xyz[0..4].try_into().unwrap())),
                        y: manifest.origin[1]
                            + f64::from(f32::from_le_bytes(xyz[4..8].try_into().unwrap())),
                        z: manifest.origin[2]
                            + f64::from(f32::from_le_bytes(xyz[8..12].try_into().unwrap())),
                    })
                    .collect::<Vec<_>>();
                let indices = fs::read(root.join("mesh").join(&part.index_url))
                    .unwrap()
                    .chunks_exact(4)
                    .map(|value| u32::from_le_bytes(value.try_into().unwrap()))
                    .collect::<Vec<_>>();
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
                            y: 256.25,
                            z: 10.0,
                        },
                        normal: WorldVec3 {
                            x: 0.0,
                            y: 1.0,
                            z: 0.0,
                        },
                    },
                    1.0e-8,
                )
                .unwrap()
                .segments
                .iter()
                .map(|segment| {
                    let dx = segment.end.x - segment.start.x;
                    let dy = segment.end.y - segment.start.y;
                    let dz = segment.end.z - segment.start.z;
                    dx.mul_add(dx, dy.mul_add(dy, dz * dz)).sqrt()
                })
                .sum::<f64>()
            })
            .sum::<f64>();
        assert!((trace_length - 1023.0).abs() < 1.0e-6);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[ignore = "explicit checksum-pinned GeoBasis-DE/LGB real-data gate"]
    fn real_brandenburg_dgm_section_is_exact_across_the_source_tile_seam() {
        use himmelcad_render::{section_open_mesh, SectionMeshInput, SectionPlane, WorldVec3};

        let fixture_root = std::env::var_os("HCAD_REAL_DGM_FIXTURE_ROOT")
            .map(PathBuf::from)
            .expect("HCAD_REAL_DGM_FIXTURE_ROOT must point at extracted locked GeoTIFFs");
        let west = fs::read(fixture_root.join("dgm_33250-5888.window.f32"))
            .expect("read derived west DGM1 window");
        let east = fs::read(fixture_root.join("dgm_33251-5888.window.f32"))
            .expect("read derived east DGM1 window");
        assert_eq!(west.len(), 512 * 512 * 4);
        assert_eq!(east.len(), 512 * 512 * 4);

        let root = std::env::temp_dir().join(format!(
            "hcad-real-brandenburg-dgm-section-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let dem_root = root.join("dem");
        for column in 0..2 {
            fs::create_dir_all(dem_root.join(format!("view/height/L00/{column}"))).unwrap();
        }
        fs::write(dem_root.join("view/height/L00/0/0.f32"), west)
            .expect("stage west real DGM window");
        fs::write(dem_root.join("view/height/L00/1/0.f32"), east)
            .expect("stage east real DGM window");

        let mut summary = raster_summary(2, 1, 1.0);
        let bounds = RasterBounds {
            minimum_east: 250_488.0,
            minimum_north: 5_888_244.0,
            maximum_east: 251_512.0,
            maximum_north: 5_888_756.0,
        };
        summary.levels[0].bounds = bounds;
        summary.grid.bounds = bounds;
        summary.crs.horizontal = "EPSG:25833".to_owned();
        summary.crs.vertical = Some("EPSG:7837".to_owned());
        summary.crs.gdal_srs = "EPSG:25833+7837".to_owned();
        let prepared = build_tiled_dem_mesh(
            &dem_root,
            &summary,
            &root.join("mesh"),
            None,
            None,
            2,
            false,
            2048,
            &CancellationToken::new(),
        )
        .expect("prepare real two-tile DGM");
        let topology = prepared
            .section_topology
            .as_ref()
            .expect("section topology");
        assert_eq!(topology.parts.len(), 2);

        let mut segments = Vec::new();
        let mut exact_triangles = 0_u64;
        for part in &topology.parts {
            let manifest: SectionTopologyPartitionManifest = serde_json::from_slice(
                &fs::read(root.join("mesh").join(&part.manifest_url)).unwrap(),
            )
            .unwrap();
            exact_triangles += manifest.index_count / 3;
            let positions = fs::read(root.join("mesh").join(&part.position_url))
                .unwrap()
                .chunks_exact(12)
                .map(|xyz| WorldVec3 {
                    x: manifest.origin[0]
                        + f64::from(f32::from_le_bytes(xyz[0..4].try_into().unwrap())),
                    y: manifest.origin[1]
                        + f64::from(f32::from_le_bytes(xyz[4..8].try_into().unwrap())),
                    z: manifest.origin[2]
                        + f64::from(f32::from_le_bytes(xyz[8..12].try_into().unwrap())),
                })
                .collect::<Vec<_>>();
            let indices = fs::read(root.join("mesh").join(&part.index_url))
                .unwrap()
                .chunks_exact(4)
                .map(|value| u32::from_le_bytes(value.try_into().unwrap()))
                .collect::<Vec<_>>();
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
                            x: 251_000.0,
                            y: 5_888_488.0,
                            z: 0.0,
                        },
                        normal: WorldVec3 {
                            x: 0.0,
                            y: 1.0,
                            z: 0.0,
                        },
                    },
                    1.0e-8,
                )
                .expect("exact real DGM partition section")
                .segments,
            );
        }
        assert_eq!(exact_triangles, 1_045_506);
        assert_eq!(segments.len(), 2_046);
        let mut intervals = segments
            .iter()
            .map(|segment| {
                (
                    segment.start.x.min(segment.end.x),
                    segment.start.x.max(segment.end.x),
                )
            })
            .collect::<Vec<_>>();
        intervals
            .sort_by(|left, right| left.0.total_cmp(&right.0).then(left.1.total_cmp(&right.1)));
        assert!((intervals[0].0 - 250_488.5).abs() < 1.0e-8);
        assert!((intervals.last().unwrap().1 - 251_511.5).abs() < 1.0e-8);
        for pair in intervals.windows(2) {
            assert!(
                (pair[1].0 - pair[0].1).abs() < 1.0e-8,
                "real DGM trace has a gap or positive overlap: {pair:?}"
            );
        }
        let seam_heights = segments
            .iter()
            .flat_map(|segment| [segment.start, segment.end])
            .filter(|point| (point.x - 251_000.5).abs() < 1.0e-8)
            .map(|point| point.z)
            .collect::<Vec<_>>();
        assert!(!seam_heights.is_empty());
        assert!(seam_heights
            .iter()
            .all(|height| (*height - 33.0).abs() < 1.0e-6));
        let projected_length = intervals
            .iter()
            .map(|(start, end)| end - start)
            .sum::<f64>();
        assert!((projected_length - 1_023.0).abs() < 1.0e-8);
        let _ = fs::remove_dir_all(root);
    }
}
