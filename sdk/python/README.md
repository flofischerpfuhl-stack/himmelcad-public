# Himmel:CAD Python SDK

This package is generated from `schemas/automation/himmelcad-automation-v1.schema.json` and requires Python 3.12 or newer. Do not edit files under `src/himmelcad` by hand.

Both `HimmelcadClient` and `AsyncHimmelcadClient` use the existing Himmel:CAD control planes. Document snapshots, journal pages, property operations and transaction commits travel through `app.protocol`; the SDK does not create a parallel commit path.

```python
from himmelcad import CanonicalTransactionBuilder, HimmelcadClient

client = HimmelcadClient(transport)
client.negotiate(required_capabilities=("document.read", "document.write"))

for entity in client.iter_entities(max_pages=100):
    print(entity.id, entity.revision)

transaction = CanonicalTransactionBuilder().delete(expected_entity_ref).build()
plan = client.validate(transaction)
# A confirmation grant is opaque, short-lived and issued by the host. The SDK
# only forwards it; it never creates or interprets one.
client.commit(transaction, confirmation_grant=host_issued_grant)
```

Property queries are chunked over exact `EntityVersionRef` values. An empty property list intentionally requests all registered canonical properties, matching the Rust core. Journal/entity iterators have a configurable `max_pages` guard and reject non-advancing cursors.

Large payloads are exposed as bounded, read-only leases. Always use their sync or async context manager so release occurs deterministically. `lease.numpy()` is available through the optional `himmelcad[numpy]` extra and returns a read-only array after hash, shape, endian and byte-length validation.

Regenerate with `python3.12 scripts/generate-automation-sdk.py`. CI/stale checks use `python3.12 scripts/generate-automation-sdk.py --check`; this regenerates into a temporary directory and also fails closed when pinned canonical Rust/TypeScript contracts drift.
