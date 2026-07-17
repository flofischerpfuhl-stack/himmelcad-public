export interface SceneIdentity {
  readonly projectId: string;
  readonly renderOffset: readonly [number, number, number];
}

export function requiresFullSceneReset(
  previous: SceneIdentity | null,
  next: SceneIdentity,
): boolean {
  if (previous == null) return true;
  return (
    previous.projectId !== next.projectId ||
    previous.renderOffset.some((value, index) => value !== next.renderOffset[index])
  );
}

export interface ProjectRefreshTicket {
  readonly projectId: string;
  readonly generation: number;
}

export class ProjectRefreshGuard {
  private generation = 0;
  private projectId: string | null = null;

  begin(projectId: string): ProjectRefreshTicket {
    this.projectId = projectId;
    return { projectId, generation: ++this.generation };
  }

  isCurrent(ticket: ProjectRefreshTicket): boolean {
    return ticket.projectId === this.projectId && ticket.generation === this.generation;
  }
}

export interface EntityLoadTicket {
  readonly entityId: string;
  readonly epoch: number;
  readonly generation: number;
}

export class EntityLoadGenerationGuard {
  private epoch = 0;
  private readonly generations = new Map<string, number>();

  begin(entityId: string): EntityLoadTicket {
    const generation = (this.generations.get(entityId) ?? 0) + 1;
    this.generations.set(entityId, generation);
    return { entityId, epoch: this.epoch, generation };
  }

  invalidate(entityId: string): void {
    this.generations.set(entityId, (this.generations.get(entityId) ?? 0) + 1);
  }

  reset(): void {
    this.epoch += 1;
    this.generations.clear();
  }

  isCurrent(ticket: EntityLoadTicket): boolean {
    return (
      ticket.epoch === this.epoch && this.generations.get(ticket.entityId) === ticket.generation
    );
  }
}

export function entityLoadToken(ticket: EntityLoadTicket): string {
  return `${ticket.epoch}:${ticket.entityId}:${ticket.generation}`;
}

export function newlyFailedJobIds(
  jobs: readonly { readonly id: string; readonly state: { readonly kind: string } }[],
  observed: ReadonlySet<string>,
): string[] {
  return jobs
    .filter((job) => job.state.kind === 'failed' && !observed.has(job.id))
    .map((job) => job.id);
}
