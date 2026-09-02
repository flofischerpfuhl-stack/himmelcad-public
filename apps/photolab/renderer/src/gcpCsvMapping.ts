export interface GcpColumnSelection {
  name: string;
  east: string;
  north: string;
  height: string;
  horizontalStddev: string;
  eastStddev: string;
  northStddev: string;
  heightStddev: string;
  code: string;
}

export interface GcpUncertaintyOrigin {
  eastUsedDefault: boolean;
  northUsedDefault: boolean;
  heightUsedDefault: boolean;
}

const ALIASES: Record<keyof GcpColumnSelection, readonly string[]> = {
  name: ['name', 'point', 'pointname', 'id', 'pointid', 'gcp', 'gcpid', 'nr', 'number'],
  east: ['east', 'easting', 'e', 'x', 'coordx', 'rechtswert', 'ost'],
  north: ['north', 'northing', 'n', 'y', 'coordy', 'hochwert', 'nord'],
  height: ['height', 'elevation', 'elev', 'z', 'h', 'hohe', 'hoehe'],
  horizontalStddev: [
    'sigma',
    'std',
    'stddev',
    'sh',
    'sigmah',
    'stdh',
    'sigmaxy',
    'stdxy',
    'dxy',
    'horizontalaccuracy',
    'horizontalstddev',
  ],
  eastStddev: ['se', 'sigmae', 'stde', 'de', 'eaccuracy', 'eastaccuracy', 'eaststddev'],
  northStddev: ['sn', 'sigman', 'stdn', 'dn', 'naccuracy', 'northaccuracy', 'northstddev'],
  heightStddev: [
    'sv',
    'sigmav',
    'stdv',
    'sz',
    'sigmaz',
    'stdz',
    'dh',
    'heightaccuracy',
    'verticalaccuracy',
    'heightstddev',
    'verticalstddev',
  ],
  code: ['code', 'pointcode', 'desc', 'description', 'remark', 'remarks'],
};

export function emptyGcpColumnSelection(): GcpColumnSelection {
  return {
    name: '0',
    east: '1',
    north: '2',
    height: '3',
    horizontalStddev: '',
    eastStddev: '',
    northStddev: '',
    heightStddev: '',
    code: '',
  };
}

/** Detects common survey headers without changing the exact header used by the mapping. */
export function detectGcpColumns(headers: readonly string[]): Partial<GcpColumnSelection> {
  const normalized = headers.map(normalizeHeader);
  const detected: Partial<GcpColumnSelection> = {};
  for (const key of Object.keys(ALIASES) as Array<keyof GcpColumnSelection>) {
    const index = normalized.findIndex((header) => ALIASES[key].includes(header));
    if (index >= 0) detected[key] = headers[index]!;
  }

  if (detected.eastStddev || detected.northStddev) {
    delete detected.horizontalStddev;
  }
  return detected;
}

export function uncertaintyOriginLabel(origin: GcpUncertaintyOrigin | undefined): string {
  if (!origin) return 'default σ';
  const defaults = [origin.eastUsedDefault, origin.northUsedDefault, origin.heightUsedDefault];
  if (defaults.every(Boolean)) return 'default σ';
  if (defaults.every((value) => !value)) return 'parsed σ';
  return 'mixed σ';
}

function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLocaleLowerCase('en-US')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/σ/g, 'sigma')
    .replace(/\u00df/g, 'ss')
    .replace(/[^a-z0-9]/g, '');
}
