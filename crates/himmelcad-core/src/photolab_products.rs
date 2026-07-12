//! Immutable product, lineage and streaming contracts for Photolab outputs.
//!
//! Large output types share one prepared tile-manifest contract. Runtime code
//! selects tiles and levels from metadata; it never scans complete products.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{hash::ObjectHash, photolab_matching::ImageId};

/// Stable identity of an immutable product run.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProductRunId(pub String);

/// Product class used in lineage and dependency validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProductKind {
    DepthMaps,
    DensePointCloud,
    Dem,
    Orthomosaic,
    TexturedMesh,
    GaussianSplat,
}

/// Whether a DEM represents the visible surface or classified terrain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DemSurfaceKind {
    Dsm,
    Dtm,
}

/// Explicit warning that an appearance product is not survey geometry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MeasurementClassification {
    SurveyEligible,
    AppearanceOnlyNonSurvey,
}

/// Compact axis-aligned bounds stored with every large tiled dataset.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetBounds {
    pub minimum: [f64; 3],
    pub maximum: [f64; 3],
}

impl DatasetBounds {
    fn validate(self) -> Result<(), ProductError> {
        for value in self.minimum.into_iter().chain(self.maximum) {
            validate_finite(value, "dataset bounds")?;
        }
        if self
            .minimum
            .into_iter()
            .zip(self.maximum)
            .any(|(minimum, maximum)| minimum > maximum)
        {
            return Err(ProductError::InvalidTiledDataset(
                "dataset bounds are inverted",
            ));
        }
        Ok(())
    }
}

/// Geometry/storage family understood by the shared streaming scheduler.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TiledDatasetKind {
    PointCloud,
    Mesh,
    Splat,
    Raster,
}

/// Prepared spatial index used by tile picking and culling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TileSpatialIndexKind {
    PointOctree,
    TriangleBvh,
    SplatTree,
    RasterGrid,
}

/// Aggregate counts for budgeting without opening every tile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TiledContentSummary {
    pub point_count: u64,
    pub triangle_count: u64,
    pub splat_count: u64,
    pub texel_count: u64,
    pub uncompressed_bytes: u64,
}

/// Shared metadata for point, mesh, splat and raster tile manifests.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TiledDatasetMetadata {
    pub dataset_id: String,
    pub kind: TiledDatasetKind,
    pub root_tile_id: String,
    pub tile_manifest_hash: ObjectHash,
    pub bounds: DatasetBounds,
    pub level_count: u16,
    pub spatial_index: TileSpatialIndexKind,
    pub content: TiledContentSummary,
}

impl TiledDatasetMetadata {
    /// Validates only O(1) metadata; tile manifests remain streamed.
    pub fn validate(&self) -> Result<(), ProductError> {
        if self.dataset_id.trim().is_empty() || self.root_tile_id.trim().is_empty() {
            return Err(ProductError::InvalidTiledDataset(
                "dataset and root tile ids cannot be empty",
            ));
        }
        if self.level_count == 0 {
            return Err(ProductError::InvalidTiledDataset(
                "tiled dataset needs at least one level",
            ));
        }
        validate_hash(&self.tile_manifest_hash, "tile manifest hash")?;
        self.bounds.validate()?;
        let expected_index = match self.kind {
            TiledDatasetKind::PointCloud => TileSpatialIndexKind::PointOctree,
            TiledDatasetKind::Mesh => TileSpatialIndexKind::TriangleBvh,
            TiledDatasetKind::Splat => TileSpatialIndexKind::SplatTree,
            TiledDatasetKind::Raster => TileSpatialIndexKind::RasterGrid,
        };
        if self.spatial_index != expected_index {
            return Err(ProductError::InvalidTiledDataset(
                "spatial index does not match tiled dataset kind",
            ));
        }
        Ok(())
    }
}

/// Projected raster tile addressing scheme.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RasterTileScheme {
    ProjectedQuadtreeTopLeft,
    ProjectedQuadtreeBottomLeft,
}

/// Explicit raster no-data representation.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum RasterNoData {
    Numeric(f64),
    Nan,
    AlphaMask,
}

/// One materialized overview level; hashes address manifests, not every tile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterPyramidLevel {
    pub level: u16,
    pub resolution_meters_per_pixel: f64,
    pub tile_columns: u32,
    pub tile_rows: u32,
    pub tile_index_hash: ObjectHash,
    pub content_hash: ObjectHash,
}

/// Multiresolution DEM/orthomosaic contract optimized for screen-GSD lookup.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterPyramid {
    pub tile_scheme: RasterTileScheme,
    pub origin_east_meters: f64,
    pub origin_north_meters: f64,
    pub tile_size_pixels: u16,
    pub no_data: RasterNoData,
    pub horizontal_crs: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vertical_crs: Option<String>,
    pub levels: Vec<RasterPyramidLevel>,
    pub pyramid_manifest_hash: ObjectHash,
}

impl RasterPyramid {
    /// Validates level order, CRS and content-addressed overview metadata.
    pub fn validate(&self) -> Result<(), ProductError> {
        validate_finite(self.origin_east_meters, "raster origin east")?;
        validate_finite(self.origin_north_meters, "raster origin north")?;
        if self.horizontal_crs.trim().is_empty() {
            return Err(ProductError::InvalidRasterPyramid(
                "horizontal CRS cannot be empty",
            ));
        }
        if self
            .vertical_crs
            .as_ref()
            .is_some_and(|crs| crs.trim().is_empty())
        {
            return Err(ProductError::InvalidRasterPyramid(
                "vertical CRS cannot be empty when present",
            ));
        }
        if !self.tile_size_pixels.is_power_of_two()
            || !(128..=2_048).contains(&self.tile_size_pixels)
        {
            return Err(ProductError::InvalidRasterPyramid(
                "tile size must be a power of two in 128..=2048",
            ));
        }
        if let RasterNoData::Numeric(value) = self.no_data {
            validate_finite(value, "raster no-data value")?;
        }
        if self.levels.is_empty() {
            return Err(ProductError::InvalidRasterPyramid(
                "raster pyramid needs at least one level",
            ));
        }
        validate_hash(&self.pyramid_manifest_hash, "pyramid manifest hash")?;
        let mut previous_resolution = 0.0;
        for (index, level) in self.levels.iter().enumerate() {
            if usize::from(level.level) != index {
                return Err(ProductError::InvalidRasterPyramid(
                    "raster levels must be contiguous from zero",
                ));
            }
            validate_positive_finite(level.resolution_meters_per_pixel, "raster resolution")?;
            if level.resolution_meters_per_pixel <= previous_resolution {
                return Err(ProductError::InvalidRasterPyramid(
                    "raster resolutions must become strictly coarser",
                ));
            }
            if level.tile_columns == 0 || level.tile_rows == 0 {
                return Err(ProductError::InvalidRasterPyramid(
                    "raster level tile dimensions must be positive",
                ));
            }
            validate_hash(&level.tile_index_hash, "raster tile index hash")?;
            validate_hash(&level.content_hash, "raster level content hash")?;
            previous_resolution = level.resolution_meters_per_pixel;
        }
        Ok(())
    }
}

/// Chooses the coarsest level that is still at least as detailed as screen GSD.
pub fn select_raster_level_for_screen_gsd(
    pyramid: &RasterPyramid,
    screen_gsd_meters_per_pixel: f64,
) -> Result<&RasterPyramidLevel, ProductError> {
    pyramid.validate()?;
    validate_positive_finite(screen_gsd_meters_per_pixel, "screen GSD")?;
    Ok(pyramid
        .levels
        .iter()
        .rev()
        .find(|level| level.resolution_meters_per_pixel <= screen_gsd_meters_per_pixel)
        .unwrap_or(&pyramid.levels[0]))
}

/// Raster presentation switches between fast locked 2D and prepared 3D data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "mode")]
pub enum RasterDisplayMode {
    LockedTopDown2d,
    DrapedOnElevation3d { surface_run_id: ProductRunId },
    TexturedMesh3d { mesh_run_id: ProductRunId },
}

/// Product-specific immutable metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ProductDescriptor {
    DepthMaps {
        image_count: u32,
    },
    DensePointCloud,
    Dem {
        surface_kind: DemSurfaceKind,
        raster: RasterPyramid,
    },
    Orthomosaic {
        raster: RasterPyramid,
    },
    TexturedMesh,
    GaussianSplat,
}

impl ProductDescriptor {
    /// Returns the dependency class independent of descriptor details.
    pub const fn kind(&self) -> ProductKind {
        match self {
            Self::DepthMaps { .. } => ProductKind::DepthMaps,
            Self::DensePointCloud => ProductKind::DensePointCloud,
            Self::Dem { .. } => ProductKind::Dem,
            Self::Orthomosaic { .. } => ProductKind::Orthomosaic,
            Self::TexturedMesh => ProductKind::TexturedMesh,
            Self::GaussianSplat => ProductKind::GaussianSplat,
        }
    }

    /// Gaussian splats remain appearance-only even when trained from survey data.
    pub const fn measurement_classification(&self) -> MeasurementClassification {
        match self {
            Self::GaussianSplat => MeasurementClassification::AppearanceOnlyNonSurvey,
            _ => MeasurementClassification::SurveyEligible,
        }
    }
}

/// Immutable source edge captured by a product run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "source")]
pub enum ProductDependency {
    SourceImages {
        content_hash: ObjectHash,
    },
    Alignment {
        content_hash: ObjectHash,
    },
    Product {
        run_id: ProductRunId,
        kind: ProductKind,
        content_hash: ObjectHash,
    },
}

impl ProductDependency {
    fn identity(&self) -> DependencyIdentity {
        match self {
            Self::SourceImages { .. } => DependencyIdentity::SourceImages,
            Self::Alignment { .. } => DependencyIdentity::Alignment,
            Self::Product { run_id, .. } => DependencyIdentity::Product(run_id.clone()),
        }
    }

    fn validate(&self) -> Result<(), ProductError> {
        let hash = match self {
            Self::SourceImages { content_hash }
            | Self::Alignment { content_hash }
            | Self::Product { content_hash, .. } => content_hash,
        };
        validate_hash(hash, "lineage content hash")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum DependencyIdentity {
    SourceImages,
    Alignment,
    Product(ProductRunId),
}

/// Frozen configuration and input graph for one product output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductLineage {
    config_hash: ObjectHash,
    dependencies: Vec<ProductDependency>,
}

impl ProductLineage {
    /// Creates canonical dependency order and rejects duplicate source identities.
    pub fn new(
        config_hash: ObjectHash,
        mut dependencies: Vec<ProductDependency>,
    ) -> Result<Self, ProductError> {
        validate_hash(&config_hash, "product config hash")?;
        for dependency in &dependencies {
            dependency.validate()?;
        }
        dependencies.sort_by_key(ProductDependency::identity);
        if dependencies
            .windows(2)
            .any(|pair| pair[0].identity() == pair[1].identity())
        {
            return Err(ProductError::DuplicateDependency);
        }
        Ok(Self {
            config_hash,
            dependencies,
        })
    }

    /// Exact configuration hash used by the worker.
    pub const fn config_hash(&self) -> &ObjectHash {
        &self.config_hash
    }

    /// Canonically ordered immutable inputs.
    pub fn dependencies(&self) -> &[ProductDependency] {
        &self.dependencies
    }

    fn validate(&self) -> Result<(), ProductError> {
        validate_hash(&self.config_hash, "product config hash")?;
        let mut identities = BTreeSet::new();
        for dependency in &self.dependencies {
            dependency.validate()?;
            if !identities.insert(dependency.identity()) {
                return Err(ProductError::DuplicateDependency);
            }
        }
        Ok(())
    }
}

/// Immutable output record; a new computation always creates a new run id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductRun {
    id: ProductRunId,
    descriptor: ProductDescriptor,
    output_hash: ObjectHash,
    lineage: ProductLineage,
    tiled_datasets: Vec<TiledDatasetMetadata>,
}

impl ProductRun {
    /// Creates an immutable product run and validates its streaming metadata.
    pub fn new(
        id: ProductRunId,
        descriptor: ProductDescriptor,
        output_hash: ObjectHash,
        lineage: ProductLineage,
        mut tiled_datasets: Vec<TiledDatasetMetadata>,
    ) -> Result<Self, ProductError> {
        if id.0.trim().is_empty() {
            return Err(ProductError::InvalidRun("product run id cannot be empty"));
        }
        validate_hash(&output_hash, "product output hash")?;
        if tiled_datasets.is_empty() {
            return Err(ProductError::InvalidRun(
                "product needs prepared tiled dataset metadata",
            ));
        }
        tiled_datasets.sort_by(|left, right| left.dataset_id.cmp(&right.dataset_id));
        for dataset in &tiled_datasets {
            dataset.validate()?;
        }
        if tiled_datasets
            .windows(2)
            .any(|pair| pair[0].dataset_id == pair[1].dataset_id)
        {
            return Err(ProductError::InvalidRun(
                "tiled dataset ids must be unique within a run",
            ));
        }
        validate_descriptor_datasets(&descriptor, &tiled_datasets)?;
        match &descriptor {
            ProductDescriptor::DepthMaps { image_count } if *image_count == 0 => {
                return Err(ProductError::InvalidRun(
                    "depth-map run needs at least one image",
                ));
            }
            ProductDescriptor::Dem { raster, .. } | ProductDescriptor::Orthomosaic { raster } => {
                raster.validate()?;
            }
            _ => {}
        }
        Ok(Self {
            id,
            descriptor,
            output_hash,
            lineage,
            tiled_datasets,
        })
    }

    pub const fn id(&self) -> &ProductRunId {
        &self.id
    }

    pub const fn descriptor(&self) -> &ProductDescriptor {
        &self.descriptor
    }

    pub const fn kind(&self) -> ProductKind {
        self.descriptor.kind()
    }

    pub const fn output_hash(&self) -> &ObjectHash {
        &self.output_hash
    }

    pub const fn lineage(&self) -> &ProductLineage {
        &self.lineage
    }

    pub fn tiled_datasets(&self) -> &[TiledDatasetMetadata] {
        &self.tiled_datasets
    }

    pub const fn measurement_classification(&self) -> MeasurementClassification {
        self.descriptor.measurement_classification()
    }

    /// Revalidates a run after deserialization without opening tile manifests.
    pub fn validate(&self) -> Result<(), ProductError> {
        if self.id.0.trim().is_empty() || self.tiled_datasets.is_empty() {
            return Err(ProductError::InvalidRun(
                "run id and tiled datasets cannot be empty",
            ));
        }
        validate_hash(&self.output_hash, "product output hash")?;
        self.lineage.validate()?;
        let mut dataset_ids = BTreeSet::new();
        for dataset in &self.tiled_datasets {
            dataset.validate()?;
            if !dataset_ids.insert(&dataset.dataset_id) {
                return Err(ProductError::InvalidRun(
                    "tiled dataset ids must be unique within a run",
                ));
            }
        }
        validate_descriptor_datasets(&self.descriptor, &self.tiled_datasets)?;
        match &self.descriptor {
            ProductDescriptor::DepthMaps { image_count } if *image_count == 0 => {
                return Err(ProductError::InvalidRun(
                    "depth-map run needs at least one image",
                ));
            }
            ProductDescriptor::Dem { raster, .. } | ProductDescriptor::Orthomosaic { raster } => {
                raster.validate()?;
            }
            _ => {}
        }
        Ok(())
    }
}

fn validate_descriptor_datasets(
    descriptor: &ProductDescriptor,
    datasets: &[TiledDatasetMetadata],
) -> Result<(), ProductError> {
    let expected = match descriptor {
        ProductDescriptor::DepthMaps { .. }
        | ProductDescriptor::Dem { .. }
        | ProductDescriptor::Orthomosaic { .. } => TiledDatasetKind::Raster,
        ProductDescriptor::DensePointCloud => TiledDatasetKind::PointCloud,
        ProductDescriptor::TexturedMesh => TiledDatasetKind::Mesh,
        ProductDescriptor::GaussianSplat => TiledDatasetKind::Splat,
    };
    if datasets.iter().all(|dataset| dataset.kind == expected) {
        Ok(())
    } else {
        Err(ProductError::InvalidRun(
            "tiled dataset kind does not match product",
        ))
    }
}

/// Validates references, hashes, acyclicity and required product inputs.
pub fn validate_product_catalog(runs: &[ProductRun]) -> Result<(), ProductError> {
    let mut by_id = BTreeMap::new();
    for run in runs {
        run.validate()?;
        if by_id.insert(run.id.clone(), run).is_some() {
            return Err(ProductError::DuplicateRun(run.id.clone()));
        }
    }
    for run in runs {
        validate_run_dependencies(run, &by_id)?;
    }
    validate_acyclic(&by_id)
}

fn validate_run_dependencies(
    run: &ProductRun,
    catalog: &BTreeMap<ProductRunId, &ProductRun>,
) -> Result<(), ProductError> {
    for dependency in run.lineage.dependencies() {
        if let ProductDependency::Product {
            run_id,
            kind,
            content_hash,
        } = dependency
        {
            let input = catalog
                .get(run_id)
                .ok_or_else(|| ProductError::UnknownDependency(run_id.clone()))?;
            if input.kind() != *kind || input.output_hash() != content_hash {
                return Err(ProductError::DependencyMismatch(run_id.clone()));
            }
        }
    }
    let dependencies = run.lineage.dependencies();
    let has_images = dependencies
        .iter()
        .any(|dependency| matches!(dependency, ProductDependency::SourceImages { .. }));
    let has_alignment = dependencies
        .iter()
        .any(|dependency| matches!(dependency, ProductDependency::Alignment { .. }));
    let has = |kind| {
        dependencies.iter().any(|dependency| {
            matches!(dependency, ProductDependency::Product { kind: dependency_kind, .. } if *dependency_kind == kind)
        })
    };
    let valid = match run.kind() {
        ProductKind::DepthMaps | ProductKind::GaussianSplat => has_images && has_alignment,
        ProductKind::DensePointCloud => has_alignment && has(ProductKind::DepthMaps),
        ProductKind::Dem => {
            has_alignment
                && has(ProductKind::DepthMaps)
                && (has(ProductKind::DensePointCloud) || has(ProductKind::TexturedMesh))
        }
        ProductKind::Orthomosaic => {
            has_images
                && has_alignment
                && has(ProductKind::DepthMaps)
                && (has(ProductKind::Dem) || has(ProductKind::TexturedMesh))
        }
        ProductKind::TexturedMesh => {
            has_images
                && has_alignment
                && has(ProductKind::DepthMaps)
                && has(ProductKind::DensePointCloud)
        }
    };
    if valid {
        Ok(())
    } else {
        Err(ProductError::MissingRequiredDependency(run.kind()))
    }
}

fn validate_acyclic(catalog: &BTreeMap<ProductRunId, &ProductRun>) -> Result<(), ProductError> {
    fn visit(
        id: &ProductRunId,
        catalog: &BTreeMap<ProductRunId, &ProductRun>,
        visiting: &mut BTreeSet<ProductRunId>,
        visited: &mut BTreeSet<ProductRunId>,
    ) -> Result<(), ProductError> {
        if visited.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id.clone()) {
            return Err(ProductError::CyclicLineage(id.clone()));
        }
        for dependency in catalog[id].lineage.dependencies() {
            if let ProductDependency::Product { run_id, .. } = dependency {
                visit(run_id, catalog, visiting, visited)?;
            }
        }
        visiting.remove(id);
        visited.insert(id.clone());
        Ok(())
    }

    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    for id in catalog.keys() {
        visit(id, catalog, &mut visiting, &mut visited)?;
    }
    Ok(())
}

/// Independent per-image tags shown in the tree and image browser.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImageProductTag {
    Aligned,
    DepthReady,
    DepthStale,
    Masked,
    RtkFixed,
    QualityWarning,
}

/// Validated status set for one image.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageProductStatus {
    pub image_id: ImageId,
    pub tags: BTreeSet<ImageProductTag>,
}

impl ImageProductStatus {
    /// Rejects the mutually exclusive ready/stale depth states.
    pub fn validate(&self) -> Result<(), ProductError> {
        if self.tags.contains(&ImageProductTag::DepthReady)
            && self.tags.contains(&ImageProductTag::DepthStale)
        {
            return Err(ProductError::InvalidImageStatus(
                "depth cannot be ready and stale simultaneously",
            ));
        }
        if (self.tags.contains(&ImageProductTag::DepthReady)
            || self.tags.contains(&ImageProductTag::DepthStale))
            && !self.tags.contains(&ImageProductTag::Aligned)
        {
            return Err(ProductError::InvalidImageStatus(
                "depth status requires aligned image",
            ));
        }
        Ok(())
    }

    /// Replaces only the depth tag while retaining all independent tags.
    pub fn with_depth_stale(mut self, stale: bool) -> Result<Self, ProductError> {
        self.tags.remove(&ImageProductTag::DepthReady);
        self.tags.remove(&ImageProductTag::DepthStale);
        self.tags.insert(if stale {
            ImageProductTag::DepthStale
        } else {
            ImageProductTag::DepthReady
        });
        self.validate()?;
        Ok(self)
    }
}

/// Camera depth convention needed for unambiguous pixel unprojection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DepthConvention {
    OpticalAxisZ,
    EuclideanRayDistance,
}

/// Pinhole camera and world transform frozen with one depth image.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepthMapCamera {
    pub image_id: ImageId,
    pub width_pixels: u32,
    pub height_pixels: u32,
    pub focal_x_pixels: f64,
    pub focal_y_pixels: f64,
    pub principal_x_pixels: f64,
    pub principal_y_pixels: f64,
    /// Row-major camera-to-world rotation.
    pub camera_to_world_rotation: [f64; 9],
    pub world_translation_meters: [f64; 3],
    pub convention: DepthConvention,
}

impl DepthMapCamera {
    fn validate(self) -> Result<(), ProductError> {
        if self.width_pixels == 0 || self.height_pixels == 0 {
            return Err(ProductError::InvalidDepthMeasurement(
                "depth camera dimensions must be positive",
            ));
        }
        validate_positive_finite(self.focal_x_pixels, "depth focal x")?;
        validate_positive_finite(self.focal_y_pixels, "depth focal y")?;
        validate_finite(self.principal_x_pixels, "depth principal x")?;
        validate_finite(self.principal_y_pixels, "depth principal y")?;
        for value in self
            .camera_to_world_rotation
            .into_iter()
            .chain(self.world_translation_meters)
        {
            validate_finite(value, "depth camera transform")?;
        }
        validate_rotation_matrix(self.camera_to_world_rotation)?;
        Ok(())
    }
}

fn validate_rotation_matrix(rotation: [f64; 9]) -> Result<(), ProductError> {
    let rows = [
        [rotation[0], rotation[1], rotation[2]],
        [rotation[3], rotation[4], rotation[5]],
        [rotation[6], rotation[7], rotation[8]],
    ];
    let dot = |first: [f64; 3], second: [f64; 3]| {
        first[0] * second[0] + first[1] * second[1] + first[2] * second[2]
    };
    let unit_rows = rows
        .iter()
        .all(|row| (dot(*row, *row) - 1.0).abs() <= 1.0e-6);
    let orthogonal = dot(rows[0], rows[1]).abs() <= 1.0e-6
        && dot(rows[0], rows[2]).abs() <= 1.0e-6
        && dot(rows[1], rows[2]).abs() <= 1.0e-6;
    if unit_rows && orthogonal {
        Ok(())
    } else {
        Err(ProductError::InvalidDepthMeasurement(
            "camera-to-world rotation must be orthonormal",
        ))
    }
}

/// Uncertainty attached to a valid depth sample.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepthUncertainty {
    pub depth_stddev_meters: f64,
    pub lateral_stddev_meters: f64,
    pub confidence_per_mille: u16,
}

impl DepthUncertainty {
    fn validate(self) -> Result<(), ProductError> {
        validate_non_negative_finite(self.depth_stddev_meters, "depth uncertainty")?;
        validate_non_negative_finite(self.lateral_stddev_meters, "lateral uncertainty")?;
        if self.confidence_per_mille > 1_000 {
            return Err(ProductError::InvalidDepthMeasurement(
                "depth confidence must be in 0..=1000",
            ));
        }
        Ok(())
    }
}

/// Why a depth pixel cannot yield survey coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InvalidDepthReason {
    OcclusionConflict,
    LowConfidence,
    OutsideReconstruction,
    Masked,
}

/// Depth tile sample with explicit valid, invalid and no-data states.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum DepthPixelValue {
    Valid {
        depth_meters: f64,
        uncertainty: DepthUncertainty,
    },
    Invalid {
        reason: InvalidDepthReason,
    },
    NoData,
}

/// Pixel request against one depth map.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepthPixelSample {
    pub x: u32,
    pub y: u32,
    pub value: DepthPixelValue,
}

/// Pixel-to-world result; invalid/no-data never fabricate a coordinate.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum DepthMeasurement {
    Valid {
        world_meters: [f64; 3],
        uncertainty: DepthUncertainty,
    },
    Invalid {
        reason: InvalidDepthReason,
    },
    NoData,
}

/// Converts a valid pinhole depth pixel to world coordinates.
pub fn measure_depth_pixel(
    camera: DepthMapCamera,
    sample: DepthPixelSample,
) -> Result<DepthMeasurement, ProductError> {
    camera.validate()?;
    if sample.x >= camera.width_pixels || sample.y >= camera.height_pixels {
        return Err(ProductError::InvalidDepthMeasurement(
            "depth pixel lies outside the camera image",
        ));
    }
    let DepthPixelValue::Valid {
        depth_meters,
        uncertainty,
    } = sample.value
    else {
        return Ok(match sample.value {
            DepthPixelValue::Invalid { reason } => DepthMeasurement::Invalid { reason },
            DepthPixelValue::NoData => DepthMeasurement::NoData,
            DepthPixelValue::Valid { .. } => unreachable!(),
        });
    };
    validate_positive_finite(depth_meters, "depth value")?;
    uncertainty.validate()?;
    let normalized_x =
        (f64::from(sample.x) + 0.5 - camera.principal_x_pixels) / camera.focal_x_pixels;
    let normalized_y =
        (f64::from(sample.y) + 0.5 - camera.principal_y_pixels) / camera.focal_y_pixels;
    let mut ray = [normalized_x, normalized_y, 1.0];
    if camera.convention == DepthConvention::EuclideanRayDistance {
        let norm = ray[0].hypot(ray[1]).hypot(ray[2]);
        for component in &mut ray {
            *component /= norm;
        }
    }
    let camera_point = ray.map(|component| component * depth_meters);
    let rotation = camera.camera_to_world_rotation;
    let world = [
        rotation[0] * camera_point[0]
            + rotation[1] * camera_point[1]
            + rotation[2] * camera_point[2]
            + camera.world_translation_meters[0],
        rotation[3] * camera_point[0]
            + rotation[4] * camera_point[1]
            + rotation[5] * camera_point[2]
            + camera.world_translation_meters[1],
        rotation[6] * camera_point[0]
            + rotation[7] * camera_point[1]
            + rotation[8] * camera_point[2]
            + camera.world_translation_meters[2],
    ];
    Ok(DepthMeasurement::Valid {
        world_meters: world,
        uncertainty,
    })
}

/// Root whose previous content was invalidated by a command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "source")]
pub enum InvalidatedLineageInput {
    SourceImages { previous_hash: ObjectHash },
    Alignment { previous_hash: ObjectHash },
    Product { run_id: ProductRunId },
}

/// Effective stale runs and their first deterministic invalidating root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleProduct {
    pub run_id: ProductRunId,
    pub invalidated_by: InvalidatedLineageInput,
}

/// Propagates source/alignment/product changes through immutable lineage edges.
pub fn propagate_stale_products(
    runs: &[ProductRun],
    roots: &[InvalidatedLineageInput],
) -> Result<Vec<StaleProduct>, ProductError> {
    validate_product_catalog(runs)?;
    let mut roots = roots.to_vec();
    roots.sort_by(compare_invalidated_inputs);
    roots.dedup();
    let mut stale = BTreeMap::<ProductRunId, InvalidatedLineageInput>::new();
    let mut changed = true;
    while changed {
        changed = false;
        for run in runs {
            if stale.contains_key(run.id()) {
                continue;
            }
            let direct_root = roots.iter().find(|root| lineage_matches_root(run, root));
            let upstream_root = run.lineage().dependencies().iter().find_map(|dependency| {
                let ProductDependency::Product { run_id, .. } = dependency else {
                    return None;
                };
                stale.get(run_id)
            });
            if let Some(root) = direct_root.or(upstream_root) {
                stale.insert(run.id().clone(), root.clone());
                changed = true;
            }
        }
    }
    Ok(stale
        .into_iter()
        .map(|(run_id, invalidated_by)| StaleProduct {
            run_id,
            invalidated_by,
        })
        .collect())
}

fn compare_invalidated_inputs(
    left: &InvalidatedLineageInput,
    right: &InvalidatedLineageInput,
) -> std::cmp::Ordering {
    fn parts(root: &InvalidatedLineageInput) -> (u8, &str) {
        match root {
            InvalidatedLineageInput::SourceImages { previous_hash } => (0, previous_hash.as_str()),
            InvalidatedLineageInput::Alignment { previous_hash } => (1, previous_hash.as_str()),
            InvalidatedLineageInput::Product { run_id } => (2, &run_id.0),
        }
    }
    parts(left).cmp(&parts(right))
}

fn lineage_matches_root(run: &ProductRun, root: &InvalidatedLineageInput) -> bool {
    run.lineage().dependencies().iter().any(|dependency| {
        matches!(
            (dependency, root),
            (
                ProductDependency::SourceImages { content_hash },
                InvalidatedLineageInput::SourceImages { previous_hash }
            ) if content_hash == previous_hash
        ) || matches!(
            (dependency, root),
            (
                ProductDependency::Alignment { content_hash },
                InvalidatedLineageInput::Alignment { previous_hash }
            ) if content_hash == previous_hash
        ) || matches!(
            (dependency, root),
            (
                ProductDependency::Product { run_id: dependency_id, .. },
                InvalidatedLineageInput::Product { run_id }
            ) if dependency_id == run_id
        )
    })
}

/// Validates that a raster display mode references a compatible product.
pub fn validate_raster_display_mode(
    mode: &RasterDisplayMode,
    runs: &[ProductRun],
) -> Result<(), ProductError> {
    validate_product_catalog(runs)?;
    let by_id = runs
        .iter()
        .map(|run| (run.id(), run))
        .collect::<BTreeMap<_, _>>();
    let required = match mode {
        RasterDisplayMode::LockedTopDown2d => return Ok(()),
        RasterDisplayMode::DrapedOnElevation3d { surface_run_id } => {
            (surface_run_id, ProductKind::Dem)
        }
        RasterDisplayMode::TexturedMesh3d { mesh_run_id } => {
            (mesh_run_id, ProductKind::TexturedMesh)
        }
    };
    let run = by_id
        .get(&required.0)
        .ok_or_else(|| ProductError::UnknownDependency(required.0.clone()))?;
    if run.kind() == required.1 {
        Ok(())
    } else {
        Err(ProductError::InvalidDisplayMode)
    }
}

fn validate_hash(hash: &ObjectHash, field: &'static str) -> Result<(), ProductError> {
    let value = hash.as_str();
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(ProductError::InvalidHash(field))
    }
}

fn validate_finite(value: f64, field: &'static str) -> Result<(), ProductError> {
    if value.is_finite() {
        Ok(())
    } else {
        Err(ProductError::NonFiniteValue(field))
    }
}

fn validate_positive_finite(value: f64, field: &'static str) -> Result<(), ProductError> {
    validate_finite(value, field)?;
    if value > 0.0 {
        Ok(())
    } else {
        Err(ProductError::NonPositiveValue(field))
    }
}

fn validate_non_negative_finite(value: f64, field: &'static str) -> Result<(), ProductError> {
    validate_finite(value, field)?;
    if value >= 0.0 {
        Ok(())
    } else {
        Err(ProductError::NegativeValue(field))
    }
}

/// Product contract or lineage validation failure.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ProductError {
    #[error("invalid product run: {0}")]
    InvalidRun(&'static str),
    #[error("invalid tiled dataset: {0}")]
    InvalidTiledDataset(&'static str),
    #[error("invalid raster pyramid: {0}")]
    InvalidRasterPyramid(&'static str),
    #[error("invalid depth measurement: {0}")]
    InvalidDepthMeasurement(&'static str),
    #[error("invalid image product status: {0}")]
    InvalidImageStatus(&'static str),
    #[error("invalid raster display mode")]
    InvalidDisplayMode,
    #[error("invalid content hash in {0}")]
    InvalidHash(&'static str),
    #[error("non-finite value in {0}")]
    NonFiniteValue(&'static str),
    #[error("non-positive value in {0}")]
    NonPositiveValue(&'static str),
    #[error("negative value in {0}")]
    NegativeValue(&'static str),
    #[error("duplicate product run id: {0:?}")]
    DuplicateRun(ProductRunId),
    #[error("duplicate dependency identity in lineage")]
    DuplicateDependency,
    #[error("unknown product dependency: {0:?}")]
    UnknownDependency(ProductRunId),
    #[error("product dependency kind or hash mismatch: {0:?}")]
    DependencyMismatch(ProductRunId),
    #[error("missing required dependency for {0:?}")]
    MissingRequiredDependency(ProductKind),
    #[error("cyclic product lineage at {0:?}")]
    CyclicLineage(ProductRunId),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash(seed: &str) -> ObjectHash {
        ObjectHash::of_bytes(seed.as_bytes())
    }

    fn bounds() -> DatasetBounds {
        DatasetBounds {
            minimum: [0.0, 0.0, 0.0],
            maximum: [100.0, 100.0, 50.0],
        }
    }

    fn dataset(id: &str, kind: TiledDatasetKind) -> TiledDatasetMetadata {
        let spatial_index = match kind {
            TiledDatasetKind::PointCloud => TileSpatialIndexKind::PointOctree,
            TiledDatasetKind::Mesh => TileSpatialIndexKind::TriangleBvh,
            TiledDatasetKind::Splat => TileSpatialIndexKind::SplatTree,
            TiledDatasetKind::Raster => TileSpatialIndexKind::RasterGrid,
        };
        TiledDatasetMetadata {
            dataset_id: id.to_owned(),
            kind,
            root_tile_id: "root".to_owned(),
            tile_manifest_hash: hash(&format!("manifest-{id}")),
            bounds: bounds(),
            level_count: 3,
            spatial_index,
            content: TiledContentSummary::default(),
        }
    }

    fn raster() -> RasterPyramid {
        RasterPyramid {
            tile_scheme: RasterTileScheme::ProjectedQuadtreeTopLeft,
            origin_east_meters: 500_000.0,
            origin_north_meters: 5_400_000.0,
            tile_size_pixels: 256,
            no_data: RasterNoData::AlphaMask,
            horizontal_crs: "EPSG:25832".to_owned(),
            vertical_crs: Some("DHHN2016".to_owned()),
            levels: [0.05, 0.10, 0.20, 0.40]
                .into_iter()
                .enumerate()
                .map(|(level, resolution)| RasterPyramidLevel {
                    level: u16::try_from(level).expect("test level"),
                    resolution_meters_per_pixel: resolution,
                    tile_columns: 16_u32 >> level,
                    tile_rows: 16_u32 >> level,
                    tile_index_hash: hash(&format!("tile-index-{level}")),
                    content_hash: hash(&format!("level-content-{level}")),
                })
                .collect(),
            pyramid_manifest_hash: hash("pyramid"),
        }
    }

    fn lineage(dependencies: Vec<ProductDependency>) -> ProductLineage {
        ProductLineage::new(hash("config"), dependencies).expect("lineage should build")
    }

    fn base_dependencies() -> Vec<ProductDependency> {
        vec![
            ProductDependency::SourceImages {
                content_hash: hash("images"),
            },
            ProductDependency::Alignment {
                content_hash: hash("alignment"),
            },
        ]
    }

    fn product_dependency(run: &ProductRun) -> ProductDependency {
        ProductDependency::Product {
            run_id: run.id().clone(),
            kind: run.kind(),
            content_hash: run.output_hash().clone(),
        }
    }

    fn product_catalog() -> Vec<ProductRun> {
        let depth = ProductRun::new(
            ProductRunId("depth-1".to_owned()),
            ProductDescriptor::DepthMaps { image_count: 10 },
            hash("depth-output"),
            lineage(base_dependencies()),
            vec![dataset("depth", TiledDatasetKind::Raster)],
        )
        .expect("depth run");
        let dense = ProductRun::new(
            ProductRunId("dense-1".to_owned()),
            ProductDescriptor::DensePointCloud,
            hash("dense-output"),
            lineage(vec![
                ProductDependency::Alignment {
                    content_hash: hash("alignment"),
                },
                product_dependency(&depth),
            ]),
            vec![dataset("dense", TiledDatasetKind::PointCloud)],
        )
        .expect("dense run");
        let dem = ProductRun::new(
            ProductRunId("dem-1".to_owned()),
            ProductDescriptor::Dem {
                surface_kind: DemSurfaceKind::Dsm,
                raster: raster(),
            },
            hash("dem-output"),
            lineage(vec![
                ProductDependency::Alignment {
                    content_hash: hash("alignment"),
                },
                product_dependency(&depth),
                product_dependency(&dense),
            ]),
            vec![dataset("dem", TiledDatasetKind::Raster)],
        )
        .expect("DEM run");
        let mesh = ProductRun::new(
            ProductRunId("mesh-1".to_owned()),
            ProductDescriptor::TexturedMesh,
            hash("mesh-output"),
            lineage(vec![
                ProductDependency::SourceImages {
                    content_hash: hash("images"),
                },
                ProductDependency::Alignment {
                    content_hash: hash("alignment"),
                },
                product_dependency(&depth),
                product_dependency(&dense),
            ]),
            vec![dataset("mesh", TiledDatasetKind::Mesh)],
        )
        .expect("mesh run");
        let ortho = ProductRun::new(
            ProductRunId("ortho-1".to_owned()),
            ProductDescriptor::Orthomosaic { raster: raster() },
            hash("ortho-output"),
            lineage(vec![
                ProductDependency::SourceImages {
                    content_hash: hash("images"),
                },
                ProductDependency::Alignment {
                    content_hash: hash("alignment"),
                },
                product_dependency(&depth),
                product_dependency(&dem),
            ]),
            vec![dataset("ortho", TiledDatasetKind::Raster)],
        )
        .expect("ortho run");
        let splat = ProductRun::new(
            ProductRunId("splat-1".to_owned()),
            ProductDescriptor::GaussianSplat,
            hash("splat-output"),
            lineage(base_dependencies()),
            vec![dataset("splat", TiledDatasetKind::Splat)],
        )
        .expect("splat run");
        vec![ortho, splat, mesh, dem, dense, depth]
    }

    #[test]
    fn complete_catalog_validates_and_splat_is_appearance_only() {
        let runs = product_catalog();
        validate_product_catalog(&runs).expect("catalog should validate");
        let splat = runs
            .iter()
            .find(|run| run.kind() == ProductKind::GaussianSplat)
            .expect("splat run");
        assert_eq!(
            splat.measurement_classification(),
            MeasurementClassification::AppearanceOnlyNonSurvey
        );
        let encoded = serde_json::to_string(splat).expect("serialize run");
        let decoded: ProductRun = serde_json::from_str(&encoded).expect("deserialize run");
        assert_eq!(decoded, *splat);
    }

    #[test]
    fn product_constructor_rejects_dataset_special_case_mismatch() {
        let result = ProductRun::new(
            ProductRunId("bad-dense".to_owned()),
            ProductDescriptor::DensePointCloud,
            hash("output"),
            lineage(base_dependencies()),
            vec![dataset("bad", TiledDatasetKind::Raster)],
        );
        assert_eq!(
            result,
            Err(ProductError::InvalidRun(
                "tiled dataset kind does not match product"
            ))
        );
    }

    #[test]
    fn catalog_rejects_missing_required_product_dependencies() {
        let splat = ProductRun::new(
            ProductRunId("incomplete-splat".to_owned()),
            ProductDescriptor::GaussianSplat,
            hash("incomplete-output"),
            lineage(vec![ProductDependency::Alignment {
                content_hash: hash("alignment"),
            }]),
            vec![dataset("splat", TiledDatasetKind::Splat)],
        )
        .expect("run structure itself is valid");
        assert_eq!(
            validate_product_catalog(&[splat]),
            Err(ProductError::MissingRequiredDependency(
                ProductKind::GaussianSplat
            ))
        );
    }

    #[test]
    fn stale_alignment_propagates_through_all_downstream_products() {
        let runs = product_catalog();
        let stale = propagate_stale_products(
            &runs,
            &[InvalidatedLineageInput::Alignment {
                previous_hash: hash("alignment"),
            }],
        )
        .expect("stale propagation should work");
        assert_eq!(stale.len(), runs.len());
        assert!(stale.windows(2).all(|pair| pair[0].run_id < pair[1].run_id));
    }

    #[test]
    fn image_depth_state_changes_without_losing_independent_tags() {
        let status = ImageProductStatus {
            image_id: ImageId(7),
            tags: BTreeSet::from([
                ImageProductTag::Aligned,
                ImageProductTag::DepthReady,
                ImageProductTag::Masked,
                ImageProductTag::RtkFixed,
            ]),
        };
        let stale = status
            .with_depth_stale(true)
            .expect("state should transition");
        assert!(stale.tags.contains(&ImageProductTag::DepthStale));
        assert!(stale.tags.contains(&ImageProductTag::Masked));
        assert!(stale.tags.contains(&ImageProductTag::RtkFixed));
        assert!(!stale.tags.contains(&ImageProductTag::DepthReady));
    }

    #[test]
    fn depth_pixel_measurement_preserves_invalid_and_no_data() {
        let camera = DepthMapCamera {
            image_id: ImageId(1),
            width_pixels: 100,
            height_pixels: 100,
            focal_x_pixels: 100.0,
            focal_y_pixels: 100.0,
            principal_x_pixels: 50.5,
            principal_y_pixels: 50.5,
            camera_to_world_rotation: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            world_translation_meters: [10.0, 20.0, 30.0],
            convention: DepthConvention::OpticalAxisZ,
        };
        let valid = measure_depth_pixel(
            camera,
            DepthPixelSample {
                x: 50,
                y: 50,
                value: DepthPixelValue::Valid {
                    depth_meters: 5.0,
                    uncertainty: DepthUncertainty {
                        depth_stddev_meters: 0.02,
                        lateral_stddev_meters: 0.01,
                        confidence_per_mille: 950,
                    },
                },
            },
        )
        .expect("measurement should work");
        let DepthMeasurement::Valid { world_meters, .. } = valid else {
            panic!("expected valid measurement")
        };
        assert!(world_meters
            .into_iter()
            .zip([10.0, 20.0, 35.0])
            .all(|(actual, expected)| (actual - expected).abs() < f64::EPSILON));

        let invalid = measure_depth_pixel(
            camera,
            DepthPixelSample {
                x: 2,
                y: 2,
                value: DepthPixelValue::Invalid {
                    reason: InvalidDepthReason::Masked,
                },
            },
        )
        .expect("invalid sample is a valid state");
        assert_eq!(
            invalid,
            DepthMeasurement::Invalid {
                reason: InvalidDepthReason::Masked
            }
        );
        let no_data = measure_depth_pixel(
            camera,
            DepthPixelSample {
                x: 3,
                y: 3,
                value: DepthPixelValue::NoData,
            },
        )
        .expect("no-data sample is a valid state");
        assert_eq!(no_data, DepthMeasurement::NoData);
    }

    #[test]
    fn raster_level_selection_uses_screen_gsd_without_undersampling() {
        let pyramid = raster();
        let selected =
            select_raster_level_for_screen_gsd(&pyramid, 0.18).expect("level should be selected");
        assert_eq!(selected.level, 1);
        let far = select_raster_level_for_screen_gsd(&pyramid, 1.0)
            .expect("coarsest level should be selected");
        assert_eq!(far.level, 3);
    }

    #[test]
    fn raster_display_modes_require_matching_surface_products() {
        let runs = product_catalog();
        assert!(validate_raster_display_mode(
            &RasterDisplayMode::DrapedOnElevation3d {
                surface_run_id: ProductRunId("dem-1".to_owned())
            },
            &runs
        )
        .is_ok());
        assert_eq!(
            validate_raster_display_mode(
                &RasterDisplayMode::TexturedMesh3d {
                    mesh_run_id: ProductRunId("dem-1".to_owned())
                },
                &runs
            ),
            Err(ProductError::InvalidDisplayMode)
        );
    }
}
