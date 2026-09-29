import styles from './App.module.css';

/**
 * Phase 0 placeholder shell. Intentionally has no ribbon, entity tree, or
 * viewport yet — those follow the shared Dark Islands app composition
 * (docs/DESIGN-SYSTEM.md "App composition") once the orchestrator designs
 * the real Assembler UI.
 */
export function App(): JSX.Element {
  return (
    <div className={styles.frame}>
      <p className={styles.title}>Himmel:CAD Assembler</p>
      <p className={styles.subtitle}>UI shell in progress</p>
    </div>
  );
}
