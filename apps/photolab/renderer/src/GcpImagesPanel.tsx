import type { EntityId, ProjectCameraImageRecord } from '@himmelcad/data';
import { Image as ImageIcon } from 'lucide-react';

import styles from './GcpImagesPanel.module.css';

export function GcpImagesPanel({
  pointName,
  images,
  selectedImageEntityId,
  onSelect,
}: {
  pointName: string;
  images: readonly ProjectCameraImageRecord[];
  selectedImageEntityId: EntityId | null;
  onSelect: (entityId: EntityId) => void;
}): JSX.Element {
  return (
    <section className={styles.root}>
      <div className={styles.summary}>
        <strong>{pointName}</strong>
        <span>
          {images.length} related image{images.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className={styles.list} aria-label={`Images containing ${pointName}`}>
        {images.map((image) => {
          const photo = image.metadata.inspectedPhoto;
          const active = image.entityId === selectedImageEntityId;
          return (
            <button
              key={image.entityId}
              type="button"
              className={active ? styles.active : undefined}
              onClick={() => onSelect(image.entityId)}
            >
              <span className={styles.preview}>
                <img
                  src={`hcad-image://project/${image.metadata.sourceObjectHash}?format=${photo.format}`}
                  alt=""
                />
                <ImageIcon size={15} aria-hidden="true" />
              </span>
              <span className={styles.text}>
                <strong>{fileName(photo.sourcePath)}</strong>
                <small>{image.metadata.statusTags.join(' · ') || 'Imported'}</small>
              </span>
            </button>
          );
        })}
      </div>
      <p>Use the Left and Right Arrow keys to step through this filtered set.</p>
    </section>
  );
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
