/* himmel:cap interactive UI prototype */

const PROJECTS = [
  {
    id: 'p-muc',
    name: 'MUC FTTH Nord',
    jobs: [
      {
        id: 'j1',
        name: 'Graben Nord — FTTH',
        date: '2026-07-18 · 09:14',
        desc: 'Offener Graben, PE 110, ca. 0,8 m. Abschnitt bis Schacht S12.',
        notes: ['Offener Graben, PE 110, ca. 0,8 m. Abschnitt bis Schacht S12.'],
        quality: 'float',
        sigmaH: 0.38,
        sigmaV: 0.72,
        fixPct: 8,
        floatPct: 79,
        path: [
          [48.1372, 11.575],
          [48.1375, 11.5758],
          [48.1379, 11.5764],
          [48.1382, 11.5771],
          [48.1384, 11.578],
        ],
        color: '#1597f2',
      },
      {
        id: 'j2',
        name: 'Hausanschluss 12b',
        date: '2026-07-19 · 14:02',
        desc: 'Kurzer Stich, gute Sicht auf Himmel.',
        notes: ['Kurzer Stich, gute Sicht auf Himmel.'],
        quality: 'fix',
        sigmaH: 0.12,
        sigmaV: 0.28,
        fixPct: 61,
        floatPct: 32,
        path: [
          [48.1364, 11.5738],
          [48.1366, 11.5742],
          [48.1368, 11.5749],
          [48.1369, 11.5755],
        ],
        color: '#73b00a',
      },
    ],
  },
  {
    id: 'p-ost',
    name: 'Trasse Ost',
    jobs: [
      {
        id: 'j3',
        name: 'Trasse Ost (Schatten)',
        date: '2026-07-20 · 16:40',
        desc: 'Bäume, Korrektur oft Float.',
        notes: ['Bäume, Korrektur oft Float. Trotzdem dokumentiert.'],
        quality: 'single',
        sigmaH: 1.4,
        sigmaV: 2.1,
        fixPct: 0,
        floatPct: 22,
        path: [
          [48.1388, 11.5725],
          [48.1391, 11.573],
          [48.1394, 11.5738],
          [48.1396, 11.5746],
        ],
        color: '#e8a33e',
      },
    ],
  },
];

const RTK_PROFILES = [
  { id: 'p1', name: 'SAPOS HEPS BY', detail: 'ntrip… · VRS_3_4G', active: true, ok: true },
  { id: 'p2', name: 'Testcaster', detail: 'rtk2go.com · demo', active: false, ok: false },
];

const GNSS_STATES = [
  { label: 'Keine Korrektur', sigma: 'Lage ~4.2 m · Höhe ~8.0 m', dot: 'red' },
  { label: 'Float', sigma: 'Lage ~0.42 m · Höhe ~0.85 m', dot: 'amber' },
  { label: 'Fix', sigma: 'Lage ~0.08 m · Höhe ~0.15 m', dot: 'green' },
  { label: 'Nur Handy-GPS', sigma: 'Lage ~3.1 m · Höhe ~6.5 m', dot: 'amber' },
];

let map;
let mapLayers = [];
let gnssIndex = 1;
let recording = false;
let recTimer = null;
let recSeconds = 0;
let recFrames = 0;
let autoUpload = false;
let currentProjectId = 'p-muc';
let currentJobId = null;
let packReady = false;
let expandedProjects = new Set(['p-muc', 'p-ost']);
const cloudLinked = { gdrive: false, dropbox: false, onedrive: false };

function $(sel, root = document) {
  return root.querySelector(sel);
}
function $all(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}
function project() {
  return PROJECTS.find((p) => p.id === currentProjectId) || PROJECTS[0];
}
function allJobs() {
  return PROJECTS.flatMap((p) => p.jobs.map((j) => ({ ...j, projectId: p.id, projectName: p.name })));
}
function findJob(id) {
  for (const p of PROJECTS) {
    const j = p.jobs.find((x) => x.id === id);
    if (j) return { job: j, project: p };
  }
  return null;
}

function showToast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('on'), 2200);
}

function navigate(name) {
  $all('.screen').forEach((s) => s.classList.toggle('active', s.dataset.screen === name));
  closeProjectDropdown();
  if (name === 'map' && map) setTimeout(() => map.invalidateSize(), 50);
}

function setTheme(mode) {
  let theme = mode;
  if (mode === 'system') {
    theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.classList.remove('hc-theme-dark', 'hc-theme-light');
  document.documentElement.classList.add(theme === 'light' ? 'hc-theme-light' : 'hc-theme-dark');
  $all('#theme-seg button').forEach((b) => b.classList.toggle('on', b.dataset.theme === mode));
}

function applyGnssState(i) {
  gnssIndex = ((i % GNSS_STATES.length) + GNSS_STATES.length) % GNSS_STATES.length;
  const s = GNSS_STATES[gnssIndex];
  $('#gnss-dot').className = `status-dot ${s.dot}`;
  $('#gnss-label').textContent = s.label;
  $('#gnss-sigma').textContent = s.sigma;
}

function updateProjectChrome() {
  $('#project-name').textContent = project().name;
}

function closeProjectDropdown() {
  const dd = $('#project-dropdown');
  if (dd) {
    dd.hidden = true;
    dd.innerHTML = '';
  }
}

function openProjectDropdown() {
  const dd = $('#project-dropdown');
  dd.hidden = false;
  dd.innerHTML = PROJECTS.map(
    (p) => `
    <button type="button" class="dd-item ${p.id === currentProjectId ? 'active' : ''}" data-pick-project="${p.id}">
      <span>${p.name}</span>
      ${p.id === currentProjectId ? '<svg class="ico ico-sm" viewBox="0 0 24 24"><use href="#i-check"/></svg>' : ''}
    </button>
  `,
  ).join('');
  dd.querySelectorAll('[data-pick-project]').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentProjectId = btn.dataset.pickProject;
      updateProjectChrome();
      refreshMapJobs();
      closeProjectDropdown();
      showToast(project().name);
    });
  });
}

function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: false }).setView([48.1378, 11.5755], 16);
  L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: '' },
  ).addTo(map);
  refreshMapJobs();
}

function refreshMapJobs() {
  mapLayers.forEach((l) => map.removeLayer(l));
  mapLayers = [];
  const jobs = project().jobs;
  jobs.forEach((job) => {
    const layer = L.polyline(job.path, {
      color: job.color,
      weight: 4,
      opacity: 0.95,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map);
    const popup = L.popup().setContent(`
      <div class="popup-card">
        <h3>${job.name}</h3>
        <div class="meta">${job.date} · σH ${job.sigmaH.toFixed(2)} m</div>
        <p>${job.desc || ''}</p>
        <button type="button" data-open-job="${job.id}">Job öffnen</button>
      </div>
    `);
    layer.bindPopup(popup);
    layer.on('popupopen', () => {
      const btn = document.querySelector(`[data-open-job="${job.id}"]`);
      if (btn) btn.onclick = () => openJob(job.id);
    });
    mapLayers.push(layer);
  });
  if (jobs.length) {
    const group = L.featureGroup(mapLayers);
    map.fitBounds(group.getBounds().pad(0.2));
  }
}

function openJob(id) {
  const found = findJob(id);
  if (!found) return;
  currentJobId = id;
  currentProjectId = found.project.id;
  updateProjectChrome();
  const job = found.job;
  $('#job-title').textContent = job.name;
  $('#job-date').textContent = `${found.project.name} · ${job.date}`;
  $('#job-desc').textContent = job.desc || '';

  const notesHtml = (job.notes || [])
    .map((n, i) => `<li class="note-item"><span class="note-idx">${i + 1}</span><span>${escapeHtml(n)}</span></li>`)
    .join('');

  const acc = $('#job-accordion');
  acc.innerHTML = `
    <div class="acc-item open">
      <button type="button" class="acc-head">Überblick <svg class="ico ico-sm chev" viewBox="0 0 24 24"><use href="#i-chevron-right"/></svg></button>
      <div class="acc-body">
        <dl class="kv">
          <dt>Qualität</dt><dd>${job.quality}</dd>
          <dt>σ Lage</dt><dd>${job.sigmaH.toFixed(2)} m</dd>
          <dt>σ Höhe</dt><dd>${job.sigmaV.toFixed(2)} m</dd>
          <dt>Fix / Float</dt><dd>${job.fixPct}% / ${job.floatPct}%</dd>
        </dl>
      </div>
    </div>
    <div class="acc-item">
      <button type="button" class="acc-head">GNSS <svg class="ico ico-sm chev" viewBox="0 0 24 24"><use href="#i-chevron-right"/></svg></button>
      <div class="acc-body">
        <dl class="kv">
          <dt>Gerät</dt><dd>Pixel 8a</dd>
          <dt>Dual-Freq</dt><dd>ja</dd>
        </dl>
      </div>
    </div>
    <div class="acc-item">
      <button type="button" class="acc-head">Korrekturen <svg class="ico ico-sm chev" viewBox="0 0 24 24"><use href="#i-chevron-right"/></svg></button>
      <div class="acc-body">
        <dl class="kv">
          <dt>Profil</dt><dd>${RTK_PROFILES.find((p) => p.active)?.name || '—'}</dd>
        </dl>
      </div>
    </div>
    <div class="acc-item">
      <button type="button" class="acc-head">Medien <svg class="ico ico-sm chev" viewBox="0 0 24 24"><use href="#i-chevron-right"/></svg></button>
      <div class="acc-body"><div class="gallery">${Array.from({ length: 6 }, () => '<div class="thumb"></div>').join('')}</div></div>
    </div>
    <div class="acc-item">
      <button type="button" class="acc-head">Paket <svg class="ico ico-sm chev" viewBox="0 0 24 24"><use href="#i-chevron-right"/></svg></button>
      <div class="acc-body">
        <dl class="kv">
          <dt>Datei</dt><dd class="mono">.hcap</dd>
          <dt>Status</dt><dd>bereit</dd>
        </dl>
      </div>
    </div>
    <div class="acc-item open">
      <button type="button" class="acc-head">Notizen <svg class="ico ico-sm chev" viewBox="0 0 24 24"><use href="#i-chevron-right"/></svg></button>
      <div class="acc-body">
        <ul class="note-list" id="note-list">${notesHtml || '<li class="note-empty">Keine Notizen</li>'}</ul>
        <button type="button" class="btn block" id="btn-add-note" style="margin-top:8px">Notiz hinzufügen</button>
      </div>
    </div>
  `;
  wireAccordion(acc);
  const addBtn = $('#btn-add-note');
  if (addBtn) addBtn.addEventListener('click', () => openAddNoteModal(job));
  navigate('job');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function wireAccordion(root) {
  root.querySelectorAll('.acc-head').forEach((head) => {
    head.addEventListener('click', () => head.parentElement.classList.toggle('open'));
  });
}

function openAddNoteModal(job) {
  const host = $('#modal-host');
  host.classList.add('on');
  host.innerHTML = `
    <div class="overlay-card island save-card">
      <h3>Notiz hinzufügen</h3>
      <label class="field">
        <span>Text</span>
        <textarea id="note-input" rows="3" placeholder="Zusätzliche Notiz…"></textarea>
      </label>
      <div class="row-btns">
        <button type="button" class="btn" id="note-cancel">Abbrechen</button>
        <button type="button" class="btn primary" id="note-ok">Anhängen</button>
      </div>
    </div>
  `;
  $('#note-cancel').onclick = () => {
    host.classList.remove('on');
    host.innerHTML = '';
  };
  $('#note-ok').onclick = () => {
    const text = $('#note-input').value.trim();
    if (text) {
      if (!job.notes) job.notes = [];
      job.notes.push(text);
      host.classList.remove('on');
      host.innerHTML = '';
      openJob(job.id);
      showToast('Notiz angehängt');
    }
  };
}

function renderMenu() {
  const el = $('#menu-list');
  el.innerHTML = PROJECTS.map((p) => {
    const open = expandedProjects.has(p.id);
    const active = p.id === currentProjectId;
    return `
      <div class="proj-block">
        <div class="proj-head ${active ? 'active' : ''}">
          <button type="button" class="proj-toggle" data-toggle-proj="${p.id}" aria-label="Aufklappen">
            <svg class="ico ico-sm chev ${open ? 'rot' : ''}" viewBox="0 0 24 24"><use href="#i-chevron-right"/></svg>
          </button>
          <button type="button" class="proj-title grow" data-use-proj="${p.id}">${p.name}</button>
          ${active ? '<span class="badge ok">aktiv</span>' : ''}
        </div>
        <div class="proj-jobs ${open ? 'open' : ''}">
          ${p.jobs
            .map(
              (j) => `
            <button type="button" class="job-row" data-job-row="${j.id}">
              <span class="grow">${j.name}<span class="sub">${j.date}</span></span>
              <span class="badge ${j.quality === 'fix' ? 'ok' : ''}">${j.quality}</span>
            </button>
          `,
            )
            .join('')}
        </div>
      </div>
    `;
  }).join('');

  el.querySelectorAll('[data-toggle-proj]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.toggleProj;
      if (expandedProjects.has(id)) expandedProjects.delete(id);
      else expandedProjects.add(id);
      renderMenu();
    });
  });
  el.querySelectorAll('[data-use-proj]').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentProjectId = btn.dataset.useProj;
      expandedProjects.add(currentProjectId);
      updateProjectChrome();
      refreshMapJobs();
      navigate('map');
      showToast(project().name);
    });
  });
  el.querySelectorAll('[data-job-row]').forEach((row) => {
    row.addEventListener('click', () => openJob(row.dataset.jobRow));
  });
}

function renderRtkProfiles() {
  const el = $('#rtk-profiles');
  el.innerHTML =
    RTK_PROFILES.map(
      (p) => `
    <button type="button" class="settings-row rtk-row ${p.active ? 'rtk-active' : ''}" data-activate-rtk="${p.id}">
      <span class="radio ${p.active ? 'on' : ''}" aria-hidden="true"></span>
      <div class="grow">
        ${p.name}
        <span class="sub">${p.detail}</span>
      </div>
      <span class="badge ${p.ok ? 'ok' : 'off'}">${p.ok ? 'OK' : '—'}</span>
      <span class="btn sm" data-test-rtk="${p.id}">Test</span>
    </button>
  `,
    ).join('') +
    `
    <button type="button" class="settings-row rtk-add" id="btn-rtk-add">
      <svg class="ico" viewBox="0 0 24 24"><use href="#i-plus"/></svg>
      <div class="grow">Profil hinzufügen</div>
    </button>
  `;

  el.querySelectorAll('[data-activate-rtk]').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-test-rtk]')) return;
      RTK_PROFILES.forEach((p) => {
        p.active = p.id === row.dataset.activateRtk;
      });
      renderRtkProfiles();
    });
  });
  el.querySelectorAll('[data-test-rtk]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      showToast('Verbindungstest…');
    });
  });
  const add = $('#btn-rtk-add');
  if (add) add.addEventListener('click', openRtkCreateModal);
}

function openRtkCreateModal() {
  const host = $('#modal-host');
  host.classList.add('on');
  host.innerHTML = `
    <div class="overlay-card island save-card">
      <h3>RTK-Profil</h3>
      <label class="field"><span>Name</span><input type="text" id="rtk-name" placeholder="z. B. SAPOS HEPS" /></label>
      <label class="field"><span>Host</span><input type="text" id="rtk-host" placeholder="ntrip.example.de" /></label>
      <label class="field"><span>Port</span><input type="text" id="rtk-port" value="2101" /></label>
      <label class="field"><span>Mountpoint</span><input type="text" id="rtk-mount" /></label>
      <label class="field"><span>Benutzer</span><input type="text" id="rtk-user" /></label>
      <label class="field"><span>Passwort</span><input type="password" id="rtk-pass" /></label>
      <div class="row-btns">
        <button type="button" class="btn" id="rtk-cancel">Abbrechen</button>
        <button type="button" class="btn primary" id="rtk-ok">Anlegen</button>
      </div>
    </div>
  `;
  $('#rtk-cancel').onclick = () => {
    host.classList.remove('on');
    host.innerHTML = '';
  };
  $('#rtk-ok').onclick = () => {
    const name = $('#rtk-name').value.trim() || 'Neues Profil';
    const hostV = $('#rtk-host').value.trim() || '…';
    const mount = $('#rtk-mount').value.trim() || '…';
    RTK_PROFILES.forEach((p) => {
      p.active = false;
    });
    RTK_PROFILES.push({
      id: 'p' + Date.now(),
      name,
      detail: `${hostV} · ${mount}`,
      active: true,
      ok: false,
    });
    host.classList.remove('on');
    host.innerHTML = '';
    renderRtkProfiles();
    showToast('Profil angelegt');
  };
}

function defaultJobName() {
  const d = new Date();
  const ds = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const ts = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return `${ds} ${ts} · ${project().name}`;
}

function startRecording() {
  recording = true;
  recSeconds = 0;
  recFrames = 0;
  $('#btn-shutter').classList.add('recording');
  $('#rec-meta').classList.add('on');
  updateRecMeta();
  recTimer = setInterval(() => {
    recSeconds += 1;
    if (recSeconds % 2 === 0) recFrames += 1;
    updateRecMeta();
  }, 1000);
}

function stopRecording() {
  recording = false;
  clearInterval(recTimer);
  $('#btn-shutter').classList.remove('recording');
  $('#rec-meta').classList.remove('on');
  openSaveFlow();
}

function updateRecMeta() {
  const m = String(Math.floor(recSeconds / 60)).padStart(2, '0');
  const s = String(recSeconds % 60).padStart(2, '0');
  $('#rec-time').textContent = `${m}:${s}`;
  $('#rec-frames').textContent = `${recFrames} Frames`;
}

function openSaveFlow() {
  packReady = false;
  const ov = $('#save-overlay');
  ov.classList.add('on');
  $('#save-name').value = defaultJobName();
  $('#save-desc').value = '';
  $('#save-status').textContent = 'Paket wird im Hintergrund gebaut…';
  $('#btn-save-job').disabled = true;
  const bar = $('#process-bar');
  bar.style.width = '0%';
  let p = 0;
  const iv = setInterval(() => {
    p += 10;
    bar.style.width = `${Math.min(p, 100)}%`;
    if (p >= 100) {
      clearInterval(iv);
      packReady = true;
      $('#save-status').textContent = '.hcap bereit';
      $('#btn-save-job').disabled = false;
    }
  }, 100);
}

function commitSavedJob() {
  const name = $('#save-name').value.trim() || defaultJobName();
  const desc = $('#save-desc').value.trim();
  const id = 'j' + Date.now();
  const base = project().jobs[0]?.path?.[0] || [48.1375, 11.5755];
  const job = {
    id,
    name,
    date: new Date().toLocaleString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
    desc,
    notes: desc ? [desc] : [],
    quality: 'float',
    sigmaH: 0.4,
    sigmaV: 0.8,
    fixPct: 5,
    floatPct: 80,
    path: [
      base,
      [base[0] + 0.0003, base[1] + 0.0004],
      [base[0] + 0.0006, base[1] + 0.0009],
    ],
    color: '#1597f2',
  };
  project().jobs.unshift(job);
  $('#save-overlay').classList.remove('on');
  refreshMapJobs();
  navigate('map');
  showToast(autoUpload ? 'Gespeichert · Upload…' : 'Gespeichert · .hcap');
  openJob(id);
}

function wire() {
  $all('[data-nav]').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.nav)));

  $('#btn-settings').addEventListener('click', () => navigate('settings'));
  $('#btn-menu').addEventListener('click', () => {
    renderMenu();
    navigate('menu');
  });
  $('#btn-project-switch').addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = $('#project-dropdown');
    if (dd.hidden) openProjectDropdown();
    else closeProjectDropdown();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#project-dropdown') && !e.target.closest('#btn-project-switch')) {
      closeProjectDropdown();
    }
  });

  $('#btn-capture').addEventListener('click', () => {
    applyGnssState(gnssIndex);
    navigate('capture');
  });
  $('#btn-locate').addEventListener('click', () => {
    map.setView([48.1378, 11.5755], 17);
    showToast('Standort');
  });
  $('#btn-job-map').addEventListener('click', () => {
    navigate('map');
    const f = findJob(currentJobId);
    if (f) map.fitBounds(f.job.path, { padding: [40, 40] });
  });
  $('#btn-shutter').addEventListener('click', () => {
    if (!recording) startRecording();
    else stopRecording();
  });
  $('#btn-save-job').addEventListener('click', () => {
    if (!packReady) return;
    commitSavedJob();
  });

  $('#btn-share-hcap').addEventListener('click', () => showToast('Teilen / speichern .hcap'));
  $('#btn-upload-cloud').addEventListener('click', () => {
    const any = Object.values(cloudLinked).some(Boolean);
    showToast(any ? 'Cloud-Upload' : 'Cloud verknüpfen');
  });
  $('#btn-auto-upload').addEventListener('click', () => {
    autoUpload = !autoUpload;
    $('#btn-auto-upload').textContent = autoUpload ? 'An' : 'Aus';
  });
  $('#btn-dxf-folder').addEventListener('click', () => showToast('Cloud-Ordner: /Bestandsplan (Demo)'));

  $all('[data-link-cloud]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.linkCloud;
      cloudLinked[id] = !cloudLinked[id];
      const badge = document.querySelector(`[data-cloud="${id}"]`);
      if (cloudLinked[id]) {
        badge.textContent = 'OK';
        badge.classList.add('ok');
        badge.classList.remove('off');
        btn.textContent = 'Trennen';
      } else {
        badge.textContent = '—';
        badge.classList.remove('ok');
        badge.classList.add('off');
        btn.textContent = 'Verknüpfen';
      }
    });
  });

  $all('#theme-seg button').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.theme)));
  $('#map-attrib').addEventListener('click', () => showToast('Kartenquellen / Lizenzen'));

  $('#studio-theme').addEventListener('click', () => {
    setTheme(document.documentElement.classList.contains('hc-theme-light') ? 'dark' : 'light');
  });
  $('#studio-gnss').addEventListener('click', () => {
    applyGnssState(gnssIndex + 1);
    navigate('capture');
  });
  $('#studio-map').addEventListener('click', () => navigate('map'));
}

function main() {
  setTheme('dark');
  applyGnssState(1);
  updateProjectChrome();
  initMap();
  renderRtkProfiles();
  wire();
}

main();
