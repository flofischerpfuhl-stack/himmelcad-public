"""HimmelCAD Assembler agent API client (``hcasm.agent-api@1``).

Hand-maintained companion to the generated HimmelCAD automation SDK: the
Assembler contract (``apps/assembler/api/agent-api-v1.schema.json``) is a
separate, versioned product contract (ADR 0033 §4) and is not covered by
``scripts/generate-automation-sdk.py``. The test suite pins this module's
method table to the checked-in schema so the two cannot drift silently.

Two layers:

* :class:`AssemblerClient` — one method per canonical command/query.
* :class:`Document` — idiomatic modelling (``doc.sketch("XY").rect(80, 50)``,
  ``doc.extrude``, ``doc.fillet(body.edges("|Z"), 2)``); each call is exactly
  one canonical command and yields editable history features.

Transports: :class:`StdioTransport` (``assembler-headless``, no GUI) and
:class:`LoopbackTransport` (the desktop app's opt-in "Agent access").
"""
from .client import API_ID, API_VERSION, METHODS, AssemblerClient
from .errors import (
    AssemblerError,
    BusyError,
    ConfirmationRequiredError,
    ConflictError,
    FeatureFailedError,
    InvalidParamsError,
    NotFoundError,
    PermissionDeniedError,
    ReferenceNotFoundError,
    SketchConflictError,
    TransactionStateError,
    TransportError,
)
from .modeling import BBox, Body, Document, Edge, EdgeSet, Face, FaceSet, Feature, PrintReport, Sketch, SketchLine, Transaction
from .printing import METRIC_HOLE_SIZES, PRINT_FITS, hole_diameter
from .transport import LoopbackTransport, StdioTransport, Transport, find_headless_command

__all__ = [
    "API_ID", "API_VERSION", "METHODS",
    "AssemblerClient", "AssemblerError", "BBox", "Body", "BusyError", "ConfirmationRequiredError",
    "ConflictError", "Document", "Edge", "EdgeSet", "Face", "FaceSet", "Feature", "FeatureFailedError",
    "InvalidParamsError", "LoopbackTransport", "NotFoundError", "PermissionDeniedError", "PrintReport",
    "ReferenceNotFoundError", "Sketch", "SketchConflictError", "SketchLine", "StdioTransport", "Transaction", "TransactionStateError",
    "Transport", "TransportError", "find_headless_command",
    "METRIC_HOLE_SIZES", "PRINT_FITS", "hole_diameter",
]
