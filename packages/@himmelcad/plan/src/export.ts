import { type PlanDocument, type PlanElement, type PlanSheet } from './document.js';
import { PLAN_SCENE_UNITS_PER_MM, resolvePaperMm } from './paper.js';

const POINTS_PER_MM = 72 / 25.4;

export interface PlanFidelityWarning {
  sheetId: string;
  elementId?: string;
  target: 'svg' | 'pdf' | 'png';
  code:
    | 'unsupportedElement'
    | 'missingImage'
    | 'fontSubstituted'
    | 'browserRasterization'
    | 'styleSimplified';
  message: string;
}

export interface PlanFidelityTargetReport {
  format: 'svg' | 'pdf' | 'png';
  deterministic: boolean;
  geometry: 'vector' | 'raster';
  limitations: readonly string[];
}

export interface PlanFidelityReport {
  schemaVersion: 1;
  documentHash: string;
  sheetCount: number;
  vectorElementCount: number;
  rasterElementCount: number;
  viewportCount: number;
  targets: readonly PlanFidelityTargetReport[];
  warnings: readonly PlanFidelityWarning[];
}

export interface PlanSvgExport {
  sheetId: string;
  fileName: string;
  svg: string;
}

export interface PlanExportBundle {
  sheets: readonly PlanSvgExport[];
  pdf: Uint8Array;
  report: PlanFidelityReport;
}

export function exportPlanDeterministically(document: PlanDocument): PlanExportBundle {
  const warnings: PlanFidelityWarning[] = [];
  let vectorElementCount = 0;
  let rasterElementCount = 0;
  const sheets = document.sheets.map((sheet, index) => {
    const result = sheetSvg(sheet, warnings);
    vectorElementCount += result.vectorCount;
    rasterElementCount += result.rasterCount;
    return {
      sheetId: sheet.id,
      fileName: `${safeName(document.name)}-${String(index + 1).padStart(2, '0')}.svg`,
      svg: result.svg,
    };
  });
  const pdf = buildPlanPdf(document, warnings);
  for (const sheet of document.sheets) {
    warnings.push({
      sheetId: sheet.id,
      target: 'png',
      code: 'browserRasterization',
      message:
        'PNG is rasterized from SVG by the browser canvas; pixels can vary by browser and OS.',
    });
  }
  return {
    sheets,
    pdf,
    report: {
      schemaVersion: 1,
      documentHash: document.contentHash,
      sheetCount: document.sheets.length,
      vectorElementCount,
      rasterElementCount,
      viewportCount: document.sheets.reduce((sum, sheet) => sum + sheet.viewports.length, 0),
      targets: fidelityTargets(),
      warnings,
    },
  };
}

export async function rasterizePlanSvg(svg: string, scale = 2): Promise<Blob> {
  if (typeof document === 'undefined') throw new Error('PNG export needs a browser canvas.');
  const match = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (!match) throw new Error('SVG has no physical viewBox.');
  const width = Math.max(1, Math.round(Number(match[1]) * scale * (96 / 25.4)));
  const height = Math.max(1, Math.round(Number(match[2]) * scale * (96 / 25.4)));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable.');
  const image = new Image();
  const source = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('SVG could not be rasterized.'));
      image.src = source;
    });
    context.drawImage(image, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed.'))),
        'image/png',
      );
    });
  } finally {
    URL.revokeObjectURL(source);
  }
}

function sheetSvg(
  sheet: PlanSheet,
  warnings: PlanFidelityWarning[],
): { svg: string; vectorCount: number; rasterCount: number } {
  const paper = resolvePaperMm(sheet.paper);
  const body: string[] = [];
  let vectorCount = 0;
  let rasterCount = 0;
  for (const element of sheet.scene.elements) {
    if (element.isDeleted === true) continue;
    const rendered = elementSvg(element, sheet.id, warnings);
    if (!rendered) continue;
    body.push(rendered.svg);
    if (rendered.raster) rasterCount += 1;
    else vectorCount += 1;
  }
  const margin = sheet.paper.marginMm;
  return {
    svg: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<svg xmlns="http://www.w3.org/2000/svg" width="${n(paper.widthMm)}mm" height="${n(paper.heightMm)}mm" viewBox="0 0 ${n(paper.widthMm)} ${n(paper.heightMm)}">`,
      '<rect width="100%" height="100%" fill="white"/>',
      `<rect x="${n(margin)}" y="${n(margin)}" width="${n(paper.widthMm - margin * 2)}" height="${n(paper.heightMm - margin * 2)}" fill="none" stroke="#d5d8dc" stroke-width="0.15"/>`,
      ...body,
      '</svg>',
    ].join('\n'),
    vectorCount,
    rasterCount,
  };
}

function elementSvg(
  element: PlanElement,
  sheetId: string,
  warnings: PlanFidelityWarning[],
): { svg: string; raster: boolean } | null {
  const type = stringValue(element.type);
  const x = mm(element.x);
  const y = mm(element.y);
  const width = mm(element.width);
  const height = mm(element.height);
  const stroke = color(element.strokeColor, '#202124');
  const fill = color(element.backgroundColor, 'none');
  const strokeWidth = Math.max(0.1, numberValue(element.strokeWidth, 1) * 0.18);
  const opacity = Math.max(0, Math.min(1, numberValue(element.opacity, 100) / 100));
  const common = `stroke="${escapeXml(stroke)}" stroke-width="${n(strokeWidth)}" fill="${escapeXml(fill)}" opacity="${n(opacity)}"`;
  if (type === 'rectangle') {
    return {
      svg: `<rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" ${common}/>`,
      raster: false,
    };
  }
  if (type === 'ellipse') {
    return {
      svg: `<ellipse cx="${n(x + width / 2)}" cy="${n(y + height / 2)}" rx="${n(width / 2)}" ry="${n(height / 2)}" ${common}/>`,
      raster: false,
    };
  }
  if (type === 'diamond') {
    return {
      svg: `<path d="M ${n(x + width / 2)} ${n(y)} L ${n(x + width)} ${n(y + height / 2)} L ${n(x + width / 2)} ${n(y + height)} L ${n(x)} ${n(y + height / 2)} Z" ${common}/>`,
      raster: false,
    };
  }
  if (type === 'line' || type === 'arrow' || type === 'freedraw') {
    const points = arrayPoints(element.points);
    if (points.length < 2) return null;
    const commands = points.map(
      ([px, py], index) =>
        `${index === 0 ? 'M' : 'L'} ${n(x + px / PLAN_SCENE_UNITS_PER_MM)} ${n(y + py / PLAN_SCENE_UNITS_PER_MM)}`,
    );
    return { svg: `<path d="${commands.join(' ')}" ${common} fill="none"/>`, raster: false };
  }
  if (type === 'text') {
    const text = stringValue(element.text);
    const size = Math.max(1.5, mm(element.fontSize));
    const lines = text.split('\n');
    warnings.push({
      sheetId,
      elementId: stringValue(element.id),
      target: 'svg',
      code: 'fontSubstituted',
      message: 'SVG text uses the Arial/sans-serif fallback instead of Excalidraw font metrics.',
    });
    return {
      svg: `<text x="${n(x)}" y="${n(y + size)}" fill="${escapeXml(stroke)}" font-family="Arial, sans-serif" font-size="${n(size)}">${lines.map((line, index) => `<tspan x="${n(x)}" dy="${index === 0 ? 0 : n(size * 1.25)}">${escapeXml(line)}</tspan>`).join('')}</text>`,
      raster: false,
    };
  }
  if (type === 'image') {
    warnings.push({
      sheetId,
      elementId: stringValue(element.id),
      target: 'svg',
      code: 'missingImage',
      message: `Image ${stringValue(element.id)} is represented by its paper bounds.`,
    });
    return {
      svg: `<rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" fill="#eceff1" stroke="#7b8790" stroke-width="0.2"/>`,
      raster: true,
    };
  }
  warnings.push({
    sheetId,
    elementId: stringValue(element.id),
    target: 'svg',
    code: 'unsupportedElement',
    message: `Element type “${type || 'unknown'}” was omitted.`,
  });
  return null;
}

function buildPlanPdf(document: PlanDocument, warnings: PlanFidelityWarning[]): Uint8Array {
  const pageCount = document.sheets.length;
  const fontObject = 3 + pageCount * 2;
  const objects = new Map<number, string>();
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const pageRefs = document.sheets.map((_, index) => `${3 + index * 2} 0 R`).join(' ');
  objects.set(2, `<< /Type /Pages /Count ${pageCount} /Kids [${pageRefs}] >>`);
  document.sheets.forEach((sheet, index) => {
    const pageObject = 3 + index * 2;
    const contentObject = pageObject + 1;
    const paper = resolvePaperMm(sheet.paper);
    const stream = pdfSheetContent(sheet, warnings);
    objects.set(
      pageObject,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(paper.widthMm * POINTS_PER_MM)} ${n(paper.heightMm * POINTS_PER_MM)}] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObject} 0 R >>`,
    );
    objects.set(
      contentObject,
      `<< /Length ${asciiLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  });
  objects.set(fontObject, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.4\n%HCAD\n';
  const offsets: number[] = [0];
  for (let id = 1; id <= fontObject; id += 1) {
    offsets[id] = asciiLength(pdf);
    pdf += `${id} 0 obj\n${objects.get(id)!}\nendobj\n`;
  }
  const xref = asciiLength(pdf);
  pdf += `xref\n0 ${fontObject + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= fontObject; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${fontObject + 1} /Root 1 0 R /ID [<${pdfId(document.contentHash)}> <${pdfId(document.contentHash)}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

function pdfSheetContent(sheet: PlanSheet, warnings: PlanFidelityWarning[]): string {
  const paper = resolvePaperMm(sheet.paper);
  const commands = [
    'q',
    '1 1 1 rg',
    `0 0 ${n(paper.widthMm * POINTS_PER_MM)} ${n(paper.heightMm * POINTS_PER_MM)} re f`,
    '0 0 0 RG',
  ];
  for (const element of sheet.scene.elements) {
    if (element.isDeleted === true) continue;
    const type = stringValue(element.type);
    const x = mm(element.x) * POINTS_PER_MM;
    const yMm = mm(element.y);
    const width = mm(element.width) * POINTS_PER_MM;
    const heightMm = mm(element.height);
    const y = (paper.heightMm - yMm - heightMm) * POINTS_PER_MM;
    const height = heightMm * POINTS_PER_MM;
    commands.push(`${n(Math.max(0.1, numberValue(element.strokeWidth, 1) * 0.5))} w`);
    if (type === 'rectangle' || type === 'image') {
      if (type === 'image') {
        warnings.push({
          sheetId: sheet.id,
          elementId: stringValue(element.id),
          target: 'pdf',
          code: 'missingImage',
          message: `PDF represents image ${stringValue(element.id)} by its paper bounds.`,
        });
      }
      commands.push(`${n(x)} ${n(y)} ${n(width)} ${n(height)} re S`);
      continue;
    }
    if (type === 'line' || type === 'arrow' || type === 'freedraw') {
      const points = arrayPoints(element.points);
      if (points.length < 2) continue;
      const [firstX, firstY] = points[0]!;
      commands.push(
        `${n(x + (firstX / PLAN_SCENE_UNITS_PER_MM) * POINTS_PER_MM)} ${n((paper.heightMm - yMm - firstY / PLAN_SCENE_UNITS_PER_MM) * POINTS_PER_MM)} m`,
      );
      for (const [px, py] of points.slice(1)) {
        commands.push(
          `${n(x + (px / PLAN_SCENE_UNITS_PER_MM) * POINTS_PER_MM)} ${n((paper.heightMm - yMm - py / PLAN_SCENE_UNITS_PER_MM) * POINTS_PER_MM)} l`,
        );
      }
      commands.push('S');
      continue;
    }
    if (type === 'text') {
      const size = Math.max(4, mm(element.fontSize) * POINTS_PER_MM);
      const text = pdfText(stringValue(element.text).replace(/\n/g, ' · '));
      warnings.push({
        sheetId: sheet.id,
        elementId: stringValue(element.id),
        target: 'pdf',
        code: 'fontSubstituted',
        message: 'PDF text uses built-in Helvetica and flattens line breaks.',
      });
      commands.push(`BT /F1 ${n(size)} Tf ${n(x)} ${n(y + height - size)} Td (${text}) Tj ET`);
      continue;
    }
    warnings.push({
      sheetId: sheet.id,
      elementId: stringValue(element.id),
      target: 'pdf',
      code: 'unsupportedElement',
      message: `PDF omitted element type “${type || 'unknown'}”; use SVG/PNG for this element.`,
    });
  }
  commands.push('Q');
  return commands.join('\n');
}

function fidelityTargets(): readonly PlanFidelityTargetReport[] {
  return [
    {
      format: 'svg',
      deterministic: true,
      geometry: 'vector',
      limitations: [
        'Roughness, rotations, arrowheads, bindings and advanced Excalidraw fill styles are simplified.',
        'Image binaries are not embedded yet; image elements are represented by paper bounds.',
        'Text uses browser sans-serif fallback metrics.',
      ],
    },
    {
      format: 'pdf',
      deterministic: true,
      geometry: 'vector',
      limitations: [
        'Ellipse and diamond elements are omitted and reported per element.',
        'Colors, fills, rotations, arrowheads, bindings and advanced Excalidraw styles are simplified.',
        'Image binaries are not embedded yet; text uses built-in Helvetica and single-line layout.',
      ],
    },
    {
      format: 'png',
      deterministic: false,
      geometry: 'raster',
      limitations: [
        'PNG inherits SVG fidelity and is rasterized by the active browser canvas.',
        'Pixel output can vary with browser, operating system, fonts and device scale.',
      ],
    },
  ];
}

function arrayPoints(value: unknown): readonly (readonly [number, number])[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((point) =>
    Array.isArray(point) && typeof point[0] === 'number' && typeof point[1] === 'number'
      ? [[point[0], point[1]] as const]
      : [],
  );
}

function mm(value: unknown): number {
  return numberValue(value, 0) / PLAN_SCENE_UNITS_PER_MM;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function color(value: unknown, fallback: string): string {
  const candidate = stringValue(value);
  return candidate === 'transparent' ? 'none' : candidate || fallback;
}

function n(value: number): string {
  return Number(value.toFixed(4)).toString();
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function pdfText(value: string): string {
  return value
    .replace(/[^\x20-\x7e]/g, '?')
    .replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)');
}

function pdfId(hash: string): string {
  return Array.from(new TextEncoder().encode(hash))
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .padEnd(32, '0');
}

function asciiLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function safeName(value: string): string {
  const name = value
    .trim()
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  return name || 'plan';
}
