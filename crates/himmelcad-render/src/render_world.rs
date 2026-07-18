//! Backend-neutral mixed-entity render world.

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{Display, Formatter};

use himmelcad_core::canonical_resources::CanonicalResourceRef;
use serde::{Deserialize, Serialize};

use crate::{
    BoundingVolume, ClipPlane, DatasetId, PickAddress, PickToken, ResourceCost, TileId, TileKey,
    WorldVec3,
};

/// Stable identity of one versioned render proxy.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RenderProxyId(pub String);

/// Stable identity of one clip volume in a view.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ClipVolumeId(pub String);

/// Pipeline class selected for a render proxy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RenderProxyKind {
    /// Streamed or resident points.
    Points,
    /// Triangulated surface or solid boundary.
    Triangles,
    /// Analytic or tessellated CAD strokes.
    CadStroke,
    /// CAD region fill or hatch.
    CadFill,
    /// Color, elevation or depth raster tiles.
    Raster,
    /// Gaussian splats.
    GaussianSplats,
    /// Text or dimension glyphs.
    Text,
}

/// Color mapping applied without rebuilding source geometry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ColorMode {
    /// Use the proxy's uniform base color.
    Uniform,
    /// Use per-vertex, raster or material source colors.
    Source,
    /// Map authoritative world height through a gradient.
    Height(HeightGradient),
    /// Map point intensity to grayscale, retaining source color when absent.
    PointIntensity,
    /// Map the LAS/Potree classification code through an optional class-indexed palette.
    /// An empty palette selects the built-in civil/LAS display palette.
    PointClassification {
        /// RGBA colors addressed directly by classification code, up to 256 entries.
        #[serde(default)]
        colors: Vec<[f32; 4]>,
    },
    /// Map the return number to a stable categorical color.
    PointReturnNumber,
    /// Map the point-source id to a stable categorical color.
    PointSourceId,
}

/// Piecewise-linear world-height color ramp.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeightGradient {
    /// Lowest world height represented by the ramp.
    pub minimum: f64,
    /// Highest world height represented by the ramp.
    pub maximum: f64,
    /// Ordered RGBA stops from minimum to maximum.
    pub colors: Vec<[f32; 4]>,
}

/// Fill resource used for triangles, regions and exact section caps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FillMode {
    /// No surface fill.
    None,
    /// Flat or vertex-derived color fill.
    Color,
    /// Sample a texture or raster resource.
    Texture {
        /// Project resource identity.
        resource_id: String,
    },
    /// Evaluate a vector hatch in object or section coordinates.
    Hatch {
        /// Exact immutable canonical hatch-pattern revision.
        resource: CanonicalResourceRef,
        /// Pattern-space origin in authoritative project coordinates.
        origin: WorldVec3,
        /// Unit world direction of the pattern-space U axis.
        axis_u: WorldVec3,
        /// Unit world direction of the pattern-space V axis.
        axis_v: WorldVec3,
        /// Hatch stroke width in authored project units.
        line_width: f64,
        /// Linear RGBA hatch-stroke color.
        color: [f32; 4],
    },
}

/// Resource selection for analytic and tessellated vector strokes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StrokeMode {
    /// Do not draw or ID-pick the stroke presentation.
    None,
    /// Draw one continuous vector stroke.
    Color,
    /// Evaluate a registered vector line-type resource along the authored path.
    LineType {
        /// Exact immutable canonical resource revision.
        resource: CanonicalResourceRef,
    },
}

/// Color source for stroke-capable proxy parts.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StrokeColor {
    /// Retain the entity's common color-mode/base-color behavior.
    Inherit,
    /// Replace the common base color for strokes with one linear RGBA color.
    Uniform {
        /// Linear RGBA stroke color.
        color: [f32; 4],
    },
}

/// Display width of a vector stroke.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StrokeWidth {
    /// Retain the source/admission width stored in the immutable line instances.
    Source,
    /// Override the source width in physical device pixels.
    Screen {
        /// Finite, strictly positive physical-pixel width.
        pixels: f32,
    },
}

/// Terminal shape of an open vector path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StrokeCap {
    /// Stop exactly at the authored endpoint.
    Butt,
    /// Extend by half a stroke width with a rectangular end.
    Square,
    /// Extend by half a stroke width with a circular end.
    Round,
}

/// Shape used to connect adjacent vector path segments.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StrokeJoin {
    /// Intersect adjacent edge offsets up to the configured miter limit.
    Miter,
    /// Connect adjacent edges with a straight bevel.
    Bevel,
    /// Connect adjacent edges with a circular arc.
    Round,
}

/// Presentation of all stroke-capable parts of an entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrokeStyle {
    /// Visibility and optional line-type resource.
    pub mode: StrokeMode,
    /// Inherited or independent uniform stroke color.
    pub color: StrokeColor,
    /// Source or live screen-space line width.
    pub width: StrokeWidth,
    /// Open-path terminal shape.
    pub cap: StrokeCap,
    /// Connected-segment join shape.
    pub join: StrokeJoin,
    /// Maximum miter length as a multiple of half the stroke width.
    pub miter_limit: f32,
}

impl Default for StrokeStyle {
    fn default() -> Self {
        Self {
            mode: StrokeMode::Color,
            color: StrokeColor::Inherit,
            width: StrokeWidth::Source,
            cap: StrokeCap::Butt,
            join: StrokeJoin::Miter,
            miter_limit: 4.0,
        }
    }
}

/// Per-view appearance resolved independently from canonical entity geometry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderStyle {
    /// Uniform fallback RGBA color in linear space.
    pub base_color: [f32; 4],
    /// Additional opacity multiplier from zero to one.
    pub opacity: f32,
    /// Finite, strictly positive display-only Z scale around the explicit datum.
    pub vertical_exaggeration: f32,
    /// Active color mapping.
    pub color_mode: ColorMode,
    /// Fill mode for fill-capable proxies.
    pub fill: FillMode,
    /// Stroke presentation for stroke-capable proxies.
    #[serde(default)]
    pub stroke: StrokeStyle,
}

impl Default for RenderStyle {
    fn default() -> Self {
        Self {
            base_color: [1.0; 4],
            opacity: 1.0,
            vertical_exaggeration: 1.0,
            color_mode: ColorMode::Source,
            fill: FillMode::Color,
            stroke: StrokeStyle::default(),
        }
    }
}

/// View-local interaction flags resolved independently from canonical geometry
/// and from an entity's retained base style.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityInteractionState {
    /// Whether the exact entity is part of the active selection.
    pub selected: bool,
    /// Whether the exact entity is beneath the current refined hover pick.
    pub hovered: bool,
}

impl RenderStyle {
    /// Resolves shared selection/hover colors without mutating the retained
    /// base style, immutable geometry or provider resources.
    #[must_use]
    pub fn with_interaction(&self, state: EntityInteractionState) -> Self {
        if !state.selected && !state.hovered {
            return self.clone();
        }
        let mut effective = self.clone();
        let mut color = if state.selected {
            [1.0, 0.55, 0.05, 1.0]
        } else {
            [0.1, 0.75, 1.0, 1.0]
        };
        color[3] = self.base_color[3];
        effective.base_color = color;
        effective.color_mode = ColorMode::Uniform;
        effective.stroke.color = StrokeColor::Uniform { color };
        effective
    }
}

/// One immutable geometry version compiled for presentation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderProxy {
    /// Stable proxy/version identity.
    pub id: RenderProxyId,
    /// Canonical entity identity.
    pub entity_id: String,
    /// Pipeline class.
    pub kind: RenderProxyKind,
    /// Conservative authoritative world bound.
    pub bounds: BoundingVolume,
    /// Streamed dataset identity, when applicable.
    pub dataset_id: Option<DatasetId>,
    /// Resident streamed tile identity, when applicable.
    pub tile_id: Option<TileId>,
    /// Current view appearance.
    pub style: RenderStyle,
    /// Complete resident resource cost.
    pub cost: ResourceCost,
    /// Whether this proxy participates in rendering and picking.
    pub visible: bool,
    /// Whether interactive commands may modify the entity.
    pub locked: bool,
}

/// Boolean interpretation of one convex clip volume.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClipOperation {
    /// Keep points satisfying every plane.
    KeepInside,
    /// Discard points satisfying every plane.
    RemoveInside,
}

/// View-local styling for a canonical hatch evaluated in a generated section plane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SectionHatchStyle {
    /// Exact immutable canonical hatch-pattern revision.
    pub resource: CanonicalResourceRef,
    /// Hatch stroke width in authored project units.
    pub line_width: f64,
    /// Linear RGBA hatch-stroke color.
    pub color: [f32; 4],
}

/// Convex world-space clip volume shared by all proxy kinds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipVolume {
    /// Stable view-local identity.
    pub id: ClipVolumeId,
    /// Plane intersection defining the convex volume.
    pub planes: Vec<ClipPlane>,
    /// Keep or remove the volume interior.
    pub operation: ClipOperation,
    /// Whether closed solid proxies request a preview cap.
    pub preview_cap: bool,
    /// Optional hatch style for exact generated sections.
    pub section_fill: Option<SectionHatchStyle>,
    /// Per-material hatch overrides for layered closed-solid preview caps.
    #[serde(default)]
    pub section_material_hatches: BTreeMap<u32, SectionHatchStyle>,
    /// Whether the clip volume is active.
    pub enabled: bool,
}

/// Mutation or validation failure in a render world.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderWorldError {
    /// A proxy identity already exists.
    DuplicateProxy(RenderProxyId),
    /// A proxy identity is unknown.
    UnknownProxy(RenderProxyId),
    /// A clip volume identity already exists.
    DuplicateClipVolume(ClipVolumeId),
    /// A clip volume identity is unknown.
    UnknownClipVolume(ClipVolumeId),
    /// A clip volume has an empty identity/plane set or a non-finite plane.
    InvalidClipVolume(ClipVolumeId),
    /// No more non-zero 32-bit GPU pick slots are available.
    PickSlotExhausted,
    /// A prepared touched-only mutation no longer matches the live world.
    StaleOverlay,
    /// A prepared mutation contains state outside its touched proxy set.
    InvalidOverlay,
}

impl Display for RenderWorldError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DuplicateProxy(id) => write!(formatter, "duplicate render proxy: {}", id.0),
            Self::UnknownProxy(id) => write!(formatter, "unknown render proxy: {}", id.0),
            Self::DuplicateClipVolume(id) => write!(formatter, "duplicate clip volume: {}", id.0),
            Self::UnknownClipVolume(id) => write!(formatter, "unknown clip volume: {}", id.0),
            Self::InvalidClipVolume(id) => write!(formatter, "invalid clip volume: {}", id.0),
            Self::PickSlotExhausted => formatter.write_str("GPU pick slot namespace exhausted"),
            Self::StaleOverlay => formatter.write_str("prepared render-world overlay is stale"),
            Self::InvalidOverlay => formatter.write_str("prepared render-world overlay is invalid"),
        }
    }
}

impl Error for RenderWorldError {}

/// Authoritative presentation state shared by every backend and viewport host.
#[derive(Debug, Default)]
pub struct RenderWorld {
    proxies: BTreeMap<RenderProxyId, ProxyEntry>,
    pick_slots: BTreeMap<u32, RenderProxyId>,
    entity_proxies: BTreeMap<String, BTreeSet<RenderProxyId>>,
    tile_proxies: BTreeMap<TileKey, BTreeSet<RenderProxyId>>,
    visible_proxy_ids: BTreeSet<RenderProxyId>,
    visible_tile_keys: BTreeSet<TileKey>,
    hidden_entities: BTreeSet<String>,
    streaming_visibility_initialized: bool,
    resident_cost: ResourceCost,
    visible_cost: ResourceCost,
    clip_volumes: BTreeMap<ClipVolumeId, ClipVolume>,
    next_pick_slot: u32,
    generation: u64,
}

#[derive(Debug, Clone, PartialEq)]
struct ProxyEntry {
    proxy: RenderProxy,
    pick_slot: u32,
}

/// Touched-only render-world mutation prepared against an observed generation.
///
/// Existing compiler functions build new GPU batches against the empty staging
/// world, whose pick-slot allocator begins exactly where the live world was
/// observed. Unchanged proxy metadata and residency are never cloned.
#[derive(Debug)]
pub struct PreparedRenderWorldOverlay {
    expected_generation: u64,
    expected_next_pick_slot: u32,
    observed_removals: BTreeMap<RenderProxyId, ProxyEntry>,
    observed_bounds_updates: BTreeMap<RenderProxyId, (ProxyEntry, BoundingVolume)>,
    staging: RenderWorld,
}

/// Bounded work counters for one prepared render-world mutation.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RenderWorldOverlayDiagnostics {
    /// Existing proxy entries observed during prepare.
    pub observed_proxies: usize,
    /// New proxy entries built in the staging world.
    pub staged_proxies: usize,
}

/// Incremental visibility work performed for one desired streamed tile set.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RenderWorldVisibilityDelta {
    /// Tile keys newly made visible.
    pub shown_tiles: usize,
    /// Tile keys newly hidden.
    pub hidden_tiles: usize,
    /// Resident proxy entries whose visibility changed.
    pub touched_proxies: usize,
}

impl RenderWorld {
    /// Creates an empty render world.
    #[must_use]
    pub fn new() -> Self {
        Self {
            next_pick_slot: 1,
            ..Self::default()
        }
    }

    /// Monotonic generation used to invalidate asynchronous picks.
    #[must_use]
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Prepares an empty touched-only staging world with stable future pick slots.
    ///
    /// Only the explicitly removed proxy entries are observed. The staging
    /// world contains no copy of unrelated residency.
    pub fn prepare_overlay(
        &self,
        removals: impl IntoIterator<Item = RenderProxyId>,
    ) -> Result<PreparedRenderWorldOverlay, RenderWorldError> {
        self.prepare_overlay_with_bounds_updates(removals, std::iter::empty())
    }

    /// Prepares proxy replacement plus in-place world-bound changes while preserving pick slots.
    ///
    /// Placement-only edits of resident streamed content use this path so immutable GPU buffers,
    /// provider residency and pick addresses survive the canonical revision change.
    pub fn prepare_overlay_with_bounds_updates(
        &self,
        removals: impl IntoIterator<Item = RenderProxyId>,
        bounds_updates: impl IntoIterator<Item = (RenderProxyId, BoundingVolume)>,
    ) -> Result<PreparedRenderWorldOverlay, RenderWorldError> {
        let mut observed_removals = BTreeMap::new();
        for id in removals {
            if observed_removals.contains_key(&id) {
                return Err(RenderWorldError::InvalidOverlay);
            }
            let entry = self
                .proxies
                .get(&id)
                .cloned()
                .ok_or_else(|| RenderWorldError::UnknownProxy(id.clone()))?;
            observed_removals.insert(id, entry);
        }
        let mut observed_bounds_updates = BTreeMap::new();
        for (id, bounds) in bounds_updates {
            if observed_removals.contains_key(&id) || observed_bounds_updates.contains_key(&id) {
                return Err(RenderWorldError::InvalidOverlay);
            }
            let entry = self
                .proxies
                .get(&id)
                .cloned()
                .ok_or_else(|| RenderWorldError::UnknownProxy(id.clone()))?;
            observed_bounds_updates.insert(id, (entry, bounds));
        }
        let staging = Self {
            next_pick_slot: self.next_pick_slot,
            generation: self.generation,
            ..Self::default()
        };
        Ok(PreparedRenderWorldOverlay {
            expected_generation: self.generation,
            expected_next_pick_slot: self.next_pick_slot,
            observed_removals,
            observed_bounds_updates,
            staging,
        })
    }

    /// Atomically applies a completely compiled touched-only overlay.
    ///
    /// Validation is complete before the first live map is mutated. A
    /// successful transaction advances the world generation exactly once.
    pub fn commit_overlay(
        &mut self,
        overlay: PreparedRenderWorldOverlay,
    ) -> Result<RenderWorldOverlayDiagnostics, RenderWorldError> {
        if self.generation != overlay.expected_generation
            || self.next_pick_slot != overlay.expected_next_pick_slot
        {
            return Err(RenderWorldError::StaleOverlay);
        }
        if !overlay.staging.clip_volumes.is_empty() {
            return Err(RenderWorldError::InvalidOverlay);
        }
        for (id, observed) in &overlay.observed_removals {
            if self.proxies.get(id) != Some(observed) {
                return Err(RenderWorldError::StaleOverlay);
            }
        }
        for (id, (observed, _)) in &overlay.observed_bounds_updates {
            if self.proxies.get(id) != Some(observed) {
                return Err(RenderWorldError::StaleOverlay);
            }
        }
        for id in overlay.staging.proxies.keys() {
            if self.proxies.contains_key(id) && !overlay.observed_removals.contains_key(id) {
                return Err(RenderWorldError::DuplicateProxy(id.clone()));
            }
        }
        if overlay.staging.pick_slots.len() != overlay.staging.proxies.len() {
            return Err(RenderWorldError::InvalidOverlay);
        }
        let mut expected_slot = overlay.expected_next_pick_slot;
        for (slot, id) in &overlay.staging.pick_slots {
            if *slot != expected_slot
                || overlay
                    .staging
                    .proxies
                    .get(id)
                    .is_none_or(|entry| entry.pick_slot != *slot)
            {
                return Err(RenderWorldError::InvalidOverlay);
            }
            expected_slot = expected_slot.checked_add(1).unwrap_or(0);
        }
        if expected_slot != overlay.staging.next_pick_slot {
            return Err(RenderWorldError::InvalidOverlay);
        }

        let diagnostics = RenderWorldOverlayDiagnostics {
            observed_proxies: overlay
                .observed_removals
                .len()
                .saturating_add(overlay.observed_bounds_updates.len()),
            staged_proxies: overlay.staging.proxies.len(),
        };
        for id in overlay.observed_removals.keys() {
            self.remove_proxy_entry(id)
                .expect("validated overlay removal remains present");
        }
        self.next_pick_slot = overlay.staging.next_pick_slot;
        for (_, entry) in overlay.staging.proxies {
            self.insert_proxy_entry(entry)
                .expect("validated overlay insertion cannot fail");
        }
        for (id, (_, bounds)) in overlay.observed_bounds_updates {
            self.proxies
                .get_mut(&id)
                .expect("validated bounds update remains present")
                .proxy
                .bounds = bounds;
        }
        self.bump_generation();
        Ok(diagnostics)
    }

    /// Inserts a new immutable proxy version and allocates its GPU pick slot.
    pub fn insert_proxy(&mut self, proxy: RenderProxy) -> Result<u32, RenderWorldError> {
        if self.proxies.contains_key(&proxy.id) {
            return Err(RenderWorldError::DuplicateProxy(proxy.id));
        }
        let pick_slot = self.next_pick_slot;
        if pick_slot == 0 {
            return Err(RenderWorldError::PickSlotExhausted);
        }
        self.next_pick_slot = self.next_pick_slot.checked_add(1).unwrap_or(0);
        self.insert_proxy_entry(ProxyEntry { proxy, pick_slot })?;
        self.bump_generation();
        Ok(pick_slot)
    }

    /// Removes one proxy and immediately invalidates its pick slot.
    pub fn remove_proxy(&mut self, id: &RenderProxyId) -> Result<RenderProxy, RenderWorldError> {
        let entry = self.remove_proxy_entry(id)?;
        self.bump_generation();
        Ok(entry.proxy)
    }

    /// Updates only view appearance, leaving immutable geometry identity intact.
    pub fn set_style(
        &mut self,
        id: &RenderProxyId,
        style: RenderStyle,
    ) -> Result<(), RenderWorldError> {
        let entry = self
            .proxies
            .get_mut(id)
            .ok_or_else(|| RenderWorldError::UnknownProxy(id.clone()))?;
        entry.proxy.style = style;
        self.bump_generation();
        Ok(())
    }

    /// Returns every proxy part belonging to one canonical entity.
    #[must_use]
    pub fn proxy_ids_for_entity(&self, entity_id: &str) -> Vec<RenderProxyId> {
        self.entity_proxies
            .get(entity_id)
            .into_iter()
            .flatten()
            .filter(|id| {
                self.proxies
                    .get(*id)
                    .is_some_and(|entry| !entry.proxy.locked)
            })
            .cloned()
            .collect()
    }

    /// Pipeline class for one resident proxy, used to resolve presentation
    /// semantics without exposing or cloning the complete proxy record.
    #[must_use]
    pub fn proxy_kind(&self, id: &RenderProxyId) -> Option<RenderProxyKind> {
        self.proxies.get(id).map(|entry| entry.proxy.kind)
    }

    /// Returns resident proxy parts for one streamed dataset/tile address.
    #[must_use]
    pub fn proxy_ids_for_tile(&self, key: &TileKey) -> Vec<RenderProxyId> {
        self.tile_proxies
            .get(key)
            .into_iter()
            .flatten()
            .cloned()
            .collect()
    }

    /// Complete resident proxy cost for a deduplicated streamed tile set.
    #[must_use]
    pub fn resident_cost_for_tiles(&self, keys: impl IntoIterator<Item = TileKey>) -> ResourceCost {
        keys.into_iter()
            .filter_map(|key| self.tile_proxies.get(&key))
            .flatten()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .filter_map(|id| self.proxies.get(id))
            .fold(ResourceCost::default(), |cost, entry| {
                cost.saturating_add(entry.proxy.cost)
            })
    }

    /// Returns the streamed dataset/tile address of one resident proxy.
    #[must_use]
    pub fn tile_key_for_proxy(&self, id: &RenderProxyId) -> Option<TileKey> {
        self.proxies
            .get(id)
            .and_then(|entry| proxy_tile_key(&entry.proxy))
    }

    /// Returns the current non-zero pick slot of one resident proxy.
    #[must_use]
    pub fn pick_slot_for_proxy(&self, id: &RenderProxyId) -> Option<u32> {
        self.proxies.get(id).map(|entry| entry.pick_slot)
    }

    /// Updates all proxy parts of one entity and returns their stable IDs.
    pub fn set_entity_style(&mut self, entity_id: &str, style: &RenderStyle) -> Vec<RenderProxyId> {
        let mut ids = Vec::new();
        let mut changed = false;
        let entity_ids = self
            .entity_proxies
            .get(entity_id)
            .cloned()
            .unwrap_or_default();
        for id in entity_ids {
            let entry = self
                .proxies
                .get_mut(&id)
                .expect("entity proxy index references a resident proxy");
            if !entry.proxy.locked {
                ids.push(id);
                if entry.proxy.style != *style {
                    entry.proxy.style = style.clone();
                    changed = true;
                }
            }
        }
        if changed {
            self.bump_generation();
        }
        ids
    }

    /// Changes view visibility without rebuilding immutable geometry resources.
    pub fn set_visible(
        &mut self,
        id: &RenderProxyId,
        visible: bool,
    ) -> Result<(), RenderWorldError> {
        if self.set_proxy_visible(id, visible)? {
            self.bump_generation();
        }
        Ok(())
    }

    /// Hides or shows one complete entity without changing immutable geometry,
    /// residency or the streaming-selected tile set.
    pub fn set_entity_visibility(&mut self, entity_id: &str, visible: bool) -> usize {
        let state_changed = if visible {
            self.hidden_entities.remove(entity_id)
        } else {
            self.hidden_entities.insert(entity_id.to_owned())
        };
        if !state_changed {
            return 0;
        }
        let ids = self.proxy_ids_for_entity(entity_id);
        let mut changed = 0;
        for id in ids {
            let desired = visible
                && self
                    .tile_key_for_proxy(&id)
                    .is_none_or(|key| self.visible_tile_keys.contains(&key));
            changed += usize::from(
                self.set_proxy_visible(&id, desired)
                    .expect("entity proxy index references a resident proxy"),
            );
        }
        self.bump_generation();
        changed
    }

    /// Forgets a retired entity's view-only visibility state.
    pub fn clear_entity_visibility(&mut self, entity_id: &str) {
        self.hidden_entities.remove(entity_id);
    }

    /// Applies one desired streamed tile set by symmetric visibility delta.
    ///
    /// Work is proportional to the previous/next visible tile sets and changed
    /// resident proxies, never to complete hidden residency.
    pub fn replace_streaming_visibility(
        &mut self,
        visible_tiles: impl IntoIterator<Item = TileKey>,
    ) -> Result<RenderWorldVisibilityDelta, RenderWorldError> {
        let next = visible_tiles.into_iter().collect::<BTreeSet<_>>();
        let shown = next
            .difference(&self.visible_tile_keys)
            .cloned()
            .collect::<Vec<_>>();
        let hidden = self
            .visible_tile_keys
            .difference(&next)
            .cloned()
            .collect::<Vec<_>>();
        let mut touched_proxies = 0;
        for key in &shown {
            let ids = self.tile_proxies.get(key).cloned().unwrap_or_default();
            for id in ids {
                touched_proxies += usize::from(self.set_proxy_visible(&id, true)?);
            }
        }
        for key in &hidden {
            let ids = self.tile_proxies.get(key).cloned().unwrap_or_default();
            for id in ids {
                touched_proxies += usize::from(self.set_proxy_visible(&id, false)?);
            }
        }
        let changed = self.visible_tile_keys != next || touched_proxies != 0;
        self.visible_tile_keys = next;
        self.streaming_visibility_initialized = true;
        if changed {
            self.bump_generation();
        }
        Ok(RenderWorldVisibilityDelta {
            shown_tiles: shown.len(),
            hidden_tiles: hidden.len(),
            touched_proxies,
        })
    }

    /// Replaces compiler-derived proxy metadata after its pick slot was
    /// allocated, without changing stable identity or visibility state.
    pub fn set_compiled_metadata(
        &mut self,
        id: &RenderProxyId,
        kind: RenderProxyKind,
        bounds: BoundingVolume,
        cost: ResourceCost,
    ) -> Result<(), RenderWorldError> {
        let entry = self
            .proxies
            .get_mut(id)
            .ok_or_else(|| RenderWorldError::UnknownProxy(id.clone()))?;
        let previous_cost = entry.proxy.cost;
        let visible = entry.proxy.visible;
        entry.proxy.kind = kind;
        entry.proxy.bounds = bounds;
        entry.proxy.cost = cost;
        self.resident_cost = self
            .resident_cost
            .saturating_sub(previous_cost)
            .saturating_add(cost);
        if visible {
            self.visible_cost = self
                .visible_cost
                .saturating_sub(previous_cost)
                .saturating_add(cost);
        }
        self.bump_generation();
        Ok(())
    }

    /// Adds retained resources created after the main geometry upload, such
    /// as an exact CPU pick index, to one proxy's complete resident cost.
    pub fn add_compiled_cost(
        &mut self,
        id: &RenderProxyId,
        additional: ResourceCost,
    ) -> Result<(), RenderWorldError> {
        let entry = self
            .proxies
            .get_mut(id)
            .ok_or_else(|| RenderWorldError::UnknownProxy(id.clone()))?;
        entry.proxy.cost = entry.proxy.cost.saturating_add(additional);
        self.resident_cost = self.resident_cost.saturating_add(additional);
        if entry.proxy.visible {
            self.visible_cost = self.visible_cost.saturating_add(additional);
        }
        self.bump_generation();
        Ok(())
    }

    /// Iterates visible proxies in deterministic identity order.
    pub fn visible_proxies(&self) -> impl Iterator<Item = (&RenderProxy, u32)> {
        self.visible_proxy_ids.iter().map(|id| {
            let entry = self
                .proxies
                .get(id)
                .expect("visible proxy index references a resident proxy");
            (&entry.proxy, entry.pick_slot)
        })
    }

    /// Iterates visible proxy IDs without allocating a frame-local set.
    pub fn visible_proxy_ids(&self) -> impl Iterator<Item = &RenderProxyId> {
        self.visible_proxy_ids.iter()
    }

    /// Returns whether one resident proxy currently contributes to a frame.
    #[must_use]
    pub fn is_visible(&self, id: &RenderProxyId) -> bool {
        self.visible_proxy_ids.contains(id)
    }

    /// Cached visible work for one entity, bounded by that entity's proxy parts.
    #[must_use]
    pub fn visible_cost_for_entity(&self, entity_id: &str) -> ResourceCost {
        self.entity_proxies
            .get(entity_id)
            .into_iter()
            .flatten()
            .filter(|id| self.visible_proxy_ids.contains(*id))
            .filter_map(|id| self.proxies.get(id))
            .fold(ResourceCost::default(), |cost, entry| {
                cost.saturating_add(entry.proxy.cost)
            })
    }

    /// Complete canonical proxy residency, including currently hidden proxies.
    /// Shared allocations intentionally remain external to avoid charging them
    /// once per proxy owner.
    #[must_use]
    pub fn resident_cost(&self) -> ResourceCost {
        self.resident_cost
    }

    /// Cached visible work, updated with proxy metadata and visibility changes.
    #[must_use]
    pub fn visible_cost(&self) -> ResourceCost {
        self.visible_cost
    }

    /// Resolves a two-attachment GPU token to a provider-refinable address.
    #[must_use]
    pub fn resolve_pick(&self, token: PickToken) -> Option<PickAddress> {
        self.resolve_pick_with_kind(token)
            .map(|(address, _kind)| address)
    }

    /// Resolves a token together with the proxy class used for coarse snap semantics.
    #[must_use]
    pub fn resolve_pick_with_kind(
        &self,
        token: PickToken,
    ) -> Option<(PickAddress, RenderProxyKind)> {
        let id = self.pick_slots.get(&token.proxy_slot)?;
        let proxy = &self.proxies.get(id)?.proxy;
        proxy.visible.then(|| {
            (
                PickAddress {
                    entity_id: proxy.entity_id.clone(),
                    render_proxy_id: proxy.id.0.clone(),
                    dataset_id: proxy.dataset_id.clone(),
                    tile_id: proxy.tile_id.clone(),
                    primitive_id: Some(u64::from(token.primitive_slot)),
                },
                proxy.kind,
            )
        })
    }

    /// Adds a convex clipping volume shared by every render pass.
    pub fn insert_clip_volume(&mut self, volume: ClipVolume) -> Result<(), RenderWorldError> {
        let volume = normalized_clip_volume(volume)?;
        if self.clip_volumes.contains_key(&volume.id) {
            return Err(RenderWorldError::DuplicateClipVolume(volume.id));
        }
        self.clip_volumes.insert(volume.id.clone(), volume);
        self.bump_generation();
        Ok(())
    }

    /// Removes a clipping volume.
    pub fn remove_clip_volume(
        &mut self,
        id: &ClipVolumeId,
    ) -> Result<ClipVolume, RenderWorldError> {
        let volume = self
            .clip_volumes
            .remove(id)
            .ok_or_else(|| RenderWorldError::UnknownClipVolume(id.clone()))?;
        self.bump_generation();
        Ok(volume)
    }

    /// Atomically replaces the complete enabled/disabled view-local clip set.
    pub fn replace_clip_volumes(
        &mut self,
        volumes: impl IntoIterator<Item = ClipVolume>,
    ) -> Result<(), RenderWorldError> {
        let mut replacement = BTreeMap::new();
        for volume in volumes {
            let volume = normalized_clip_volume(volume)?;
            let id = volume.id.clone();
            if replacement.contains_key(&id) {
                return Err(RenderWorldError::DuplicateClipVolume(id));
            }
            replacement.insert(id, volume);
        }
        self.clip_volumes = replacement;
        self.bump_generation();
        Ok(())
    }

    /// Iterates enabled clip volumes in deterministic identity order.
    pub fn active_clip_volumes(&self) -> impl Iterator<Item = &ClipVolume> {
        self.clip_volumes.values().filter(|volume| volume.enabled)
    }

    /// Iterates every normalized clip volume, including disabled saved state.
    pub fn clip_volumes(&self) -> impl Iterator<Item = &ClipVolume> {
        self.clip_volumes.values()
    }

    fn insert_proxy_entry(&mut self, mut entry: ProxyEntry) -> Result<(), RenderWorldError> {
        let id = entry.proxy.id.clone();
        if self.proxies.contains_key(&id) {
            return Err(RenderWorldError::DuplicateProxy(id));
        }
        if entry.pick_slot == 0 || self.pick_slots.contains_key(&entry.pick_slot) {
            return Err(RenderWorldError::PickSlotExhausted);
        }
        self.pick_slots.insert(entry.pick_slot, id.clone());
        self.entity_proxies
            .entry(entry.proxy.entity_id.clone())
            .or_default()
            .insert(id.clone());
        if let Some(key) = proxy_tile_key(&entry.proxy) {
            if self.streaming_visibility_initialized {
                entry.proxy.visible = self.visible_tile_keys.contains(&key);
            } else if entry.proxy.visible {
                self.visible_tile_keys.insert(key.clone());
            }
            self.tile_proxies.entry(key).or_default().insert(id.clone());
        }
        if self.hidden_entities.contains(&entry.proxy.entity_id) {
            entry.proxy.visible = false;
        }
        self.resident_cost = self.resident_cost.saturating_add(entry.proxy.cost);
        if entry.proxy.visible {
            self.visible_proxy_ids.insert(id.clone());
            self.visible_cost = self.visible_cost.saturating_add(entry.proxy.cost);
        }
        self.proxies.insert(id, entry);
        Ok(())
    }

    fn remove_proxy_entry(&mut self, id: &RenderProxyId) -> Result<ProxyEntry, RenderWorldError> {
        let entry = self
            .proxies
            .remove(id)
            .ok_or_else(|| RenderWorldError::UnknownProxy(id.clone()))?;
        self.pick_slots.remove(&entry.pick_slot);
        if let Some(ids) = self.entity_proxies.get_mut(&entry.proxy.entity_id) {
            ids.remove(id);
            if ids.is_empty() {
                self.entity_proxies.remove(&entry.proxy.entity_id);
            }
        }
        if let Some(key) = proxy_tile_key(&entry.proxy) {
            if let Some(ids) = self.tile_proxies.get_mut(&key) {
                ids.remove(id);
                if ids.is_empty() {
                    self.tile_proxies.remove(&key);
                }
            }
        }
        self.resident_cost = self.resident_cost.saturating_sub(entry.proxy.cost);
        if self.visible_proxy_ids.remove(id) {
            self.visible_cost = self.visible_cost.saturating_sub(entry.proxy.cost);
        }
        Ok(entry)
    }

    fn set_proxy_visible(
        &mut self,
        id: &RenderProxyId,
        visible: bool,
    ) -> Result<bool, RenderWorldError> {
        let entry = self
            .proxies
            .get_mut(id)
            .ok_or_else(|| RenderWorldError::UnknownProxy(id.clone()))?;
        let visible = visible && !self.hidden_entities.contains(&entry.proxy.entity_id);
        if entry.proxy.visible == visible {
            return Ok(false);
        }
        entry.proxy.visible = visible;
        if visible {
            self.visible_proxy_ids.insert(id.clone());
            self.visible_cost = self.visible_cost.saturating_add(entry.proxy.cost);
        } else {
            self.visible_proxy_ids.remove(id);
            self.visible_cost = self.visible_cost.saturating_sub(entry.proxy.cost);
        }
        Ok(true)
    }

    fn bump_generation(&mut self) {
        self.generation = self.generation.wrapping_add(1);
    }
}

impl PreparedRenderWorldOverlay {
    /// Empty scratch world used by existing entity/stream compiler functions.
    pub fn staging_world_mut(&mut self) -> &mut RenderWorld {
        &mut self.staging
    }

    /// Bounded work represented by the prepared mutation so far.
    #[must_use]
    pub fn diagnostics(&self) -> RenderWorldOverlayDiagnostics {
        RenderWorldOverlayDiagnostics {
            observed_proxies: self
                .observed_removals
                .len()
                .saturating_add(self.observed_bounds_updates.len()),
            staged_proxies: self.staging.proxies.len(),
        }
    }
}

fn proxy_tile_key(proxy: &RenderProxy) -> Option<TileKey> {
    Some(TileKey {
        dataset_id: proxy.dataset_id.clone()?,
        tile_id: proxy.tile_id.clone()?,
    })
}

fn normalized_clip_volume(mut volume: ClipVolume) -> Result<ClipVolume, RenderWorldError> {
    let invalid = || RenderWorldError::InvalidClipVolume(volume.id.clone());
    if volume.id.0.trim().is_empty()
        || volume.planes.is_empty()
        || volume
            .section_fill
            .as_ref()
            .is_some_and(invalid_section_hatch)
        || volume
            .section_material_hatches
            .values()
            .any(invalid_section_hatch)
    {
        return Err(invalid());
    }
    for plane in &mut volume.planes {
        let length = (plane.normal.x * plane.normal.x
            + plane.normal.y * plane.normal.y
            + plane.normal.z * plane.normal.z)
            .sqrt();
        if !length.is_finite() || length <= f64::EPSILON || !plane.distance.is_finite() {
            return Err(invalid());
        }
        plane.normal.x /= length;
        plane.normal.y /= length;
        plane.normal.z /= length;
        plane.distance /= length;
    }
    Ok(volume)
}

fn invalid_section_hatch(style: &SectionHatchStyle) -> bool {
    style.resource.resource_id.trim().is_empty()
        || style.resource.schema_id.trim().is_empty()
        || style.resource.content_hash.as_str().len() != 64
        || !style
            .resource
            .content_hash
            .as_str()
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || !style.line_width.is_finite()
        || style.line_width <= 0.0
        || style.color.iter().any(|value| !value.is_finite())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{
        ClipOperation, ClipVolume, ClipVolumeId, ColorMode, EntityInteractionState, RenderProxy,
        RenderProxyId, RenderProxyKind, RenderStyle, RenderWorld, RenderWorldError, StrokeCap,
        StrokeColor, StrokeJoin, StrokeMode, StrokeStyle, StrokeWidth,
    };
    use crate::{
        BoundingVolume, DatasetId, PickToken, ResourceCost, TileId, TileKey, WorldAabb, WorldVec3,
    };

    #[test]
    fn point_classification_json_without_palette_keeps_the_default_contract() {
        let mode: ColorMode = serde_json::from_str(r#"{"kind":"pointClassification"}"#)
            .expect("classification mode without an authored palette");
        assert_eq!(mode, ColorMode::PointClassification { colors: Vec::new() });
    }

    #[test]
    fn interaction_overlay_preserves_base_style_and_resolves_shared_priority() {
        let base = RenderStyle {
            base_color: [0.2, 0.3, 0.4, 0.6],
            color_mode: ColorMode::Source,
            ..RenderStyle::default()
        };
        let hovered = base.with_interaction(EntityInteractionState {
            selected: false,
            hovered: true,
        });
        assert_eq!(hovered.base_color, [0.1, 0.75, 1.0, 0.6]);
        assert_eq!(hovered.color_mode, ColorMode::Uniform);
        assert_eq!(
            hovered.stroke.color,
            StrokeColor::Uniform {
                color: [0.1, 0.75, 1.0, 0.6]
            }
        );

        let selected = base.with_interaction(EntityInteractionState {
            selected: true,
            hovered: true,
        });
        assert_eq!(selected.base_color, [1.0, 0.55, 0.05, 0.6]);
        assert_eq!(base.base_color, [0.2, 0.3, 0.4, 0.6]);
        assert_eq!(
            base.with_interaction(EntityInteractionState::default()),
            base
        );
    }

    #[test]
    fn legacy_render_style_normalizes_to_an_explicit_source_stroke() {
        let style: RenderStyle = serde_json::from_str(
            r#"{"baseColor":[1,1,1,1],"opacity":1,"verticalExaggeration":1,"colorMode":{"kind":"uniform"},"fill":{"kind":"color"}}"#,
        )
        .expect("legacy style");
        assert_eq!(
            style.stroke,
            StrokeStyle {
                mode: StrokeMode::Color,
                color: StrokeColor::Inherit,
                width: StrokeWidth::Source,
                cap: StrokeCap::Butt,
                join: StrokeJoin::Miter,
                miter_limit: 4.0,
            }
        );
        let serialized = serde_json::to_value(style).expect("serialized normalized style");
        assert!(serialized.get("stroke").is_some());
    }

    #[test]
    fn point_mesh_and_cad_share_one_collision_free_pick_namespace() {
        let mut world = RenderWorld::new();
        let point_slot = world.insert_proxy(proxy("point-tile", "cloud", RenderProxyKind::Points));
        let mesh_slot =
            world.insert_proxy(proxy("mesh-tile", "building", RenderProxyKind::Triangles));
        let cad_slot = world.insert_proxy(proxy("cad-curve", "parcel", RenderProxyKind::CadStroke));

        assert_eq!(point_slot.expect("point slot"), 1);
        assert_eq!(mesh_slot.expect("mesh slot"), 2);
        assert_eq!(cad_slot.expect("CAD slot"), 3);
        let pick = world
            .resolve_pick(PickToken {
                proxy_slot: 3,
                primitive_slot: 17,
            })
            .expect("known visible token");
        assert_eq!(pick.entity_id, "parcel");
        assert_eq!(pick.primitive_id, Some(17));
    }

    #[test]
    fn removed_proxy_never_resolves_stale_asynchronous_pick() {
        let mut world = RenderWorld::new();
        world
            .insert_proxy(proxy("old-version", "road", RenderProxyKind::Triangles))
            .expect("insert");
        world
            .remove_proxy(&RenderProxyId("old-version".to_owned()))
            .expect("remove");

        assert_eq!(
            world.resolve_pick(PickToken {
                proxy_slot: 1,
                primitive_slot: 5,
            }),
            None
        );
    }

    #[test]
    fn bounds_overlay_preserves_proxy_and_pick_identity() {
        let mut world = RenderWorld::new();
        let id = RenderProxyId("resident-road-tile".to_owned());
        let slot = world
            .insert_proxy(proxy(&id.0, "road-scan", RenderProxyKind::Triangles))
            .expect("resident proxy");
        let bounds = BoundingVolume::AxisAlignedBox {
            bounds: WorldAabb {
                min: WorldVec3 {
                    x: 500_000.0,
                    y: 5_400_000.0,
                    z: 420.0,
                },
                max: WorldVec3 {
                    x: 500_200.0,
                    y: 5_400_100.0,
                    z: 460.0,
                },
            },
        };
        let overlay = world
            .prepare_overlay_with_bounds_updates([], [(id.clone(), bounds)])
            .expect("prepare bounds-only update");
        world.commit_overlay(overlay).expect("commit bounds update");
        assert_eq!(world.pick_slot_for_proxy(&id), Some(slot));
        let pick = world
            .resolve_pick(PickToken {
                proxy_slot: slot,
                primitive_slot: 9,
            })
            .expect("stable pick token");
        assert_eq!(pick.entity_id, "road-scan");
        assert_eq!(pick.primitive_id, Some(9));
    }

    #[test]
    fn canonical_residency_includes_hidden_proxies_without_changing_visible_workload() {
        let mut world = RenderWorld::new();
        let mut visible = proxy("visible", "surface", RenderProxyKind::Triangles);
        visible.cost = ResourceCost {
            gpu_buffer_bytes: 128,
            triangles: 2,
            draw_calls: 1,
            ..ResourceCost::default()
        };
        let mut hidden = proxy("hidden", "surface", RenderProxyKind::Triangles);
        hidden.visible = false;
        hidden.cost = ResourceCost {
            gpu_buffer_bytes: 256,
            triangles: 4,
            draw_calls: 1,
            ..ResourceCost::default()
        };
        world.insert_proxy(visible).expect("visible proxy");
        world.insert_proxy(hidden).expect("hidden proxy");

        assert_eq!(world.visible_proxies().count(), 1);
        assert_eq!(world.resident_cost().gpu_buffer_bytes, 384);
        assert_eq!(world.resident_cost().triangles, 6);
    }

    #[test]
    fn entity_visibility_preserves_residency_and_latest_stream_selection() {
        let mut world = RenderWorld::new();
        world.insert_proxy(tiled_proxy(0)).expect("first tile");
        world.insert_proxy(tiled_proxy(1)).expect("second tile");
        world
            .replace_streaming_visibility([tile_key(0)])
            .expect("initial selection");
        let resident = world.resident_cost();

        assert_eq!(world.set_entity_visibility("large-cloud-entity", false), 1);
        assert_eq!(world.visible_proxies().count(), 0);
        assert_eq!(world.resident_cost(), resident);

        world
            .replace_streaming_visibility([tile_key(1)])
            .expect("selection advances while hidden");
        assert_eq!(world.visible_proxies().count(), 0);
        assert_eq!(world.set_entity_visibility("large-cloud-entity", true), 1);
        assert!(!world.is_visible(&RenderProxyId("tile-0".to_owned())));
        assert!(world.is_visible(&RenderProxyId("tile-1".to_owned())));
        assert_eq!(world.resident_cost(), resident);
    }

    #[test]
    fn one_clip_volume_is_visible_to_every_proxy_pipeline() {
        let mut world = RenderWorld::new();
        for (id, kind) in [
            ("points", RenderProxyKind::Points),
            ("mesh", RenderProxyKind::Triangles),
            ("cad", RenderProxyKind::CadFill),
        ] {
            world.insert_proxy(proxy(id, id, kind)).expect("insert");
        }
        world
            .insert_clip_volume(ClipVolume {
                id: ClipVolumeId("section-box".to_owned()),
                planes: vec![crate::ClipPlane {
                    normal: WorldVec3 {
                        x: 2.0,
                        y: 0.0,
                        z: 0.0,
                    },
                    distance: -4.0,
                }],
                operation: ClipOperation::KeepInside,
                preview_cap: true,
                section_fill: None,
                section_material_hatches: BTreeMap::new(),
                enabled: true,
            })
            .expect("clip");

        assert_eq!(world.visible_proxies().count(), 3);
        assert_eq!(world.active_clip_volumes().count(), 1);
        let plane = world
            .active_clip_volumes()
            .next()
            .expect("active clip")
            .planes[0];
        assert_eq!(plane.normal.x, 1.0);
        assert_eq!(plane.distance, -2.0);
    }

    #[test]
    fn replacing_clip_set_rejects_duplicates_without_mutating_the_live_view() {
        let mut world = RenderWorld::new();
        world
            .replace_clip_volumes([clip("existing")])
            .expect("initial clip set");
        let generation = world.generation();

        let result = world.replace_clip_volumes([clip("duplicate"), clip("duplicate")]);

        assert!(result.is_err());
        assert_eq!(world.generation(), generation);
        let active = world
            .active_clip_volumes()
            .map(|volume| volume.id.0.as_str())
            .collect::<Vec<_>>();
        assert_eq!(active, ["existing"]);
    }

    #[test]
    fn invalid_clip_plane_is_rejected_without_mutating_live_state() {
        let mut world = RenderWorld::new();
        world
            .replace_clip_volumes([clip("existing")])
            .expect("initial clip set");
        let generation = world.generation();
        let mut invalid = clip("invalid");
        invalid.planes[0].normal.x = 0.0;

        assert!(world.replace_clip_volumes([invalid]).is_err());
        assert_eq!(world.generation(), generation);
        assert_eq!(
            world
                .clip_volumes()
                .map(|volume| volume.id.0.as_str())
                .collect::<Vec<_>>(),
            ["existing"]
        );
    }

    #[test]
    fn touched_overlay_preserves_one_hundred_thousand_foreign_pick_slots() {
        const FOREIGN_COUNT: usize = 100_000;
        let mut world = RenderWorld::new();
        let mut original_slots = Vec::with_capacity(FOREIGN_COUNT);
        for index in 0..FOREIGN_COUNT {
            let id = RenderProxyId(format!("foreign-{index}"));
            let slot = world
                .insert_proxy(proxy(
                    &id.0,
                    &format!("entity-{index}"),
                    RenderProxyKind::Points,
                ))
                .expect("foreign proxy");
            original_slots.push(slot);
        }
        let replaced_id = RenderProxyId("foreign-50000".to_owned());
        let old_pick_slot = world
            .pick_slot_for_proxy(&replaced_id)
            .expect("old target slot");
        let generation = world.generation();
        let mut overlay = world
            .prepare_overlay([replaced_id.clone()])
            .expect("touched overlay");
        let new_pick_slot = overlay
            .staging_world_mut()
            .insert_proxy(proxy(
                &replaced_id.0,
                "replacement-entity",
                RenderProxyKind::Triangles,
            ))
            .expect("staged replacement");
        assert_eq!(
            overlay.diagnostics(),
            super::RenderWorldOverlayDiagnostics {
                observed_proxies: 1,
                staged_proxies: 1,
            }
        );
        assert_eq!(
            world.pick_slot_for_proxy(&replaced_id),
            Some(old_pick_slot),
            "prepare must not mutate the live world"
        );

        let committed = world.commit_overlay(overlay).expect("overlay commit");
        assert_eq!(committed.observed_proxies, 1);
        assert_eq!(committed.staged_proxies, 1);
        assert_eq!(world.generation(), generation + 1);
        assert_eq!(world.pick_slot_for_proxy(&replaced_id), Some(new_pick_slot));
        assert_ne!(new_pick_slot, old_pick_slot);
        for (index, expected) in original_slots.into_iter().enumerate() {
            if index == 50_000 {
                continue;
            }
            assert_eq!(
                world.pick_slot_for_proxy(&RenderProxyId(format!("foreign-{index}"))),
                Some(expected),
                "unrelated pick slot changed at {index}"
            );
        }
        assert_eq!(
            world.proxy_ids_for_entity("replacement-entity"),
            [replaced_id]
        );
        assert!(world.proxy_ids_for_entity("entity-50000").is_empty());
    }

    #[test]
    fn stale_overlay_and_id_collision_leave_live_world_unchanged() {
        let mut world = RenderWorld::new();
        let target = RenderProxyId("target".to_owned());
        world
            .insert_proxy(proxy(
                &target.0,
                "target-entity",
                RenderProxyKind::CadStroke,
            ))
            .expect("target");
        let mut stale = world
            .prepare_overlay([target.clone()])
            .expect("prepare stale candidate");
        stale
            .staging_world_mut()
            .insert_proxy(proxy(&target.0, "replacement", RenderProxyKind::CadStroke))
            .expect("staged target");
        world
            .insert_proxy(proxy("unrelated", "other", RenderProxyKind::Points))
            .expect("intervening mutation");
        let generation = world.generation();
        let target_slot = world.pick_slot_for_proxy(&target);
        assert_eq!(
            world.commit_overlay(stale),
            Err(RenderWorldError::StaleOverlay)
        );
        assert_eq!(world.generation(), generation);
        assert_eq!(world.pick_slot_for_proxy(&target), target_slot);

        let mut collision = world.prepare_overlay([]).expect("empty removal set");
        collision
            .staging_world_mut()
            .insert_proxy(proxy("unrelated", "duplicate", RenderProxyKind::Points))
            .expect("scratch world has no unrelated residency");
        let generation = world.generation();
        assert_eq!(
            world.commit_overlay(collision),
            Err(RenderWorldError::DuplicateProxy(RenderProxyId(
                "unrelated".to_owned()
            )))
        );
        assert_eq!(world.generation(), generation);
        assert_eq!(world.proxy_ids_for_entity("other").len(), 1);
    }

    #[test]
    fn visibility_delta_and_cached_cost_ignore_hidden_residency() {
        const RESIDENT_COUNT: usize = 100_000;
        const VISIBLE_COUNT: usize = 1_000;
        let mut world = RenderWorld::new();
        for index in 0..RESIDENT_COUNT {
            let mut resident = tiled_proxy(index);
            resident.visible = index < VISIBLE_COUNT;
            resident.cost = ResourceCost {
                points: 1,
                draw_calls: 1,
                gpu_buffer_bytes: 32,
                ..ResourceCost::default()
            };
            world.insert_proxy(resident).expect("resident tile proxy");
        }
        assert_eq!(world.visible_proxies().count(), VISIBLE_COUNT);
        assert_eq!(world.visible_cost().points, VISIBLE_COUNT as u64);
        assert_eq!(world.resident_cost().points, RESIDENT_COUNT as u64);

        let next = (0..VISIBLE_COUNT - 1)
            .chain(std::iter::once(VISIBLE_COUNT))
            .map(tile_key)
            .collect::<Vec<_>>();
        let generation = world.generation();
        let delta = world
            .replace_streaming_visibility(next.clone())
            .expect("small visibility delta");
        assert_eq!(delta.shown_tiles, 1);
        assert_eq!(delta.hidden_tiles, 1);
        assert_eq!(delta.touched_proxies, 2);
        assert_eq!(world.generation(), generation + 1);
        assert_eq!(world.visible_proxies().count(), VISIBLE_COUNT);
        assert_eq!(world.visible_cost().points, VISIBLE_COUNT as u64);
        assert_eq!(world.resident_cost().points, RESIDENT_COUNT as u64);
        assert_eq!(
            world.proxy_ids_for_tile(&tile_key(VISIBLE_COUNT)),
            [RenderProxyId(format!("tile-{VISIBLE_COUNT}"))]
        );

        let generation = world.generation();
        let unchanged = world
            .replace_streaming_visibility(next)
            .expect("unchanged visibility");
        assert_eq!(unchanged, super::RenderWorldVisibilityDelta::default());
        assert_eq!(world.generation(), generation);
    }

    fn clip(id: &str) -> ClipVolume {
        ClipVolume {
            id: ClipVolumeId(id.to_owned()),
            planes: vec![crate::ClipPlane {
                normal: WorldVec3 {
                    x: 1.0,
                    y: 0.0,
                    z: 0.0,
                },
                distance: 0.0,
            }],
            operation: ClipOperation::KeepInside,
            preview_cap: false,
            section_fill: None,
            section_material_hatches: BTreeMap::new(),
            enabled: true,
        }
    }

    fn proxy(id: &str, entity_id: &str, kind: RenderProxyKind) -> RenderProxy {
        RenderProxy {
            id: RenderProxyId(id.to_owned()),
            entity_id: entity_id.to_owned(),
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

    fn tile_key(index: usize) -> TileKey {
        TileKey {
            dataset_id: DatasetId("large-cloud".to_owned()),
            tile_id: TileId(format!("node-{index}")),
        }
    }

    fn tiled_proxy(index: usize) -> RenderProxy {
        let mut proxy = proxy(
            &format!("tile-{index}"),
            "large-cloud-entity",
            RenderProxyKind::Points,
        );
        let key = tile_key(index);
        proxy.dataset_id = Some(key.dataset_id);
        proxy.tile_id = Some(key.tile_id);
        proxy
    }
}
