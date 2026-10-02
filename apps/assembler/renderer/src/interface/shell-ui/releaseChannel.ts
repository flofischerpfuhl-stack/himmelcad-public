/**
 * `true` in a build released as a preview (the web build until the product is
 * announced: `apps/assembler-web/vite.config.ts` defines `VITE_HC_RELEASE`;
 * `HIMMELCAD_WEB_PUBLIC=1` turns it off). Home and About then show a small
 * "Preview" badge. The desktop build defines nothing: no badge.
 */
export const isPreviewRelease = (): boolean =>
  // `import.meta.env` is Vite's; the Node test runs have none.
  (import.meta.env as ImportMetaEnv | undefined)?.VITE_HC_RELEASE === 'preview';
