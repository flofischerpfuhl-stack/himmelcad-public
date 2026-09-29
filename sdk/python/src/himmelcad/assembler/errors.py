"""Structured errors of the HimmelCAD Assembler agent API (``hcasm.agent-api@1``).

Hand-maintained (not produced by ``scripts/generate-automation-sdk.py``). Errors
subclass the generated :class:`himmelcad.errors.HimmelcadError`, so
``except HimmelcadError`` keeps working across both SDK surfaces; the Assembler
contract code is ``raw_code`` and the repair data is on ``hint``/``details``.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ..errors import HimmelcadError

#: Every contract error code (mirrors ``API_ERROR_CODES`` in ``renderer/src/api/errors.ts``).
ERROR_CODES = (
    "invalidRequest",
    "methodNotFound",
    "invalidParams",
    "notFound",
    "referenceNotFound",
    "featureFailed",
    "conflict",
    "busy",
    "transactionState",
    "permissionDenied",
    "confirmationRequired",
    "unsupported",
    "cancelled",
    "internal",
)


class AssemblerError(HimmelcadError):
    """A failed Assembler API call. ``raw_code`` is the contract code."""

    def __init__(
        self,
        *,
        raw_code: str,
        message: str,
        hint: str | None = None,
        details: Mapping[str, Any] | None = None,
        method: str | None = None,
    ) -> None:
        super().__init__(raw_code=raw_code, message=message, retryable=raw_code in {"busy", "conflict"}, details=details)
        self.hint = hint
        self.method = method

    @property
    def candidates(self) -> list[Any]:
        """Valid alternatives the server suggested (reference keys, ids, method names)."""
        value = self.details.get("candidates", [])
        return list(value) if isinstance(value, (list, tuple)) else []

    def __str__(self) -> str:
        text = f"{self.raw_code}: {self.message}"
        if self.hint:
            text += f" (hint: {self.hint})"
        return text


class InvalidParamsError(AssemblerError):
    pass


class NotFoundError(AssemblerError):
    pass


class ReferenceNotFoundError(NotFoundError):
    pass


class FeatureFailedError(AssemblerError):
    """The CAD kernel rejected the feature; nothing was committed."""


class ConflictError(AssemblerError):
    pass


class BusyError(AssemblerError):
    pass


class TransactionStateError(AssemblerError):
    pass


class PermissionDeniedError(AssemblerError):
    pass


class ConfirmationRequiredError(AssemblerError):
    pass


class TransportError(AssemblerError):
    """The headless process or loopback endpoint could not be reached or died."""


_CLASSES: dict[str, type[AssemblerError]] = {
    "invalidParams": InvalidParamsError,
    "invalidRequest": InvalidParamsError,
    "methodNotFound": InvalidParamsError,
    "notFound": NotFoundError,
    "referenceNotFound": ReferenceNotFoundError,
    "featureFailed": FeatureFailedError,
    "conflict": ConflictError,
    "busy": BusyError,
    "transactionState": TransactionStateError,
    "permissionDenied": PermissionDeniedError,
    "confirmationRequired": ConfirmationRequiredError,
}


def error_from_rpc(error: Mapping[str, Any], method: str | None = None) -> AssemblerError:
    """Builds the typed error from a JSON-RPC ``error`` member (contract payload in ``data``)."""
    data = error.get("data")
    payload: Mapping[str, Any] = data if isinstance(data, Mapping) else {}
    code = str(payload.get("code", "internal"))
    details = payload.get("details")
    hint = payload.get("hint")
    return _CLASSES.get(code, AssemblerError)(
        raw_code=code,
        message=str(payload.get("message", error.get("message", "Assembler request failed"))),
        hint=str(hint) if isinstance(hint, str) else None,
        details=details if isinstance(details, Mapping) else None,
        method=method,
    )
