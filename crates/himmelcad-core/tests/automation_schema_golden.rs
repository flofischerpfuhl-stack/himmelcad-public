use himmelcad_core::app_protocol::AppProtocolRequestEnvelope;
use himmelcad_core::canonical_document::CanonicalCommandTransaction;
use serde_json::Value;

const FIXTURE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../schemas/automation/fixtures/automation-wire-v1.json"
));

#[test]
fn automation_fixture_round_trips_through_canonical_rust_serde() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture JSON");

    let transaction_value = fixture
        .get("canonicalTransaction")
        .cloned()
        .expect("canonical transaction fixture");
    let transaction: CanonicalCommandTransaction =
        serde_json::from_value(transaction_value.clone()).expect("canonical transaction serde");
    assert_eq!(
        serde_json::to_value(transaction).expect("serialize canonical transaction"),
        transaction_value
    );

    let envelope_value = fixture
        .get("appRequestEnvelope")
        .cloned()
        .expect("app request envelope fixture");
    let envelope: AppProtocolRequestEnvelope =
        serde_json::from_value(envelope_value.clone()).expect("app request envelope serde");
    assert_eq!(
        serde_json::to_value(envelope).expect("serialize app request envelope"),
        envelope_value
    );
}
