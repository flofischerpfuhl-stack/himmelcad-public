import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { chromium } from 'playwright-core';
import { browserHeadless, resolveChromeExecutable } from '../support/platform-tools.mjs';

const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(
    '<!doctype html><title>WebGPU map range probe</title><canvas width="64" height="64"></canvas>',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address === 'object');

const browser = await chromium.launch({
  executablePath: resolveChromeExecutable(),
  headless: browserHeadless(),
  args: ['--enable-unsafe-webgpu'],
});

try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${String(address.port)}/`, { waitUntil: 'load' });
  const result = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice({
      requiredFeatures: [...adapter.features].filter((feature) => feature !== 'timestamp-query'),
      requiredLimits: Object.fromEntries(
        Object.keys(Object.getPrototypeOf(adapter.limits))
          .filter((key) => typeof adapter.limits[key] === 'number')
          .map((key) => [key, adapter.limits[key]]),
      ),
    });

    const run = async (size, explicitRange) => {
      const source = device.createBuffer({
        size,
        usage: GPUBufferUsage.COPY_SRC,
        mappedAtCreation: true,
      });
      new Uint8Array(source.getMappedRange()).fill(0x5a);
      source.unmap();
      const staging = device.createBuffer({
        size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(source, 0, staging, 0, size);
      device.queue.submit([encoder.finish()]);
      try {
        if (explicitRange) await staging.mapAsync(GPUMapMode.READ, 0, size);
        else await staging.mapAsync(GPUMapMode.READ);
        const bytes = new Uint8Array(staging.getMappedRange());
        const valid = bytes.length === size && bytes[0] === 0x5a && bytes[size - 1] === 0x5a;
        staging.unmap();
        return { ok: valid, byteLength: bytes.length };
      } catch (error) {
        return {
          ok: false,
          error: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
        };
      }
    };

    const sizes = [768, 13_056];
    const probes = [];
    for (const size of sizes) {
      probes.push({ size, implicit: await run(size, false), explicit: await run(size, true) });
    }
    let surfaceStep = 'context';
    let postSurfaceProbe;
    try {
      const canvas = document.querySelector('canvas');
      const context = canvas.getContext('webgpu');
      const format = navigator.gpu.getPreferredCanvasFormat();
      surfaceStep = 'configure';
      context.configure({ device, format, alphaMode: 'opaque' });
      surfaceStep = 'encode';
      const surfaceEncoder = device.createCommandEncoder();
      const surfacePass = surfaceEncoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0.1, g: 0.2, b: 0.3, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      surfacePass.end();
      surfaceStep = 'submit';
      device.queue.submit([surfaceEncoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      surfaceStep = 'present';
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      surfaceStep = 'map';
      postSurfaceProbe = await run(768, true);
    } catch (error) {
      postSurfaceProbe = {
        ok: false,
        error: `${surfaceStep}: ${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
      };
    }
    return {
      adapterInfo: adapter.info,
      isFallbackAdapter: adapter.info.isFallbackAdapter,
      features: [...device.features],
      probes,
      postSurfaceProbe,
    };
  });
  console.log(JSON.stringify(result, null, 2));
  for (const probe of result.probes) {
    assert.equal(probe.implicit.ok, true, `implicit map failed at ${String(probe.size)} bytes`);
    assert.equal(probe.explicit.ok, true, `explicit map failed at ${String(probe.size)} bytes`);
  }
  if (result.isFallbackAdapter && !result.postSurfaceProbe.ok) {
    assert.match(result.postSurfaceProbe.error, /external Instance reference|map/i);
  } else {
    assert.equal(result.postSurfaceProbe.ok, true, 'WebGPU post-surface map failed');
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
