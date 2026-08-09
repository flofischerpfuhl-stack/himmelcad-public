use std::collections::BTreeMap;
use std::env;
use std::error::Error;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use himmelcad_core::canonical_document::{
    CanonicalCommandTransaction, CanonicalEntityEdit, CanonicalEntityEffect, CanonicalEntityField,
    CanonicalEntityMutation, CanonicalEntityTombstone, CanonicalJournalEntry,
    CanonicalJournalEntryKind, EntityVersionRef,
};
use himmelcad_core::canonical_resources::{
    AnnotationStyleResource, BimClassificationComponent, BlockDefinition, CanonicalResourceRef,
    HatchPatternResource, LineTypeResource, MaterialResource, MaterialTableResource,
    NetworkTopology, TextureResource,
};
use himmelcad_core::entity_model::{BuiltInEntityType, CanonicalEntity, GeometryObject};
use himmelcad_core::geometry_representation_registry::{
    CanonicalRepresentationAdmission, GeometryRepresentationBindingRef, GeometryRepresentationKey,
    GeometryRepresentationSlotKey, SectionTopologyPartitionManifest,
};
use ts_rs::TS;

const GENERATED_RELATIVE_PATH: &str = "packages/@himmelcad/data/src/generated";
const LEGACY_BARREL_RELATIVE_PATH: &str = "packages/@himmelcad/viewer/src/kernel/generated";
const LEGACY_BARREL: &str = concat!(
    "// Compatibility barrel. Canonical contracts are generated in @himmelcad/data.\n",
    "export type * from '@himmelcad/data/canonical';\n",
);

fn main() -> Result<(), Box<dyn Error>> {
    let check = match env::args().nth(1).as_deref() {
        None => false,
        Some("--check") => true,
        Some(argument) => return Err(format!("unsupported argument: {argument}").into()),
    };
    if env::args().nth(2).is_some() {
        return Err("expected at most one argument".into());
    }

    let repository = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .ok_or("himmelcad-core must live below the repository root")?;
    let generated = repository.join(GENERATED_RELATIVE_PATH);
    let legacy_barrel = repository.join(LEGACY_BARREL_RELATIVE_PATH);
    let staging = repository
        .join("target")
        .join(format!("entity-bindings-{}", std::process::id()));
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    fs::create_dir_all(&staging)?;

    let result = generate(&staging).and_then(|()| {
        if check {
            check_equal(&generated, &staging)?;
            check_legacy_barrel(&legacy_barrel)
        } else {
            replace_generated(&generated, &staging)?;
            replace_legacy_barrel(&legacy_barrel)
        }
    });
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    result?;

    if check {
        println!("canonical entity bindings are current");
    } else {
        println!("generated canonical entity bindings in {GENERATED_RELATIVE_PATH}");
    }
    Ok(())
}

fn replace_legacy_barrel(directory: &Path) -> Result<(), Box<dyn Error>> {
    if directory.exists() {
        fs::remove_dir_all(directory)?;
    }
    fs::create_dir_all(directory)?;
    fs::write(directory.join("index.ts"), LEGACY_BARREL)?;
    Ok(())
}

fn check_legacy_barrel(directory: &Path) -> Result<(), Box<dyn Error>> {
    let expected = BTreeMap::from([(PathBuf::from("index.ts"), LEGACY_BARREL.as_bytes().to_vec())]);
    let actual = if directory.exists() {
        read_tree(directory)?
    } else {
        BTreeMap::new()
    };
    if actual == expected {
        Ok(())
    } else {
        Err("viewer canonical-contract compatibility barrel drifted; regenerate bindings".into())
    }
}

fn generate(staging: &Path) -> Result<(), Box<dyn Error>> {
    CanonicalEntity::export_all_to(staging)?;
    GeometryObject::export_all_to(staging)?;
    BuiltInEntityType::export_all_to(staging)?;
    CanonicalRepresentationAdmission::export_all_to(staging)?;
    GeometryRepresentationSlotKey::export_all_to(staging)?;
    GeometryRepresentationKey::export_all_to(staging)?;
    GeometryRepresentationBindingRef::export_all_to(staging)?;
    SectionTopologyPartitionManifest::export_all_to(staging)?;
    CanonicalCommandTransaction::export_all_to(staging)?;
    CanonicalEntityEffect::export_all_to(staging)?;
    CanonicalEntityEdit::export_all_to(staging)?;
    CanonicalEntityField::export_all_to(staging)?;
    CanonicalEntityMutation::export_all_to(staging)?;
    CanonicalEntityTombstone::export_all_to(staging)?;
    CanonicalJournalEntry::export_all_to(staging)?;
    CanonicalJournalEntryKind::export_all_to(staging)?;
    EntityVersionRef::export_all_to(staging)?;
    CanonicalResourceRef::export_all_to(staging)?;
    BlockDefinition::export_all_to(staging)?;
    MaterialResource::export_all_to(staging)?;
    MaterialTableResource::export_all_to(staging)?;
    TextureResource::export_all_to(staging)?;
    HatchPatternResource::export_all_to(staging)?;
    LineTypeResource::export_all_to(staging)?;
    AnnotationStyleResource::export_all_to(staging)?;
    BimClassificationComponent::export_all_to(staging)?;
    NetworkTopology::export_all_to(staging)?;
    normalize_typescript(staging)?;

    let mut modules = Vec::new();
    collect_typescript_modules(staging, staging, &mut modules)?;
    modules.sort();
    let mut barrel =
        String::from("// This file is generated by himmelcad-core. Do not edit manually.\n");
    for module in modules {
        barrel.push_str("export type * from \"");
        barrel.push_str(&module);
        barrel.push_str("\";\n");
    }
    fs::write(staging.join("index.ts"), barrel)?;
    Ok(())
}

fn normalize_typescript(directory: &Path) -> Result<(), Box<dyn Error>> {
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        if path.is_dir() {
            normalize_typescript(&path)?;
        } else if path.extension() == Some(OsStr::new("ts")) {
            let source = fs::read_to_string(&path)?;
            let mut normalized = source
                .lines()
                .map(str::trim_end)
                .collect::<Vec<_>>()
                .join("\n");
            normalized.push('\n');
            fs::write(path, normalized)?;
        }
    }
    Ok(())
}

fn collect_typescript_modules(
    root: &Path,
    directory: &Path,
    modules: &mut Vec<String>,
) -> Result<(), Box<dyn Error>> {
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        if path.is_dir() {
            collect_typescript_modules(root, &path, modules)?;
        } else if path.extension() == Some(OsStr::new("ts"))
            && path.file_name() != Some(OsStr::new("index.ts"))
        {
            let relative = path.strip_prefix(root)?.with_extension("");
            modules.push(format!(
                "./{}",
                relative.to_string_lossy().replace('\\', "/")
            ));
        }
    }
    Ok(())
}

fn replace_generated(generated: &Path, staging: &Path) -> Result<(), Box<dyn Error>> {
    if generated.exists() {
        fs::remove_dir_all(generated)?;
    }
    fs::create_dir_all(
        generated
            .parent()
            .ok_or("generated binding directory must have a parent")?,
    )?;
    fs::rename(staging, generated)?;
    Ok(())
}

fn check_equal(generated: &Path, staging: &Path) -> Result<(), Box<dyn Error>> {
    let expected = read_tree(staging)?;
    let actual = if generated.exists() {
        read_tree(generated)?
    } else {
        BTreeMap::new()
    };
    if actual == expected {
        return Ok(());
    }

    let missing: Vec<_> = expected
        .keys()
        .filter(|path| !actual.contains_key(*path))
        .collect();
    let stale: Vec<_> = actual
        .keys()
        .filter(|path| !expected.contains_key(*path))
        .collect();
    let changed: Vec<_> = expected
        .iter()
        .filter_map(|(path, bytes)| (actual.get(path) != Some(bytes)).then_some(path))
        .filter(|path| actual.contains_key(*path))
        .collect();
    Err(format!(
        "canonical entity bindings drifted (missing: {missing:?}, stale: {stale:?}, changed: {changed:?}); run cargo run -p himmelcad-core --features ts-bindings --bin generate_entity_bindings",
    )
    .into())
}

fn read_tree(root: &Path) -> Result<BTreeMap<PathBuf, Vec<u8>>, Box<dyn Error>> {
    let mut files = BTreeMap::new();
    read_tree_into(root, root, &mut files)?;
    Ok(files)
}

fn read_tree_into(
    root: &Path,
    directory: &Path,
    files: &mut BTreeMap<PathBuf, Vec<u8>>,
) -> Result<(), Box<dyn Error>> {
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        if path.is_dir() {
            read_tree_into(root, &path, files)?;
        } else {
            files.insert(path.strip_prefix(root)?.to_owned(), fs::read(path)?);
        }
    }
    Ok(())
}
