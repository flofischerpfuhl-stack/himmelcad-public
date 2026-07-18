import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import '@himmelcad/theme/fonts.css';
import '@himmelcad/theme/tokens.css';
import '@himmelcad/theme/reset.css';

import { FloatingTaskIsland } from './FloatingTaskIsland.js';
import { PlanIsland } from './PlanIsland.js';
import { SpecsIsland } from './SpecsIsland.js';

function Sandbox(): JSX.Element {
  const [specsOpen, setSpecsOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);

  return (
    <div
      style={{
        minHeight: '100vh',
        padding: 32,
        background: 'var(--hc-bg-void, #0a0c10)',
        color: 'var(--hc-fg-default, #e8eaef)',
        fontFamily: 'var(--hc-font-ui, system-ui, sans-serif)',
      }}
    >
      <h1 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 600 }}>
        Specs &amp; Plan — standalone test
      </h1>
      <p style={{ margin: '0 0 20px', color: 'var(--hc-fg-muted, #9aa3b2)', fontSize: 13 }}>
        Independent popups (no project / no viewport). English UI.
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" style={btn} onClick={() => setSpecsOpen(true)}>
          Open Specifications
        </button>
        <button type="button" style={btn} onClick={() => setPlanOpen(true)}>
          Open Plan
        </button>
      </div>

      {specsOpen ? (
        <FloatingTaskIsland onRequestClose={() => setSpecsOpen(false)}>
          <SpecsIsland onClose={() => setSpecsOpen(false)} />
        </FloatingTaskIsland>
      ) : null}
      {planOpen ? (
        <FloatingTaskIsland onRequestClose={() => setPlanOpen(false)}>
          <PlanIsland onClose={() => setPlanOpen(false)} />
        </FloatingTaskIsland>
      ) : null}
    </div>
  );
}

const btn: React.CSSProperties = {
  height: 32,
  padding: '0 14px',
  border: '1px solid var(--hc-border-default, #2a3344)',
  borderRadius: 6,
  background: 'var(--hc-bg-island-hi, #1a2030)',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
};

const rootEl = document.getElementById('hc-root');
if (!rootEl) throw new Error('Missing #hc-root');
createRoot(rootEl).render(
  <StrictMode>
    <Sandbox />
  </StrictMode>,
);
