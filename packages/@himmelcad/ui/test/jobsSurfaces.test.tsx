import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { JobsIsland, JobsStatusChip, type JobSurfaceItem } from '../src/JobsSurfaces.js';

function job(state: JobSurfaceItem['state'], extra: Partial<JobSurfaceItem> = {}): JobSurfaceItem {
  return {
    id: `job-${state}`,
    label: 'Import scan_01.laz',
    state,
    phase: state === 'needs-input' ? 'Choose registration' : 'Reading points',
    fraction: state === 'running' ? 0.42 : null,
    cancellation: { cancellable: true },
    registeredAtUnixMs: 0,
    finishedAtUnixMs: null,
    suppressChip: false,
    ...extra,
  };
}

test('jobs chip uses the shared label grammar and honest progress', () => {
  const html = renderToStaticMarkup(
    <JobsStatusChip jobs={[job('running')]} now={1_000} onClick={() => {}} />,
  );
  assert.match(html, /aria-label="Jobs: 1 job running · Import scan_01.laz 42 %"/);
  assert.match(html, />1 job running · Import scan_01.laz 42 %</);

  const multi = renderToStaticMarkup(
    <JobsStatusChip
      jobs={[job('running'), job('running', { id: 'second' })]}
      now={1_000}
      onClick={() => {}}
    />,
  );
  assert.match(multi, />2 jobs running</);
  assert.doesNotMatch(multi, /\+1/);
});

test('jobs island pairs every determinate phase with its visible percentage', () => {
  const html = renderToStaticMarkup(
    <JobsIsland
      jobs={[job('running', { phase: 'Preparing hierarchy', fraction: 0.42 })]}
      onCancel={() => {}}
      onRespond={() => {}}
    />,
  );
  assert.match(html, /Preparing hierarchy/);
  assert.match(html, />42%<\/code>/);
});

test('jobs chip covers needs-input, cancellation, failure and completion linger', () => {
  const render = (item: JobSurfaceItem, now = 1_000) =>
    renderToStaticMarkup(<JobsStatusChip jobs={[item]} now={now} onClick={() => {}} />);
  assert.match(render(job('needs-input')), />Needs input · Import scan_01.laz</);
  assert.match(render(job('cancelling')), />Cancelling…</);
  assert.match(
    render(job('failed', { finishedAtUnixMs: 900 })),
    />Job failed — Import scan_01.laz</,
  );
  assert.match(
    render(job('completed', { finishedAtUnixMs: 900 }), 4_900),
    />Job completed — Import scan_01.laz</,
  );
  assert.equal(render(job('completed', { finishedAtUnixMs: 900 }), 4_901), '');
});

test('unknown-unit jobs say in progress and remain indeterminate', () => {
  const html = renderToStaticMarkup(
    <JobsIsland
      jobs={[job('running', { fraction: null, phase: 'Indexing source tiles' })]}
      onCancel={() => {}}
      onRespond={() => {}}
    />,
  );
  assert.match(html, /Indexing source tiles/);
  assert.match(html, /in progress/);
  assert.match(html, /role="progressbar"/);
  assert.doesNotMatch(html, /aria-valuenow/);
  assert.doesNotMatch(html, /overall 0\s*%/i);
});

test('jobs island exposes respond, cancellation reason and retained summary', () => {
  const html = renderToStaticMarkup(
    <JobsIsland
      jobs={[
        job('needs-input'),
        job('running', {
          id: 'atomic',
          cancellation: { cancellable: false, reason: 'Publishing atomic result' },
        }),
        job('completed', { id: 'old', finishedAtUnixMs: 1 }),
      ]}
      now={31_001}
      onCancel={() => {}}
      onRespond={() => {}}
    />,
  );
  assert.match(html, />Respond</);
  assert.match(html, /Publishing atomic result/);
  assert.match(html, /1 finished/);
  assert.match(html, />Clear</);
});
