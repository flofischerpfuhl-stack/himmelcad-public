/// <reference lib="webworker" />

const STRIDE = 44;
const SH_C0 = 0.28209479177387814;
const HEADER_LIMIT = 1024 * 1024;

interface RequestMessage {
  source: ArrayBuffer;
  maximumSplats: number;
}

interface Property {
  name: string;
  type: ScalarType;
}

type ScalarType = 'char' | 'uchar' | 'short' | 'ushort' | 'int' | 'uint' | 'float' | 'double';

interface PlyHeader {
  format: 'ascii' | 'binary_little_endian';
  vertexCount: number;
  properties: Property[];
  bodyOffset: number;
}

self.onmessage = (event: MessageEvent<RequestMessage>) => {
  try {
    const result = decodePly(event.data.source, event.data.maximumSplats);
    self.postMessage(result, { transfer: [result.packed] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};

function decodePly(source: ArrayBuffer, maximumSplats: number) {
  const header = parseHeader(source);
  if (header.vertexCount <= 0 || header.vertexCount > maximumSplats) {
    throw new Error(
      `Monolithic PLY contains ${header.vertexCount} splats; limit is ${maximumSplats}. Prepare a tiled splat manifest.`,
    );
  }
  const packed = new ArrayBuffer(header.vertexCount * STRIDE);
  const output = new DataView(packed);
  const propertyIndex = new Map(header.properties.map((property, index) => [property.name, index]));
  requireProperties(propertyIndex, ['x', 'y', 'z']);
  const min: [number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const max: [number, number, number] = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  let maximumScale = 0;
  if (header.format === 'binary_little_endian') {
    const input = new DataView(source);
    let cursor = header.bodyOffset;
    for (let vertex = 0; vertex < header.vertexCount; vertex += 1) {
      const values = new Float64Array(header.properties.length);
      for (let property = 0; property < header.properties.length; property += 1) {
        const type = header.properties[property]?.type;
        if (!type) throw new Error('Malformed PLY property table');
        values[property] = readScalar(input, cursor, type);
        cursor += scalarBytes(type);
      }
      maximumScale = Math.max(
        maximumScale,
        writeSplat(output, vertex, values, propertyIndex, min, max),
      );
    }
    if (cursor > source.byteLength) throw new Error('PLY vertex payload is truncated');
  } else {
    const text = new TextDecoder().decode(new Uint8Array(source, header.bodyOffset));
    const lines = text.split(/\r?\n/);
    if (lines.length < header.vertexCount) throw new Error('ASCII PLY vertex payload is truncated');
    for (let vertex = 0; vertex < header.vertexCount; vertex += 1) {
      const line = lines[vertex];
      if (line === undefined) throw new Error('ASCII PLY vertex row is missing');
      const fields = line.trim().split(/\s+/);
      if (fields.length < header.properties.length)
        throw new Error(`ASCII PLY row ${vertex} is short`);
      const values = new Float64Array(header.properties.length);
      for (let property = 0; property < header.properties.length; property += 1) {
        const parsed = Number(fields[property]);
        if (!Number.isFinite(parsed)) throw new Error(`ASCII PLY row ${vertex} has invalid values`);
        values[property] = parsed;
      }
      maximumScale = Math.max(
        maximumScale,
        writeSplat(output, vertex, values, propertyIndex, min, max),
      );
    }
  }
  const origin: [number, number, number] = [
    (min[0] + max[0]) * 0.5,
    (min[1] + max[1]) * 0.5,
    (min[2] + max[2]) * 0.5,
  ];
  for (let vertex = 0; vertex < header.vertexCount; vertex += 1) {
    const base = vertex * STRIDE;
    output.setFloat32(base, output.getFloat32(base, true) - origin[0], true);
    output.setFloat32(base + 4, output.getFloat32(base + 4, true) - origin[1], true);
    output.setFloat32(base + 8, output.getFloat32(base + 8, true) - origin[2], true);
  }
  return {
    packed,
    splatCount: header.vertexCount,
    origin,
    bounds: {
      min: { x: min[0], y: min[1], z: min[2] },
      max: { x: max[0], y: max[1], z: max[2] },
    },
    geometricError: Math.max(0.001, maximumScale * 2),
  };
}

function writeSplat(
  output: DataView,
  vertex: number,
  values: Float64Array,
  properties: Map<string, number>,
  min: [number, number, number],
  max: [number, number, number],
): number {
  const x = value(values, properties, 'x');
  const y = value(values, properties, 'y');
  const z = value(values, properties, 'z');
  if (![x, y, z].every(Number.isFinite)) throw new Error('PLY contains non-finite positions');
  min[0] = Math.min(min[0] ?? x, x);
  min[1] = Math.min(min[1] ?? y, y);
  min[2] = Math.min(min[2] ?? z, z);
  max[0] = Math.max(max[0] ?? x, x);
  max[1] = Math.max(max[1] ?? y, y);
  max[2] = Math.max(max[2] ?? z, z);
  const base = vertex * STRIDE;
  output.setFloat32(base, x, true);
  output.setFloat32(base + 4, y, true);
  output.setFloat32(base + 8, z, true);
  const scales = [
    scaleValue(values, properties, 'scale_0', 'scale_x'),
    scaleValue(values, properties, 'scale_1', 'scale_y'),
    scaleValue(values, properties, 'scale_2', 'scale_z'),
  ];
  for (let axis = 0; axis < 3; axis += 1)
    output.setFloat32(base + 12 + axis * 4, scales[axis] ?? 0.01, true);
  const quaternion = readQuaternion(values, properties);
  for (let component = 0; component < 4; component += 1) {
    output.setFloat32(base + 24 + component * 4, quaternion[component] ?? 0, true);
  }
  const color = readColor(values, properties);
  for (let component = 0; component < 4; component += 1) {
    output.setUint8(base + 40 + component, color[component] ?? 255);
  }
  return Math.max(...scales);
}

function scaleValue(
  values: Float64Array,
  properties: Map<string, number>,
  logarithmicName: string,
  linearName: string,
): number {
  if (properties.has(logarithmicName)) {
    return Math.max(1e-6, Math.min(1e6, Math.exp(value(values, properties, logarithmicName))));
  }
  if (properties.has(linearName)) return Math.max(1e-6, value(values, properties, linearName));
  return 0.01;
}

function readQuaternion(values: Float64Array, properties: Map<string, number>): number[] {
  const source = properties.has('rot_0')
    ? [
        value(values, properties, 'rot_1', 0),
        value(values, properties, 'rot_2', 0),
        value(values, properties, 'rot_3', 0),
        value(values, properties, 'rot_0', 1),
      ]
    : [
        value(values, properties, 'qx', 0),
        value(values, properties, 'qy', 0),
        value(values, properties, 'qz', 0),
        value(values, properties, 'qw', 1),
      ];
  const length = Math.hypot(...source);
  return length > 1e-8 ? source.map((component) => component / length) : [0, 0, 0, 1];
}

function readColor(values: Float64Array, properties: Map<string, number>): number[] {
  const rgb = properties.has('f_dc_0')
    ? [
        0.5 + SH_C0 * value(values, properties, 'f_dc_0'),
        0.5 + SH_C0 * value(values, properties, 'f_dc_1'),
        0.5 + SH_C0 * value(values, properties, 'f_dc_2'),
      ].map((component) => Math.round(clamp(component, 0, 1) * 255))
    : [
        byteColor(values, properties, 'red'),
        byteColor(values, properties, 'green'),
        byteColor(values, properties, 'blue'),
      ];
  const opacity = properties.has('opacity')
    ? Math.round(sigmoid(value(values, properties, 'opacity')) * 255)
    : properties.has('alpha')
      ? byteColor(values, properties, 'alpha')
      : 255;
  return [...rgb, opacity];
}

function byteColor(values: Float64Array, properties: Map<string, number>, name: string): number {
  return Math.round(clamp(value(values, properties, name, 255), 0, 255));
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-clamp(value, -20, 20)));
}

function value(
  values: Float64Array,
  properties: Map<string, number>,
  name: string,
  fallback = Number.NaN,
): number {
  const index = properties.get(name);
  return index === undefined ? fallback : (values[index] ?? fallback);
}

function parseHeader(source: ArrayBuffer): PlyHeader {
  const headerBytes = new Uint8Array(source, 0, Math.min(source.byteLength, HEADER_LIMIT));
  const headerText = new TextDecoder('ascii').decode(headerBytes);
  const match = /end_header\r?\n/.exec(headerText);
  if (!match || match.index === undefined) throw new Error('PLY header is missing or too large');
  const bodyOffset = match.index + match[0].length;
  const lines = headerText.slice(0, match.index).split(/\r?\n/);
  if (lines[0]?.trim() !== 'ply') throw new Error('Not a PLY file');
  let format: PlyHeader['format'] | null = null;
  let vertexCount = 0;
  let inVertices = false;
  const properties: Property[] = [];
  for (const line of lines.slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === 'format') {
      if (fields[1] === 'ascii' || fields[1] === 'binary_little_endian') format = fields[1];
      else throw new Error(`Unsupported PLY format: ${fields[1] ?? ''}`);
    } else if (fields[0] === 'element') {
      inVertices = fields[1] === 'vertex';
      if (inVertices) vertexCount = Number(fields[2]);
    } else if (fields[0] === 'property' && inVertices) {
      if (fields[1] === 'list') throw new Error('List properties are not valid vertex splat data');
      if (!isScalarType(fields[1]) || !fields[2])
        throw new Error(`Unsupported PLY property: ${line}`);
      properties.push({ type: fields[1], name: fields[2] });
    }
  }
  if (!format || !Number.isSafeInteger(vertexCount)) throw new Error('Malformed PLY header');
  return { format, vertexCount, properties, bodyOffset };
}

function requireProperties(properties: Map<string, number>, names: string[]): void {
  for (const name of names) if (!properties.has(name)) throw new Error(`PLY is missing '${name}'`);
}

function isScalarType(value: string | undefined): value is ScalarType {
  return ['char', 'uchar', 'short', 'ushort', 'int', 'uint', 'float', 'double'].includes(
    value ?? '',
  );
}

function scalarBytes(type: ScalarType): number {
  if (type === 'char' || type === 'uchar') return 1;
  if (type === 'short' || type === 'ushort') return 2;
  if (type === 'double') return 8;
  return 4;
}

function readScalar(view: DataView, offset: number, type: ScalarType): number {
  if (offset + scalarBytes(type) > view.byteLength) throw new Error('PLY payload is truncated');
  switch (type) {
    case 'char':
      return view.getInt8(offset);
    case 'uchar':
      return view.getUint8(offset);
    case 'short':
      return view.getInt16(offset, true);
    case 'ushort':
      return view.getUint16(offset, true);
    case 'int':
      return view.getInt32(offset, true);
    case 'uint':
      return view.getUint32(offset, true);
    case 'float':
      return view.getFloat32(offset, true);
    case 'double':
      return view.getFloat64(offset, true);
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export {};
