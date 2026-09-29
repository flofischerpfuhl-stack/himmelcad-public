/**
 * Strict, test-only 3MF validator: parses a package back (ZIP with CRC
 * check, OPC content types and relationships, the model XML) and checks it
 * against the 3MF Core Specification 1.3 and the Materials and Properties
 * Extension 1.2 rules this app relies on — required parts and
 * relationships, units, resource ids and property references, metadata
 * names, build items and transforms, and that every object's mesh is a
 * closed, consistently oriented 2-manifold with positive volume. Returns
 * the problems found (empty = valid) plus the parsed model for further
 * assertions. Independent of the writer (own ZIP/XML parsing).
 */

export const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
export const MATERIAL_NS = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const MODEL_REL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
const MODEL_CT = 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml';
const RELS_CT = 'application/vnd.openxmlformats-package.relationships+xml';
const UNITS = ['micron', 'millimeter', 'centimeter', 'inch', 'foot', 'meter'];
const WELL_KNOWN_METADATA = [
  'Title',
  'Designer',
  'Description',
  'Copyright',
  'LicenseTerms',
  'Rating',
  'CreationDate',
  'ModificationDate',
  'Application',
];
const OBJECT_TYPES = ['model', 'solidsupport', 'support', 'surface', 'other'];
const COLOR = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;
const NUMBER = /^[+-]?((\d+(\.\d+)?)|(\.\d+))([eE][+-]?\d+)?$/;

// ---- ZIP ----------------------------------------------------------------------------

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function readZip(bytes: Uint8Array, problems: string[]): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  const entries = new Map<string, Uint8Array>();
  if (eocd < 0) {
    problems.push('zip: no end-of-central-directory record');
    return entries;
  }
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      problems.push('zip: bad central directory signature');
      break;
    }
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const size = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (view.getUint32(local, true) !== 0x04034b50) problems.push(`zip: ${name}: bad local header`);
    if (method !== 0 && method !== 8) problems.push(`zip: ${name}: unsupported method ${method}`);
    const localName = view.getUint16(local + 26, true);
    const localExtra = view.getUint16(local + 28, true);
    const start = local + 30 + localName + localExtra;
    const data = bytes.subarray(start, start + size);
    if (method === 0 && crc32(data) !== crc) problems.push(`zip: ${name}: CRC mismatch`);
    if (entries.has(name)) problems.push(`zip: duplicate entry ${name}`);
    if (name.startsWith('/') || name.includes('\\'))
      problems.push(`zip: invalid part name ${name}`);
    entries.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// ---- XML ----------------------------------------------------------------------------

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_m, e: string) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    return String.fromCodePoint(e.startsWith('#x') ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  });
}

/** Strict little XML parser (no DTDs); throws on malformed input. */
export function parseXml(source: string): XmlElement {
  let i = 0;
  const skipMisc = () => {
    for (;;) {
      while (i < source.length && /\s/.test(source[i]!)) i += 1;
      if (source.startsWith('<?', i)) {
        const end = source.indexOf('?>', i);
        if (end < 0) throw new Error('unterminated processing instruction');
        i = end + 2;
      } else if (source.startsWith('<!--', i)) {
        const end = source.indexOf('-->', i);
        if (end < 0) throw new Error('unterminated comment');
        i = end + 3;
      } else return;
    }
  };
  const parseElement = (): XmlElement => {
    if (source[i] !== '<') throw new Error(`expected < at ${i}`);
    i += 1;
    const nameMatch = /^[A-Za-z_][\w.:-]*/.exec(source.slice(i, i + 200));
    if (!nameMatch) throw new Error(`bad element name at ${i}`);
    const name = nameMatch[0];
    i += name.length;
    const attrs: Record<string, string> = {};
    for (;;) {
      while (/\s/.test(source[i] ?? '')) i += 1;
      if (source.startsWith('/>', i)) {
        i += 2;
        return { name, attrs, children: [], text: '' };
      }
      if (source[i] === '>') {
        i += 1;
        break;
      }
      const attr = /^([A-Za-z_][\w.:-]*)\s*=\s*("([^"<]*)"|'([^'<]*)')/.exec(
        source.slice(i, i + 4096),
      );
      if (!attr) throw new Error(`bad attribute in <${name}> at ${i}`);
      const key = attr[1]!;
      if (key in attrs) throw new Error(`duplicate attribute ${key} in <${name}>`);
      attrs[key] = decode(attr[3] ?? attr[4] ?? '');
      i += attr[0].length;
    }
    const children: XmlElement[] = [];
    let text = '';
    for (;;) {
      if (i >= source.length) throw new Error(`unterminated <${name}>`);
      if (source.startsWith('</', i)) {
        const close = /^<\/([A-Za-z_][\w.:-]*)\s*>/.exec(source.slice(i, i + 200));
        if (!close || close[1] !== name) throw new Error(`mismatched close for <${name}> at ${i}`);
        i += close[0].length;
        return { name, attrs, children, text: decode(text) };
      }
      if (source.startsWith('<!--', i)) {
        const end = source.indexOf('-->', i);
        i = end + 3;
        continue;
      }
      if (source[i] === '<') {
        children.push(parseElement());
        continue;
      }
      const next = source.indexOf('<', i);
      text += source.slice(i, next < 0 ? source.length : next);
      i = next < 0 ? source.length : next;
    }
  };
  skipMisc();
  const root = parseElement();
  skipMisc();
  if (i !== source.length) throw new Error('content after the root element');
  return root;
}

// ---- 3MF ----------------------------------------------------------------------------

export interface ParsedObject {
  id: number;
  name: string | undefined;
  partnumber: string | undefined;
  pid: number | undefined;
  pindex: number | undefined;
  vertices: number[][];
  triangles: { v: [number, number, number]; pid?: number; p1?: number }[];
  metadata: Record<string, string>;
}

export interface ParsedModel {
  unit: string;
  metadata: Record<string, string>;
  baseMaterials: Map<number, { name: string; color: string }[]>;
  colorGroups: Map<number, string[]>;
  objects: Map<number, ParsedObject>;
  items: { objectId: number; transform: number[] }[];
}

function int(value: string | undefined, what: string, problems: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    problems.push(`${what}: "${value}" is not a non-negative integer`);
    return undefined;
  }
  return Number(value);
}

/** Mesh closedness/orientation of one object (every edge twice, opposite directions). */
export function meshProblems(object: ParsedObject): string[] {
  const out: string[] = [];
  const uses = new Map<string, [number, number]>();
  for (const { v } of object.triangles) {
    for (let k = 0; k < 3; k += 1) {
      const a = v[k]!;
      const b = v[(k + 1) % 3]!;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const entry = uses.get(key) ?? [0, 0];
      entry[a < b ? 0 : 1] += 1;
      uses.set(key, entry);
    }
  }
  let open = 0;
  let nonManifold = 0;
  let flipped = 0;
  for (const [f, b] of uses.values()) {
    if (f + b === 1) open += 1;
    else if (f + b > 2) nonManifold += 1;
    else if (f !== 1) flipped += 1;
  }
  if (open) out.push(`object ${object.id}: ${open} open edges`);
  if (nonManifold) out.push(`object ${object.id}: ${nonManifold} non-manifold edges`);
  if (flipped) out.push(`object ${object.id}: ${flipped} inconsistently oriented edges`);
  let volume = 0;
  for (const { v } of object.triangles) {
    const [a, b, c] = v.map((i) => object.vertices[i]!);
    volume +=
      a![0]! * (b![1]! * c![2]! - b![2]! * c![1]!) -
      a![1]! * (b![0]! * c![2]! - b![2]! * c![0]!) +
      a![2]! * (b![0]! * c![1]! - b![1]! * c![0]!);
  }
  if (!(volume > 0)) out.push(`object ${object.id}: non-positive volume (inward-facing mesh)`);
  return out;
}

export function validateThreeMf(bytes: Uint8Array): {
  problems: string[];
  model: ParsedModel | null;
} {
  const problems: string[] = [];
  const entries = readZip(bytes, problems);
  const text = (name: string) => {
    const data = entries.get(name);
    return data ? new TextDecoder('utf-8', { fatal: true }).decode(data) : null;
  };

  // Content types.
  const ctText = text('[Content_Types].xml');
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  if (!ctText) problems.push('missing [Content_Types].xml');
  else {
    const ct = parseXml(ctText);
    if (ct.name !== 'Types' || ct.attrs.xmlns !== CT_NS) problems.push('content types: bad root');
    for (const child of ct.children) {
      if (child.name === 'Default')
        defaults.set(child.attrs.Extension!.toLowerCase(), child.attrs.ContentType!);
      else if (child.name === 'Override')
        overrides.set(child.attrs.PartName!, child.attrs.ContentType!);
      else problems.push(`content types: unexpected <${child.name}>`);
    }
  }
  const contentType = (part: string) =>
    overrides.get(`/${part}`) ?? defaults.get(part.split('.').pop()!.toLowerCase());
  for (const part of entries.keys()) {
    if (part === '[Content_Types].xml') continue;
    if (!contentType(part)) problems.push(`part ${part} has no content type`);
  }

  // Root relationships.
  const relsText = text('_rels/.rels');
  let modelPart: string | null = null;
  if (!relsText) problems.push('missing _rels/.rels');
  else {
    if (contentType('_rels/.rels') !== RELS_CT) problems.push('_rels/.rels: wrong content type');
    const rels = parseXml(relsText);
    if (rels.name !== 'Relationships' || rels.attrs.xmlns !== RELS_NS)
      problems.push('rels: bad root');
    const ids = new Set<string>();
    for (const rel of rels.children) {
      if (rel.name !== 'Relationship') problems.push(`rels: unexpected <${rel.name}>`);
      if (!rel.attrs.Id || ids.has(rel.attrs.Id)) problems.push('rels: missing or duplicate Id');
      ids.add(rel.attrs.Id ?? '');
      if (rel.attrs.Type === MODEL_REL) {
        if (modelPart) problems.push('rels: more than one 3D model relationship');
        const target = rel.attrs.Target ?? '';
        if (!target.startsWith('/')) problems.push('rels: model Target must be absolute');
        modelPart = target.replace(/^\//, '');
      }
    }
    if (!modelPart) problems.push('rels: no 3D model relationship');
  }
  if (!modelPart) return { problems, model: null };
  const modelText = text(modelPart);
  if (!modelText) {
    problems.push(`model part ${modelPart} missing`);
    return { problems, model: null };
  }
  if (contentType(modelPart) !== MODEL_CT) problems.push('model part: wrong content type');

  const root = parseXml(modelText);
  if (root.name !== 'model' || root.attrs.xmlns !== CORE_NS)
    problems.push('model: bad root/namespace');
  const unit = root.attrs.unit ?? 'millimeter';
  if (!UNITS.includes(unit)) problems.push(`model: bad unit ${unit}`);
  const prefixes = new Map<string, string>();
  for (const [k, v] of Object.entries(root.attrs)) {
    if (k.startsWith('xmlns:')) prefixes.set(k.slice(6), v);
  }
  const materialPrefix = [...prefixes].find(([, ns]) => ns === MATERIAL_NS)?.[0] ?? null;
  const checkMetadataName = (name: string | undefined, where: string) => {
    if (!name) problems.push(`${where}: metadata without name`);
    else if (name.includes(':')) {
      if (!prefixes.has(name.split(':')[0]!))
        problems.push(`${where}: undeclared metadata namespace ${name}`);
    } else if (!WELL_KNOWN_METADATA.includes(name)) {
      problems.push(`${where}: "${name}" is not a well-known metadata name and has no namespace`);
    }
  };

  const model: ParsedModel = {
    unit,
    metadata: {},
    baseMaterials: new Map(),
    colorGroups: new Map(),
    objects: new Map(),
    items: [],
  };
  const order = root.children.map((c) => c.name);
  const resourcesIndex = order.indexOf('resources');
  const buildIndex = order.indexOf('build');
  if (resourcesIndex < 0 || buildIndex < 0) problems.push('model: needs <resources> and <build>');
  if (order.lastIndexOf('metadata') > resourcesIndex)
    problems.push('model: metadata after resources');
  if (buildIndex < resourcesIndex) problems.push('model: build before resources');

  for (const meta of root.children.filter((c) => c.name === 'metadata')) {
    checkMetadataName(meta.attrs.name, 'model');
    model.metadata[meta.attrs.name ?? ''] = meta.text;
  }
  const ids = new Set<number>();
  const resources = root.children.find((c) => c.name === 'resources');
  for (const resource of resources?.children ?? []) {
    const id = int(resource.attrs.id, `<${resource.name}> id`, problems);
    if (id === undefined || id < 1) {
      problems.push(`<${resource.name}>: missing/invalid id`);
      continue;
    }
    if (ids.has(id)) problems.push(`duplicate resource id ${id}`);
    ids.add(id);
    if (materialPrefix && resource.name === `${materialPrefix}:basematerials`) {
      const bases = resource.children.map((b) => {
        if (b.name !== `${materialPrefix}:base`)
          problems.push(`basematerials ${id}: unexpected <${b.name}>`);
        if (!b.attrs.name) problems.push(`basematerials ${id}: base without name`);
        if (!COLOR.test(b.attrs.displaycolor ?? ''))
          problems.push(`basematerials ${id}: bad displaycolor`);
        return { name: b.attrs.name ?? '', color: b.attrs.displaycolor ?? '' };
      });
      if (bases.length === 0) problems.push(`basematerials ${id}: empty`);
      model.baseMaterials.set(id, bases);
    } else if (materialPrefix && resource.name === `${materialPrefix}:colorgroup`) {
      const colors = resource.children.map((c) => {
        if (!COLOR.test(c.attrs.color ?? '')) problems.push(`colorgroup ${id}: bad color`);
        return c.attrs.color ?? '';
      });
      if (colors.length === 0) problems.push(`colorgroup ${id}: empty`);
      model.colorGroups.set(id, colors);
    } else if (resource.name === 'object') {
      const type = resource.attrs.type ?? 'model';
      if (!OBJECT_TYPES.includes(type)) problems.push(`object ${id}: bad type ${type}`);
      const object: ParsedObject = {
        id,
        name: resource.attrs.name,
        partnumber: resource.attrs.partnumber,
        pid: int(resource.attrs.pid, `object ${id} pid`, problems),
        pindex: int(resource.attrs.pindex, `object ${id} pindex`, problems),
        vertices: [],
        triangles: [],
        metadata: {},
      };
      const kids = resource.children.map((c) => c.name);
      const group = resource.children.find((c) => c.name === 'metadatagroup');
      if (group && kids.indexOf('metadatagroup') > kids.indexOf('mesh')) {
        problems.push(`object ${id}: metadatagroup must precede mesh`);
      }
      for (const meta of group?.children ?? []) {
        checkMetadataName(meta.attrs.name, `object ${id}`);
        object.metadata[meta.attrs.name ?? ''] = meta.text;
      }
      const propertyCount = (pid: number) =>
        model.baseMaterials.get(pid)?.length ?? model.colorGroups.get(pid)?.length ?? null;
      if (object.pid !== undefined) {
        const count = propertyCount(object.pid);
        if (count === null)
          problems.push(
            `object ${id}: pid ${object.pid} is not a property group defined before it`,
          );
        else if ((object.pindex ?? 0) >= count) problems.push(`object ${id}: pindex out of range`);
      }
      const mesh = resource.children.find((c) => c.name === 'mesh');
      if (!mesh) problems.push(`object ${id}: no mesh`);
      const vertices = mesh?.children.find((c) => c.name === 'vertices')?.children ?? [];
      for (const v of vertices) {
        const xyz = ['x', 'y', 'z'].map((k) => v.attrs[k] ?? '');
        if (!xyz.every((n) => NUMBER.test(n)))
          problems.push(`object ${id}: bad vertex ${xyz.join(' ')}`);
        object.vertices.push(xyz.map(Number));
      }
      const triangles = mesh?.children.find((c) => c.name === 'triangles')?.children ?? [];
      if (vertices.length < 3 || triangles.length < 1) problems.push(`object ${id}: empty mesh`);
      for (const t of triangles) {
        const v = [t.attrs.v1, t.attrs.v2, t.attrs.v3].map((x, k) =>
          int(x, `object ${id} triangle v${k + 1}`, problems),
        ) as [number, number, number];
        if (v.some((x) => x === undefined || x >= vertices.length)) {
          problems.push(`object ${id}: triangle index out of range`);
          continue;
        }
        if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2])
          problems.push(`object ${id}: degenerate triangle`);
        const pid = int(t.attrs.pid, `object ${id} triangle pid`, problems);
        const p1 = int(t.attrs.p1, `object ${id} triangle p1`, problems);
        if (pid !== undefined) {
          const count = propertyCount(pid);
          if (count === null) problems.push(`object ${id}: triangle pid ${pid} undefined`);
          else if ((p1 ?? object.pindex ?? 0) >= count)
            problems.push(`object ${id}: triangle p1 out of range`);
        }
        object.triangles.push({
          v,
          ...(pid !== undefined ? { pid } : {}),
          ...(p1 !== undefined ? { p1 } : {}),
        });
      }
      if (type === 'model') problems.push(...meshProblems(object));
      model.objects.set(id, object);
    } else {
      problems.push(`resources: unexpected <${resource.name}>`);
    }
  }

  const build = root.children.find((c) => c.name === 'build');
  if (build && build.children.length === 0) problems.push('build: no items');
  for (const item of build?.children ?? []) {
    if (item.name !== 'item') {
      problems.push(`build: unexpected <${item.name}>`);
      continue;
    }
    const objectId = int(item.attrs.objectid, 'item objectid', problems);
    const object = objectId !== undefined ? model.objects.get(objectId) : undefined;
    if (!object) problems.push(`build item references missing object ${item.attrs.objectid}`);
    const transform = (item.attrs.transform ?? '1 0 0 0 1 0 0 0 1 0 0 0').trim().split(/\s+/);
    if (transform.length !== 12 || !transform.every((n) => NUMBER.test(n))) {
      problems.push(`build item ${objectId}: transform needs 12 numbers`);
    }
    const m = transform.map(Number);
    const det =
      m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) -
      m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) +
      m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);
    if (!(det > 0)) problems.push(`build item ${objectId}: transform is singular or mirrors`);
    model.items.push({ objectId: objectId ?? -1, transform: m });
  }
  return { problems, model };
}
