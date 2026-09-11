import type { IoExportPlanEnvelope, IoFormatDescriptor, JsonValue } from '@himmelcad/app';
import type { EntityKind } from '@himmelcad/data';
import { ExportIsland, type ExportRunningState, type ExportScope } from '@himmelcad/ui';
import { useEffect, useMemo, useState } from 'react';

import type { BuilderCanonicalProjectSession } from './project.js';
import {
  exportDisclosureRows,
  exportFormatChoices,
  exportFormatLabel,
  landXmlProjectUnitDefault,
  type LandXmlLinearUnit,
  type ProjectUnitSource,
} from './exportDisclosure.js';

interface ExportEntity {
  readonly id: string;
  readonly kind: EntityKind;
  readonly label?: string;
}

export function BuilderExportIsland({
  session,
  entities,
  selectedIds,
  visibleIds,
  projectUnitSources,
  initialScope,
  detached,
  onDetachedChange,
  onClose,
  onConsole,
}: {
  readonly session: BuilderCanonicalProjectSession;
  readonly entities: readonly ExportEntity[];
  readonly selectedIds: readonly string[];
  readonly visibleIds: readonly string[];
  readonly projectUnitSources: readonly ProjectUnitSource[];
  readonly initialScope: ExportScope;
  readonly detached: boolean;
  readonly onDetachedChange: (detached: boolean) => void;
  readonly onClose: () => void;
  readonly onConsole: (level: 'info' | 'error', message: string) => void;
}): JSX.Element {
  const projectUnitDefault = useMemo(
    () => landXmlProjectUnitDefault(projectUnitSources),
    [projectUnitSources],
  );
  const [descriptors, setDescriptors] = useState<readonly IoFormatDescriptor[]>([]);
  const [scope, setScope] = useState<ExportScope>(initialScope);
  const [formatId, setFormatId] = useState('');
  const [path, setPath] = useState('');
  const [linearUnit, setLinearUnit] = useState<LandXmlLinearUnit | ''>(projectUnitDefault ?? '');
  const [acceptedPlan, setAcceptedPlan] = useState<IoExportPlanEnvelope | null>(null);
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState<ExportRunningState | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const exportableIds = useMemo(() => new Set(entities.map((entity) => entity.id)), [entities]);
  const ids = useMemo(() => {
    if (scope === 'selection') return selectedIds.filter((id) => exportableIds.has(id));
    if (scope === 'visible') return visibleIds.filter((id) => exportableIds.has(id));
    return entities.map((entity) => entity.id);
  }, [entities, exportableIds, scope, selectedIds, visibleIds]);
  const scopeIdentity = ids.join('\u0000');
  const scopedEntities = useMemo(
    () => entities.filter((entity) => ids.includes(entity.id)),
    [entities, ids],
  );
  const formats = useMemo(
    () =>
      exportFormatChoices(
        descriptors,
        scopedEntities.map((entity) => entity.kind),
      ),
    [descriptors, scopedEntities],
  );
  const selectedDescriptor = descriptors.find((descriptor) =>
    descriptor.formatIds.includes(formatId),
  );
  const isLandXml = exportFormatLabel(formatId) === 'LandXML';
  const plannedUnitLabel = acceptedPlan && isLandXml ? landXmlUnitLabel(linearUnit || null) : null;
  const planRows = acceptedPlan
    ? exportDisclosureRows(
        scopedEntities.map((entity) => ({
          kind: entity.kind,
          ...(entity.label ? { label: entity.label } : {}),
        })),
        formatId,
        acceptedPlan.plan.semanticLosses,
      )
    : null;

  useEffect(() => {
    let active = true;
    void session
      .listFormats()
      .then((items) => {
        if (!active) return;
        const exporters = items.filter((item) => item.capabilities.includes('export'));
        setDescriptors(exporters);
        const choices = exportFormatChoices(
          exporters,
          entities
            .filter((entity) =>
              initialScope === 'selection'
                ? selectedIds.includes(entity.id)
                : initialScope === 'visible'
                  ? visibleIds.includes(entity.id)
                  : true,
            )
            .map((entity) => entity.kind),
        );
        setFormatId(choices.find((choice) => choice.enabled)?.id ?? choices[0]?.id ?? '');
      })
      .catch((reason: unknown) => setError(messageOf(reason)));
    return () => {
      active = false;
    };
  }, [session]);

  useEffect(() => {
    setScope(initialScope);
  }, [initialScope]);

  useEffect(() => {
    setAcceptedPlan(null);
    setError(null);
  }, [scopeIdentity]);

  const invalidate = (): void => {
    setAcceptedPlan(null);
    setError(null);
  };

  const choosePath = async (): Promise<void> => {
    if (!selectedDescriptor) return;
    const choice = await window.himmelcad?.dialog.chooseExport({
      formatId,
      extensions: selectedDescriptor.extensions,
      suggestedName: `export.${selectedDescriptor.extensions[0] ?? 'dat'}`,
    });
    if (choice) {
      setPath(choice);
      invalidate();
    }
  };

  const plan = async (): Promise<void> => {
    if (!selectedDescriptor || ids.length === 0 || !path) return;
    if (isLandXml && !linearUnit) {
      const message = 'LandXML export requires Units. Choose metre, feet, or US feet.';
      setAcceptedPlan(null);
      setError(message);
      onConsole('error', `io.export.plan refused · ${message}`);
      return;
    }
    setPlanning(true);
    setError(null);
    try {
      const next = await session.planExport({
        commandId: `builder-export-${crypto.randomUUID()}`,
        scope,
        entityIds: [...ids],
        providerId: selectedDescriptor.providerId,
        providerVersion: selectedDescriptor.providerVersion,
        targetPath: path,
        formatId,
        options: exportOptions(selectedDescriptor.exportOptions?.defaults ?? {}, linearUnit),
      });
      setAcceptedPlan(next);
      onConsole(
        'info',
        `io.export.plan · ${scope} · ${ids.length} entities · ${next.plan.semanticLosses.length} losses · ${path}`,
      );
    } catch (reason) {
      const message = messageOf(reason);
      setError(message);
      onConsole('error', `io.export.plan failed · ${message}`);
    } finally {
      setPlanning(false);
    }
  };

  const execute = async (): Promise<void> => {
    if (!acceptedPlan || !window.himmelcad) return;
    const operation = `builder-export-${crypto.randomUUID()}`;
    const planWithAcceptance = acceptPlanLosses(acceptedPlan);
    setOperationId(operation);
    setRunning({ phase: 'Preparing export', fraction: 0 });
    setError(null);
    await window.himmelcad.jobs.register({
      id: operation,
      label: `Export ${exportFormatLabel(formatId)}`,
      owner: 'builder.export',
      phase: 'Preparing export',
      expectedDurationMs: 1_001,
      progressKey: operation,
      cancellable: true,
      context: { targetPath: path, formatId, scope },
    });
    onConsole(
      'info',
      `io.export.execute · started · ${planWithAcceptance.plan.semanticLosses.join(', ') || 'lossless'}`,
    );
    const poll = pollExport(session, operation, (next) => {
      setRunning(next);
      void window.himmelcad?.jobs.update(operation, {
        phase: next.phase,
        fraction: next.fraction,
      });
    });
    try {
      await session.executeExport(operation, planWithAcceptance);
      await poll;
      await window.himmelcad.jobs.complete(operation, `Exported ${path}`);
      setRunning(null);
      setOperationId(null);
      onConsole(
        'info',
        `io.export.execute · completed · ${path} · losses: ${planWithAcceptance.plan.semanticLosses.join(', ') || 'none'}`,
      );
    } catch (reason) {
      await poll;
      const message = messageOf(reason);
      const cancelled = /cancel/i.test(message);
      if (cancelled) await window.himmelcad.jobs.cancelled(operation);
      else await window.himmelcad.jobs.fail(operation, message);
      setRunning(null);
      setOperationId(null);
      setError(cancelled ? null : message);
      onConsole(
        cancelled ? 'info' : 'error',
        `io.export.execute · ${cancelled ? 'cancelled' : `failed · ${message}`}`,
      );
    }
  };

  const cancel = async (): Promise<void> => {
    if (!operationId) return;
    setRunning((current) => (current ? { ...current, cancelling: true } : current));
    await window.himmelcad?.jobs.cancel(operationId);
  };

  return (
    <ExportIsland
      formats={formats}
      formatId={formatId}
      scope={scope}
      selectionCount={selectedIds.filter((id) => exportableIds.has(id)).length}
      path={path}
      {...(isLandXml
        ? {
            unitChoices: LANDXML_UNIT_CHOICES,
            unitId: linearUnit,
            plannedUnitLabel,
            onUnitChange: (value: string) => {
              setLinearUnit(isLandXmlLinearUnit(value) ? value : '');
              invalidate();
            },
          }
        : {})}
      planRows={planRows}
      {...(acceptedPlan
        ? { outputs: acceptedPlan.plan.outputs.map((output) => output.relativePath) }
        : {})}
      planning={planning}
      running={running}
      error={error}
      detached={detached}
      onDetachedChange={onDetachedChange}
      onFormatChange={(value) => {
        setFormatId(value);
        setPath('');
        invalidate();
      }}
      onScopeChange={(value) => {
        setScope(value);
        invalidate();
      }}
      onChoosePath={() => void choosePath()}
      onPlan={() => void plan()}
      onExport={() => void execute()}
      onCancel={() => void cancel()}
      onClose={onClose}
    />
  );
}

const LANDXML_UNIT_CHOICES = [
  { id: '', label: 'Not set' },
  { id: 'meter', label: 'Metre' },
  { id: 'foot', label: 'Feet' },
  { id: 'USSurveyFoot', label: 'US feet' },
] as const;

function isLandXmlLinearUnit(value: string): value is LandXmlLinearUnit {
  return value === 'meter' || value === 'foot' || value === 'USSurveyFoot';
}

function landXmlUnitLabel(unit: LandXmlLinearUnit | null): string | null {
  return LANDXML_UNIT_CHOICES.find((choice) => choice.id === unit)?.label ?? null;
}

function exportOptions(defaults: JsonValue, linearUnit: LandXmlLinearUnit | ''): JsonValue {
  const options = cloneJson(defaults);
  if (!linearUnit) return options;
  const record = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  return {
    ...record,
    units: {
      system: linearUnit === 'meter' ? 'Metric' : 'Imperial',
      linearUnit,
      attributes: {},
    },
  };
}

async function pollExport(
  session: BuilderCanonicalProjectSession,
  operationId: string,
  update: (state: ExportRunningState) => void,
): Promise<void> {
  for (;;) {
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    try {
      const status = await session.exportStatus(operationId);
      if (status.progress) {
        update({
          phase: exportPhaseLabel(status.progress.phase),
          fraction:
            status.progress.total && status.progress.total > 0
              ? status.progress.completed / status.progress.total
              : null,
          cancelling: status.state === 'cancelled',
        });
      }
      if (status.state !== 'running') return;
    } catch {
      // Execute may complete between the final write and status lookup.
      return;
    }
  }
}

function exportPhaseLabel(phase: string): string {
  switch (phase) {
    case 'scan':
    case 'prepare':
      return 'Preparing export';
    case 'encode':
    case 'convert':
      return 'Encoding output';
    case 'copy':
      return 'Copying exact source';
    case 'hash':
    case 'verify':
      return 'Verifying output';
    case 'write':
    case 'publish':
      return 'Publishing output';
    default:
      return phase.replace(/[._:-]+/gu, ' ').replace(/^./u, (value) => value.toUpperCase());
  }
}

function cloneJson(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function acceptPlanLosses(plan: IoExportPlanEnvelope): IoExportPlanEnvelope {
  const options =
    plan.options && typeof plan.options === 'object' && !Array.isArray(plan.options)
      ? { ...plan.options }
      : {};
  return {
    ...plan,
    options: { ...options, acceptedLossCodes: [...plan.plan.semanticLosses] },
  };
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
