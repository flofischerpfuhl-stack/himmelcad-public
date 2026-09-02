import type { EntityId, ProjectCameraImageRecord } from '@himmelcad/data';
import { Check, HelpCircle, Image as ImageIcon, ImageOff } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent as ReactWheelEvent,
} from 'react';

import {
  calculateFilmstripPageSize,
  calculateFilmstripWindow,
  isFilmstripNavigationKey,
  navigateFilmstripSelection,
} from './imageFilmstripMath.js';
import styles from './ImageFilmstrip.module.css';

const ITEM_WIDTH_PIXELS = 132;
const ITEM_EXTENT_PIXELS = 140;
const OVERSCAN_ITEMS = 3;
const KEYBOARD_SHORTCUTS =
  'Left/Right Arrow: previous or next image · Home/End: first or last image · Page Up/Down: previous or next page';

export interface ImageFilmstripFilter {
  label: string;
  totalImageCount: number;
  onClear: () => void;
}

export interface ImageFilmstripProps {
  images: readonly ProjectCameraImageRecord[];
  selectedImageEntityId: EntityId | null;
  gcpObservationCounts: ReadonlyMap<EntityId, number> | null;
  filter: ImageFilmstripFilter | null;
  onSelect: (entityId: EntityId) => void;
}

export function ImageFilmstrip({
  images,
  selectedImageEntityId,
  gcpObservationCounts,
  filter,
  onSelect,
}: ImageFilmstripProps): JSX.Element | null {
  const rootRef = useRef<HTMLElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [viewportPixels, setViewportPixels] = useState(0);
  const [scrollOffsetPixels, setScrollOffsetPixels] = useState(0);
  const imageIds = useMemo(() => images.map((image) => image.entityId), [images]);
  const selectedIndex = selectedImageEntityId ? imageIds.indexOf(selectedImageEntityId) : -1;
  const virtualWindow = calculateFilmstripWindow(
    images.length,
    ITEM_EXTENT_PIXELS,
    viewportPixels,
    scrollOffsetPixels,
    OVERSCAN_ITEMS,
  );
  const visibleImages = images.slice(virtualWindow.startIndex, virtualWindow.endIndex);

  const updateViewport = useCallback((): void => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    setViewportPixels(scroller.clientWidth);
    setScrollOffsetPixels(scroller.scrollLeft);
  }, []);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [updateViewport]);

  useEffect(
    () => () => {
      if (animationFrameRef.current != null) cancelAnimationFrame(animationFrameRef.current);
    },
    [],
  );

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || selectedIndex < 0) return;
    const itemStart = selectedIndex * ITEM_EXTENT_PIXELS;
    const itemEnd = itemStart + ITEM_WIDTH_PIXELS;
    const viewportStart = scroller.scrollLeft;
    const viewportEnd = viewportStart + scroller.clientWidth;
    if (itemStart < viewportStart) scroller.scrollTo({ left: itemStart });
    else if (itemEnd > viewportEnd) {
      scroller.scrollTo({ left: Math.max(0, itemEnd - scroller.clientWidth) });
    }
  }, [images, selectedIndex]);

  useEffect(() => {
    const navigate = (event: KeyboardEvent): void => {
      if (
        !isFilmstripNavigationKey(event.key) ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        keyboardTargetOwnsNavigation(event.target) ||
        document.querySelector('[data-task-drag-handle]')
      ) {
        return;
      }
      const root = rootRef.current;
      const scroller = scrollerRef.current;
      if (
        !root ||
        !scroller ||
        root.getClientRects().length === 0 ||
        getComputedStyle(root).visibility === 'hidden' ||
        images.length === 0
      ) {
        return;
      }
      event.preventDefault();
      const nextId = navigateFilmstripSelection(
        imageIds,
        selectedImageEntityId,
        event.key,
        calculateFilmstripPageSize(scroller.clientWidth, ITEM_EXTENT_PIXELS),
      );
      if (nextId != null && nextId !== selectedImageEntityId) onSelect(nextId);
    };
    window.addEventListener('keydown', navigate);
    return () => window.removeEventListener('keydown', navigate);
  }, [imageIds, images.length, onSelect, selectedImageEntityId]);

  const handleScroll = (): void => {
    if (animationFrameRef.current != null) return;
    animationFrameRef.current = requestAnimationFrame(() => {
      animationFrameRef.current = null;
      const scroller = scrollerRef.current;
      if (scroller) setScrollOffsetPixels(scroller.scrollLeft);
    });
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    const scroller = event.currentTarget;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (delta === 0 || scroller.scrollWidth <= scroller.clientWidth) return;
    const previous = scroller.scrollLeft;
    scroller.scrollLeft += delta;
    if (scroller.scrollLeft !== previous) event.preventDefault();
  };

  if (images.length === 0 && !filter) return null;

  return (
    <section ref={rootRef} className={styles.root} aria-label="Image filmstrip">
      <div className={styles.header}>
        <span className={styles.count}>
          {images.length} image{images.length === 1 ? '' : 's'}
        </span>
        {filter && (
          <span className={styles.filterChip}>
            Filtered: {images.length} of {filter.totalImageCount}
            <span aria-hidden="true">·</span>
            <button type="button" onClick={filter.onClear}>
              Clear
            </button>
          </span>
        )}
        <span className={styles.shortcutHelp}>
          <button
            type="button"
            aria-label="Filmstrip keyboard shortcuts"
            aria-describedby="filmstrip-keyboard-shortcuts"
          >
            <HelpCircle size={13} aria-hidden="true" />
          </button>
          <span id="filmstrip-keyboard-shortcuts" role="tooltip">
            {KEYBOARD_SHORTCUTS}
          </span>
        </span>
      </div>
      {images.length === 0 ? (
        <div className={styles.empty}>No images contain {filter?.label ?? 'this GCP'}.</div>
      ) : (
        <div
          ref={scrollerRef}
          className={styles.scroller}
          onScroll={handleScroll}
          onWheel={handleWheel}
          aria-label="Project images"
        >
          <div className={styles.track} style={{ width: virtualWindow.totalPixels }}>
            <div
              className={styles.window}
              style={{ transform: `translateX(${virtualWindow.offsetPixels}px)` }}
            >
              {visibleImages.map((image) => (
                <FilmstripThumbnail
                  key={image.entityId}
                  image={image}
                  selected={image.entityId === selectedImageEntityId}
                  aligned={
                    image.metadata.statusTags.includes('aligned') &&
                    !image.metadata.statusTags.includes('alignmentStale')
                  }
                  gcpObservationCount={gcpObservationCounts?.get(image.entityId)}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function FilmstripThumbnail({
  image,
  selected,
  aligned,
  gcpObservationCount,
  onSelect,
}: {
  image: ProjectCameraImageRecord;
  selected: boolean;
  aligned: boolean;
  gcpObservationCount: number | undefined;
  onSelect: (entityId: EntityId) => void;
}): JSX.Element {
  const [previewState, setPreviewState] = useState<'loading' | 'ready' | 'error'>('loading');
  const photo = image.metadata.inspectedPhoto;
  const previewSource = `hcad-image://project/${image.metadata.sourceObjectHash}?format=${photo.format}&preview=1`;
  return (
    <button
      type="button"
      className={`${styles.thumbnail} ${selected ? styles.selected : ''}`}
      aria-pressed={selected}
      aria-label={`${image.name}, ${aligned ? 'aligned' : 'not aligned'}${gcpObservationCount == null ? '' : `, ${gcpObservationCount} GCP observations`}`}
      title={image.name}
      onClick={() => onSelect(image.entityId)}
    >
      <span className={styles.preview} data-state={previewState}>
        {previewState === 'error' ? (
          <span className={styles.previewError}>
            <ImageOff size={16} aria-hidden="true" />
            Preview unavailable
          </span>
        ) : (
          <>
            <ImageIcon className={styles.placeholderIcon} size={18} aria-hidden="true" />
            <img
              src={previewSource}
              alt=""
              loading="lazy"
              decoding="async"
              onLoad={() => setPreviewState('ready')}
              onError={() => setPreviewState('error')}
            />
          </>
        )}
        <span className={`${styles.badge} ${aligned ? styles.alignedBadge : ''}`}>
          {aligned && <Check size={9} aria-hidden="true" />}
          {aligned ? 'Aligned' : 'Not aligned'}
        </span>
        {gcpObservationCount != null && (
          <span
            className={`${styles.badge} ${styles.gcpBadge}`}
            title={`${gcpObservationCount} GCP observation${gcpObservationCount === 1 ? '' : 's'}`}
          >
            {gcpObservationCount} GCP
          </span>
        )}
      </span>
      <span className={styles.name}>{image.name}</span>
    </button>
  );
}

function keyboardTargetOwnsNavigation(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      'input, select, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"], [role="listbox"], [role="spinbutton"]',
    ) !== null
  );
}
