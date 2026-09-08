//! Adaptive point/splat presentation policy independent of provider decoding.

use serde::{Deserialize, Serialize};

use crate::{FrontierHardwareClass, RuntimeQualityTier};

/// Tunables for spacing-derived point diameter in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdaptivePointTunables {
    /// Coverage factor applied after projecting the node sample spacing.
    pub coverage: f32,
    /// Smallest submitted point diameter.
    pub minimum_pixels: f32,
    /// Largest submitted point diameter.
    pub maximum_pixels: f32,
}

impl Default for AdaptivePointTunables {
    fn default() -> Self {
        Self {
            coverage: 1.0,
            minimum_pixels: 1.0,
            maximum_pixels: 8.0,
        }
    }
}

impl AdaptivePointTunables {
    /// Validates the finite bounded contract shared by CPU identity tests and WGSL.
    pub fn validate(self) -> Result<Self, PointQualityError> {
        if !self.coverage.is_finite()
            || self.coverage <= 0.0
            || !self.minimum_pixels.is_finite()
            || !self.maximum_pixels.is_finite()
            || self.minimum_pixels < 1.0
            || self.maximum_pixels > 8.0
            || self.minimum_pixels > self.maximum_pixels
        {
            return Err(PointQualityError::InvalidTunables);
        }
        Ok(self)
    }
}

/// Deterministic reference calculation mirrored by the point vertex shader.
pub fn adaptive_point_diameter(
    spacing: f64,
    pixels_per_project_unit: f64,
    entity_multiplier: f32,
    view_multiplier: f32,
    tunables: AdaptivePointTunables,
) -> Result<f32, PointQualityError> {
    let tunables = tunables.validate()?;
    if !spacing.is_finite()
        || spacing <= 0.0
        || !pixels_per_project_unit.is_finite()
        || pixels_per_project_unit <= 0.0
        || !entity_multiplier.is_finite()
        || entity_multiplier <= 0.0
        || !view_multiplier.is_finite()
        || view_multiplier <= 0.0
    {
        return Err(PointQualityError::InvalidInput);
    }
    #[allow(clippy::cast_possible_truncation)]
    let projected = (spacing
        * pixels_per_project_unit
        * f64::from(tunables.coverage)
        * f64::from(entity_multiplier)
        * f64::from(view_multiplier)) as f32;
    Ok(projected.clamp(tunables.minimum_pixels, tunables.maximum_pixels))
}

/// Eye-dome-lighting sampling tier. It never changes depth or picking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EyeDomeLightingTier {
    /// No full-screen depth samples.
    Off,
    /// Horizontal/vertical two-direction pair.
    TwoTap,
    /// Horizontal, vertical and diagonal four-direction pairs.
    FourTap,
}

impl EyeDomeLightingTier {
    /// Number of neighbor directions sampled by the presentation shader.
    #[must_use]
    pub const fn taps(self) -> u32 {
        match self {
            Self::Off => 0,
            Self::TwoTap => 2,
            Self::FourTap => 4,
        }
    }
}

/// Presentation-only EDL parameters selected at the current frame boundary.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EyeDomeLightingSettings {
    /// Governor-selected sample tier.
    pub tier: EyeDomeLightingTier,
    /// Neighbor radius in physical pixels.
    pub radius_pixels: f32,
    /// Exponential depth-contrast strength.
    pub strength: f32,
}

impl EyeDomeLightingSettings {
    /// Disabled effect used before policy initialization and for exact picking.
    pub const OFF: Self = Self {
        tier: EyeDomeLightingTier::Off,
        radius_pixels: 1.0,
        strength: 80.0,
    };
}

/// Maps the V-03 class/tier state and motion state to bounded EDL work.
#[must_use]
pub const fn eye_dome_lighting_settings(
    hardware_class: FrontierHardwareClass,
    quality_tier: RuntimeQualityTier,
    interacting: bool,
) -> EyeDomeLightingSettings {
    let tier = match quality_tier {
        RuntimeQualityTier::Minimum => EyeDomeLightingTier::Off,
        RuntimeQualityTier::Coarse => {
            if interacting {
                EyeDomeLightingTier::Off
            } else {
                EyeDomeLightingTier::TwoTap
            }
        }
        RuntimeQualityTier::Balanced | RuntimeQualityTier::Full => match hardware_class {
            FrontierHardwareClass::I if interacting => EyeDomeLightingTier::Off,
            FrontierHardwareClass::I => EyeDomeLightingTier::TwoTap,
            FrontierHardwareClass::W | FrontierHardwareClass::D if interacting => {
                EyeDomeLightingTier::TwoTap
            }
            FrontierHardwareClass::W | FrontierHardwareClass::D => EyeDomeLightingTier::FourTap,
        },
    };
    EyeDomeLightingSettings {
        tier,
        radius_pixels: 1.0,
        strength: 80.0,
    }
}

/// Invalid adaptive-quality input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointQualityError {
    /// Tunables violate the renderer's 1–8 px bounded contract.
    InvalidTunables,
    /// Spacing, projection scale or a multiplier is non-finite/non-positive.
    InvalidInput,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adaptive_diameter_is_deterministic_and_bounded() {
        let tunables = AdaptivePointTunables::default();
        assert_eq!(
            adaptive_point_diameter(0.5, 6.0, 1.0, 1.0, tunables),
            Ok(3.0)
        );
        assert_eq!(
            adaptive_point_diameter(0.01, 1.0, 1.0, 1.0, tunables),
            Ok(1.0)
        );
        assert_eq!(
            adaptive_point_diameter(10.0, 10.0, 2.0, 2.0, tunables),
            Ok(8.0)
        );
        assert_eq!(
            adaptive_point_diameter(0.5, 6.0, 1.5, 0.5, tunables),
            Ok(2.25)
        );
    }

    #[test]
    fn class_i_edl_yields_to_motion_and_returns_at_rest() {
        assert_eq!(
            eye_dome_lighting_settings(FrontierHardwareClass::I, RuntimeQualityTier::Full, true,)
                .tier,
            EyeDomeLightingTier::Off,
        );
        assert_eq!(
            eye_dome_lighting_settings(FrontierHardwareClass::I, RuntimeQualityTier::Full, false,)
                .tier,
            EyeDomeLightingTier::TwoTap,
        );
        assert_eq!(
            eye_dome_lighting_settings(FrontierHardwareClass::D, RuntimeQualityTier::Full, false,)
                .tier,
            EyeDomeLightingTier::FourTap,
        );
    }
}
