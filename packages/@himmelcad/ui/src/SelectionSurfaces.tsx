import styles from './SelectionSurfaces.module.css';

export function SelectionCandidateIndicator({
  index,
  count,
}: {
  readonly index: number;
  readonly count: number;
}): JSX.Element | null {
  if (count < 2 || index < 0 || index >= count) return null;
  return (
    <span className={styles.candidate}>
      {index + 1} of {count} under cursor — Up/Down cycles
    </span>
  );
}

export function SelectionPropertiesSummary({
  count,
  perKind,
}: {
  readonly count: number;
  readonly perKind: Readonly<Record<string, number>>;
}): JSX.Element {
  return (
    <div className={styles.propertiesSummary}>
      <strong>{count} selected</strong>
      <span>{kindBreakdown(perKind)}</span>
    </div>
  );
}

export function MixedPropertyMarker(): JSX.Element {
  return <span className={styles.mixed}>Mixed</span>;
}

function kindBreakdown(perKind: Readonly<Record<string, number>>): string {
  return Object.entries(perKind)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${count} ${count === 1 ? kind : plural(kind)}`)
    .join(' · ');
}

function plural(label: string): string {
  if (label.endsWith('y') && !/[aeiou]y$/i.test(label)) return `${label.slice(0, -1)}ies`;
  return label.endsWith('s') ? label : `${label}s`;
}
