//! Local geometry estimators.
//!
//! These take the k nearest neighbours of a cursor and return a usable
//! coordinate, even when no exact point sits under the pointer. Used by the
//! cursor-coordinate service for the "interpolated" snap kind.

use glam::{Mat3, Vec3};

/// Result of fitting a local plane to a point neighbourhood.
#[derive(Debug, Clone, Copy)]
pub struct LocalPlane {
    pub origin: Vec3,
    pub normal: Vec3,
    /// Smallest singular value / sum of singular values. Closer to 0 = flatter.
    pub planarity: f32,
}

/// Fit a plane to a point neighbourhood by weighted PCA.
/// Weights are typically `1 / max(eps, distance_sq_to_query)` so closer
/// neighbours dominate the estimate.
#[allow(
    clippy::similar_names,
    reason = "covariance matrix components use their conventional mathematical names"
)]
pub fn fit_plane(points: &[Vec3], weights: &[f32]) -> Option<LocalPlane> {
    if points.len() < 3 {
        return None;
    }
    debug_assert_eq!(points.len(), weights.len());

    let mut weight_sum = 0.0_f32;
    let mut centroid = Vec3::ZERO;
    for (p, w) in points.iter().zip(weights) {
        weight_sum += *w;
        centroid += *p * *w;
    }
    if weight_sum <= 0.0 {
        return None;
    }
    centroid /= weight_sum;

    // Build weighted 3x3 covariance.
    let mut covariance_xx = 0.0;
    let mut covariance_yy = 0.0;
    let mut covariance_zz = 0.0;
    let mut covariance_xy = 0.0;
    let mut covariance_xz = 0.0;
    let mut covariance_yz = 0.0;
    for (p, w) in points.iter().zip(weights) {
        let d = *p - centroid;
        let wf = *w;
        covariance_xx += wf * d.x * d.x;
        covariance_yy += wf * d.y * d.y;
        covariance_zz += wf * d.z * d.z;
        covariance_xy += wf * d.x * d.y;
        covariance_xz += wf * d.x * d.z;
        covariance_yz += wf * d.y * d.z;
    }
    let cov = Mat3::from_cols(
        Vec3::new(covariance_xx, covariance_xy, covariance_xz),
        Vec3::new(covariance_xy, covariance_yy, covariance_yz),
        Vec3::new(covariance_xz, covariance_yz, covariance_zz),
    );

    let (normal, planarity) = smallest_eigenvector(cov)?;
    Some(LocalPlane {
        origin: centroid,
        normal,
        planarity,
    })
}

/// Intersect a ray with a plane. Returns world-space hit position.
/// Returns None if ray is parallel to the plane (within epsilon).
pub fn ray_plane_intersect(ray_origin: Vec3, ray_dir: Vec3, plane: LocalPlane) -> Option<Vec3> {
    let denom = ray_dir.dot(plane.normal);
    if denom.abs() < 1e-6 {
        return None;
    }
    let t = (plane.origin - ray_origin).dot(plane.normal) / denom;
    if t < 0.0 {
        return None;
    }
    Some(ray_origin + ray_dir * t)
}

/// Inverse-power-iteration eigenvector for the smallest eigenvalue.
/// Returns `(unit_eigenvector, smallest_lambda / trace)`.
fn smallest_eigenvector(cov: Mat3) -> Option<(Vec3, f32)> {
    let trace = cov.x_axis.x + cov.y_axis.y + cov.z_axis.z;
    if trace <= f32::EPSILON {
        return None;
    }

    // Ridge-shifted inverse to bias toward the smallest eigenvalue.
    let shift = trace * 1e-3;
    let shifted = Mat3::from_cols(
        cov.x_axis - Vec3::X * shift,
        cov.y_axis - Vec3::Y * shift,
        cov.z_axis - Vec3::Z * shift,
    );
    let det = shifted.determinant();
    if det.abs() < 1e-12 {
        // Already singular along the smallest direction; do one rough pick.
        return Some((principal_smallest(cov, trace), 0.0));
    }
    let inv = shifted.inverse();

    // Power iterate on the shifted inverse — converges to the largest
    // eigenvalue of inv = the smallest eigenvalue of cov-shift*I.
    let mut v = Vec3::new(0.5, 0.7, 0.3).normalize();
    for _ in 0..32 {
        let nv = inv * v;
        let len = nv.length();
        if len < f32::EPSILON {
            return Some((principal_smallest(cov, trace), 0.0));
        }
        v = nv / len;
    }

    let cv = cov * v;
    let lambda = cv.dot(v).max(0.0);
    Some((v.normalize(), lambda / trace.max(f32::EPSILON)))
}

fn principal_smallest(cov: Mat3, trace: f32) -> Vec3 {
    // Fallback: return the axis with the smallest diagonal entry. For nearly
    // degenerate covariance this is at least a defined direction.
    let dx = cov.x_axis.x;
    let dy = cov.y_axis.y;
    let dz = cov.z_axis.z;
    let _ = trace;
    if dx <= dy && dx <= dz {
        Vec3::X
    } else if dy <= dz {
        Vec3::Y
    } else {
        Vec3::Z
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fits_horizontal_plane() {
        let points = vec![
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(0.0, 1.0, 0.0),
            Vec3::new(1.0, 1.0, 0.0),
            Vec3::new(0.5, 0.5, 0.0),
        ];
        let weights = vec![1.0; points.len()];
        let plane = fit_plane(&points, &weights).expect("plane");
        let n = plane.normal.normalize();
        // Should be aligned with +/- Z.
        assert!(n.z.abs() > 0.95, "normal z={}", n.z);
    }

    #[test]
    fn ray_intersects_horizontal_plane() {
        let plane = LocalPlane {
            origin: Vec3::new(0.0, 0.0, 5.0),
            normal: Vec3::Z,
            planarity: 0.0,
        };
        let hit = ray_plane_intersect(Vec3::new(2.0, 3.0, 0.0), Vec3::Z, plane).unwrap();
        assert!((hit.x - 2.0).abs() < 1e-4);
        assert!((hit.y - 3.0).abs() < 1e-4);
        assert!((hit.z - 5.0).abs() < 1e-4);
    }
}
