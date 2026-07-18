#!/usr/bin/env node

/* global document, getComputedStyle, process, requestAnimationFrame, window */
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Playwright values cross the Node/browser boundary in this standalone visual audit. */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const rendererUrl = pathToFileURL(resolve(root, 'apps/photolab/dist/renderer/index.html')).href;
const viewports = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1100x720', width: 1100, height: 720 },
];
const ribbonActions = {
  Project: [],
  Images: ['Metadata', 'Image Status'],
  Reference: ['Reference Frame'],
  Alignment: ['Align Photos', 'Optimize', 'Merge Alignments', 'Capture Groups', 'Report'],
  Products: ['Depth Maps', 'Dense Cloud', 'DEM', 'Orthomosaic', 'Textured Mesh', 'Gaussian Splat'],
  Automation: ['Configure Batch', 'Queue'],
};

if (!process.argv.includes('--skip-build'))
  await run('pnpm', ['--filter', '@himmelcad/photolab', 'exec', 'vite', 'build']);
let browser;
const reports = [];
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN ?? '/usr/bin/google-chrome',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--allow-file-access-from-files',
    ],
  });
  for (const viewport of viewports) reports.push(await auditViewport(browser, viewport));
} finally {
  await browser?.close();
}

const reportPath = resolve(root, '.build/visual-regression/report.json');
await writeFile(reportPath, `${JSON.stringify({ reports }, null, 2)}\n`, 'utf8');
const issues = reports.flatMap((report) =>
  report.issues.map((issue) => `${report.viewport}: ${issue}`),
);
if (issues.length > 0) {
  throw new Error(
    `PhotoLab visual audit failed:\n${issues.map((issue) => `- ${issue}`).join('\n')}`,
  );
}
process.stdout.write(
  `PhotoLab visual audit passed · ${reports.reduce((sum, report) => sum + report.captures.length, 0)} captures · ${reportPath}\n`,
);

async function auditViewport(browserInstance, viewport) {
  const output = resolve(root, `.build/visual-regression/${viewport.name}`);
  await mkdir(output, { recursive: true });
  const context = await browserInstance.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    bypassCSP: true,
  });
  const page = await context.newPage();
  const issues = [];
  const captures = [];
  const pageErrors = [];
  const nativeDialogs = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', async (dialog) => {
    nativeDialogs.push(`${dialog.type()}: ${dialog.message()}`);
    await dialog.dismiss();
  });
  await page.addInitScript({ content: mockBridgeSource() });
  await page.goto(rendererUrl);
  await page.waitForFunction(() => document.body.innerText.includes('Project'));

  const capture = async (name) => {
    await page.evaluate(
      () =>
        new Promise((resolveCapture) =>
          requestAnimationFrame(() => requestAnimationFrame(resolveCapture)),
        ),
    );
    await page.waitForTimeout(120);
    await page.screenshot({ path: resolve(output, `${name}.png`) });
    captures.push(name);
    const audit = await page.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return (
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          box.width > 0 &&
          box.height > 0
        );
      };
      const taskIslands = [...document.querySelectorAll('[data-task-drag-handle]')]
        .map((handle) => handle.closest('section'))
        .filter((section) => section && visible(section))
        .map((section) => {
          const box = section.getBoundingClientRect();
          return {
            left: box.left,
            top: box.top,
            right: box.right,
            bottom: box.bottom,
            outerPointerEvents: section.parentElement?.parentElement
              ? getComputedStyle(section.parentElement.parentElement).pointerEvents
              : null,
          };
        });
      const selectedTabs = [...document.querySelectorAll('[role="tab"][aria-selected="true"]')]
        .filter(visible)
        .map((tab) => ({
          label: tab.textContent?.trim() ?? '',
          background: getComputedStyle(tab).backgroundColor,
        }));
      const dialogs = [...document.querySelectorAll('[role="dialog"]')]
        .filter(visible)
        .map((dialog) => {
          const box = dialog.getBoundingClientRect();
          const layer = dialog.parentElement?.parentElement;
          return {
            left: box.left,
            top: box.top,
            right: box.right,
            bottom: box.bottom,
            layerPointerEvents: layer ? getComputedStyle(layer).pointerEvents : null,
            activeElementInside: dialog.contains(document.activeElement),
          };
        });
      return {
        bodyOverflowX: document.documentElement.scrollWidth - window.innerWidth,
        bodyOverflowY: document.documentElement.scrollHeight - window.innerHeight,
        taskIslands,
        selectedTabs,
        dialogs,
        emptyFunctionPanel: [...document.querySelectorAll('main,aside,section')].some(
          (node) => visible(node) && node.textContent?.trim() === 'FUNCTION',
        ),
      };
    });
    if (audit.bodyOverflowX > 1)
      issues.push(`${name}: page overflows horizontally by ${audit.bodyOverflowX}px`);
    if (audit.bodyOverflowY > 1)
      issues.push(`${name}: page overflows vertically by ${audit.bodyOverflowY}px`);
    for (const box of audit.taskIslands) {
      if (
        box.left < -1 ||
        box.top < -1 ||
        box.right > viewport.width + 1 ||
        box.bottom > viewport.height + 1
      )
        issues.push(`${name}: task island escapes viewport (${JSON.stringify(box)})`);
      if (box.outerPointerEvents !== 'none')
        issues.push(`${name}: task island blocks the entire application surface`);
    }
    for (const dialog of audit.dialogs) {
      if (
        dialog.left < -1 ||
        dialog.top < -1 ||
        dialog.right > viewport.width + 1 ||
        dialog.bottom > viewport.height + 1
      )
        issues.push(`${name}: modal dialog escapes viewport (${JSON.stringify(dialog)})`);
      if (dialog.layerPointerEvents !== 'auto')
        issues.push(`${name}: modal dialog does not block background pointers`);
      if (!dialog.activeElementInside) issues.push(`${name}: modal dialog does not contain focus`);
    }
    return audit;
  };

  const mainAudit = await capture('00-main-view');
  const viewTab = mainAudit.selectedTabs.find((tab) => tab.label === 'View');
  const rightTab = mainAudit.selectedTabs.find(
    (tab) => tab.label === 'Function' || tab.label === 'Properties',
  );
  if (viewTab && rightTab && viewTab.background !== rightTab.background)
    issues.push(
      `active View and right-panel tabs use inconsistent backgrounds (${viewTab.background} vs ${rightTab.background})`,
    );

  await page.getByRole('tree').getByText('DJI_VISUAL_0001.JPG', { exact: true }).click();
  await page.getByRole('tab', { name: 'Properties', exact: true }).click();
  await capture('right-panel-properties');

  await page.getByRole('tab', { name: 'Jobs', exact: true }).click();
  await capture('bottom-jobs');
  await page.getByRole('tab', { name: 'Accuracy', exact: true }).click();
  await capture('bottom-accuracy');
  await page.getByRole('tab', { name: 'Report', exact: true }).click();
  await capture('bottom-report');
  await page.getByRole('button', { name: 'HTML', exact: true }).click();
  await page.waitForTimeout(200);
  await capture('bottom-report-saved');
  await page.evaluate(() => window.__photolabVisualStderr?.('ERROR visual audit failure'));
  await page
    .getByRole('tab', { name: 'Console', exact: true })
    .and(page.locator('[aria-selected="true"]'))
    .waitFor();
  await capture('error-opens-console');
  for (const [tabName, actions] of Object.entries(ribbonActions)) {
    await page.getByRole('tab', { name: tabName, exact: true }).first().click();
    await capture(`ribbon-${slug(tabName)}`);
    for (const action of actions) {
      const button = page.getByRole('button', { name: action, exact: true }).first();
      if ((await button.count()) === 0) {
        issues.push(`${tabName}: missing ribbon action ${action}`);
        continue;
      }
      if (action === 'Capture Groups') {
        const tree = page.getByRole('tree');
        await tree.getByText('DJI_VISUAL_0001.JPG', { exact: true }).click();
        await tree
          .getByText('DJI_VISUAL_0002.JPG', { exact: true })
          .click({ modifiers: ['Control'] });
      }
      await button.click();
      await capture(`function-${slug(action)}`);
      if (action === 'Capture Groups') {
        await page.getByRole('button', { name: 'Add split', exact: true }).click();
        await capture('function-capture-groups-calibration-split');
      }
    }
  }

  await page.getByRole('tab', { name: 'Images', exact: true }).first().click();
  await page.getByRole('button', { name: 'Images', exact: true }).first().click();
  await page.getByText('Reading photos', { exact: true }).waitFor();
  await capture('image-import-progress');
  await page.getByText('Import 2 photos', { exact: true }).waitFor();
  for (const [stepIndex, label] of [
    'Files',
    'Metadata',
    'Height',
    'Horizontal',
    'Import',
  ].entries()) {
    await page.locator('ol[aria-label="Image import steps"] button').nth(stepIndex).click();
    if (label === 'Horizontal') await page.waitForTimeout(350);
    await capture(`image-import-${slug(label)}`);
  }
  await page.getByRole('button', { name: 'Close image import', exact: true }).click();

  await page.evaluate(() => {
    window.__photolabVisualInspectError = true;
  });
  await page.getByRole('button', { name: 'Images', exact: true }).first().click();
  await page.getByText('Image inspection failed', { exact: true }).waitFor();
  await capture('image-import-error');
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.evaluate(() => {
    window.__photolabVisualInspectError = false;
  });

  await page.getByRole('tab', { name: 'Reference', exact: true }).first().click();
  await page.getByRole('button', { name: 'Import GCPs', exact: true }).click();
  await page.getByText('Import ground control points', { exact: true }).waitFor();
  await capture('gcp-import-file');
  for (const name of [
    'gcp-import-columns',
    'gcp-import-preview',
    'gcp-import-crs',
    'gcp-import-review',
  ]) {
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    if (name === 'gcp-import-crs') await page.waitForTimeout(350);
    await capture(name);
  }
  await page.getByRole('button', { name: 'Close GCP import', exact: true }).click();

  await page.evaluate(() => {
    window.__photolabVisualGcpPreviewError = true;
  });
  await page.getByRole('button', { name: 'Import GCPs', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Visual GCP preview failure' }).waitFor();
  await capture('gcp-import-error');
  await page.getByRole('button', { name: 'Close GCP import', exact: true }).click();
  await page.evaluate(() => {
    window.__photolabVisualGcpPreviewError = false;
  });

  const cameraTreeItem = page.getByText('DJI_VISUAL_0001.JPG', { exact: true });
  await cameraTreeItem.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove from project…', exact: true }).click();
  await page.getByRole('dialog', { name: /Remove (?:image|\d+ images)\?/ }).waitFor();
  await capture('confirmation-remove-image');
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click();

  const productTreeItem = page.getByText('Sparse Point Cloud', { exact: true });
  await productTreeItem.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Export…', exact: true }).click();
  const exportDialog = page.getByRole('dialog', { name: 'Replace “Sparse Point Cloud”?' });
  await exportDialog.waitFor();
  await page.keyboard.press('Tab');
  if (!(await exportDialog.evaluate((dialog) => dialog.contains(document.activeElement))))
    issues.push('product export confirmation allowed focus to escape the modal');
  await capture('confirmation-replace-product');
  await exportDialog.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.getByRole('tab', { name: 'Images', exact: true }).last().click();
  await capture('workspace-images');
  await page.getByRole('tab', { name: 'View', exact: true }).click();
  await capture('workspace-view-restored');

  if (nativeDialogs.length > 0) issues.push(`native dialogs used: ${nativeDialogs.join(' | ')}`);
  if (pageErrors.length > 0) issues.push(`page errors: ${pageErrors.join(' | ')}`);
  await context.close();
  return { viewport: viewport.name, captures, issues, nativeDialogs, pageErrors };
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function mockBridgeSource() {
  return `(() => {
    window.alert=()=>{throw new Error('Native alert is forbidden')};
    window.confirm=()=>{throw new Error('Native confirm is forbidden')};
    window.prompt=()=>{throw new Error('Native prompt is forbidden')};
    const hash='${'0'.repeat(64)}';
    const entity=(id,kind,name,parent,children=[])=>({id,kind,name,parent,children,visibility:{visible:true,locked:false},versionHash:hash,bounds:null});
    const entities={
      root:entity('root','ProjectRoot','Visual Test Project',null,['survey']),
      survey:entity('survey','Survey','Survey 01','root',['images','reference','products']),
      images:entity('images','ImageCollection','Images · 2','survey',['camera-1','camera-2']),
      'camera-1':entity('camera-1','CameraImage','DJI_VISUAL_0001.JPG','images'),
      'camera-2':entity('camera-2','CameraImage','DJI_VISUAL_0002.JPG','images'),
      reference:entity('reference','Group','Reference & GCPs','survey'),
      products:entity('products','Group','Products','survey',['sparse-1']),
      'sparse-1':entity('sparse-1','PointCloud','Sparse Point Cloud','products')
    };
    const opened={
      session:{sessionId:'visual',sourcePath:'/tmp/visual.hcad',workingPath:'/tmp/visual.hcad',usesLocalWorkingCopy:false,recoveryAvailable:false,readOnly:false,autosaveGeneration:0,lastSavedGeneration:0},
      manifest:{formatVersion:1,coordinateAxisContractVersion:2,projectId:'visual',name:'Visual Test Project',createdUnixMs:0,modifiedUnixMs:0,autosaveGeneration:0,commandSequence:0,cleanShutdown:true,rootEntity:'root',entities,renderOffset:{x:4375560,y:5281257,z:735},activeRuns:[]}
    };
    const defaults={delimiter:';',decimalSeparator:'comma',hasHeader:true,columns:{name:'0',east:'1',north:'2',height:'3'},role:'controlXyz',horizontalStddev:.02,heightStddev:.03};
    const photo=(number)=>({sourcePath:'/tmp/DJI_000'+number+'.JPG',format:'jpeg',byteSize:12000000,sha256:String(number).padStart(64,'0'),metadata:{exif:{make:'DJI',model:'M4E',focalLengthMm:12.29,dimensions:{widthPixels:5280,heightPixels:3956},gps:{latitudeDegrees:47.6657+number*.0001,longitudeDegrees:10.3414+number*.0001,altitude:{meters:783,semanticReference:'unknown'}}},djiXmp:{latitudeDegrees:47.6657+number*.0001,longitudeDegrees:10.3414+number*.0001,absoluteAltitude:{meters:783,semanticReference:'unknown'},gimbalAttitude:{yaw:65,pitch:-90,roll:0},rtk:{flag:'50',standardDeviationLongitudeMeters:.01,standardDeviationLatitudeMeters:.01,standardDeviationHeightMeters:.03}}}});
    const batch={photos:[photo(1),photo(2)],warnings:[]};
    const projectImage=(number)=>({entityId:'camera-'+number,name:'DJI_VISUAL_000'+number+'.JPG',metadataObjectHash:hash,metadata:{schemaVersion:1,sourceObjectHash:photo(number).sha256,transformationObjectHash:hash,inspectedPhoto:photo(number),projectedReference:{sourceLatitudeDegrees:47.6657+number*.0001,sourceLongitudeDegrees:10.3414+number*.0001,sourceHeightMeters:783,easting:4375560+number,northing:5281257+number,transformedHeightMeters:735,transformationDecisionSha256:hash},statusTags:['rtkFixed']}});
    const discovery={candidates:[{operationId:'visual-operation',name:'Explicit offline coordinate operation',kind:'general',projPipeline:'+proj=noop',areaOfUse:{westLongitude:-180,southLatitude:-90,eastLongitude:180,northLatitude:90},expectedAccuracyMm:1,ballpark:false,bestAvailable:true,requiredGrids:[]}],audit:{versions:{projVersion:'9.6.0',epsgDatabaseVersion:'12.004'}},warnings:[]};
    const preview={header:['Name','East','North','Height'],dataRowCount:2,validPointCount:2,previewRows:[{sourceLine:2,point:{name:'GCP-01',coordinate:{eastMeters:4375560.1,northMeters:5281257.2,heightMeters:735.3},role:'controlXyz'}},{sourceLine:3,point:{name:'GCP-02',coordinate:{eastMeters:4375572.4,northMeters:5281268.5,heightMeters:736.1},role:'checkpointXyz'}}],errors:[]};
    const productDataset={entityId:'sparse-1',kind:'sparse',relativePath:'products/sparse/metadata.json',format:'potreeV2',visible:false,boundsMin:[4375550,5281247,730],boundsMax:[4375570,5281267,740],renderOffset:[4375560,5281257,735],pointCount:10};
    const call=async(method)=>{
      if(method==='photolab.hardware.probe')return {operatingSystem:'linux',cpu:{physicalCores:8,logicalCores:16,supportsAvx2:true},ramBytes:34359738368,dedicatedVramBytes:0};
      if(method==='photolab.images.inspect'){await new Promise(resolve=>setTimeout(resolve,450));if(window.__photolabVisualInspectError)throw new Error('Visual image inspection failure');return batch;}
      if(method==='photolab.crs.discover')return discovery;
      if(method==='photolab.gcp.preview'){if(window.__photolabVisualGcpPreviewError)throw new Error('Visual GCP preview failure');return preview;}
      if(method==='photolab.images.list')return [projectImage(1),projectImage(2)];
      if(method==='photolab.products.list')return [productDataset];
      if(method==='photolab.project.processingSet.list'||method==='photolab.project.captureGroup.list'||method==='photolab.project.calibrationGroup.list'||method==='photolab.project.alignmentMerge.candidates'||method==='photolab.project.alignmentMerge.list'||method==='photolab.gcp.optimization.list'||method==='photolab.jobs.list')return [];
      if(method==='photolab.gcp.list'||method==='photolab.gcp.optimization.latest')return null;
      if(method==='photolab.project.autosave')return {autosaveGeneration:0,lastSavedGeneration:0,dirty:false};
      if(method==='photolab.project.snapshot')return opened;
      throw new Error('Visual mock has no response for '+method);
    };
    Object.defineProperty(window,'himmelcad',{value:{
      version:'visual',platform:'linux',
      window:{minimize:async()=>{},maximizeToggle:async()=>false,close:async()=>{},isMaximized:async()=>false,onMaximizeChange:()=>()=>{}},
      sidecar:{status:async()=>true,call,onStderr:(listener)=>{window.__photolabVisualStderr=listener;return ()=>{window.__photolabVisualStderr=undefined}}},
      preferences:{gcpCsv:{get:async()=>defaults,save:async()=>{}}},
      project:{bootstrap:async()=>opened,create:async()=>opened,open:async()=>opened,save:async()=>opened,saveAs:async()=>opened,cancelArchive:async()=>({})},
      images:{selectFiles:async()=>['/tmp/DJI_0001.JPG','/tmp/DJI_0002.JPG'],selectFolder:async()=>['/tmp']},
      grids:{select:async()=>null},
      reference:{selectGcpCsv:async()=>'/tmp/visual-gcps.csv'},
      batch:{load:async()=>null,save:async()=>true},reports:{save:async()=>true},products:{export:async()=>({confirmation:{token:'visual-export',displayName:'Sparse Point Cloud'}}),confirmExport:async()=>({job:{id:'visual-export-job',kind:'exportProduct',state:{kind:'queued'},stages:[],createdUnixMs:0,updatedUnixMs:0,progress:{completedWork:0,totalWork:1,completedBytes:0,totalBytes:0}}}),cancelExport:async()=>{}}
    },configurable:false});
  })();`;
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.on('error', rejectRun);
    child.on('exit', (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} exited with code ${String(code)}`));
    });
  });
}
