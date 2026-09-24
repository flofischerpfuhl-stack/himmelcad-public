use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Comparable dotted numeric version retained without vendor-name matching.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct HardwareQuirkVersion(pub String);

/// Exact, structured hardware/session facts used by one reviewed rule.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HardwareQuirkMatch {
    /// Operating system identifier.
    pub os: Option<String>,
    /// Numeric PCI vendor identifier.
    pub vendor_id: Option<u32>,
    /// Numeric PCI device identifier.
    pub device_id: Option<u32>,
    /// Inclusive minimum driver version.
    pub driver_min: Option<HardwareQuirkVersion>,
    /// Inclusive maximum driver version.
    pub driver_max: Option<HardwareQuirkVersion>,
    /// Selected renderer backend.
    pub backend: Option<String>,
    /// Display session type.
    pub session_type: Option<String>,
    /// Reviewed Electron semver range.
    pub electron_range: Option<String>,
}

/// Actions produced by a matched reviewed rule.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HardwareQuirkActions {
    /// Backends excluded for this exact match.
    pub disable_backends: Vec<String>,
    /// ANGLE backend forced for this exact match.
    pub force_angle: Option<String>,
    /// Render-budget multiplier in the inclusive range 0.1..=1.0.
    pub render_budget_scale: Option<f32>,
    /// Compute-budget multiplier in the inclusive range 0.1..=1.0.
    pub compute_budget_scale: Option<f32>,
}

/// One version-one reviewed hardware quirk.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HardwareQuirk {
    /// Stable lowercase identifier.
    pub id: String,
    /// Higher values resolve first.
    pub priority: i32,
    /// Structured match fields.
    #[serde(rename = "match")]
    pub matcher: HardwareQuirkMatch,
    /// Deterministic actions.
    pub actions: HardwareQuirkActions,
    /// Reviewed human-readable rationale.
    pub reason: String,
    /// ISO date after which the rule must be reviewed.
    pub expires: String,
}

/// Fully merged deterministic quirk result.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HardwareQuirkResolution {
    /// Rules that contributed actions, in priority/id order.
    pub matched_ids: Vec<String>,
    /// Disabled backends with stable ordering.
    pub disable_backends: Vec<String>,
    /// Forced ANGLE backend, if any.
    pub force_angle: Option<String>,
    /// Product of matched render scales.
    pub render_budget_scale: f32,
    /// Product of matched compute scales.
    pub compute_budget_scale: f32,
}

/// Rejected quirk registry or conflicting resolution.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum HardwareQuirkValidationError {
    /// Stable id is absent or malformed.
    #[error("hardware quirk id is invalid: {0}")]
    InvalidId(String),
    /// Two entries reuse one stable id.
    #[error("duplicate hardware quirk id: {0}")]
    DuplicateId(String),
    /// Scale lies outside the accepted range.
    #[error("hardware quirk {id} has an invalid {field}")]
    InvalidScale {
        /// Rule id.
        id: String,
        /// Invalid scale field.
        field: &'static str,
    },
    /// Driver range is reversed.
    #[error("hardware quirk {0} has a reversed driver range")]
    ReversedDriverRange(String),
    /// Equal-priority rules prescribe incompatible singular actions.
    #[error("hardware quirks {left} and {right} conflict at equal priority")]
    Conflict {
        /// First conflicting rule id.
        left: String,
        /// Second conflicting rule id.
        right: String,
    },
}

/// Returns the checked-in rules generated from the canonical JSON registry.
#[must_use]
pub fn reviewed_quirks() -> Vec<HardwareQuirk> {
    crate::generated_quirks::generated_quirks()
}

/// Validates and deterministically merges already-matched rules.
pub fn resolve_quirks(
    rules: &[HardwareQuirk],
) -> Result<HardwareQuirkResolution, HardwareQuirkValidationError> {
    validate(rules)?;
    let mut ordered = rules.to_vec();
    ordered.sort_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then_with(|| left.id.cmp(&right.id))
    });
    for pair in ordered.windows(2) {
        if pair[0].priority == pair[1].priority
            && pair[0].actions.force_angle.is_some()
            && pair[1].actions.force_angle.is_some()
            && pair[0].actions.force_angle != pair[1].actions.force_angle
        {
            return Err(HardwareQuirkValidationError::Conflict {
                left: pair[0].id.clone(),
                right: pair[1].id.clone(),
            });
        }
    }
    let mut disabled = BTreeSet::new();
    let mut result = HardwareQuirkResolution {
        render_budget_scale: 1.0,
        compute_budget_scale: 1.0,
        ..HardwareQuirkResolution::default()
    };
    for rule in ordered {
        result.matched_ids.push(rule.id);
        disabled.extend(rule.actions.disable_backends);
        if result.force_angle.is_none() {
            result.force_angle = rule.actions.force_angle;
        }
        result.render_budget_scale *= rule.actions.render_budget_scale.unwrap_or(1.0);
        result.compute_budget_scale *= rule.actions.compute_budget_scale.unwrap_or(1.0);
    }
    result.disable_backends = disabled.into_iter().collect();
    Ok(result)
}

fn validate(rules: &[HardwareQuirk]) -> Result<(), HardwareQuirkValidationError> {
    let mut ids = BTreeSet::new();
    for rule in rules {
        if rule.id.is_empty()
            || !rule
                .id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err(HardwareQuirkValidationError::InvalidId(rule.id.clone()));
        }
        if !ids.insert(rule.id.clone()) {
            return Err(HardwareQuirkValidationError::DuplicateId(rule.id.clone()));
        }
        for (field, scale) in [
            ("renderBudgetScale", rule.actions.render_budget_scale),
            ("computeBudgetScale", rule.actions.compute_budget_scale),
        ] {
            if scale.is_some_and(|value| !value.is_finite() || !(0.1..=1.0).contains(&value)) {
                return Err(HardwareQuirkValidationError::InvalidScale {
                    id: rule.id.clone(),
                    field,
                });
            }
        }
        if rule.matcher.driver_min > rule.matcher.driver_max && rule.matcher.driver_max.is_some() {
            return Err(HardwareQuirkValidationError::ReversedDriverRange(
                rule.id.clone(),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(id: &str, priority: i32, angle: Option<&str>) -> HardwareQuirk {
        HardwareQuirk {
            id: id.into(),
            priority,
            matcher: HardwareQuirkMatch::default(),
            actions: HardwareQuirkActions {
                force_angle: angle.map(str::to_owned),
                render_budget_scale: Some(0.5),
                ..HardwareQuirkActions::default()
            },
            reason: "test".into(),
            expires: "2099-01-01".into(),
        }
    }

    #[test]
    fn priority_is_deterministic_and_equal_priority_conflicts_are_rejected() {
        let resolved = resolve_quirks(&[
            rule("lower", 1, Some("gl")),
            rule("higher", 2, Some("d3d11")),
        ])
        .expect("valid rules");
        assert_eq!(resolved.matched_ids, ["higher", "lower"]);
        assert_eq!(resolved.force_angle.as_deref(), Some("d3d11"));
        assert_eq!(resolved.render_budget_scale, 0.25);
        assert!(matches!(
            resolve_quirks(&[rule("alpha", 1, Some("gl")), rule("beta", 1, Some("d3d11"))]),
            Err(HardwareQuirkValidationError::Conflict { .. })
        ));
    }

    #[test]
    fn generated_registry_is_valid_and_currently_empty() {
        let resolved =
            resolve_quirks(&crate::generated_quirks::generated_quirks()).expect("generated rules");
        assert!(resolved.matched_ids.is_empty());
        assert_eq!(resolved.render_budget_scale, 1.0);
    }
}
