# ADR 0023: Local metric photogrammetry is first-class without a CRS

- Status: Accepted
- Date: 2026-07-19
- Depends on: ADR 0011, ADR 0012, ADR 0021

## Context

Rooms, objects and other location-irrelevant captures need correct metric scale
without claiming georeferencing. Requiring a survey CRS for every PhotoLab
project would either block this workflow or invent false origin, north, gravity
and map metadata.

## Decision

A PhotoLab reference snapshot declares either `crsBacked` or `localMetric`.
Both use a right-handed Cartesian project frame in metres. Only `crsBacked`
adds a defined CRS and its explicit horizontal/vertical transform provenance.
`localMetric` does not invent an EPSG code, world origin, north direction or
gravity constraint.

A versioned `ScaleConstraintSet` may establish or refine the local scale. Each
constraint stores two 3D endpoint references, target distance in metres,
uncertainty and lineage. Endpoints must be triangulated from sufficient image
observations or resolve against valid reconstructed geometry; two unrelated
single-image pixels do not define a metric distance. One independent distance
fixes scale only, not orientation or absolute position.

Embedded smartphone/GNSS positions remain optional noisy priors with recorded
accuracy or conservative uncertainty. Their presence never silently promotes a
local project to a CRS-backed project.

## Consequences

- Metric measurements and non-geospatial products work in both modes.
- Geospatial export and map overlay remain unavailable or explicitly marked
  ungeoreferenced until a CRS-backed reference is established.
- Scale constraints are immutable inputs to alignment/adjustment runs and are
  included in provenance, covariance reporting and stale-result checks.
