//! Materializing geometry transforms (no lazy paths).
//!
//! Builds on [`TransformRuntime::apply_points`] for vertex maps and adds:
//! - densify → map for circles/arcs
//! - optional best-fit circle preserve
//! - Jacobian-based vector/frame maps
//! - text height policies
//! - inverse-map raster warp (in-memory f64 grids)

use himmelcad_core::{
    photolab_jobs::CancellationToken,
    transform::{apply_empirical, EmpiricalOp, FrozenTransform, TransformStage, WorldPoint},
    transform_geometry::{
        classify_geometry, densify_arc, densify_circle, fit_circle_xy, mean_radius_xy,
        vec_normalize, Arc3, Circle3, CirclePolicy, GeometryKind, GeometryStrategy,
        GeometryTransformError, GeometryTransformPolicy, GeometryTransformWarning,
        GeometryWarningCode, RasterGrid2D, TextAnchor, TextScalePolicy, TransformSupport,
        TransformedText,
    },
};

use crate::transform_runtime::{TransformRuntime, TransformRuntimeError};

/// Aggregated result for a geometry transform job.
#[derive(Debug, Clone)]
pub struct GeometryTransformResult<T> {
    pub value: T,
    pub warnings: Vec<GeometryTransformWarning>,
}

impl TransformRuntime {
    /// Classify geometry under this frozen transform + policy.
    pub fn classify(
        &self,
        frozen: &FrozenTransform,
        kind: GeometryKind,
        policy: &GeometryTransformPolicy,
        geometry_id: Option<&str>,
    ) -> himmelcad_core::transform_geometry::GeometryClassification {
        let policy = frozen.spec.geometry_policy.as_ref().unwrap_or(policy);
        classify_geometry(kind, &frozen.spec, policy, geometry_id)
    }

    /// Map discrete vertices (and optional normals via Jacobian).
    pub fn map_vertices(
        &self,
        frozen: &FrozenTransform,
        positions: &[WorldPoint],
        normals: Option<&[WorldPoint]>,
        policy: &GeometryTransformPolicy,
        cancellation: &CancellationToken,
    ) -> Result<
        GeometryTransformResult<(Vec<WorldPoint>, Option<Vec<WorldPoint>>)>,
        TransformRuntimeError,
    > {
        let mapped = self.apply_points(frozen, positions, cancellation)?;
        let mut warnings = Vec::new();
        for w in &mapped.warnings {
            warnings.push(GeometryTransformWarning {
                code: GeometryWarningCode::OutOfBounds,
                message: w.clone(),
                geometry_id: None,
            });
        }
        let out_normals = if let Some(ns) = normals {
            if ns.len() != positions.len() {
                return Err(TransformRuntimeError::RowCountMismatch {
                    expected: positions.len(),
                    got: ns.len(),
                });
            }
            warnings.push(GeometryTransformWarning {
                code: GeometryWarningCode::OrientationLinearized,
                message: "normals transformed with local Jacobian".into(),
                geometry_id: None,
            });
            let mut out = Vec::with_capacity(ns.len());
            for (p, n) in positions.iter().zip(ns.iter()) {
                out.push(self.map_vector_at(frozen, *p, *n, policy, cancellation)?);
            }
            Some(out)
        } else {
            None
        };
        Ok(GeometryTransformResult {
            value: (mapped.points, out_normals),
            warnings,
        })
    }

    /// Numerical Jacobian: map free vector `v` at base point `p`.
    pub fn map_vector_at(
        &self,
        frozen: &FrozenTransform,
        p: WorldPoint,
        v: WorldPoint,
        policy: &GeometryTransformPolicy,
        cancellation: &CancellationToken,
    ) -> Result<WorldPoint, TransformRuntimeError> {
        // Pure empirical chain: analytic for similarity/translation; else finite difference.
        if let Some(mapped) = try_map_vector_empirical(&frozen.spec.stages, p, v) {
            return Ok(mapped);
        }
        let h = policy.jacobian_step_meters.max(1e-4);
        let len = (v.x * v.x + v.y * v.y + v.z * v.z).sqrt();
        if len < 1e-15 {
            return Ok(WorldPoint::new(0.0, 0.0, 0.0));
        }
        let dir = WorldPoint::new(v.x / len, v.y / len, v.z / len);
        let p0 = p;
        let p1 = WorldPoint::new(p.x + dir.x * h, p.y + dir.y * h, p.z + dir.z * h);
        let batch = self.apply_points(frozen, &[p0, p1], cancellation)?;
        if batch.points.len() != 2 {
            return Err(TransformRuntimeError::RowCountMismatch {
                expected: 2,
                got: batch.points.len(),
            });
        }
        let d = WorldPoint::new(
            (batch.points[1].x - batch.points[0].x) / h * len,
            (batch.points[1].y - batch.points[0].y) / h * len,
            (batch.points[1].z - batch.points[0].z) / h * len,
        );
        Ok(vec_normalize(d).unwrap_or(d))
    }

    /// Transform a circle according to policy (always materialized).
    pub fn map_circle(
        &self,
        frozen: &FrozenTransform,
        circle: Circle3,
        policy: &GeometryTransformPolicy,
        geometry_id: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<GeometryTransformResult<CircleOrPolyline>, TransformRuntimeError> {
        let policy = frozen.spec.geometry_policy.as_ref().unwrap_or(policy);
        let class = classify_geometry(GeometryKind::Circle, &frozen.spec, policy, geometry_id);
        if class.strategy == GeometryStrategy::Reject {
            return Err(TransformRuntimeError::Geometry(
                GeometryTransformError::StrictBlocked(GeometryKind::Circle),
            ));
        }
        let mut warnings = class.warnings;
        match class.strategy {
            GeometryStrategy::DensifyThenMapVertices => {
                let samples = densify_circle(circle, &policy.densify, true)
                    .map_err(TransformRuntimeError::Geometry)?;
                let mapped = self.apply_points(frozen, &samples, cancellation)?;
                Ok(GeometryTransformResult {
                    value: CircleOrPolyline::Polyline(mapped.points),
                    warnings,
                })
            }
            GeometryStrategy::MapCentreAndBestFitRadius => {
                let samples = densify_circle(circle, &policy.densify, false)
                    .map_err(TransformRuntimeError::Geometry)?;
                let mapped = self.apply_points(frozen, &samples, cancellation)?;
                let centre_batch = self.apply_points(frozen, &[circle.centre], cancellation)?;
                let centre = centre_batch.points[0];
                let circle_out = match policy.circle {
                    CirclePolicy::FitCircleFromSamples => {
                        fit_circle_xy(&mapped.points).map_err(TransformRuntimeError::Geometry)?
                    }
                    _ => {
                        let radius = mean_radius_xy(centre, &mapped.points);
                        Circle3 {
                            centre,
                            radius,
                            normal: circle.normal,
                        }
                    }
                };
                if !matches!(policy.circle, CirclePolicy::DensifyToPolyline) {
                    warnings.push(GeometryTransformWarning {
                        code: GeometryWarningCode::CircleBestFitApproximation,
                        message: format!(
                            "preserved circle r={:.6} (policy {:?})",
                            circle_out.radius, policy.circle
                        ),
                        geometry_id: geometry_id.map(str::to_owned),
                    });
                }
                Ok(GeometryTransformResult {
                    value: CircleOrPolyline::Circle(circle_out),
                    warnings,
                })
            }
            GeometryStrategy::Reject
            | GeometryStrategy::MapVertices
            | GeometryStrategy::MapFrameWithJacobian
            | GeometryStrategy::MapTextAnchorAndScale
            | GeometryStrategy::WarpRasterInverseMap
            | GeometryStrategy::TessellateThenMap
            | GeometryStrategy::RematerializeHierarchy => Err(TransformRuntimeError::Geometry(
                GeometryTransformError::Unsupported("unexpected circle strategy"),
            )),
        }
    }

    /// Transform an arc (densify default under non-similarity).
    pub fn map_arc(
        &self,
        frozen: &FrozenTransform,
        arc: Arc3,
        policy: &GeometryTransformPolicy,
        geometry_id: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<GeometryTransformResult<Vec<WorldPoint>>, TransformRuntimeError> {
        let policy = frozen.spec.geometry_policy.as_ref().unwrap_or(policy);
        let class = classify_geometry(GeometryKind::Arc, &frozen.spec, policy, geometry_id);
        if class.support == TransformSupport::Unsupported {
            return Err(TransformRuntimeError::Geometry(
                GeometryTransformError::StrictBlocked(GeometryKind::Arc),
            ));
        }
        let samples = densify_arc(arc, &policy.densify).map_err(TransformRuntimeError::Geometry)?;
        let mapped = self.apply_points(frozen, &samples, cancellation)?;
        Ok(GeometryTransformResult {
            value: mapped.points,
            warnings: class.warnings,
        })
    }

    /// Transform text anchor + height.
    pub fn map_text(
        &self,
        frozen: &FrozenTransform,
        text: &TextAnchor,
        policy: &GeometryTransformPolicy,
        cancellation: &CancellationToken,
    ) -> Result<GeometryTransformResult<TransformedText>, TransformRuntimeError> {
        let policy = frozen.spec.geometry_policy.as_ref().unwrap_or(policy);
        let class = classify_geometry(GeometryKind::Text, &frozen.spec, policy, text.id.as_deref());
        let mapped = self.apply_points(frozen, &[text.position], cancellation)?;
        let position = mapped.points[0];
        // Local isotropic scale from Jacobian of unit X axis length.
        let sx = self.map_vector_at(
            frozen,
            text.position,
            WorldPoint::new(1.0, 0.0, 0.0),
            policy,
            cancellation,
        )?;
        let sy = self.map_vector_at(
            frozen,
            text.position,
            WorldPoint::new(0.0, 1.0, 0.0),
            policy,
            cancellation,
        )?;
        let len_x = (sx.x * sx.x + sx.y * sx.y + sx.z * sx.z).sqrt();
        let len_y = (sy.x * sy.x + sy.y * sy.y + sy.z * sy.z).sqrt();
        let height = match policy.text_scale {
            TextScalePolicy::KeepDrawingHeight | TextScalePolicy::LeaveUnscaledWithWarning => {
                text.height_meters
            }
            TextScalePolicy::ScaleByLocalIsotropic => text.height_meters * (0.5 * (len_x + len_y)),
            TextScalePolicy::ScaleByLocalAreaSqrt => text.height_meters * (len_x * len_y).sqrt(),
        };
        let mut warnings = class.warnings;
        if (len_x - len_y).abs() > 0.02 * len_x.max(len_y) {
            warnings.push(GeometryTransformWarning {
                code: GeometryWarningCode::StrongLocalScaleGradient,
                message: format!(
                    "anisotropic local scale sx={len_x:.5} sy={len_y:.5}; text may look distorted"
                ),
                geometry_id: text.id.clone(),
            });
        }
        Ok(GeometryTransformResult {
            value: TransformedText {
                position,
                height_meters: height,
                rotation_rad: text.rotation_rad,
                id: text.id.clone(),
            },
            warnings,
        })
    }

    /// Inverse-map warp of a regular f64 raster (materialized). Output grid geometry equals input.
    pub fn warp_raster_inverse(
        &self,
        frozen: &FrozenTransform,
        raster: &RasterGrid2D,
        policy: &GeometryTransformPolicy,
        cancellation: &CancellationToken,
    ) -> Result<GeometryTransformResult<RasterGrid2D>, TransformRuntimeError> {
        let policy = frozen.spec.geometry_policy.as_ref().unwrap_or(policy);
        let class = classify_geometry(GeometryKind::RasterField, &frozen.spec, policy, None);
        if raster.values.len() != (raster.width as usize) * (raster.height as usize) {
            return Err(TransformRuntimeError::Geometry(
                GeometryTransformError::RasterSizeMismatch,
            ));
        }
        // Build inverse sample locations: for each output pixel centre, find source approx
        // by inverse finite-difference of the map (fixed-point: start at same index).
        // Practical approach for survey: forward-map a coarse source lattice is expensive;
        // we use inverse iteration: guess source = dest, refine with local Jacobian.
        let mut out_values = vec![raster.nodata; raster.values.len()];
        let mut oob = 0_u64;
        for row in 0..raster.height {
            if cancellation.is_cancel_requested() {
                return Err(TransformRuntimeError::Cancelled);
            }
            for col in 0..raster.width {
                let dest = pixel_centre(raster, col, row);
                // Inverse map: find source S such that map(S) ≈ dest.
                let source = self.invert_point(frozen, dest, policy, cancellation)?;
                let sample = sample_bilinear(raster, source);
                let idx = (row as usize) * (raster.width as usize) + (col as usize);
                match sample {
                    Some(v) => out_values[idx] = v,
                    None => {
                        out_values[idx] = raster.nodata;
                        oob += 1;
                    }
                }
            }
        }
        let mut warnings = class.warnings;
        if oob > 0 {
            warnings.push(GeometryTransformWarning {
                code: GeometryWarningCode::OutOfBounds,
                message: format!("{oob} output pixels fell outside source raster (nodata)"),
                geometry_id: None,
            });
        }
        Ok(GeometryTransformResult {
            value: RasterGrid2D {
                origin: raster.origin,
                pixel_size_x: raster.pixel_size_x,
                pixel_size_y: raster.pixel_size_y,
                width: raster.width,
                height: raster.height,
                values: out_values,
                nodata: raster.nodata,
            },
            warnings,
        })
    }

    /// Newton-ish inverse: find S with map(S)≈target using Jacobian of the point map.
    fn invert_point(
        &self,
        frozen: &FrozenTransform,
        target: WorldPoint,
        policy: &GeometryTransformPolicy,
        cancellation: &CancellationToken,
    ) -> Result<WorldPoint, TransformRuntimeError> {
        let mut s = target;
        let h = policy.jacobian_step_meters.max(1e-3);
        for _ in 0..12 {
            let m = self.apply_points(frozen, &[s], cancellation)?;
            let p = m.points[0];
            let ex = target.x - p.x;
            let ey = target.y - p.y;
            let ez = target.z - p.z;
            if (ex * ex + ey * ey + ez * ez).sqrt() < 1e-6 {
                return Ok(s);
            }
            // Column-wise Jacobian of map at s
            let sx = WorldPoint::new(s.x + h, s.y, s.z);
            let sy = WorldPoint::new(s.x, s.y + h, s.z);
            let sz = WorldPoint::new(s.x, s.y, s.z + h);
            let batch = self.apply_points(frozen, &[s, sx, sy, sz], cancellation)?;
            if batch.points.len() != 4 {
                break;
            }
            let p0 = batch.points[0];
            let jx = WorldPoint::new(
                (batch.points[1].x - p0.x) / h,
                (batch.points[1].y - p0.y) / h,
                (batch.points[1].z - p0.z) / h,
            );
            let jy = WorldPoint::new(
                (batch.points[2].x - p0.x) / h,
                (batch.points[2].y - p0.y) / h,
                (batch.points[2].z - p0.z) / h,
            );
            let jz = WorldPoint::new(
                (batch.points[3].x - p0.x) / h,
                (batch.points[3].y - p0.y) / h,
                (batch.points[3].z - p0.z) / h,
            );
            // Solve J * ds = err in least-squares sense (3x3)
            if let Some(ds) = solve3(
                jx.x, jy.x, jz.x, jx.y, jy.y, jz.y, jx.z, jy.z, jz.z, ex, ey, ez,
            ) {
                s = WorldPoint::new(s.x + ds.0, s.y + ds.1, s.z + ds.2);
            } else {
                break;
            }
        }
        Ok(s)
    }
}

/// Circle may become a polyline under densify policy.
#[derive(Debug, Clone, PartialEq)]
pub enum CircleOrPolyline {
    Circle(Circle3),
    Polyline(Vec<WorldPoint>),
}

fn pixel_centre(raster: &RasterGrid2D, col: u32, row: u32) -> WorldPoint {
    WorldPoint::new(
        raster.origin.x + (f64::from(col) + 0.5) * raster.pixel_size_x,
        raster.origin.y + (f64::from(row) + 0.5) * raster.pixel_size_y,
        raster.origin.z,
    )
}

fn sample_bilinear(raster: &RasterGrid2D, p: WorldPoint) -> Option<f64> {
    let u = (p.x - raster.origin.x) / raster.pixel_size_x - 0.5;
    let v = (p.y - raster.origin.y) / raster.pixel_size_y - 0.5;
    if u < 0.0 || v < 0.0 || u > f64::from(raster.width - 1) || v > f64::from(raster.height - 1) {
        return None;
    }
    let c0 = u.floor() as u32;
    let r0 = v.floor() as u32;
    let c1 = (c0 + 1).min(raster.width - 1);
    let r1 = (r0 + 1).min(raster.height - 1);
    let du = u - f64::from(c0);
    let dv = v - f64::from(r0);
    let w = raster.width as usize;
    let v00 = raster.values[r0 as usize * w + c0 as usize];
    let v01 = raster.values[r0 as usize * w + c1 as usize];
    let v10 = raster.values[r1 as usize * w + c0 as usize];
    let v11 = raster.values[r1 as usize * w + c1 as usize];
    if [v00, v01, v10, v11]
        .iter()
        .any(|x| (*x - raster.nodata).abs() < 1e-12)
    {
        return None;
    }
    Some(
        v00 * (1.0 - du) * (1.0 - dv)
            + v01 * du * (1.0 - dv)
            + v10 * (1.0 - du) * dv
            + v11 * du * dv,
    )
}

fn solve3(
    a00: f64,
    a01: f64,
    a02: f64,
    a10: f64,
    a11: f64,
    a12: f64,
    a20: f64,
    a21: f64,
    a22: f64,
    b0: f64,
    b1: f64,
    b2: f64,
) -> Option<(f64, f64, f64)> {
    let det = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20)
        + a02 * (a10 * a21 - a11 * a20);
    if det.abs() < 1e-18 {
        return None;
    }
    let x = (b0 * (a11 * a22 - a12 * a21) - a01 * (b1 * a22 - a12 * b2)
        + a02 * (b1 * a21 - a11 * b2))
        / det;
    let y = (a00 * (b1 * a22 - a12 * b2) - b0 * (a10 * a22 - a12 * a20)
        + a02 * (a10 * b2 - b1 * a20))
        / det;
    let z = (a00 * (a11 * b2 - b1 * a21) - a01 * (a10 * b2 - b1 * a20)
        + b0 * (a10 * a21 - a11 * a20))
        / det;
    Some((x, y, z))
}

fn try_map_vector_empirical(
    stages: &[TransformStage],
    _p: WorldPoint,
    v: WorldPoint,
) -> Option<WorldPoint> {
    // Only handle pure empirical chains without PROJ.
    let mut ops = Vec::new();
    for stage in stages {
        match stage {
            TransformStage::Identity | TransformStage::HeightOffset(_) => {}
            TransformStage::Empirical(op) => ops.push(op.clone()),
            _ => return None,
        }
    }
    let mut out = v;
    for op in ops {
        out = match op {
            EmpiricalOp::Translation3D { .. } => out,
            EmpiricalOp::Similarity2D { model, .. } => {
                let c = model.rotation_radians.cos();
                let s = model.rotation_radians.sin();
                let sc = model.scale;
                WorldPoint::new(
                    sc * (c * out.x - s * out.y),
                    sc * (s * out.x + c * out.y),
                    out.z,
                )
            }
            EmpiricalOp::Affine2D { model, .. } => WorldPoint::new(
                model.a * out.x + model.b * out.y,
                model.c * out.x + model.d * out.y,
                out.z,
            ),
            EmpiricalOp::Similarity3D { model } => {
                // Linear part only (ignore translation)
                let p0 = WorldPoint::new(0.0, 0.0, 0.0);
                let p1 = apply_empirical(
                    &EmpiricalOp::Similarity3D {
                        model: {
                            let mut m = model;
                            m.tx = 0.0;
                            m.ty = 0.0;
                            m.tz = 0.0;
                            m
                        },
                    },
                    out,
                );
                let _ = p0;
                p1
            }
        };
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use himmelcad_core::transform::{
        identity_spec, EmpiricalOp, Similarity2D, TransformCompositionMode, TransformSpec,
        TransformStage, TRANSFORM_SPEC_SCHEMA_VERSION,
    };
    use himmelcad_core::transform_geometry::GeometryTransformPolicy;

    use crate::transform_runtime::TransformRuntimeConfig;

    #[test]
    fn densify_circle_under_similarity_can_best_fit() {
        let runtime = TransformRuntime::new(TransformRuntimeConfig::system());
        let cancel = CancellationToken::new();
        let mut policy = GeometryTransformPolicy::default();
        policy.circle = CirclePolicy::PreserveAsCircleBestFit;
        let spec = TransformSpec {
            schema_version: TRANSFORM_SPEC_SCHEMA_VERSION,
            composition: TransformCompositionMode::Joint3D,
            separate_order: Default::default(),
            stages: vec![TransformStage::Empirical(EmpiricalOp::Similarity2D {
                model: Similarity2D {
                    tx: 10.0,
                    ty: 20.0,
                    rotation_radians: 0.2,
                    scale: 2.0,
                },
                z_offset: None,
            })],
            vertical_stages: vec![],
            domain: None,
            out_of_bounds: Default::default(),
            area_of_interest: None,
            label: None,
            geometry_policy: Some(policy.clone()),
        };
        let frozen = runtime.freeze_spec(&spec, &cancel).unwrap();
        let circle = Circle3 {
            centre: WorldPoint::new(0.0, 0.0, 0.0),
            radius: 5.0,
            normal: WorldPoint::new(0.0, 0.0, 1.0),
        };
        let result = runtime
            .map_circle(&frozen, circle, &policy, Some("c1"), &cancel)
            .unwrap();
        match result.value {
            CircleOrPolyline::Circle(c) => {
                assert!((c.radius - 10.0).abs() < 1e-6);
                assert!((c.centre.x - 10.0).abs() < 1e-6);
                assert!((c.centre.y - 20.0).abs() < 1e-6);
            }
            CircleOrPolyline::Polyline(_) => panic!("expected preserved circle"),
        }
    }

    #[test]
    fn text_scales_with_similarity() {
        let runtime = TransformRuntime::new(TransformRuntimeConfig::system());
        let cancel = CancellationToken::new();
        let mut policy = GeometryTransformPolicy::default();
        policy.text_scale = TextScalePolicy::ScaleByLocalIsotropic;
        let spec = TransformSpec {
            schema_version: TRANSFORM_SPEC_SCHEMA_VERSION,
            composition: TransformCompositionMode::Joint3D,
            separate_order: Default::default(),
            stages: vec![TransformStage::Empirical(EmpiricalOp::Similarity2D {
                model: Similarity2D {
                    tx: 0.0,
                    ty: 0.0,
                    rotation_radians: 0.0,
                    scale: 3.0,
                },
                z_offset: None,
            })],
            vertical_stages: vec![],
            domain: None,
            out_of_bounds: Default::default(),
            area_of_interest: None,
            label: None,
            geometry_policy: Some(policy.clone()),
        };
        let frozen = runtime.freeze_spec(&spec, &cancel).unwrap();
        let text = TextAnchor {
            position: WorldPoint::new(1.0, 2.0, 0.0),
            height_meters: 1.0,
            rotation_rad: None,
            id: Some("t".into()),
        };
        let out = runtime.map_text(&frozen, &text, &policy, &cancel).unwrap();
        assert!((out.value.height_meters - 3.0).abs() < 1e-6);
    }

    #[test]
    fn connectivity_warning_on_ntv2_like_circle() {
        let mut spec = identity_spec();
        // Force non-similarity by adding empty proj stage marker via HeightPlane only is still global
        // Use Proj stage
        use himmelcad_core::photolab_crs::{CrsDefinition, CrsWithEpoch};
        use himmelcad_core::transform::ProjCoordinateOp;
        spec.stages = vec![TransformStage::Proj(ProjCoordinateOp {
            source: CrsWithEpoch {
                crs: CrsDefinition::Epsg(31468),
                coordinate_epoch: None,
            },
            target: CrsWithEpoch {
                crs: CrsDefinition::Epsg(25832),
                coordinate_epoch: None,
            },
            proj_pipeline: Some("+proj=noop".into()),
            grids: vec![],
            selection_policy: Default::default(),
            expected_accuracy_mm: None,
            ballpark: false,
        })];
        let class = classify_geometry(
            GeometryKind::Circle,
            &spec,
            &GeometryTransformPolicy::default(),
            Some("ifc-wall-arc"),
        );
        assert!(class
            .warnings
            .iter()
            .any(|w| w.code == GeometryWarningCode::ConnectivityRisk));
    }
}
