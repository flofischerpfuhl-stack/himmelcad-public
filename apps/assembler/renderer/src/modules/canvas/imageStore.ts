/**
 * The project's pictures for reference images (`referenceImage` steps,
 * `referenceImage.ts`): bytes by content id, kept for the whole session so
 * undoing the deletion of an image step finds its picture again. Saving
 * writes only the pictures some step still uses, as the `images` file field
 * (base64, after the reference meshes); Open/New replace the store.
 *
 * In the desktop app each picture is also decoded once into an
 * `ImageBitmap` for the viewport (`viewportImages.ts`); headless agents only
 * store the bytes.
 */
import { create } from 'zustand';

import {
  registerProjectFileField,
  type FileFieldHelpers,
} from '../../foundation/document/format.js';
import type { ProjectSection } from '../../foundation/document/projectSections.js';
import { useAssemblerStore } from '../../foundation/commands/store.js';
import { IMAGE_MIME_TYPES, MAX_IMAGE_BYTES, sniffImage, type ImageMime } from './referenceImage.js';

export interface StoredImage {
  id: string;
  mime: ImageMime;
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** One picture in the `.hcasm` file. */
export interface ProjectImageRecord {
  id: string;
  mime: ImageMime;
  /** Base64 of the file bytes. */
  data: string;
}

declare module '../../foundation/document/format.js' {
  interface ProjectFileFields {
    /** Pictures of the reference-image steps (Block 8; additive, written only when used). */
    images?: ProjectImageRecord[];
  }
}

interface ImageStoreState {
  images: ReadonlyMap<string, StoredImage>;
  /** Adds a picture (deduplicated by content); throws with a user-facing reason. */
  add(bytes: Uint8Array): Promise<StoredImage>;
  /** Replaces every picture (Open/New). */
  replaceAll(images: readonly StoredImage[]): void;
}

export const useImageStore = create<ImageStoreState>((set, get) => ({
  images: new Map(),
  add: async (bytes) => {
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(
        `The picture is too large (${Math.round(bytes.byteLength / 1048576)} MB; at most ${MAX_IMAGE_BYTES / 1048576} MB).`,
      );
    }
    const sniffed = sniffImage(bytes);
    if (!sniffed) throw new Error('Only PNG and JPEG pictures can be inserted.');
    const id = await contentId(bytes);
    const known = get().images.get(id);
    if (known) return known;
    const image: StoredImage = { id, bytes: bytes.slice(), ...sniffed };
    set((s) => ({ images: new Map(s.images).set(id, image) }));
    return image;
  },
  replaceAll: (images) => set({ images: new Map(images.map((i) => [i.id, i])) }),
}));

/** `img-` + the first 16 hex digits of the SHA-256 of the bytes (same picture, same id). */
async function contentId(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes.slice()));
  return `img-${[...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// ---- file field ------------------------------------------------------------------------

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function validateImages(raw: unknown, h: FileFieldHelpers): ProjectImageRecord[] {
  if (!Array.isArray(raw)) h.fail('images', 'expected an array');
  const ids = new Set<string>();
  return raw.map((r: unknown, i) => {
    const path = `images[${i}]`;
    if (!h.isRecord(r)) h.fail(path, 'expected an object');
    if (!h.isString(r.id) || r.id === '') h.fail(`${path}.id`, 'expected a non-empty string');
    if (ids.has(r.id)) h.fail(`${path}.id`, `duplicate image id "${r.id}"`);
    ids.add(r.id);
    if (!(IMAGE_MIME_TYPES as readonly unknown[]).includes(r.mime)) {
      h.fail(`${path}.mime`, 'expected "image/png" or "image/jpeg"');
    }
    if (!h.isString(r.data) || r.data === '' || !/^[A-Za-z0-9+/]+=*$/.test(r.data)) {
      h.fail(`${path}.data`, 'expected base64 data');
    }
    return { id: r.id, mime: r.mime as ImageMime, data: r.data };
  });
}

// After the reference meshes, before `viewState`.
registerProjectFileField({
  key: 'images',
  module: 'canvas',
  order: 110,
  validate: validateImages,
  include: (images) => images.length > 0,
});

/** The pictures some reference-image step of `features` uses. */
export function usedImageIds(
  features: readonly { kind: string; imageId?: unknown }[],
): Set<string> {
  const ids = new Set<string>();
  for (const f of features) {
    if (f.kind === 'referenceImage' && typeof f.imageId === 'string') ids.add(f.imageId);
  }
  return ids;
}

/** Records of the used pictures (Save). */
export function imageRecords(
  images: ReadonlyMap<string, StoredImage>,
  used: ReadonlySet<string>,
): ProjectImageRecord[] {
  return [...images.values()]
    .filter((i) => used.has(i.id))
    .map((i) => ({ id: i.id, mime: i.mime, data: toBase64(i.bytes) }));
}

/** Pictures of an opened file (malformed ones are skipped: their steps show "picture missing"). */
export function imagesFromRecords(records: readonly ProjectImageRecord[]): StoredImage[] {
  const out: StoredImage[] = [];
  for (const r of records) {
    try {
      const bytes = fromBase64(r.data);
      const sniffed = sniffImage(bytes);
      if (sniffed) out.push({ id: r.id, bytes, ...sniffed });
    } catch {
      // Damaged picture data: the step keeps its placement, shown as missing.
    }
  }
  return out;
}

export const IMAGES_PROJECT_SECTION: ProjectSection = {
  id: 'canvas.images',
  order: 140,
  save: () => {
    const used = usedImageIds(useAssemblerStore.getState().features);
    const records = imageRecords(useImageStore.getState().images, used);
    return records.length > 0 ? { fields: { images: records } } : {};
  },
  load: (project) => useImageStore.getState().replaceAll(imagesFromRecords(project?.images ?? [])),
};
