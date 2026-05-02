export const themeTokens = {
  bg: {
    base: 'var(--hc-bg-base)',
    panel: 'var(--hc-bg-panel)',
    elevated: 'var(--hc-bg-elevated)',
    sunken: 'var(--hc-bg-sunken)',
    overlay: 'var(--hc-bg-overlay)',
  },
  fg: {
    default: 'var(--hc-fg-default)',
    muted: 'var(--hc-fg-muted)',
    subtle: 'var(--hc-fg-subtle)',
    inverse: 'var(--hc-fg-inverse)',
  },
  border: {
    subtle: 'var(--hc-border-subtle)',
    default: 'var(--hc-border-default)',
    strong: 'var(--hc-border-strong)',
    accent: 'var(--hc-border-accent)',
  },
  accent: {
    base: 'var(--hc-accent-base)',
    hover: 'var(--hc-accent-hover)',
    on: 'var(--hc-accent-on)',
    soft: 'var(--hc-accent-soft)',
  },
  state: {
    selectionBg: 'var(--hc-selection-bg)',
    hoverBg: 'var(--hc-hover-bg)',
    focusRing: 'var(--hc-focus-ring)',
  },
  status: {
    success: 'var(--hc-success)',
    warning: 'var(--hc-warning)',
    error: 'var(--hc-error)',
    info: 'var(--hc-info)',
  },
  font: {
    ui: 'var(--hc-font-ui)',
    mono: 'var(--hc-font-mono)',
  },
  size: {
    ribbonHeight: 'var(--hc-size-ribbon)',
    ribbonCollapsedHeight: 'var(--hc-size-ribbon-collapsed)',
    statusBarHeight: 'var(--hc-size-statusbar)',
    panelMin: 'var(--hc-size-panel-min)',
    panelDefault: 'var(--hc-size-panel-default)',
  },
  radius: {
    sm: 'var(--hc-radius-sm)',
    md: 'var(--hc-radius-md)',
    lg: 'var(--hc-radius-lg)',
  },
  motion: {
    fast: 'var(--hc-motion-fast)',
    base: 'var(--hc-motion-base)',
  },
} as const;
