//! Sidecar composition adapter for PhotoLab product export capabilities.

use std::path::Path;

use himmelcad_domain_photogrammetry::product_export::{
    export_product_with_transcoder, PointCloudTranscodeSummary, PointCloudTranscoder,
};
use himmelcad_domain_pointcloud::pointcloud_export::{
    transcode_ply_atomic, PointCloudExportError, PointCloudExportFormat,
};
use himmelcad_process::jobs::CancellationToken;

pub use himmelcad_domain_photogrammetry::product_export::{
    ProductExportConversion, ProductExportError, ProductExportRequest, ProductExportSource,
    ProductExportSourceKind, ProductExportSummary,
};

#[derive(Debug)]
struct SidecarPointCloudTranscoder;

impl PointCloudTranscoder for SidecarPointCloudTranscoder {
    fn transcode(
        &self,
        source: &Path,
        destination: &Path,
        operation_id: &str,
        format: PointCloudExportFormat,
        crs_wkt: Option<&str>,
        cancellation: &CancellationToken,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<PointCloudTranscodeSummary, ProductExportError> {
        transcode_ply_atomic(
            source,
            destination,
            operation_id,
            format,
            crs_wkt,
            cancellation,
            progress,
        )
        .map(|summary| PointCloudTranscodeSummary {
            bytes: summary.bytes,
        })
        .map_err(|error| match error {
            PointCloudExportError::Cancelled => ProductExportError::Cancelled,
            PointCloudExportError::Io(error) => ProductExportError::Io(error),
            PointCloudExportError::InvalidPly(message) => {
                ProductExportError::InvalidRequest(message)
            }
            PointCloudExportError::Las(error) => {
                ProductExportError::InvalidRequest(error.to_string())
            }
        })
    }
}

pub fn export_product(
    request: &ProductExportRequest,
    cancellation: &CancellationToken,
    progress: impl FnMut(u64, u64),
) -> Result<ProductExportSummary, ProductExportError> {
    export_product_with_transcoder(
        request,
        cancellation,
        progress,
        &SidecarPointCloudTranscoder,
    )
}
