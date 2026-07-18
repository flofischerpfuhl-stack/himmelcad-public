//! Validated `3DTILES_batch_table_hierarchy` topology and property resolution.

use std::collections::{BTreeMap, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::legacy_batch_table::{
    legacy_batch_table_row, legacy_property_set_row, validate_legacy_property_set,
};
use super::tiles3d_content::ThreeDTilesContentError;

const EXTENSION: &str = "3DTILES_batch_table_hierarchy";
const MAX_CLASSES: usize = 65_536;
const MAX_INSTANCES: usize = 1_000_000;
const MAX_PARENT_LINKS: usize = 4_000_000;
const MAX_QUERY_INSTANCES: usize = 65_536;

/// Stable class and local-row binding for one hierarchy instance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecodedLegacyHierarchyInstance {
    /// Global hierarchy instance ID.
    pub instance_id: u32,
    /// Index in the extension's `classes` array.
    pub class_id: u32,
    /// Class name retained for inspection and styling.
    pub class_name: String,
    /// Occurrence index within the class's `instances` property arrays.
    pub class_instance_index: u32,
    /// Direct parent IDs in normative array order; a self-ID denotes no parent.
    pub parent_ids: Vec<u32>,
}

/// One resolved feature hierarchy with deterministic ancestry provenance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedLegacyHierarchyRow {
    /// Geometry-addressable batch feature.
    pub feature_id: u32,
    /// Exact hierarchy instance addressed by the feature ID.
    pub exact_instance: DecodedLegacyHierarchyInstance,
    /// Unique ancestors in breadth-first, parent-array order.
    pub ancestors: Vec<DecodedLegacyHierarchyInstance>,
    /// Direct batch properties overlaid on nearest unambiguous class properties.
    pub properties: Value,
}

/// Prevalidated hierarchy topology without expanded per-instance property values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecodedLegacyBatchTableHierarchy {
    classes: Vec<DecodedClass>,
    instances: Vec<DecodedInstance>,
    parents: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct DecodedClass {
    name: String,
    length: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct DecodedInstance {
    class_id: u32,
    class_instance_index: u32,
    parent_start: u32,
    parent_count: u32,
}

impl DecodedLegacyBatchTableHierarchy {
    /// Retained heap memory for the validated topology and class names.
    #[must_use]
    pub fn resident_bytes(&self) -> u64 {
        allocation_bytes::<DecodedClass>(self.classes.capacity())
            .saturating_add(
                self.classes
                    .iter()
                    .map(|class| usize_to_u64(class.name.capacity()))
                    .fold(0_u64, u64::saturating_add),
            )
            .saturating_add(allocation_bytes::<DecodedInstance>(
                self.instances.capacity(),
            ))
            .saturating_add(allocation_bytes::<u32>(self.parents.capacity()))
    }

    /// Returns the exact class/instance/parent binding for one hierarchy ID.
    #[must_use]
    pub fn instance(&self, instance_id: u32) -> Option<DecodedLegacyHierarchyInstance> {
        let instance = *self.instances.get(usize::try_from(instance_id).ok()?)?;
        let class = self.classes.get(usize::try_from(instance.class_id).ok()?)?;
        let start = usize::try_from(instance.parent_start).ok()?;
        let count = usize::try_from(instance.parent_count).ok()?;
        Some(DecodedLegacyHierarchyInstance {
            instance_id,
            class_id: instance.class_id,
            class_name: class.name.clone(),
            class_instance_index: instance.class_instance_index,
            parent_ids: self.parents.get(start..start.checked_add(count)?)?.to_vec(),
        })
    }

    /// Resolves direct and inherited properties for one geometry feature.
    pub fn resolve_feature(
        &self,
        batch_json: &Value,
        batch_binary: &[u8],
        batch_length: u32,
        feature_id: u32,
    ) -> Result<DecodedLegacyHierarchyRow, ThreeDTilesContentError> {
        if feature_id >= batch_length {
            return Err(invalid("hierarchy feature ID is out of range"));
        }
        let hierarchy = hierarchy_object(batch_json)?;
        let classes = hierarchy
            .get("classes")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("hierarchy classes are missing"))?;
        let exact_instance = self
            .instance(feature_id)
            .ok_or_else(|| invalid("hierarchy feature instance is missing"))?;
        let mut queue = VecDeque::from([(feature_id, 0_u32)]);
        let mut visited = BTreeMap::<u32, u32>::new();
        let mut ancestors = Vec::new();
        let mut resolved = BTreeMap::<String, (u32, Value)>::new();
        while let Some((instance_id, depth)) = queue.pop_front() {
            if visited.len() >= MAX_QUERY_INSTANCES && !visited.contains_key(&instance_id) {
                return Err(invalid("hierarchy query exceeds the traversal budget"));
            }
            if let Some(previous_depth) = visited.get(&instance_id) {
                if *previous_depth <= depth {
                    continue;
                }
            }
            visited.insert(instance_id, depth);
            let binding = self
                .instance(instance_id)
                .ok_or_else(|| invalid("hierarchy traversal instance is missing"))?;
            if depth > 0 {
                ancestors.push(binding.clone());
            }
            let class = classes
                .get(usize::try_from(binding.class_id).expect("validated u32"))
                .and_then(|class| class.get("instances"))
                .and_then(Value::as_object)
                .ok_or_else(|| invalid("hierarchy class instances are invalid"))?;
            let class_length =
                self.classes[usize::try_from(binding.class_id).expect("validated class")].length;
            let properties = legacy_property_set_row(
                class,
                batch_binary,
                class_length,
                binding.class_instance_index,
                false,
            )?;
            for (name, value) in properties.as_object().expect("property row is an object") {
                match resolved.get(name) {
                    None => {
                        resolved.insert(name.clone(), (depth, value.clone()));
                    }
                    Some((existing_depth, _)) if *existing_depth < depth => {}
                    Some((existing_depth, existing))
                        if *existing_depth == depth && existing == value => {}
                    Some((existing_depth, _)) if *existing_depth == depth => {
                        return Err(invalid(
                            "hierarchy property is ambiguous between equal-depth ancestors",
                        ));
                    }
                    Some(_) => unreachable!("breadth-first traversal cannot decrease depth"),
                }
            }
            let next_depth = depth
                .checked_add(1)
                .ok_or_else(|| invalid("hierarchy depth overflows"))?;
            for parent in binding.parent_ids {
                if parent != instance_id {
                    queue.push_back((parent, next_depth));
                }
            }
        }
        let direct =
            legacy_batch_table_row(Some(batch_json), batch_binary, batch_length, feature_id)?;
        for (name, value) in direct.as_object().expect("direct row is an object") {
            resolved.insert(name.clone(), (0, value.clone()));
        }
        Ok(DecodedLegacyHierarchyRow {
            feature_id,
            exact_instance,
            ancestors,
            properties: Value::Object(
                resolved
                    .into_iter()
                    .map(|(name, (_, value))| (name, value))
                    .collect(),
            ),
        })
    }
}

#[allow(clippy::too_many_lines)]
pub(super) fn decode_legacy_batch_table_hierarchy(
    batch_json: Option<&Value>,
    batch_binary: &[u8],
    batch_length: u32,
) -> Result<Option<DecodedLegacyBatchTableHierarchy>, ThreeDTilesContentError> {
    let Some(batch_json) = batch_json else {
        return Ok(None);
    };
    let Some(extensions) = batch_json.get("extensions") else {
        return Ok(None);
    };
    let extensions = extensions
        .as_object()
        .ok_or_else(|| invalid("batch-table extensions are not an object"))?;
    let Some(extension) = extensions.get(EXTENSION) else {
        return Ok(None);
    };
    let hierarchy = extension
        .as_object()
        .ok_or_else(|| invalid("batch-table hierarchy is not an object"))?;
    let class_values = hierarchy
        .get("classes")
        .and_then(Value::as_array)
        .filter(|classes| classes.len() <= MAX_CLASSES)
        .ok_or_else(|| invalid("hierarchy class count is invalid"))?;
    let instances_length = required_u32(hierarchy.get("instancesLength"), "instancesLength")?;
    let instance_count = usize::try_from(instances_length)
        .map_err(|_| invalid("hierarchy instance count exceeds the address space"))?;
    if instance_count > MAX_INSTANCES || instances_length < batch_length {
        return Err(invalid("hierarchy instance count is invalid"));
    }
    let mut classes = Vec::with_capacity(class_values.len());
    let mut class_length_sum = 0_u32;
    for class in class_values {
        let class = class
            .as_object()
            .ok_or_else(|| invalid("hierarchy class is not an object"))?;
        let name = class
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("hierarchy class name is invalid"))?;
        let length = required_u32(class.get("length"), "class.length")?;
        class_length_sum = class_length_sum
            .checked_add(length)
            .ok_or_else(|| invalid("hierarchy class lengths overflow"))?;
        let properties = class
            .get("instances")
            .and_then(Value::as_object)
            .ok_or_else(|| invalid("hierarchy class instances are invalid"))?;
        validate_legacy_property_set(properties, batch_binary, length, false)?;
        classes.push(DecodedClass {
            name: name.to_owned(),
            length,
        });
    }
    if class_length_sum != instances_length {
        return Err(invalid(
            "hierarchy instancesLength does not equal the class lengths",
        ));
    }
    let class_ids = topology_values(
        hierarchy.get("classIds"),
        batch_binary,
        instance_count,
        "classIds",
    )?;
    if class_ids
        .iter()
        .any(|class_id| usize::try_from(*class_id).map_or(true, |id| id >= classes.len()))
    {
        return Err(invalid("hierarchy class ID is out of range"));
    }
    let parent_counts = hierarchy
        .get("parentCounts")
        .map(|value| topology_values(Some(value), batch_binary, instance_count, "parentCounts"))
        .transpose()?;
    let expected_parents = match &parent_counts {
        Some(counts) => counts.iter().try_fold(0_usize, |sum, count| {
            sum.checked_add(usize::try_from(*count).ok()?)
        }),
        None if hierarchy.get("parentIds").is_some() => Some(instance_count),
        None => Some(0),
    }
    .filter(|count| *count <= MAX_PARENT_LINKS)
    .ok_or_else(|| invalid("hierarchy parent count exceeds the budget"))?;
    let parents = if let Some(parent_ids) = hierarchy.get("parentIds") {
        topology_values(
            Some(parent_ids),
            batch_binary,
            expected_parents,
            "parentIds",
        )?
    } else {
        if parent_counts
            .as_ref()
            .is_some_and(|counts| counts.iter().any(|count| *count != 0))
        {
            return Err(invalid("hierarchy parentCounts exist without parentIds"));
        }
        Vec::new()
    };
    if parents.iter().any(|parent| *parent >= instances_length) {
        return Err(invalid("hierarchy parent ID is out of range"));
    }
    let mut class_rows = vec![0_u32; classes.len()];
    let mut instances = Vec::with_capacity(instance_count);
    let mut parent_start = 0_usize;
    for (instance_index, class_id) in class_ids.into_iter().enumerate() {
        let class_index = usize::try_from(class_id).expect("validated class ID");
        let class_instance_index = class_rows[class_index];
        class_rows[class_index] = class_rows[class_index]
            .checked_add(1)
            .ok_or_else(|| invalid("hierarchy class instance index overflows"))?;
        let parent_count = parent_counts.as_ref().map_or_else(
            || usize::from(hierarchy.get("parentIds").is_some()),
            |counts| usize::try_from(counts[instance_index]).expect("validated u32"),
        );
        instances.push(DecodedInstance {
            class_id,
            class_instance_index,
            parent_start: u32::try_from(parent_start)
                .map_err(|_| invalid("hierarchy parent offset exceeds u32"))?,
            parent_count: u32::try_from(parent_count)
                .map_err(|_| invalid("hierarchy parent count exceeds u32"))?,
        });
        parent_start = parent_start
            .checked_add(parent_count)
            .ok_or_else(|| invalid("hierarchy parent offset overflows"))?;
    }
    if parent_start != parents.len()
        || class_rows
            .iter()
            .zip(&classes)
            .any(|(actual, class)| *actual != class.length)
    {
        return Err(invalid("hierarchy instance bindings are inconsistent"));
    }
    validate_acyclic(&instances, &parents)?;
    Ok(Some(DecodedLegacyBatchTableHierarchy {
        classes,
        instances,
        parents,
    }))
}

fn validate_acyclic(
    instances: &[DecodedInstance],
    parents: &[u32],
) -> Result<(), ThreeDTilesContentError> {
    let mut incoming = vec![0_u32; instances.len()];
    for (child, instance) in instances.iter().enumerate() {
        for parent in parent_slice(*instance, parents)? {
            if usize::try_from(*parent).expect("validated parent") != child {
                let slot = &mut incoming[usize::try_from(*parent).expect("validated parent")];
                *slot = slot
                    .checked_add(1)
                    .ok_or_else(|| invalid("hierarchy incoming edge count overflows"))?;
            }
        }
    }
    let mut queue = VecDeque::new();
    for (instance, count) in incoming.iter().enumerate() {
        if *count == 0 {
            queue.push_back(instance);
        }
    }
    let mut visited = 0_usize;
    while let Some(child) = queue.pop_front() {
        visited += 1;
        for parent in parent_slice(instances[child], parents)? {
            let parent = usize::try_from(*parent).expect("validated parent");
            if parent == child {
                continue;
            }
            incoming[parent] -= 1;
            if incoming[parent] == 0 {
                queue.push_back(parent);
            }
        }
    }
    if visited != instances.len() {
        return Err(invalid("hierarchy contains a parent cycle"));
    }
    Ok(())
}

fn parent_slice(
    instance: DecodedInstance,
    parents: &[u32],
) -> Result<&[u32], ThreeDTilesContentError> {
    let start = usize::try_from(instance.parent_start).expect("validated u32");
    let count = usize::try_from(instance.parent_count).expect("validated u32");
    parents
        .get(start..start.saturating_add(count))
        .ok_or_else(|| invalid("hierarchy parent range is invalid"))
}

fn topology_values(
    value: Option<&Value>,
    binary: &[u8],
    count: usize,
    field: &str,
) -> Result<Vec<u32>, ThreeDTilesContentError> {
    let value = value.ok_or_else(|| invalid(&format!("hierarchy {field} are missing")))?;
    if let Some(values) = value.as_array() {
        if values.len() != count {
            return Err(invalid(&format!("hierarchy {field} length is invalid")));
        }
        return values
            .iter()
            .map(|value| {
                json_u32(value)
                    .ok_or_else(|| invalid(&format!("hierarchy {field} value is invalid")))
            })
            .collect();
    }
    let descriptor = value
        .as_object()
        .ok_or_else(|| invalid(&format!("hierarchy {field} is invalid")))?;
    if descriptor
        .get("type")
        .is_some_and(|value| value != "SCALAR")
    {
        return Err(invalid(&format!("hierarchy {field} type is invalid")));
    }
    let component_type = descriptor
        .get("componentType")
        .and_then(Value::as_str)
        .unwrap_or("UNSIGNED_SHORT");
    let size = match component_type {
        "UNSIGNED_BYTE" => 1,
        "UNSIGNED_SHORT" => 2,
        "UNSIGNED_INT" => 4,
        _ => {
            return Err(invalid(&format!(
                "hierarchy {field} componentType is invalid"
            )));
        }
    };
    let offset = descriptor
        .get("byteOffset")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| invalid(&format!("hierarchy {field} byteOffset is invalid")))?;
    if !offset.is_multiple_of(size) {
        return Err(invalid(&format!(
            "hierarchy {field} byteOffset is misaligned"
        )));
    }
    let byte_length = count
        .checked_mul(size)
        .ok_or_else(|| invalid(&format!("hierarchy {field} range overflows")))?;
    let bytes = binary
        .get(offset..offset.saturating_add(byte_length))
        .ok_or_else(|| invalid(&format!("hierarchy {field} exceeds the binary body")))?;
    Ok(bytes
        .chunks_exact(size)
        .map(|bytes| match size {
            1 => u32::from(bytes[0]),
            2 => u32::from(u16::from_le_bytes(bytes.try_into().expect("two bytes"))),
            4 => u32::from_le_bytes(bytes.try_into().expect("four bytes")),
            _ => unreachable!("validated topology component size"),
        })
        .collect::<Vec<_>>())
}

fn hierarchy_object(
    batch_json: &Value,
) -> Result<&serde_json::Map<String, Value>, ThreeDTilesContentError> {
    batch_json
        .get("extensions")
        .and_then(|extensions| extensions.get(EXTENSION))
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("batch-table hierarchy is missing"))
}

fn required_u32(value: Option<&Value>, field: &str) -> Result<u32, ThreeDTilesContentError> {
    value
        .and_then(json_u32)
        .ok_or_else(|| invalid(&format!("hierarchy {field} is invalid")))
}

fn json_u32(value: &Value) -> Option<u32> {
    let number = value.as_number()?;
    if let Some(integer) = number.as_u64() {
        return u32::try_from(integer).ok();
    }
    let decimal = number.as_f64()?;
    if !decimal.is_finite()
        || decimal < 0.0
        || decimal > f64::from(u32::MAX)
        || decimal.fract().abs().to_bits() != 0
    {
        return None;
    }
    decimal.to_string().parse().ok()
}

fn invalid(message: &str) -> ThreeDTilesContentError {
    ThreeDTilesContentError::InvalidJson(message.to_owned())
}

fn allocation_bytes<T>(capacity: usize) -> u64 {
    usize_to_u64(capacity)
        .saturating_mul(u64::try_from(std::mem::size_of::<T>()).unwrap_or(u64::MAX))
}

fn usize_to_u64(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::decode_legacy_batch_table_hierarchy;
    use serde_json::{json, Value};

    #[test]
    fn resolves_exact_class_rows_linear_ancestors_and_direct_precedence() {
        let json = hierarchy_json(
            json!({
                "classes": [
                    {"name":"Wall","length":2,"instances":{"color":["blue","lime"],"shared":["wall0","wall1"]}},
                    {"name":"Building","length":1,"instances":{"name":["building"],"shared":["building"]}},
                    {"name":"Block","length":1,"instances":{"district":["central"],"shared":["block"]}}
                ],
                "instancesLength": 4,
                "classIds": [0,0,1,2],
                "parentIds": [2,2,3,3]
            }),
            json!({"shared":["direct0","direct1"],"surveyId":[10,11]}),
        );
        let decoded = decode_legacy_batch_table_hierarchy(Some(&json), &[], 2)
            .expect("hierarchy")
            .expect("extension");
        let row = decoded
            .resolve_feature(&json, &[], 2, 1)
            .expect("resolved hierarchy");

        assert_eq!(row.exact_instance.class_name, "Wall");
        assert_eq!(row.exact_instance.class_instance_index, 1);
        assert_eq!(row.exact_instance.parent_ids, [2]);
        assert!(decoded.resident_bytes() > 0);
        assert_eq!(
            row.ancestors
                .iter()
                .map(|instance| (&*instance.class_name, instance.instance_id))
                .collect::<Vec<_>>(),
            [("Building", 2), ("Block", 3)]
        );
        assert_eq!(
            row.properties,
            json!({
                "color":"lime",
                "district":"central",
                "name":"building",
                "shared":"direct1",
                "surveyId":11
            })
        );
    }

    #[test]
    fn multiple_parents_collapse_equal_values_and_reject_equal_depth_conflicts() {
        let extension = json!({
            "classes": [
                {"name":"Child","length":1,"instances":{"own":[7]}},
                {"name":"Left","length":1,"instances":{"zone":["same"]}},
                {"name":"Right","length":1,"instances":{"zone":["same"]}}
            ],
            "instancesLength":3,
            "classIds":[0,1,2],
            "parentCounts":[2,1,1],
            "parentIds":[1,2,1,2]
        });
        let json = hierarchy_json(extension.clone(), json!({}));
        let decoded = decode_legacy_batch_table_hierarchy(Some(&json), &[], 1)
            .expect("hierarchy")
            .expect("extension");
        let row = decoded
            .resolve_feature(&json, &[], 1, 0)
            .expect("equal inherited values");
        assert_eq!(row.properties, json!({"own":7,"zone":"same"}));
        assert_eq!(
            row.ancestors
                .iter()
                .map(|instance| instance.instance_id)
                .collect::<Vec<_>>(),
            [1, 2]
        );

        let mut conflict = extension;
        conflict["classes"][2]["instances"]["zone"] = json!(["different"]);
        let conflict = hierarchy_json(conflict, json!({}));
        let decoded = decode_legacy_batch_table_hierarchy(Some(&conflict), &[], 1)
            .expect("valid topology")
            .expect("extension");
        assert!(decoded.resolve_feature(&conflict, &[], 1, 0).is_err());
    }

    #[test]
    fn decodes_binary_topology_and_binary_class_properties_without_expansion() {
        let mut binary = Vec::new();
        for value in [0_u16, 1] {
            binary.extend(value.to_le_bytes());
        }
        for value in [1_u16, 1] {
            binary.extend(value.to_le_bytes());
        }
        binary.extend(27.5_f32.to_le_bytes());
        binary.extend([0; 4]);
        binary.extend(1250_u32.to_le_bytes());
        let json = hierarchy_json(
            json!({
                "classes":[
                    {"name":"Valve","length":1,"instances":{"pressure":{"byteOffset":8,"componentType":"FLOAT","type":"SCALAR"}}},
                    {"name":"Owner","length":1,"instances":{"ownerId":{"byteOffset":16,"componentType":"UNSIGNED_INT","type":"SCALAR"}}}
                ],
                "instancesLength":2,
                "classIds":{"byteOffset":0},
                "parentIds":{"byteOffset":4}
            }),
            json!({}),
        );
        let decoded = decode_legacy_batch_table_hierarchy(Some(&json), &binary, 1)
            .expect("binary hierarchy")
            .expect("extension");
        let row = decoded
            .resolve_feature(&json, &binary, 1, 0)
            .expect("binary properties");
        assert_eq!(row.properties, json!({"ownerId":1250,"pressure":27.5}));
    }

    #[test]
    fn rejects_cycles_ranges_counts_offsets_and_budgets_before_queries() {
        let invalid_extensions = [
            json!({
                "classes":[{"name":"Node","length":2,"instances":{"id":[0,1]}}],
                "instancesLength":2,"classIds":[0,0],"parentIds":[1,0]
            }),
            json!({
                "classes":[{"name":"Node","length":1,"instances":{"id":[0]}}],
                "instancesLength":1,"classIds":[1]
            }),
            json!({
                "classes":[{"name":"Node","length":1,"instances":{"id":[0]}}],
                "instancesLength":2,"classIds":[0,0]
            }),
            json!({
                "classes":[{"name":"Node","length":1,"instances":{"id":[0]}}],
                "instancesLength":1,"classIds":[0],"parentCounts":[1]
            }),
            json!({
                "classes":[{"name":"Node","length":1_000_001,"instances":{}}],
                "instancesLength":1_000_001,"classIds":[]
            }),
        ];
        for extension in invalid_extensions {
            let json = hierarchy_json(extension, json!({}));
            assert!(decode_legacy_batch_table_hierarchy(Some(&json), &[], 1).is_err());
        }

        let misaligned = hierarchy_json(
            json!({
                "classes":[{"name":"Node","length":1,"instances":{}}],
                "instancesLength":1,
                "classIds":{"byteOffset":1,"componentType":"UNSIGNED_SHORT"}
            }),
            json!({}),
        );
        assert!(decode_legacy_batch_table_hierarchy(Some(&misaligned), &[0; 4], 1).is_err());

        assert!(
            decode_legacy_batch_table_hierarchy(Some(&json!({"extensions": []})), &[], 0).is_err()
        );
    }

    #[test]
    fn accepts_schema_valid_empty_hierarchy_empty_name_and_integral_decimals() {
        let empty = hierarchy_json(
            json!({"classes":[],"instancesLength":0,"classIds":[]}),
            json!({}),
        );
        let decoded = decode_legacy_batch_table_hierarchy(Some(&empty), &[], 0)
            .expect("empty hierarchy")
            .expect("extension");
        assert_eq!(decoded.resident_bytes(), 0);

        let unnamed = hierarchy_json(
            json!({
                "classes":[{"name":"","length":1.0,"instances":{"value":[3]}}],
                "instancesLength":1e0,
                "classIds":[0.0]
            }),
            json!({}),
        );
        let decoded = decode_legacy_batch_table_hierarchy(Some(&unnamed), &[], 1)
            .expect("empty class name")
            .expect("extension");
        assert_eq!(decoded.instance(0).expect("instance").class_name, "");
    }

    fn hierarchy_json(extension: Value, direct: Value) -> Value {
        let Value::Object(mut root) = direct else {
            panic!("direct object");
        };
        let mut extensions = serde_json::Map::new();
        extensions.insert("3DTILES_batch_table_hierarchy".to_owned(), extension);
        root.insert("extensions".to_owned(), Value::Object(extensions));
        Value::Object(root)
    }
}
