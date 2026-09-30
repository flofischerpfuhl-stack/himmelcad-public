/**
 * The display module's UI, floating over the viewport: the Section View
 * controls (while Section View is on), the analysis legend (curvature and
 * zebra modes), the body colour dialog and the Export image… dialog. The
 * Display menu (`ui/DisplayMenu.tsx`) is part of the shell's top bar and
 * right dock. On install it probes the GPU tier (`gpuProbe.ts`).
 */
import { defineModuleUi } from '../../platform/widgets/moduleUi.js';
import { probeGpuTier } from './gpuProbe.js';
import { AnalysisLegend } from './ui/AnalysisLegend.js';
import { ColourDialog } from './ui/ColourDialog.js';
import { ExportImageDialog } from './ui/ExportImageDialog.js';
import { SectionPanel } from './ui/SectionControls.js';

export const displayUi = defineModuleUi({
  id: 'display',
  panels: [
    { id: 'section', slot: 'overlay', order: 10, component: SectionPanel },
    { id: 'analysisLegend', slot: 'overlay', order: 210, component: AnalysisLegend },
    { id: 'colour', slot: 'overlay', order: 400, component: ColourDialog },
    { id: 'exportImage', slot: 'overlay', order: 410, component: ExportImageDialog },
  ],
  // The GPU tier's render-quality preset (software rasterizer: standard quality).
  install: probeGpuTier,
});
