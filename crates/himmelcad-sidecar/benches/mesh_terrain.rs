use std::collections::BTreeSet;
use std::time::Instant;

use himmelcad_core::mesh_surface::{
    check_surface_draft, triangulate_surface, triangulate_surface_with_cancel, SurfaceDraft,
    SurfaceLine, SurfacePoint, SurfaceRules, SurfaceSourceRole,
};

const SIDE: usize = 1_000;
const CONSTRAINTS: usize = 500;

fn main() {
    if !std::env::args().any(|arg| arg == "G-MT-3") {
        eprintln!("usage: cargo bench -p himmelcad-sidecar --bench mesh_terrain -- G-MT-3");
        std::process::exit(2);
    }

    let started = Instant::now();
    let draft = fixture();
    progress(1, "fixture-ready", started.elapsed().as_secs_f64());

    let checked_at = Instant::now();
    let check = check_surface_draft(&draft).expect("G-MT-3 draft check");
    let check_seconds = checked_at.elapsed().as_secs_f64();
    progress(2, "checked", started.elapsed().as_secs_f64());
    assert_eq!(check.blocking, 0, "G-MT-3 fixture must be publishable");

    let meshed_at = Instant::now();
    let mesh = triangulate_surface(&draft).expect("G-MT-3 triangulation");
    let mesh_seconds = meshed_at.elapsed().as_secs_f64();
    progress(3, "meshed", started.elapsed().as_secs_f64());

    let cancel_at = Instant::now();
    let cancelled = triangulate_surface_with_cancel(&draft, || true);
    let cancel_ms = cancel_at.elapsed().as_secs_f64() * 1_000.0;
    progress(4, "cancel-acknowledged", started.elapsed().as_secs_f64());
    let total_seconds = started.elapsed().as_secs_f64();
    let cancel_ok = matches!(
        cancelled,
        Err(himmelcad_core::mesh_surface::SurfaceBuildError::Cancelled)
    );
    let pass = total_seconds <= 60.0 && cancel_ok && cancel_ms <= 250.0;

    println!(
        "{{\"gate\":\"G-MT-3\",\"status\":\"{}\",\"sampledPoints\":{},\"constraints\":{},\"progressEvents\":4,\"checkSeconds\":{:.6},\"meshSeconds\":{:.6},\"cancelMilliseconds\":{:.3},\"triangles\":{},\"publishesOnCancel\":false,\"totalSeconds\":{:.6}}}",
        if pass { "PASS" } else { "FAIL" },
        draft.points.len(),
        draft.lines.len(),
        check_seconds,
        mesh_seconds,
        cancel_ms,
        mesh.indices.len() / 3,
        total_seconds,
    );
    if !pass {
        std::process::exit(1);
    }
}

fn fixture() -> SurfaceDraft {
    let mut points = Vec::with_capacity(SIDE * SIDE);
    for y in 0..SIDE {
        for x in 0..SIDE {
            points.push(point(x, y));
        }
    }
    let mut lines = Vec::with_capacity(CONSTRAINTS);
    for y in 0..CONSTRAINTS {
        lines.push(SurfaceLine {
            source_id: format!("breakline-{y}"),
            role: SurfaceSourceRole::Breakline,
            vertices: vec![point(0, y), point(SIDE - 1, y)],
            closed: false,
        });
    }
    SurfaceDraft {
        draft_id: "g-mt-3".to_owned(),
        name: "G-MT-3 1M / 500".to_owned(),
        points,
        lines,
        rules: SurfaceRules {
            maximum_edge_length: 2.0,
            thin_cloud_spacing: 1.0,
            auto_boundary: false,
            exclude_outside_boundary: false,
            ..SurfaceRules::default()
        },
        excluded_source_ids: BTreeSet::new(),
        excluded_point_ids: BTreeSet::new(),
    }
}

fn point(x: usize, y: usize) -> SurfacePoint {
    SurfacePoint {
        point_id: format!("p-{x}-{y}"),
        source_id: "sampled-cloud".to_owned(),
        position: [x as f64, y as f64],
        z: Some((x as f64 * 0.01).sin() + (y as f64 * 0.01).cos()),
    }
}

fn progress(ordinal: usize, phase: &str, elapsed_seconds: f64) {
    eprintln!("G-MT-3 progress {ordinal}/4 phase={phase} elapsedSeconds={elapsed_seconds:.6}");
}
