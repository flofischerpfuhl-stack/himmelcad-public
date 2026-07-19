//! Bounded ISO 10303-21 record indexing and lazy value decoding for IFC SPF.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use thiserror::Error;

pub(crate) const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024 * 1024;
pub(crate) const MAX_RECORDS: usize = 5_000_000;
const MAX_RECORD_BYTES: u64 = 64 * 1024 * 1024;
const MAX_NESTING: usize = 256;
const MAX_VALUES_PER_RECORD: usize = 4_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecordLocation {
    pub(crate) offset: u64,
    pub(crate) length: u64,
    pub(crate) entity_type: String,
}

#[derive(Debug)]
pub(crate) struct StepIndex {
    path: PathBuf,
    pub(crate) byte_length: u64,
    pub(crate) schema: String,
    pub(crate) records: BTreeMap<u64, RecordLocation>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum StepValue {
    Null,
    Omitted,
    Ref(u64),
    Integer(i64),
    Real(f64),
    String(String),
    Enum(String),
    List(Vec<StepValue>),
    Typed(String, Box<StepValue>),
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct StepRecord {
    pub(crate) id: u64,
    pub(crate) entity_type: String,
    pub(crate) arguments: Vec<StepValue>,
}

#[derive(Debug, Error)]
pub(crate) enum StepError {
    #[error("I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("source exceeds the bounded IFC file size")]
    FileLimit,
    #[error("STEP syntax is malformed: {0}")]
    Syntax(&'static str),
    #[error("STEP record budget exceeded")]
    RecordLimit,
    #[error("STEP record is too large")]
    RecordSize,
    #[error("STEP reference #{0} is missing")]
    MissingReference(u64),
}

impl StepIndex {
    pub(crate) fn build(
        path: &Path,
        mut cancelled: impl FnMut() -> bool,
    ) -> Result<Self, StepError> {
        let file = File::open(path)?;
        let byte_length = file.metadata()?.len();
        if byte_length == 0 || byte_length > MAX_FILE_BYTES {
            return Err(StepError::FileLimit);
        }
        let mut reader = BufReader::with_capacity(1024 * 1024, file);
        let mut records = BTreeMap::new();
        let mut schema = None;
        let mut offset = 0_u64;
        let mut record_start = 0_u64;
        let mut record = Vec::new();
        let mut in_string = false;
        let mut string_quote_pending = false;
        let mut in_comment = false;
        let mut previous = 0_u8;
        let mut chunk = vec![0_u8; 256 * 1024].into_boxed_slice();
        loop {
            if cancelled() {
                return Err(StepError::Syntax("cancelled"));
            }
            let count = reader.read(&mut chunk)?;
            if count == 0 {
                break;
            }
            for &byte in &chunk[..count] {
                if record.is_empty() && byte.is_ascii_whitespace() {
                    previous = byte;
                    offset += 1;
                    continue;
                }
                if record.is_empty() {
                    record_start = offset;
                }
                record.push(byte);
                if record.len() as u64 > MAX_RECORD_BYTES {
                    return Err(StepError::RecordSize);
                }
                if in_comment {
                    if previous == b'*' && byte == b'/' {
                        in_comment = false;
                    }
                } else if in_string && !string_quote_pending {
                    if byte == b'\'' {
                        string_quote_pending = true;
                    }
                } else if in_string && byte == b'\'' {
                    string_quote_pending = false;
                } else {
                    if in_string {
                        in_string = false;
                        string_quote_pending = false;
                    }
                    if previous == b'/' && byte == b'*' {
                        in_comment = true;
                    } else if byte == b'\'' {
                        in_string = true;
                    } else if byte == b';' {
                        let text = std::str::from_utf8(&record)
                            .map_err(|_| StepError::Syntax("SPF must be UTF-8/ASCII compatible"))?;
                        let trimmed = text.trim();
                        let semantic = strip_comments(trimmed)?;
                        let semantic = semantic.trim();
                        if schema.is_none()
                            && semantic.to_ascii_uppercase().starts_with("FILE_SCHEMA")
                        {
                            schema = Some(parse_schema(semantic)?);
                        }
                        if semantic.starts_with('#') {
                            let (id, entity_type) = record_identity(semantic)?;
                            if records.len() >= MAX_RECORDS {
                                return Err(StepError::RecordLimit);
                            }
                            if records
                                .insert(
                                    id,
                                    RecordLocation {
                                        offset: record_start,
                                        length: record.len() as u64,
                                        entity_type,
                                    },
                                )
                                .is_some()
                            {
                                return Err(StepError::Syntax("duplicate STEP instance id"));
                            }
                        }
                        record.clear();
                    }
                }
                previous = byte;
                offset += 1;
            }
        }
        if (in_string && !string_quote_pending)
            || in_comment
            || record.iter().any(|byte| !byte.is_ascii_whitespace())
        {
            return Err(StepError::Syntax("unterminated STEP token or record"));
        }
        let schema = schema.ok_or(StepError::Syntax("FILE_SCHEMA is missing"))?;
        if records.is_empty() {
            return Err(StepError::Syntax("DATA section contains no instances"));
        }
        Ok(Self {
            path: path.to_owned(),
            byte_length,
            schema,
            records,
        })
    }

    pub(crate) fn record(&self, id: u64) -> Result<StepRecord, StepError> {
        let location = self
            .records
            .get(&id)
            .ok_or(StepError::MissingReference(id))?;
        let mut file = File::open(&self.path)?;
        file.seek(SeekFrom::Start(location.offset))?;
        let length = usize::try_from(location.length).map_err(|_| StepError::RecordSize)?;
        let mut bytes = vec![0_u8; length];
        file.read_exact(&mut bytes)?;
        parse_record(&bytes)
    }

    pub(crate) fn ids_of_type(&self, entity_type: &str) -> impl Iterator<Item = u64> + '_ {
        let wanted = entity_type.to_owned();
        self.records
            .iter()
            .filter(move |(_, location)| location.entity_type == wanted)
            .map(|(id, _)| *id)
    }
}

fn parse_schema(record: &str) -> Result<String, StepError> {
    let upper = record.to_ascii_uppercase();
    for supported in ["IFC4X3_ADD2", "IFC4X3", "IFC4", "IFC2X3"] {
        if upper.contains(&format!("'{supported}'")) {
            return Ok(supported.to_owned());
        }
    }
    Err(StepError::Syntax("unsupported IFC schema"))
}

fn record_identity(record: &str) -> Result<(u64, String), StepError> {
    let equal = record
        .find('=')
        .ok_or(StepError::Syntax("record lacks '='"))?;
    let id = record[1..equal]
        .trim()
        .parse::<u64>()
        .map_err(|_| StepError::Syntax("invalid instance id"))?;
    if id == 0 {
        return Err(StepError::Syntax("instance id must be positive"));
    }
    let tail = record[equal + 1..].trim_start();
    let end = tail
        .find(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
        .ok_or(StepError::Syntax("record lacks arguments"))?;
    let entity_type = tail[..end].to_ascii_uppercase();
    if !entity_type.starts_with("IFC") {
        return Err(StepError::Syntax("non-IFC DATA entity"));
    }
    Ok((id, entity_type))
}

fn parse_record(bytes: &[u8]) -> Result<StepRecord, StepError> {
    let source = std::str::from_utf8(bytes)
        .map_err(|_| StepError::Syntax("SPF must be UTF-8/ASCII compatible"))?;
    let source = strip_comments(source)?;
    let trimmed = source.trim();
    let (id, entity_type) = record_identity(trimmed)?;
    let open = trimmed
        .find('(')
        .ok_or(StepError::Syntax("arguments are missing"))?;
    let close = trimmed
        .rfind(')')
        .ok_or(StepError::Syntax("arguments are unterminated"))?;
    let mut parser = ValueParser::new(&trimmed[open + 1..close]);
    let arguments = parser.parse_sequence(None)?;
    parser.skip_space();
    if !parser.done() {
        return Err(StepError::Syntax("trailing argument content"));
    }
    Ok(StepRecord {
        id,
        entity_type,
        arguments,
    })
}

fn strip_comments(source: &str) -> Result<String, StepError> {
    let mut output = String::with_capacity(source.len());
    let bytes = source.as_bytes();
    let mut index = 0;
    let mut in_string = false;
    while index < bytes.len() {
        if bytes[index] == b'\'' {
            in_string = !in_string;
            output.push('\'');
            index += 1;
        } else if !in_string && index + 1 < bytes.len() && &bytes[index..index + 2] == b"/*" {
            let rest = &source[index + 2..];
            let end = rest
                .find("*/")
                .ok_or(StepError::Syntax("unterminated comment"))?;
            output.push(' ');
            index += end + 4;
        } else {
            output.push(bytes[index] as char);
            index += 1;
        }
    }
    Ok(output)
}

struct ValueParser<'a> {
    source: &'a [u8],
    cursor: usize,
    depth: usize,
    values: usize,
}

impl<'a> ValueParser<'a> {
    fn new(source: &'a str) -> Self {
        Self {
            source: source.as_bytes(),
            cursor: 0,
            depth: 0,
            values: 0,
        }
    }

    fn parse_sequence(&mut self, closing: Option<u8>) -> Result<Vec<StepValue>, StepError> {
        self.depth += 1;
        if self.depth > MAX_NESTING {
            return Err(StepError::Syntax("value nesting limit exceeded"));
        }
        let mut output = Vec::new();
        loop {
            self.skip_space();
            if closing.is_some_and(|value| self.peek() == Some(value)) {
                self.cursor += 1;
                break;
            }
            if closing.is_none() && self.done() {
                break;
            }
            output.push(self.parse_value()?);
            self.skip_space();
            match self.peek() {
                Some(b',') => self.cursor += 1,
                Some(value) if Some(value) == closing => {
                    self.cursor += 1;
                    break;
                }
                None if closing.is_none() => break,
                _ => return Err(StepError::Syntax("expected ',' or ')'")),
            }
        }
        self.depth -= 1;
        Ok(output)
    }

    fn parse_value(&mut self) -> Result<StepValue, StepError> {
        self.values += 1;
        if self.values > MAX_VALUES_PER_RECORD {
            return Err(StepError::RecordLimit);
        }
        self.skip_space();
        match self.peek().ok_or(StepError::Syntax("missing value"))? {
            b'$' => {
                self.cursor += 1;
                Ok(StepValue::Null)
            }
            b'*' => {
                self.cursor += 1;
                Ok(StepValue::Omitted)
            }
            b'#' => {
                self.cursor += 1;
                let digits = self.take_while(|byte| byte.is_ascii_digit());
                let id = std::str::from_utf8(digits)
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .filter(|id| *id > 0)
                    .ok_or(StepError::Syntax("invalid reference"))?;
                Ok(StepValue::Ref(id))
            }
            b'\'' => self.parse_string().map(StepValue::String),
            b'.' => self.parse_enum().map(StepValue::Enum),
            b'(' => {
                self.cursor += 1;
                self.parse_sequence(Some(b')')).map(StepValue::List)
            }
            byte if byte.is_ascii_alphabetic() => {
                let name = self.take_name()?;
                self.skip_space();
                if self.peek() != Some(b'(') {
                    return Err(StepError::Syntax("typed value lacks parentheses"));
                }
                self.cursor += 1;
                let values = self.parse_sequence(Some(b')'))?;
                let value = if values.len() == 1 {
                    values.into_iter().next().expect("one typed value")
                } else {
                    StepValue::List(values)
                };
                Ok(StepValue::Typed(name, Box::new(value)))
            }
            _ => self.parse_number(),
        }
    }

    fn parse_string(&mut self) -> Result<String, StepError> {
        self.cursor += 1;
        let mut output = String::new();
        loop {
            let byte = self
                .peek()
                .ok_or(StepError::Syntax("unterminated string"))?;
            self.cursor += 1;
            if byte == b'\'' {
                if self.peek() == Some(b'\'') {
                    self.cursor += 1;
                    output.push('\'');
                } else {
                    return Ok(output);
                }
            } else {
                output.push(byte as char);
            }
        }
    }

    fn parse_enum(&mut self) -> Result<String, StepError> {
        self.cursor += 1;
        let start = self.cursor;
        while self.peek().is_some_and(|byte| byte != b'.') {
            self.cursor += 1;
        }
        if self.peek() != Some(b'.') || self.cursor == start {
            return Err(StepError::Syntax("invalid enumeration"));
        }
        let value = std::str::from_utf8(&self.source[start..self.cursor])
            .map_err(|_| StepError::Syntax("invalid enumeration"))?
            .to_ascii_uppercase();
        self.cursor += 1;
        Ok(value)
    }

    fn parse_number(&mut self) -> Result<StepValue, StepError> {
        let token = self.take_while(|byte| {
            byte.is_ascii_digit() || matches!(byte, b'+' | b'-' | b'.' | b'E' | b'e')
        });
        let text = std::str::from_utf8(token).map_err(|_| StepError::Syntax("invalid number"))?;
        if text.contains(['.', 'E', 'e']) {
            let value = text
                .parse::<f64>()
                .map_err(|_| StepError::Syntax("invalid real"))?;
            if !value.is_finite() {
                return Err(StepError::Syntax("non-finite real"));
            }
            Ok(StepValue::Real(value))
        } else {
            text.parse::<i64>()
                .map(StepValue::Integer)
                .map_err(|_| StepError::Syntax("invalid integer"))
        }
    }

    fn take_name(&mut self) -> Result<String, StepError> {
        let token = self.take_while(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
        if token.is_empty() {
            return Err(StepError::Syntax("missing type name"));
        }
        Ok(std::str::from_utf8(token)
            .map_err(|_| StepError::Syntax("invalid type name"))?
            .to_ascii_uppercase())
    }

    fn take_while(&mut self, predicate: impl Fn(u8) -> bool) -> &'a [u8] {
        let start = self.cursor;
        while self.peek().is_some_and(&predicate) {
            self.cursor += 1;
        }
        &self.source[start..self.cursor]
    }

    fn skip_space(&mut self) {
        while self.peek().is_some_and(|byte| byte.is_ascii_whitespace()) {
            self.cursor += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.source.get(self.cursor).copied()
    }

    fn done(&self) -> bool {
        self.cursor == self.source.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture(contents: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "hcad-ifc-step-{}-{}.ifc",
            std::process::id(),
            ObjectHashForTest::of(contents)
        ));
        let mut file = File::create(&path).expect("fixture");
        file.write_all(contents.as_bytes()).expect("write fixture");
        path
    }

    struct ObjectHashForTest;
    impl ObjectHashForTest {
        fn of(value: &str) -> u64 {
            value.bytes().fold(1469598103934665603, |hash, byte| {
                (hash ^ u64::from(byte)).wrapping_mul(1099511628211)
            })
        }
    }

    #[test]
    fn indexes_forward_references_and_decodes_only_requested_record() {
        let path = fixture("ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X3_ADD2'));ENDSEC;DATA;#2=IFCWALL('g',$,'Wall',$,$,#9,$,$,$);#9=IFCLOCALPLACEMENT($,#10);#10=IFCAXIS2PLACEMENT3D(#11,$,$);#11=IFCCARTESIANPOINT((1.,2.,3.));ENDSEC;END-ISO-10303-21;");
        let index = StepIndex::build(&path, || false).expect("index");
        assert_eq!(index.schema, "IFC4X3_ADD2");
        assert_eq!(index.records.len(), 4);
        let wall = index.record(2).expect("wall");
        assert_eq!(wall.entity_type, "IFCWALL");
        assert_eq!(wall.arguments[5], StepValue::Ref(9));
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn rejects_duplicate_ids_and_unbounded_nesting() {
        let duplicate = fixture("ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;#1=IFCPROXY($);#1=IFCPROXY($);ENDSEC;END-ISO-10303-21;");
        assert!(matches!(
            StepIndex::build(&duplicate, || false),
            Err(StepError::Syntax("duplicate STEP instance id"))
        ));
        std::fs::remove_file(duplicate).ok();

        let nested = format!("ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;#1=IFCPROXY({}1{});ENDSEC;END-ISO-10303-21;", "(".repeat(300), ")".repeat(300));
        let path = fixture(&nested);
        let index = StepIndex::build(&path, || false).expect("index is shallow");
        assert!(matches!(index.record(1), Err(StepError::Syntax(_))));
        std::fs::remove_file(path).ok();
    }
}
