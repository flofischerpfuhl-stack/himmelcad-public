from __future__ import annotations

import asyncio
import base64
import hashlib
import sys
import unittest
from pathlib import Path
from typing import Any, Mapping

SDK_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SDK_ROOT / "src"))

from himmelcad import (  # noqa: E402
    AsyncBulkLease,
    AsyncHimmelcadClient,
    BulkLease,
    CanonicalTransactionBuilder,
    GenerationChangedError,
    HimmelcadClient,
    LeaseError,
    ProtocolError,
    ValidationError,
)
from himmelcad.errors import ErrorCode, error_from_payload  # noqa: E402
from himmelcad.models import (  # noqa: E402
    CanonicalEntity,
    CanonicalEntityEdit,
    CanonicalEntityMutation,
    EntityVersionRef,
    PropertyId,
)

HASH_A = "a" * 64
HASH_B = "b" * 64
ALL_CAPABILITIES = (
    "document.read",
    "document.write",
    "journal.read",
    "view.read",
    "view.write",
    "view.screenshot",
    "automation.entities.page",
    "automation.cas.describe",
    "automation.commands.validate",
    "automation.commands.status",
    "automation.commands.cancel",
    "automation.bulk.read",
    "automation.bulk.release",
)


def entity_ref(index: int = 1) -> EntityVersionRef:
    return EntityVersionRef(id=f"entity-{index}", revision=index, version_hash=HASH_A)


def canonical_entity() -> CanonicalEntity:
    return CanonicalEntity.from_dict(
        {
            "id": "entity-new",
            "revision": 0,
            "typeId": "hcad.test@1",
            "name": "New",
            "owner": None,
            "layerIds": [],
            "placement": None,
            "representations": [],
            "componentsRef": HASH_A,
            "attributesRef": HASH_A,
            "relationsRef": HASH_A,
            "styleRef": None,
            "schemaVersion": 1,
            "versionHash": HASH_B,
        }
    )


def view_state() -> dict[str, Any]:
    return {
        "schema": "himmelcad.view-state",
        "version": 1,
        "camera": {
            "position": {"x": 1.0, "y": 2.0, "z": 3.0},
            "target": {"x": 0.0, "y": 0.0, "z": 0.0},
            "up": {"x": 0.0, "y": 0.0, "z": 1.0},
            "projection": {"kind": "perspective", "verticalFieldOfViewRadians": 1.0, "near": 0.1, "far": 1000.0},
        },
        "navigationMode": "3d",
        "hiddenEntityIds": [],
        "selectedEntityIds": [],
        "scopedClips": [],
        "presentation": {"background": "theme", "renderStyle": "source", "showGrid": True, "showAxes": True, "showSelectionOutline": True},
    }


class FixtureTransport:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Mapping[str, Any]]] = []
        self.entity_pages = [
            {"generation": 7, "items": [{"id": "one", "revision": 1, "versionHash": HASH_A, "typeId": "test", "name": "One", "layerIds": []}], "returnedBytes": 100, "nextCursor": "next"},
            {"generation": 7, "items": [{"id": "two", "revision": 1, "versionHash": HASH_B, "typeId": "test", "name": "Two", "layerIds": []}], "returnedBytes": 100},
        ]
        self.bulk = b"\x01\x02\x03\x04"
        self.bulk_budget = len(self.bulk)
        self.released = False
        self.inline_screenshot = True
        self.used_grants: set[str] = set()
        self.selected_version = 1
        self.capabilities = ALL_CAPABILITIES
        self.screenshot_width_delta = 0

    def request(self, method: str, params: Mapping[str, Any]) -> Mapping[str, Any]:
        self.calls.append((method, params))
        if method == "app.negotiate":
            return {"selectedVersion": self.selected_version, "serverName": "fixture", "serverVersion": "1", "sessionId": "session", "capabilities": list(self.capabilities)}
        if method == "automation.entities.page":
            return self.entity_pages.pop(0)
        if method == "automation.commands.validate":
            command_id = params["transaction"]["commandId"]
            return {"commandId": command_id, "valid": True, "requiresConfirmation": False, "losses": [], "conflicts": [], "planHash": HASH_A}
        if method == "automation.commands.status":
            return {"operationId": params["operationId"], "state": "completed", "completed": 1, "total": 1, "message": "done"}
        if method == "automation.commands.cancel":
            return {"operationId": params["operationId"], "cancellationRequested": True}
        if method == "automation.cas.describe":
            return {"contentHash": params["contentHash"], "mediaType": "application/octet-stream", "byteLength": 4, "logicalShape": {"kind": "bytes"}}
        if method == "view.state.get" or method == "view.state.set":
            return view_state()
        if method == "view.screenshot":
            common = {"schema": "himmelcad.screenshot-result", "version": 1, "requestId": params["requestId"], "mimeType": "image/png", "width": round(params["width"] * params["pixelRatio"]) + self.screenshot_width_delta, "height": round(params["height"] * params["pixelRatio"])}
            if self.inline_screenshot:
                return {**common, "encoding": "base64", "data": base64.b64encode(b"PNG").decode()}
            return {**common, "encoding": "bulkLease", "lease": self.lease_descriptor()}
        if method == "automation.bulk.read":
            offset, length = params["offset"], params["length"]
            data = self.bulk[offset : offset + length]
            self.bulk_budget -= len(data)
            return {"leaseId": "lease", "offset": offset, "byteLength": len(data), "encoding": "base64", "data": base64.b64encode(data).decode(), "remainingReadBudget": self.bulk_budget}
        if method == "automation.bulk.release":
            self.released = True
            return {"leaseId": "lease", "released": True}
        if method == "app.protocol":
            return self._app_protocol(params)
        raise AssertionError(method)

    def lease_descriptor(self) -> dict[str, Any]:
        return {"leaseId": "lease", "accessToken": "opaque", "contentHash": hashlib.sha256(self.bulk).hexdigest(), "mediaType": "application/octet-stream", "elementType": "uint8", "shape": [4], "endianness": "notApplicable", "byteLength": 4, "expiresAt": "2099-01-01T00:00:00Z", "maxReadableRange": 2, "remainingReadBudget": 4, "readOnly": True}

    def _app_protocol(self, envelope: Mapping[str, Any]) -> Mapping[str, Any]:
        request = envelope["request"]
        method = request["method"]
        params = request.get("params", {})
        if method == "readDocumentSnapshot":
            kind, payload = "documentSnapshot", {"generation": 7, "entities": [], "tombstones": [], "journalHeadSequence": 2}
        elif method == "readJournal":
            after = params["afterSequence"]
            payload = {"afterSequence": after, "entries": [{"sequence": after + 1}], "journalHeadSequence": 2, "hasMore": after == 0}
            kind = "journalPage"
        elif method == "readPropertySchemas":
            kind, payload = "propertySchemas", [{"schemaId": "entity"}]
        elif method == "queryProperties":
            kind, payload = "propertyQuery", {"schemaId": "hcad.property-query-result@1", "entities": params["entities"], "properties": []}
        elif method == "compilePropertyEdit":
            kind, payload = "compiledTransaction", {"commandId": "compiled", "mutations": [{"operation": "delete", "expected": entity_ref().to_dict()}]}
        elif method == "executeCanonicalTransaction":
            grant = envelope.get("extensions", {}).get("hcad.automation.confirmation@1", {}).get("grant")
            if grant != "valid-grant" or grant in self.used_grants:
                return {"schemaId": "hcad.app-protocol@1", "requestId": envelope["requestId"], "response": {"kind": "error", "payload": {"code": "confirmationRequired", "message": "missing, invalid, stale or replayed approval grant", "details": {}}}}
            self.used_grants.add(grant)
            kind, payload = "transactionAccepted", {"sequence": 3, "commandId": params["commandId"]}
        else:
            raise AssertionError(method)
        return {"schemaId": "hcad.app-protocol@1", "requestId": envelope["requestId"], "response": {"kind": kind, "payload": payload}}


class AsyncFixtureTransport:
    def __init__(self, fixture: FixtureTransport) -> None:
        self.fixture = fixture

    async def request(self, method: str, params: Mapping[str, Any]) -> Mapping[str, Any]:
        return self.fixture.request(method, params)


class SdkTests(unittest.TestCase):
    def setUp(self) -> None:
        self.transport = FixtureTransport()
        self.client = HimmelcadClient(self.transport)
        self.client.negotiate(required_capabilities=ALL_CAPABILITIES)

    def test_canonical_variants_are_typed_and_round_trip(self) -> None:
        entity = canonical_entity()
        expected = entity_ref()
        edit_values = {
            "setName": {"name": "renamed"}, "setOwner": {"owner": None}, "setLayerIds": {"layerIds": ["layer"]},
            "setPlacement": {"placement": None}, "setRepresentations": {"representations": []},
            "setComponentsRef": {"componentsRef": HASH_A}, "setAttributesRef": {"attributesRef": HASH_A},
            "setRelationsRef": {"relationsRef": HASH_A}, "setStyleRef": {"styleRef": None},
        }
        edits = tuple(CanonicalEntityEdit.from_dict({"kind": kind, **values}) for kind, values in edit_values.items())
        variants = (
            CanonicalEntityMutation(operation="create", entity=entity),
            CanonicalEntityMutation(operation="update", expected=expected, edits=edits),
            CanonicalEntityMutation(operation="delete", expected=expected),
            CanonicalEntityMutation(operation="restore", expected=expected, snapshot=entity),
        )
        for mutation in variants:
            self.assertEqual(CanonicalEntityMutation.from_dict(mutation.to_dict()), mutation)
        self.assertIn("owner", entity.to_dict())
        self.assertIn("placement", entity.to_dict())
        self.assertIn("styleRef", entity.to_dict())
        for edit in edits:
            if edit.kind in {"setOwner", "setPlacement", "setStyleRef"}:
                self.assertIn(next(key for key in edit.to_dict() if key != "kind"), edit.to_dict())
        with self.assertRaises(ValueError):
            CanonicalEntityMutation.from_dict({"operation": "delete", "entity": entity.to_dict()})
        with self.assertRaises(ValueError):
            EntityVersionRef(id=None, revision=1, version_hash=HASH_A)  # type: ignore[arg-type]

    def test_paging_and_canonical_app_methods(self) -> None:
        self.assertEqual([item.id for item in self.client.iter_entities()], ["one", "two"])
        self.assertEqual(self.client.snapshot()["generation"], 7)
        self.assertEqual(len(self.client.read_property_schemas()), 1)
        self.assertEqual([page.after_sequence for page in self.client.iter_journal_pages(limit=1)], [0, 1])
        refs = [entity_ref(index) for index in range(1, 1002)]
        pages = list(self.client.iter_property_pages(refs, []))
        self.assertEqual([len(page.entities) for page in pages], [1000, 1])
        property_calls = [params for method, params in self.transport.calls if method == "app.protocol" and params["request"]["method"] == "queryProperties"]
        self.assertTrue(all(call["request"]["params"]["properties"] == [] for call in property_calls))
        compiled = self.client.compile_property_edit({"schemaId": "fixture"})
        self.assertEqual(compiled.command_id, "compiled")

    def test_validate_commit_status_cancel_use_canonical_paths(self) -> None:
        tx = CanonicalTransactionBuilder("command").delete(entity_ref()).build()
        self.assertTrue(self.client.validate(tx).valid)
        for grant in (None, "wrong-grant", "stale-grant"):
            with self.assertRaises(ProtocolError) as rejected:
                self.client.commit(tx, confirmation_grant=grant)
            self.assertEqual(rejected.exception.raw_code, "confirmationRequired")
        self.assertEqual(self.client.commit(tx, confirmation_grant="valid-grant")["commandId"], "command")
        with self.assertRaises(ProtocolError):
            self.client.commit(tx, confirmation_grant="valid-grant")
        self.assertEqual(self.client.command_status("operation").state, "completed")
        self.assertTrue(self.client.cancel_command("operation").cancellation_requested)
        commit = next(params for method, params in self.transport.calls if method == "app.protocol" and params["request"]["method"] == "executeCanonicalTransaction")
        self.assertNotIn("expectedGeneration", commit["request"]["params"])
        accepted = [params for method, params in self.transport.calls if method == "app.protocol" and params["request"]["method"] == "executeCanonicalTransaction" and params.get("extensions", {}).get("hcad.automation.confirmation@1", {}).get("grant") == "valid-grant"]
        self.assertEqual(accepted[0]["extensions"], {"hcad.automation.confirmation@1": {"grant": "valid-grant"}})

    def test_screenshot_and_bulk_lease(self) -> None:
        request = {"schema": "himmelcad.screenshot-request", "version": 1, "requestId": "shot", "format": "png", "width": 20, "height": 10, "pixelRatio": 2, "background": "view", "includeUi": False}
        self.assertEqual(self.client.screenshot(request), b"PNG")
        self.transport.screenshot_width_delta = 1
        with self.assertRaises(ProtocolError):
            self.client.screenshot(request)
        self.transport.screenshot_width_delta = 0
        self.transport.inline_screenshot = False
        lease = self.client.screenshot(request)
        self.assertIsInstance(lease, BulkLease)
        with lease as opened:
            self.assertEqual(opened.read_all(), self.transport.bulk)
        self.assertTrue(self.transport.released)

    def test_failure_guards(self) -> None:
        unnegotiated = HimmelcadClient(FixtureTransport())
        with self.assertRaises(ProtocolError):
            unnegotiated.entities_page()
        missing = FixtureTransport()
        missing.capabilities = ()
        with self.assertRaises(ProtocolError):
            HimmelcadClient(missing).negotiate(required_capabilities=("document.read",))
        wrong_version = FixtureTransport()
        wrong_version.selected_version = 2
        with self.assertRaises(ProtocolError):
            HimmelcadClient(wrong_version).negotiate()
        with self.assertRaises(ValidationError):
            self.client.entities_page(limit=1001)
        with self.assertRaises(ValidationError):
            list(self.client.iter_property_pages([], []))
        unknown = error_from_payload({"code": "future.error", "message": "future"})
        self.assertEqual(unknown.code, ErrorCode.UNKNOWN)
        self.assertEqual(unknown.raw_code, "future.error")
        bad = FixtureTransport()
        bad.entity_pages = [{"generation": 1, "items": [], "returnedBytes": 0, "nextCursor": "same"}, {"generation": 1, "items": [], "returnedBytes": 0, "nextCursor": "same"}]
        client = HimmelcadClient(bad)
        client.negotiate(required_capabilities=("automation.entities.page",))
        with self.assertRaises(ProtocolError):
            list(client.iter_entity_pages())
        mismatch = FixtureTransport()
        mismatch.entity_pages = [{"generation": 1, "items": [], "returnedBytes": 0, "nextCursor": "two"}, {"generation": 2, "items": [], "returnedBytes": 0}]
        client = HimmelcadClient(mismatch)
        client.negotiate(required_capabilities=("automation.entities.page",))
        with self.assertRaises(GenerationChangedError):
            list(client.iter_entity_pages())

    def test_bulk_descriptor_rejects_shape_and_budget_mismatch_early(self) -> None:
        self.transport.inline_screenshot = False
        descriptor = self.transport.lease_descriptor()
        descriptor["shape"] = [5]
        from himmelcad.models import BulkLeaseDescriptor
        self.assertNotIn("opaque", repr(BulkLeaseDescriptor.from_dict(self.transport.lease_descriptor())))
        with self.assertRaises(LeaseError):
            BulkLease(self.client, BulkLeaseDescriptor.from_dict(descriptor))
        descriptor = self.transport.lease_descriptor()
        descriptor["remainingReadBudget"] = 3
        with self.assertRaises(LeaseError):
            BulkLease(self.client, BulkLeaseDescriptor.from_dict(descriptor))

    def test_numpy_adapter_is_read_only_when_available(self) -> None:
        try:
            import numpy  # noqa: F401
        except ImportError:
            self.skipTest("NumPy optional dependency is not installed")
        from himmelcad.models import BulkLeaseDescriptor
        with BulkLease(self.client, BulkLeaseDescriptor.from_dict(self.transport.lease_descriptor())) as lease:
            array = lease.numpy()
            self.assertEqual(array.tolist(), [1, 2, 3, 4])
            self.assertFalse(array.flags.writeable)

    def test_async_surface_and_context_manager(self) -> None:
        async def exercise() -> None:
            fixture = FixtureTransport()
            fixture.inline_screenshot = False
            client = AsyncHimmelcadClient(AsyncFixtureTransport(fixture))
            await client.negotiate(required_capabilities=ALL_CAPABILITIES)
            request = {"schema": "himmelcad.screenshot-request", "version": 1, "requestId": "shot", "format": "png", "width": 20, "height": 10, "pixelRatio": 2, "background": "view", "includeUi": False}
            lease = await client.screenshot(request)
            self.assertIsInstance(lease, AsyncBulkLease)
            async with lease as opened:
                self.assertEqual(await opened.read_all(), fixture.bulk)
            self.assertTrue(fixture.released)
        asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
