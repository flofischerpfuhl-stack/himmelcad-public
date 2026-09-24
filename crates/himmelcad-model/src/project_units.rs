//! Project-local metric coordinate declaration shared by domain packages.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PhotolabSpatialReference {
    LocalMetric {
        unit: MetricLengthUnit,
        axes: LocalMetricAxes,
    },
    CrsBacked,
}

impl Default for PhotolabSpatialReference {
    fn default() -> Self {
        Self::LocalMetric {
            unit: MetricLengthUnit::Meter,
            axes: LocalMetricAxes::RightHandedZUp,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalMetricAxes {
    RightHandedZUp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MetricLengthUnit {
    Millimeter,
    Centimeter,
    Meter,
    Inch,
    Foot,
}

impl MetricLengthUnit {
    #[must_use]
    pub const fn meters_per_unit(self) -> f64 {
        match self {
            Self::Millimeter => 0.001,
            Self::Centimeter => 0.01,
            Self::Meter => 1.0,
            Self::Inch => 0.0254,
            Self::Foot => 0.3048,
        }
    }
}
