pub(crate) const METHODS: &[&str] = &[
    "app.negotiate",
    "app.protocol",
    "automation.bulk.read",
    "automation.bulk.release",
    "automation.cas.describe",
    "automation.commands.cancel",
    "automation.commands.status",
    "automation.commands.validate",
    "automation.entities.page",
    "builder.project.archive.cancel",
    "builder.project.archive.pack",
    "builder.project.archive.unpack",
    "canonical.project.close",
    "canonical.project.durability",
    "canonical.project.open",
    "canonical.residency.bootstrap",
    "canonical.residency.resource.read",
    "canonical.viewing_box.delete",
    "canonical.viewing_box.list",
    "canonical.viewing_box.put",
    "draw.curve.list",
    "draw.curve.put",
    "draw.curve.redo",
    "draw.curve.undo",
    "import.ifc",
    "import.las",
    "import.las.cancel",
    "io.export.execute",
    "io.export.plan",
    "io.formats.page",
    "io.import.execute",
    "io.operation.cancel",
    "io.operation.status",
    "io.probe",
    "measurement.create",
    "measurement.get",
    "measurement.list",
    "measurement.remove",
    "mesh.edit.cancel",
    "mesh.edit.downsample",
    "mesh.edit.downsample.preview",
    "mesh.edit.region.select",
    "mesh.edit.smooth",
    "mesh.edit.smooth.preview",
    "mesh.surface.cancel",
    "mesh.surface.check",
    "mesh.surface.create",
    "mesh.surface.draft.apply_fix",
    "mesh.surface.draft.create",
    "photolab.alignment.resolve",
    "photolab.alignmentMerge.preflight",
    "photolab.capture.cancel",
    "photolab.capture.capabilities",
    "photolab.capture.image.prepare",
    "photolab.capture.scale.evaluate",
    "photolab.capture.video.prepare",
    "photolab.crs.cancel",
    "photolab.crs.discover",
    "photolab.crs.freeze",
    "photolab.gcp.alignedCameras",
    "photolab.gcp.calibrationReport",
    "photolab.gcp.cancel",
    "photolab.gcp.commit",
    "photolab.gcp.list",
    "photolab.gcp.localEstimate.compute",
    "photolab.gcp.localEstimate.read",
    "photolab.gcp.observation.edit",
    "photolab.gcp.observation.upsert",
    "photolab.gcp.observation.upsertAssisted",
    "photolab.gcp.optimization.latest",
    "photolab.gcp.optimization.list",
    "photolab.gcp.optimization.snapshot",
    "photolab.gcp.preview",
    "photolab.hardware.probe",
    "photolab.himmelcap.cancel",
    "photolab.himmelcap.inspect",
    "photolab.himmelcap.release",
    "photolab.images.commit",
    "photolab.images.commit.cancel",
    "photolab.images.inspect",
    "photolab.images.inspect.cancel",
    "photolab.images.list",
    "photolab.images.quality.list",
    "photolab.jobs.cancel",
    "photolab.jobs.list",
    "photolab.jobs.resume",
    "photolab.jobs.startAlignment",
    "photolab.jobs.startAlignmentMerge",
    "photolab.jobs.startBatch",
    "photolab.jobs.startGcpOptimization",
    "photolab.jobs.startImageQuality",
    "photolab.jobs.startProduct",
    "photolab.jobs.startProductExport",
    "photolab.jobs.status",
    "photolab.products.list",
    "photolab.products.resolveInputs",
    "photolab.project.alignmentMerge.candidates",
    "photolab.project.alignmentMerge.create",
    "photolab.project.alignmentMerge.list",
    "photolab.project.archive.cancel",
    "photolab.project.autosave",
    "photolab.project.calibrationGroup.list",
    "photolab.project.calibrationGroup.setInitialCalibration",
    "photolab.project.calibrationGroup.updateIntrinsics",
    "photolab.project.captureGroup.confirm",
    "photolab.project.captureGroup.create",
    "photolab.project.captureGroup.duplicateAsDraft",
    "photolab.project.captureGroup.list",
    "photolab.project.captureGroup.mergeProposals",
    "photolab.project.close",
    "photolab.project.create",
    "photolab.project.diagnostics",
    "photolab.project.entity.move",
    "photolab.project.entity.rename",
    "photolab.project.entity.visibility",
    "photolab.project.imageMask.cancel",
    "photolab.project.imageMask.edit",
    "photolab.project.imageMask.list",
    "photolab.project.images.cancel",
    "photolab.project.images.commit",
    "photolab.project.images.remove",
    "photolab.project.journal.finish",
    "photolab.project.journal.start",
    "photolab.project.open",
    "photolab.project.processingSet.create",
    "photolab.project.processingSet.list",
    "photolab.project.save",
    "photolab.project.saveAs",
    "photolab.project.snapshot",
    "photolab.report.surveyData",
    "photolab.shutdown.drain",
    "ping",
    "pointcloud.display.set",
    "pointcloud.ground.cancel",
    "pointcloud.ground.extract",
    "pointcloud.ground.preview",
    "pointcloud.processing.cancel",
    "pointcloud.rasterize",
    "pointcloud.sample",
    "pointcloud.segment.cancel",
    "pointcloud.segment.keep_inside",
    "pointcloud.segment.remove_inside",
    "product.import.provenance",
    "project.flush",
    "project.redo",
    "project.undo",
    "registration.import.commit",
    "registration.import.stage",
    "registration.preview.icp",
    "registration.preview.pointPairs",
    "registration.resource.read",
    "registration.resources.describe",
    "registration.samples.projectPointCloud",
    "registration.samples.source",
    "registration.session.cancel",
    "registration.session.state",
    "registration.siteCalibration.inspect",
    "snapshot.create",
    "snapshot.list",
    "snapshot.restore",
    "view.bookmark.create",
    "view.bookmark.list",
    "view.bookmark.restore",
];

pub(crate) fn handler_family(method: &str) -> &'static str {
    if method.starts_with("photolab.project.") {
        "photolab-project"
    } else if method.starts_with("photolab.jobs.") {
        "photolab-jobs"
    } else if method.starts_with("photolab.crs.") {
        "photolab-crs"
    } else if method.starts_with("photolab.images.") {
        "photolab-images"
    } else if method.starts_with("photolab.himmelcap.") {
        "photolab-himmelcap"
    } else if method.starts_with("photolab.capture.") {
        "photolab-capture"
    } else if method.starts_with("photolab.gcp.") {
        "photolab-gcp"
    } else if method.starts_with("photolab.products.") {
        "photolab-products"
    } else if method.starts_with("registration.") {
        "registration"
    } else if method.starts_with("io.") {
        "io"
    } else if method.starts_with("builder.project.archive.") {
        "builder-archive"
    } else if method.starts_with("automation.") {
        "automation"
    } else if method.starts_with("pointcloud.segment.") {
        "pointcloud-segment"
    } else if method.starts_with("pointcloud.ground.") {
        "pointcloud-ground"
    } else if matches!(
        method,
        "pointcloud.sample" | "pointcloud.rasterize" | "pointcloud.processing.cancel"
    ) {
        "pointcloud-processing"
    } else if method.starts_with("mesh.surface.") || method.starts_with("mesh.edit.") {
        "mesh-surface"
    } else if routes_to_canonical_app(method) {
        "canonical-app"
    } else {
        "root"
    }
}

fn routes_to_canonical_app(method: &str) -> bool {
    method == "app.negotiate"
        || method == "app.protocol"
        || matches!(method, "project.flush" | "project.undo" | "project.redo")
        || method.starts_with("snapshot.")
        || method.starts_with("canonical.project.")
        || method.starts_with("canonical.residency.")
        || method.starts_with("canonical.viewing_box.")
        || method.starts_with("measurement.")
        || method.starts_with("draw.curve.")
        || method.starts_with("view.bookmark.")
        || method == "pointcloud.display.set"
        || method == "product.import.provenance"
}

pub(crate) fn product(method: &str) -> &'static str {
    if method.starts_with("photolab.") {
        "photolab"
    } else if method.starts_with("builder.")
        || method.starts_with("pointcloud.")
        || method.starts_with("mesh.")
        || method.starts_with("measurement.")
        || method.starts_with("draw.")
        || method.starts_with("view.bookmark.")
        || method.starts_with("snapshot.")
        || method.starts_with("product.import.")
        || matches!(method, "import.las" | "import.las.cancel" | "import.ifc")
        || matches!(method, "project.flush" | "project.undo" | "project.redo")
        || method.starts_with("canonical.viewing_box.")
    {
        "builder"
    } else {
        "shared"
    }
}
