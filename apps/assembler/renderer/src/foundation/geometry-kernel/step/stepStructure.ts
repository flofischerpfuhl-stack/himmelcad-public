/**
 * Product structure of a STEP file (AP203/AP214/AP242): which parts and
 * sub-assemblies it has, their names and surface colours — read from the
 * file text with `p21.ts`, because the OCCT build in the app has no
 * `STEPCAFControl_Reader` (XCAF reading). The importer
 * (`kernel/stepImport.ts`) hands OCCT one `NEXT_ASSEMBLY_USAGE_OCCURRENCE`
 * at a time and places each part itself, so names and folders line up with
 * the geometry by construction.
 *
 * Entities used (ISO 10303-44/-41/-46): PRODUCT, PRODUCT_DEFINITION_FORMATION,
 * PRODUCT_DEFINITION, PRODUCT_DEFINITION_SHAPE, SHAPE_DEFINITION_REPRESENTATION,
 * SHAPE_REPRESENTATION_RELATIONSHIP (without transformation),
 * NEXT_ASSEMBLY_USAGE_OCCURRENCE, STYLED_ITEM and its presentation chain down
 * to COLOUR_RGB / DRAUGHTING_PRE_DEFINED_COLOUR, and the shell/solid records
 * needed to walk a face colour up to its representation.
 */
import {
  partOf,
  refOf,
  refsOf,
  scanStep,
  stringOf,
  numberOf,
  type ScanResult,
  type StepEntity,
  type StepValue,
} from './p21.js';

export interface StepAssemblyInstance {
  /** Instance id of the `NEXT_ASSEMBLY_USAGE_OCCURRENCE`. */
  nauo: number;
  /** 1-based record position of the NAUO (OCCT `StepModel::Entity`). */
  nauoIndex: number;
  /** Instance name written by the exporting system (often empty or `Part:1`). */
  instanceName: string;
  node: StepProductNode;
}

export interface StepProductNode {
  /** Instance id of the `PRODUCT_DEFINITION`. */
  pd: number;
  pdIndex: number;
  name: string;
  /** Surface colour of the part (`#RRGGBB`), `null` if the file gives none. */
  color: string | null;
  /** Components (empty for a part). */
  children: StepAssemblyInstance[];
}

export interface StepStructure {
  schemas: string[];
  /** `AP203`, `AP214`, `AP242` or `null` (unknown schema). */
  protocol: 'AP203' | 'AP214' | 'AP242' | null;
  /** Length unit of the file (`mm`, `cm`, `m`, `in`, `ft`, …), `null` if none was found. */
  lengthUnit: string | null;
  /** Top-level products (not used as a component). */
  roots: StepProductNode[];
  /** Number of parts (leaf products) and of placed part instances. */
  partCount: number;
  instanceCount: number;
  recordCount: number;
  /** Instance id → record position of every record. */
  positions: Map<number, number>;
}

const PD_TYPES = [
  'PRODUCT_DEFINITION',
  'PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS',
  'COMPOSITE_ASSEMBLY_DEFINITION',
];
const PDF_TYPES = [
  'PRODUCT_DEFINITION_FORMATION',
  'PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE',
];
const STYLE_TYPES = [
  'STYLED_ITEM',
  'OVER_RIDING_STYLED_ITEM',
  'PRESENTATION_STYLE_ASSIGNMENT',
  'PRESENTATION_STYLE_BY_CONTEXT',
  'SURFACE_STYLE_USAGE',
  'SURFACE_SIDE_STYLE',
  'SURFACE_STYLE_FILL_AREA',
  'FILL_AREA_STYLE',
  'FILL_AREA_STYLE_COLOUR',
  'COLOUR_RGB',
  'DRAUGHTING_PRE_DEFINED_COLOUR',
  'SURFACE_STYLE_RENDERING',
  'SURFACE_STYLE_RENDERING_WITH_PROPERTIES',
];
/** Records a face or solid colour is walked up through to reach its representation. */
const CONTAINER_TYPES = [
  'CLOSED_SHELL',
  'OPEN_SHELL',
  'ORIENTED_CLOSED_SHELL',
  'MANIFOLD_SOLID_BREP',
  'BREP_WITH_VOIDS',
  'FACETED_BREP',
  'SHELL_BASED_SURFACE_MODEL',
];
const REPRESENTATION_TYPES = [
  'SHAPE_REPRESENTATION',
  'ADVANCED_BREP_SHAPE_REPRESENTATION',
  'MANIFOLD_SURFACE_SHAPE_REPRESENTATION',
  'FACETED_BREP_SHAPE_REPRESENTATION',
  'GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION',
  'GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION',
  'EDGE_BASED_WIREFRAME_SHAPE_REPRESENTATION',
  'SHAPE_REPRESENTATION_WITH_PARAMETERS',
];

export const STEP_STRUCTURE_TYPES: ReadonlySet<string> = new Set([
  'PRODUCT',
  ...PD_TYPES,
  ...PDF_TYPES,
  'PRODUCT_DEFINITION_SHAPE',
  'SHAPE_DEFINITION_REPRESENTATION',
  'SHAPE_REPRESENTATION_RELATIONSHIP',
  'REPRESENTATION_RELATIONSHIP',
  'NEXT_ASSEMBLY_USAGE_OCCURRENCE',
  'LENGTH_UNIT',
  ...STYLE_TYPES,
  ...CONTAINER_TYPES,
  ...REPRESENTATION_TYPES,
]);

/** DRAUGHTING_PRE_DEFINED_COLOUR names (ISO 10303-46). */
const PREDEFINED_COLOURS: Record<string, string> = {
  red: '#FF0000',
  green: '#00FF00',
  blue: '#0000FF',
  yellow: '#FFFF00',
  magenta: '#FF00FF',
  cyan: '#00FFFF',
  black: '#000000',
  white: '#FFFFFF',
};

function hexOf(r: number, g: number, b: number): string {
  const to = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `#${to(r)}${to(g)}${to(b)}`;
}

function firstPart(entity: StepEntity | undefined, types: readonly string[]): StepValue[] | null {
  if (!entity) return null;
  for (const t of types) {
    const p = partOf(entity, t);
    if (p) return p;
  }
  return null;
}

function hasType(entity: StepEntity | undefined, types: readonly string[]): boolean {
  return entity !== undefined && entity.types.some((t) => types.includes(t));
}

/** Length unit of a `( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )` or a conversion-based unit. */
function lengthUnitOf(entity: StepEntity): string | null {
  const si = partOf(entity, 'SI_UNIT');
  if (si) {
    const prefix = si[0] && typeof si[0] === 'object' && 'enum' in si[0] ? si[0].enum : null;
    const map: Record<string, string> = {
      MILLI: 'mm',
      CENTI: 'cm',
      DECI: 'dm',
      KILO: 'km',
      MICRO: 'µm',
    };
    return prefix ? (map[prefix] ?? prefix.toLowerCase()) : 'm';
  }
  const conv = partOf(entity, 'CONVERSION_BASED_UNIT');
  if (conv) {
    const name = stringOf(conv[0]).toLowerCase();
    if (name.startsWith('inch')) return 'in';
    if (name.startsWith('foot') || name.startsWith('feet')) return 'ft';
    return name || null;
  }
  return null;
}

/**
 * Colour of a styled item's presentation chain: the first fill-area or
 * rendering colour found (`#RRGGBB`), or `null`.
 */
function styleColour(entities: Map<number, StepEntity>, start: StepValue[]): string | null {
  const stack: number[] = [...refsOf(start)];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const e = entities.get(id);
    if (!e) continue;
    const rgb = partOf(e, 'COLOUR_RGB');
    if (rgb) {
      const [r, g, b] = [numberOf(rgb[1]), numberOf(rgb[2]), numberOf(rgb[3])];
      if (r !== null && g !== null && b !== null) return hexOf(r, g, b);
    }
    const predefined = partOf(e, 'DRAUGHTING_PRE_DEFINED_COLOUR');
    if (predefined) {
      const hex = PREDEFINED_COLOURS[stringOf(predefined[0]).toLowerCase()];
      if (hex) return hex;
    }
    for (const args of e.parts) {
      for (const value of args) {
        const r = refOf(value);
        if (r !== null) stack.push(r);
        else if (Array.isArray(value)) stack.push(...refsOf(value));
      }
    }
  }
  return null;
}

export interface ParseStructureOptions {
  onProgress?: (fraction: number) => void;
}

/** Reads the product structure of a STEP file's text. Throws `StepSyntaxError` for non-STEP input. */
export function parseStepStructure(
  text: string,
  options: ParseStructureOptions = {},
): StepStructure {
  const scan: ScanResult = scanStep(text, {
    wanted: STEP_STRUCTURE_TYPES,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  const { entities } = scan;

  const productName = new Map<number, string>();
  const pdfProduct = new Map<number, number>();
  const pdProduct = new Map<number, number>();
  const pdsDefinition = new Map<number, number>();
  const repPd = new Map<number, number>();
  const repLinks = new Map<number, number[]>();
  const parentOf = new Map<number, number[]>();
  const nauos: { id: number; relating: number; related: number; name: string }[] = [];
  const styled: { item: number; colour: string | null; overriding: boolean }[] = [];
  let lengthUnit: string | null = null;

  const link = (a: number, b: number) => {
    repLinks.set(a, [...(repLinks.get(a) ?? []), b]);
    repLinks.set(b, [...(repLinks.get(b) ?? []), a]);
  };
  const addParent = (child: number, parent: number) => {
    const list = parentOf.get(child);
    if (list) list.push(parent);
    else parentOf.set(child, [parent]);
  };

  for (const e of entities.values()) {
    const product = partOf(e, 'PRODUCT');
    if (product) {
      const name = stringOf(product[1]) || stringOf(product[0]);
      productName.set(e.id, name);
      continue;
    }
    const pdf = firstPart(e, PDF_TYPES);
    if (pdf) {
      const p = refOf(pdf[2]);
      if (p !== null) pdfProduct.set(e.id, p);
      continue;
    }
    const pd = firstPart(e, PD_TYPES);
    if (pd) {
      const f = refOf(pd[2]);
      if (f !== null) pdProduct.set(e.id, f);
      continue;
    }
    const pds = partOf(e, 'PRODUCT_DEFINITION_SHAPE');
    if (pds) {
      const d = refOf(pds[2]);
      if (d !== null) pdsDefinition.set(e.id, d);
      continue;
    }
    const nauo = partOf(e, 'NEXT_ASSEMBLY_USAGE_OCCURRENCE');
    if (nauo) {
      const relating = refOf(nauo[3]);
      const related = refOf(nauo[4]);
      if (relating !== null && related !== null) {
        nauos.push({ id: e.id, relating, related, name: stringOf(nauo[1]) || stringOf(nauo[0]) });
      }
      continue;
    }
    const styledItem = partOf(e, 'STYLED_ITEM') ?? partOf(e, 'OVER_RIDING_STYLED_ITEM');
    if (styledItem) {
      const item = refOf(styledItem[2]);
      if (item !== null) {
        styled.push({
          item,
          colour: styleColour(entities, styledItem[1] as StepValue[]),
          overriding: e.types.includes('OVER_RIDING_STYLED_ITEM'),
        });
      }
      continue;
    }
    if (e.types.includes('LENGTH_UNIT') && lengthUnit === null) {
      lengthUnit = lengthUnitOf(e);
      continue;
    }
    // Plain (untransformed) shape representation relationships tie the part's
    // SHAPE_REPRESENTATION to the representation holding its solid.
    const srr = [
      partOf(e, 'SHAPE_REPRESENTATION_RELATIONSHIP'),
      partOf(e, 'REPRESENTATION_RELATIONSHIP'),
    ].find((args) => args !== null && args.length >= 4);
    if (srr && !e.types.includes('REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION')) {
      const a = refOf(srr[2]);
      const b = refOf(srr[3]);
      if (a !== null && b !== null) link(a, b);
      continue;
    }
    const sdr = partOf(e, 'SHAPE_DEFINITION_REPRESENTATION');
    if (sdr) {
      const pdsId = refOf(sdr[0]);
      const rep = refOf(sdr[1]);
      if (pdsId !== null && rep !== null) repPd.set(rep, pdsId); // resolved to the PD below
      continue;
    }
    if (hasType(e, REPRESENTATION_TYPES)) {
      const args = firstPart(e, REPRESENTATION_TYPES)!;
      for (const item of refsOf(args[1])) addParent(item, e.id);
      continue;
    }
    if (hasType(e, CONTAINER_TYPES)) {
      for (const args of e.parts) {
        for (const value of args) {
          const r = refOf(value);
          if (r !== null) addParent(r, e.id);
          else for (const inner of refsOf(value)) addParent(inner, e.id);
        }
      }
    }
  }

  // Representation → product definition (through SDR → PDS, then plain SRR links).
  const repDefinition = new Map<number, number>();
  for (const [rep, pdsId] of repPd) {
    const pd = pdsDefinition.get(pdsId);
    if (pd !== undefined && pdProduct.has(pd)) repDefinition.set(rep, pd);
  }
  const queue = [...repDefinition.keys()];
  while (queue.length > 0) {
    const rep = queue.shift()!;
    const pd = repDefinition.get(rep)!;
    for (const other of repLinks.get(rep) ?? []) {
      if (repDefinition.has(other)) continue;
      repDefinition.set(other, pd);
      queue.push(other);
    }
  }

  /** The product definition an item (solid, face, shell) belongs to. */
  const definitionOfItem = (item: number): number | null => {
    const seen = new Set<number>();
    const stack = [item];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const pd = repDefinition.get(id);
      if (pd !== undefined) return pd;
      for (const p of parentOf.get(id) ?? []) stack.push(p);
      if (seen.size > 64) break;
    }
    return null;
  };

  // Colour per product definition: a solid/representation-level colour wins
  // over face colours; among face colours, the most frequent one.
  const solidColour = new Map<number, string>();
  const faceVotes = new Map<number, Map<string, number>>();
  for (const s of styled) {
    if (!s.colour) continue;
    const pd = definitionOfItem(s.item);
    if (pd === null) continue;
    const item = entities.get(s.item);
    // Faces are not parsed (not in STEP_STRUCTURE_TYPES): an unknown item is a face-level colour.
    const isBody =
      item !== undefined && (hasType(item, CONTAINER_TYPES) || hasType(item, REPRESENTATION_TYPES));
    if (isBody && !s.overriding) {
      if (!solidColour.has(pd)) solidColour.set(pd, s.colour);
    } else {
      const votes = faceVotes.get(pd) ?? new Map<string, number>();
      votes.set(s.colour, (votes.get(s.colour) ?? 0) + 1);
      faceVotes.set(pd, votes);
    }
  }
  const colourOf = (pd: number): string | null => {
    const solid = solidColour.get(pd);
    if (solid) return solid;
    const votes = faceVotes.get(pd);
    if (!votes) return null;
    let best: string | null = null;
    let count = 0;
    for (const [c, n] of votes) {
      if (n > count) {
        best = c;
        count = n;
      }
    }
    return best;
  };

  const nameOfPd = (pd: number): string => {
    const product = pdfProduct.get(pdProduct.get(pd) ?? -1);
    return (product !== undefined ? productName.get(product) : undefined) ?? '';
  };

  const childrenOf = new Map<number, typeof nauos>();
  const used = new Set<number>();
  for (const n of nauos) {
    if (!pdProduct.has(n.relating) || !pdProduct.has(n.related)) continue;
    const list = childrenOf.get(n.relating) ?? [];
    list.push(n);
    childrenOf.set(n.relating, list);
    used.add(n.related);
  }

  let partCount = 0;
  let instanceCount = 0;
  const partSeen = new Set<number>();
  const build = (pd: number, stack: Set<number>): StepProductNode => {
    const children: StepAssemblyInstance[] = [];
    for (const n of childrenOf.get(pd) ?? []) {
      if (stack.has(n.related)) continue; // a cyclic assembly (invalid file): cut the cycle
      stack.add(n.related);
      const node = build(n.related, stack);
      stack.delete(n.related);
      children.push({
        nauo: n.id,
        nauoIndex: scan.positions.get(n.id) ?? 0,
        instanceName: n.name,
        node,
      });
    }
    if (children.length === 0) {
      instanceCount += 1;
      if (!partSeen.has(pd)) {
        partSeen.add(pd);
        partCount += 1;
      }
    }
    return {
      pd,
      pdIndex: scan.positions.get(pd) ?? 0,
      name: nameOfPd(pd),
      color: colourOf(pd),
      children,
    };
  };
  const roots = [...pdProduct.keys()]
    .filter((pd) => !used.has(pd))
    .sort((a, b) => (scan.positions.get(a) ?? 0) - (scan.positions.get(b) ?? 0))
    .map((pd) => build(pd, new Set([pd])));

  const schema = scan.schemas.join(' ').toUpperCase();
  const protocol = /AP242|MANAGED_MODEL_BASED_3D_ENGINEERING|\b442\b/.test(schema)
    ? 'AP242'
    : /AUTOMOTIVE_DESIGN|\b214\b/.test(schema)
      ? 'AP214'
      : /CONFIG_CONTROL_DESIGN|\b203\b/.test(schema)
        ? 'AP203'
        : null;

  return {
    schemas: scan.schemas,
    protocol,
    lengthUnit,
    roots,
    partCount,
    instanceCount,
    recordCount: scan.recordCount,
    positions: scan.positions,
  };
}
