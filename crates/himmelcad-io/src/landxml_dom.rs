//! Small bounded XML tree used by the `LandXML` provider.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use quick_xml::events::{BytesRef, BytesStart, Event};
use quick_xml::reader::Reader;
use quick_xml::XmlVersion;

use crate::canonical_provider::{ProviderOperationContext, ProviderProgress};
use crate::landxml::LandXmlError;

const MAX_XML_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ELEMENTS: usize = 750_000;
const MAX_DEPTH: usize = 128;
const MAX_ATTRIBUTES_PER_ELEMENT: usize = 128;
const MAX_TEXT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct XmlNode {
    pub(crate) name: String,
    pub(crate) attributes: BTreeMap<String, String>,
    pub(crate) text: String,
    pub(crate) children: Vec<Self>,
}

impl XmlNode {
    pub(crate) fn attr(&self, name: &str) -> Option<&str> {
        self.attributes.get(name).map(String::as_str)
    }

    pub(crate) fn child(&self, name: &str) -> Option<&Self> {
        self.children.iter().find(|child| child.name == name)
    }

    pub(crate) fn children_named<'a>(
        &'a self,
        name: &'a str,
    ) -> impl Iterator<Item = &'a Self> + 'a {
        self.children.iter().filter(move |child| child.name == name)
    }

    pub(crate) fn descendants_named<'a>(&'a self, name: &'a str) -> Vec<&'a Self> {
        let mut output = Vec::new();
        self.collect_descendants(name, &mut output);
        output
    }

    fn collect_descendants<'a>(&'a self, name: &str, output: &mut Vec<&'a Self>) {
        for child in &self.children {
            if child.name == name {
                output.push(child);
            }
            child.collect_descendants(name, output);
        }
    }
}

pub(crate) fn parse_xml(
    path: &Path,
    context: &mut dyn ProviderOperationContext,
) -> Result<XmlNode, LandXmlError> {
    let metadata = path.metadata()?;
    if metadata.len() == 0 || metadata.len() > MAX_XML_BYTES {
        return Err(LandXmlError::Limit(format!(
            "LandXML byte length must be between 1 and {MAX_XML_BYTES}"
        )));
    }
    let file = File::open(path)?;
    let mut reader = Reader::from_reader(BufReader::new(file));
    reader.config_mut().check_end_names = true;
    reader.config_mut().allow_unmatched_ends = false;
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::with_capacity(16 * 1024);
    let mut stack = Vec::<XmlNode>::new();
    let mut root = None;
    let mut elements = 0_usize;
    let mut text_bytes = 0_usize;
    let mut events = 0_u64;
    let mut xml_version = XmlVersion::Implicit1_0;

    loop {
        events = events.saturating_add(1);
        if events.is_multiple_of(4_096) {
            if context.is_cancelled() {
                return Err(LandXmlError::Cancelled);
            }
            context.report_progress(ProviderProgress {
                phase: "landxml-parse".to_owned(),
                completed: reader.buffer_position(),
                total: Some(metadata.len()),
                message: "parsing bounded LandXML tree".to_owned(),
            });
        }
        match reader.read_event_into(&mut buffer)? {
            Event::Start(start) => {
                elements = elements.saturating_add(1);
                check_structure_limits(elements, stack.len().saturating_add(1))?;
                stack.push(node_from_start(&reader, xml_version, &start)?);
            }
            Event::Empty(start) => {
                elements = elements.saturating_add(1);
                check_structure_limits(elements, stack.len().saturating_add(1))?;
                attach_node(
                    node_from_start(&reader, xml_version, &start)?,
                    &mut stack,
                    &mut root,
                )?;
            }
            Event::End(_) => {
                let node = stack
                    .pop()
                    .ok_or_else(|| LandXmlError::Xml("unmatched closing element".to_owned()))?;
                attach_node(node, &mut stack, &mut root)?;
            }
            Event::Text(text) => {
                let decoded = text.decode()?.into_owned();
                let decoded = quick_xml::escape::unescape(&decoded)?.into_owned();
                append_text(&mut stack, &decoded, &mut text_bytes)?;
            }
            Event::CData(text) => {
                let decoded = text.decode()?.into_owned();
                append_text(&mut stack, &decoded, &mut text_bytes)?;
            }
            Event::GeneralRef(reference) => {
                let resolved = resolve_reference(&reference)?;
                append_text(&mut stack, &resolved, &mut text_bytes)?;
            }
            Event::DocType(_) => {
                return Err(LandXmlError::Xml(
                    "DTD declarations are forbidden in LandXML imports".to_owned(),
                ));
            }
            Event::Decl(declaration) => xml_version = declaration.xml_version()?,
            Event::Comment(_) | Event::PI(_) => {}
            Event::Eof => break,
        }
        buffer.clear();
    }
    if !stack.is_empty() {
        return Err(LandXmlError::Xml(
            "LandXML ended with unclosed elements".to_owned(),
        ));
    }
    context.report_progress(ProviderProgress {
        phase: "landxml-parse".to_owned(),
        completed: metadata.len(),
        total: Some(metadata.len()),
        message: "parsed bounded LandXML tree".to_owned(),
    });
    root.ok_or_else(|| LandXmlError::Xml("LandXML document has no root element".to_owned()))
}

fn node_from_start<R: std::io::BufRead>(
    reader: &Reader<R>,
    xml_version: XmlVersion,
    start: &BytesStart<'_>,
) -> Result<XmlNode, LandXmlError> {
    let name = local_name(start.local_name().as_ref())?;
    let mut attributes = BTreeMap::new();
    for (index, result) in start.attributes().with_checks(true).enumerate() {
        if index >= MAX_ATTRIBUTES_PER_ELEMENT {
            return Err(LandXmlError::Limit(format!(
                "element {name} exceeds {MAX_ATTRIBUTES_PER_ELEMENT} attributes"
            )));
        }
        let attribute = result?;
        let key = local_name(attribute.key.local_name().as_ref())?;
        let value = attribute
            .decoded_and_normalized_value(xml_version, reader.decoder())?
            .into_owned();
        if attributes.insert(key.clone(), value).is_some() {
            return Err(LandXmlError::Xml(format!(
                "element {name} contains duplicate local attribute {key}"
            )));
        }
    }
    Ok(XmlNode {
        name,
        attributes,
        text: String::new(),
        children: Vec::new(),
    })
}

fn local_name(bytes: &[u8]) -> Result<String, LandXmlError> {
    let name = std::str::from_utf8(bytes)
        .map_err(|error| LandXmlError::Xml(error.to_string()))?
        .to_owned();
    if name.is_empty() {
        Err(LandXmlError::Xml("empty XML local name".to_owned()))
    } else {
        Ok(name)
    }
}

fn append_text(
    stack: &mut [XmlNode],
    text: &str,
    text_bytes: &mut usize,
) -> Result<(), LandXmlError> {
    *text_bytes = text_bytes
        .checked_add(text.len())
        .ok_or_else(|| LandXmlError::Limit("LandXML text byte count overflow".to_owned()))?;
    if *text_bytes > MAX_TEXT_BYTES {
        return Err(LandXmlError::Limit(format!(
            "LandXML decoded text exceeds {MAX_TEXT_BYTES} bytes"
        )));
    }
    if let Some(node) = stack.last_mut() {
        node.text.push_str(text);
    } else if !text.trim().is_empty() {
        return Err(LandXmlError::Xml(
            "non-whitespace text outside the root element".to_owned(),
        ));
    }
    Ok(())
}

fn resolve_reference(reference: &BytesRef<'_>) -> Result<String, LandXmlError> {
    if let Some(character) = reference.resolve_char_ref()? {
        return Ok(character.to_string());
    }
    match reference.decode()?.as_ref() {
        "amp" => Ok("&".to_owned()),
        "apos" => Ok("'".to_owned()),
        "gt" => Ok(">".to_owned()),
        "lt" => Ok("<".to_owned()),
        "quot" => Ok("\"".to_owned()),
        name => Err(LandXmlError::Xml(format!(
            "general entity reference &{name}; is forbidden"
        ))),
    }
}

fn attach_node(
    node: XmlNode,
    stack: &mut [XmlNode],
    root: &mut Option<XmlNode>,
) -> Result<(), LandXmlError> {
    if let Some(parent) = stack.last_mut() {
        parent.children.push(node);
    } else if root.replace(node).is_some() {
        return Err(LandXmlError::Xml(
            "LandXML document contains multiple root elements".to_owned(),
        ));
    }
    Ok(())
}

fn check_structure_limits(elements: usize, depth: usize) -> Result<(), LandXmlError> {
    if elements > MAX_ELEMENTS {
        Err(LandXmlError::Limit(format!(
            "LandXML exceeds {MAX_ELEMENTS} elements"
        )))
    } else if depth > MAX_DEPTH {
        Err(LandXmlError::Limit(format!(
            "LandXML nesting exceeds {MAX_DEPTH}"
        )))
    } else {
        Ok(())
    }
}
