//! Deterministic pass plan for a mixed-entity frame.

use serde::{Deserialize, Serialize};

use crate::{RenderProxyKind, RenderWorld};

/// Ordered logical pass executed by all graphics backends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RenderPassKind {
    /// Clear shared color and reverse-Z depth attachments.
    Clear,
    /// Opaque triangles, CAD fills and rasters.
    Opaque,
    /// Point clouds with the same depth attachment.
    Points,
    /// Alpha-blended triangles, points, rasters and splats.
    Transparent,
    /// Exact or preview solid section caps.
    SectionCaps,
    /// Proxy and primitive ID attachments plus depth.
    Pick,
    /// CAD strokes, text, selection and interaction overlays.
    Overlay,
}

/// Minimal ordered frame graph derived from visible world content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameGraph {
    passes: Vec<RenderPassKind>,
}

impl FrameGraph {
    /// Builds a pass sequence while preserving one color/depth/clip world.
    #[must_use]
    pub fn build(world: &RenderWorld, picking_requested: bool) -> Self {
        let mut has_opaque = false;
        let mut has_points = false;
        let mut has_transparent = false;
        let mut has_overlay = false;
        for (proxy, _) in world.visible_proxies() {
            if proxy.style.opacity < 1.0 || proxy.kind == RenderProxyKind::GaussianSplats {
                has_transparent = true;
            } else {
                match proxy.kind {
                    RenderProxyKind::Points => has_points = true,
                    RenderProxyKind::CadStroke | RenderProxyKind::Text => has_overlay = true,
                    RenderProxyKind::Triangles
                    | RenderProxyKind::CadFill
                    | RenderProxyKind::Raster => has_opaque = true,
                    RenderProxyKind::GaussianSplats => has_transparent = true,
                }
            }
        }
        let has_caps = world
            .active_clip_volumes()
            .any(|volume| volume.preview_cap || volume.section_fill_resource.is_some());
        let mut passes = vec![RenderPassKind::Clear];
        if has_opaque {
            passes.push(RenderPassKind::Opaque);
        }
        if has_points {
            passes.push(RenderPassKind::Points);
        }
        if has_transparent {
            passes.push(RenderPassKind::Transparent);
        }
        if has_caps {
            passes.push(RenderPassKind::SectionCaps);
        }
        if picking_requested {
            passes.push(RenderPassKind::Pick);
        }
        if has_overlay {
            passes.push(RenderPassKind::Overlay);
        }
        Self { passes }
    }

    /// Ordered logical passes for backend encoding.
    #[must_use]
    pub fn passes(&self) -> &[RenderPassKind] {
        &self.passes
    }
}

#[cfg(test)]
mod tests {
    use super::{FrameGraph, RenderPassKind};
    use crate::{
        BoundingVolume, RenderProxy, RenderProxyId, RenderProxyKind, RenderStyle, RenderWorld,
        ResourceCost, WorldAabb, WorldVec3,
    };

    #[test]
    fn mixed_scene_uses_one_ordered_depth_and_pick_plan() {
        let mut world = RenderWorld::new();
        for (id, kind) in [
            ("mesh", RenderProxyKind::Triangles),
            ("cloud", RenderProxyKind::Points),
            ("curve", RenderProxyKind::CadStroke),
        ] {
            world.insert_proxy(proxy(id, kind)).expect("insert");
        }

        let graph = FrameGraph::build(&world, true);
        assert_eq!(
            graph.passes(),
            [
                RenderPassKind::Clear,
                RenderPassKind::Opaque,
                RenderPassKind::Points,
                RenderPassKind::Pick,
                RenderPassKind::Overlay,
            ]
        );
    }

    fn proxy(id: &str, kind: RenderProxyKind) -> RenderProxy {
        RenderProxy {
            id: RenderProxyId(id.to_owned()),
            entity_id: id.to_owned(),
            kind,
            bounds: BoundingVolume::AxisAlignedBox {
                bounds: WorldAabb {
                    min: WorldVec3 {
                        x: 0.0,
                        y: 0.0,
                        z: 0.0,
                    },
                    max: WorldVec3 {
                        x: 1.0,
                        y: 1.0,
                        z: 1.0,
                    },
                },
            },
            dataset_id: None,
            tile_id: None,
            style: RenderStyle::default(),
            cost: ResourceCost::default(),
            visible: true,
            locked: false,
        }
    }
}
