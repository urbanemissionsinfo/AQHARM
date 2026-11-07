// ── CONFIGURATION & CONSTANTS ────────────────────────────────
const CONFIG = {
  populationTifPath: 'landscan_ethiopia_2024_packbits.tif',
  pm25TifPath: 'pm25_northup.tif'
};

/* GEMM model constants (Burnett et al. 2018) */
const THETA = 0.143, ALPHA = 1.6, MU = 15.5, NU = 36.8, X0 = 2.4;

/* Morbidity effects: base = 'all' | 'adult' | 'under25' */
const EFFECTS = [
  { acr: "ACB", name: "Adult Chronic Bronchitis",      drf: 0.00004,  cost: 300000, base: "adult" },
  { acr: "CAB", name: "Child Acute Bronchitis",         drf: 0.000544, cost: 300000, base: "under25" },
  { acr: "RHA", name: "Respiratory Hospital Admission", drf: 0.000012, cost: 1000,   base: "all" },
  { acr: "CHA", name: "Cardiac Hospital Admission",     drf: 0.000005, cost: 100000, base: "adult" },
  { acr: "ERV", name: "Emergency Room Visit",           drf: 0.000235, cost: 1000,   base: "all" },
  { acr: "AA",  name: "Asthma Attacks",                 drf: 0.0029,   cost: 50,     base: "all" },
  { acr: "RAD", name: "Restricted Activity Days",       drf: 0.03828,  cost: 500,    base: "adult" },
  { acr: "RSD", name: "Respiratory Symptom Days",       drf: 0.183,    cost: 30,     base: "all" }
];
const BASE_LABEL = { all: "population base: all ages", adult: "population base: adult 25+", under25: "population base: under 25" };

/* Remember the published DRFs so edits can be flagged and reset */
EFFECTS.forEach(e => { e.drfDefault = e.drf; });

// ── UI HELPER (PREVENTS ERRORS ON MISSING DOM ELEMENTS) ───────
function updateText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function fmtMoney(n) {
  if (!isFinite(n)) n = 0;
  if (Math.abs(n) >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B";
  if (Math.abs(n) >= 1e6) return "$" + Math.round(n / 1e6) + "M";
  return "$" + Math.round(n).toLocaleString('en-US');
}

// ── MAP INIT ────────────────────────────────────────────────--
const map = L.map('map', { center: [10, 40], zoom: 6, zoomControl: true });

L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
  attribution: 'Tiles &copy; Esri',
  maxZoom: 18
}).addTo(map);

// ── STATE VARIABLES ───────────────────────────────────────────
let rawTifInfo = {
  population: null,
  pm25: null
};
let activeBounds = null;
let lastBoxResults = null;

// Visual raster layers
let mapLayerPop = null;
let mapLayerPm25 = null;

// ── LEAFLET DRAW TOOLBAR ──────────────────────────────────────
const drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);

const drawControl = new L.Control.Draw({
  draw: {
    polyline: false,
    polygon: false,
    circle: false,
    marker: false,
    circlemarker: false,
    rectangle: {
      shapeOptions: { color: '#164D12', weight: 2, fillOpacity: 0.15 }
    }
  },
  edit: { featureGroup: drawnItems, remove: true }
});
map.addControl(drawControl);

document.getElementById('drawRectBtn')?.addEventListener('click', function() {
  for (let id in drawControl._toolbars.draw._modes) {
    if (drawControl._toolbars.draw._modes[id].handler instanceof L.Draw.Rectangle) {
      drawControl._toolbars.draw._modes[id].handler.enable();
      break;
    }
  }
});

map.on(L.Draw.Event.CREATED, function (e) {
  drawnItems.clearLayers();
  drawnItems.addLayer(e.layer);
  activeBounds = e.layer.getBounds();
  updateAOIState(true);
  renderHealthImpacts();
});

map.on(L.Draw.Event.EDITED, function (e) {
  e.layers.eachLayer(function (layer) { activeBounds = layer.getBounds(); });
  renderHealthImpacts();
});

map.on(L.Draw.Event.DELETED, function () {
  clearBoundingBox();
});

function clearBoundingBox() {
  drawnItems.clearLayers();
  activeBounds = null;
  heatmapLayer.clearLayers();
  updateAOIState(false);

  updateText('stat-area', 'Full Extent');
  updateText('stat-pop-total', '0');
  updateText('stat-avg-pm25', '—');
  updateText('totalMortalityCount', '—');
  updateText('totalMortalityCost', '—');
  updateText('totalMorbidityCost', '—');
  updateText('totalCombinedCost', '—');
  EFFECTS.forEach((eff, i) => {
    updateText(`morb-cases-${i}`, '—');
    updateText(`morb-cost-${i}`, '—');
  });
  lastBoxResults = null;
  const downloadBtn = document.getElementById('btn-download-box-csv');
  if (downloadBtn) downloadBtn.disabled = true;
  updateDrfAoiNote();
}

function updateAOIState(hasBox) {
  const statusEl = document.getElementById('selection-status');
  const clearBtn = document.getElementById('btn-clear-box');

  if (statusEl) {
    statusEl.textContent = hasBox ? "Filtered Box Area" : "Entire Extent";
    statusEl.style.color = hasBox ? "#164D12" : "#6b7268";
  }

  if (clearBtn) {
    if (hasBox) clearBtn.classList.remove('hidden');
    else clearBtn.classList.add('hidden');
  }
}

document.getElementById('btn-clear-box')?.addEventListener('click', clearBoundingBox);

// ── RASTER COLOR SCHEMES (return [r,g,b,a]) ────────────────────
function getPopColor(value) {
  if (value <= 0 || isNaN(value)) return null;
  if (value > 1000) return [8, 48, 107, 200];
  if (value > 500)  return [40, 121, 185, 190];
  if (value > 100)  return [115, 179, 216, 180];
  if (value > 10)   return [200, 221, 240, 170];
  return [247, 251, 255, 160];
}

function getPmColor(value) {
  if (value <= 0 || isNaN(value)) return null;
  if (value > 100) return [128, 0, 38, 200];
  if (value > 75)  return [189, 0, 38, 195];
  if (value > 50)  return [227, 26, 28, 190];
  if (value > 35)  return [252, 78, 42, 185];
  if (value > 15)  return [253, 141, 60, 180];
  if (value > 5)   return [254, 178, 76, 175];
  return [255, 237, 160, 160];
}

// ── LEGEND DEFINITIONS & RENDERING ─────────────────────────────
const POP_LEGEND = {
  title: 'Population (per cell)',
  rows: [
    { color: '#08306b', label: '> 1000' },
    { color: '#2879b9', label: '500 – 1000' },
    { color: '#73b3d8', label: '100 – 500' },
    { color: '#c8ddf0', label: '10 – 100' },
    { color: '#f7fbff', label: '0 – 10' }
  ]
};

const PM_LEGEND = {
  title: 'PM2.5 (µg/m³)',
  rows: [
    { color: '#800026', label: '> 100' },
    { color: '#bd0026', label: '75 – 100' },
    { color: '#e31a1c', label: '50 – 75' },
    { color: '#fc4e2a', label: '35 – 50' },
    { color: '#fd8d3c', label: '15 – 35' },
    { color: '#feb24c', label: '5 – 15' },
    { color: '#ffeda0', label: '0 – 5' }
  ]
};

function renderLegendGroup(group) {
  const rowsHtml = group.rows.map(r =>
    `<div class="legend-row"><span class="legend-swatch" style="background:${r.color}"></span><span>${r.label}</span></div>`
  ).join('');
  return `<div class="legend-group"><div class="legend-group-title">${group.title}</div>${rowsHtml}</div>`;
}

function updateLegend() {
  const legendEl = document.getElementById('raster-legend');
  if (!legendEl) return;

  const groups = [];
  if (mapLayerPop && map.hasLayer(mapLayerPop)) groups.push(POP_LEGEND);
  if (mapLayerPm25 && map.hasLayer(mapLayerPm25)) groups.push(PM_LEGEND);

  if (groups.length === 0) {
    legendEl.classList.add('hidden');
    legendEl.innerHTML = '';
    return;
  }

  legendEl.innerHTML = groups.map(renderLegendGroup).join('');
  legendEl.classList.remove('hidden');
}

// ── RASTER LAYER GENERATOR (custom canvas tiles — avoids GeoRasterLayer's
// tile-caching/z-index bugs where a toggled-on layer "sticks" and blocks
// whatever is toggled on after it) ─────────────────────────────
function createRasterLayer(tifInfo, colorScaleFn, zIndex) {
  const layer = L.gridLayer({ opacity: 0.7, zIndex: zIndex });

  layer.createTile = function(coords, done) {
    const tile = L.DomUtil.create('canvas', 'leaflet-tile');
    const size = this.getTileSize();
    tile.width = size.x;
    tile.height = size.y;
    const ctx = tile.getContext('2d');

    const nwPoint = coords.scaleBy(size);
    const { data, nodata, width, height, originX, originY, pixelW, pixelH } = tifInfo;

    const imgData = ctx.createImageData(size.x, size.y);
    const pixels = imgData.data;

    for (let y = 0; y < size.y; y++) {
      for (let x = 0; x < size.x; x++) {
        const pt = nwPoint.add(L.point(x, y));
        const latlng = map.unproject(pt, coords.z);

        const col = Math.floor((latlng.lng - originX) / pixelW);
        const row = Math.floor((originY - latlng.lat) / pixelH);

        const idx = (y * size.x + x) * 4;

        if (col >= 0 && col < width && row >= 0 && row < height) {
          const val = data[row * width + col];

          if (val !== null && val !== undefined && !isNaN(val) && val !== nodata && val > 0) {
            const rgba = colorScaleFn(val);
            if (rgba) {
              pixels[idx] = rgba[0];
              pixels[idx + 1] = rgba[1];
              pixels[idx + 2] = rgba[2];
              pixels[idx + 3] = rgba[3];
            } else {
              pixels[idx + 3] = 0;
            }
          } else {
            pixels[idx + 3] = 0;
          }
        } else {
          pixels[idx + 3] = 0;
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);
    setTimeout(() => done(null, tile), 0);
    return tile;
  };

  return layer;
}

// ── GEOTIFF LOADER (SINGLE PARSE, REUSED FOR MATH + VISUAL LAYER) ──
// Previously the app fetched each file once but then parsed it TWICE:
// once via GeoTIFF.fromArrayBuffer (for the math grid) and again via
// parseGeoraster (for the visual GeoRasterLayer). For large rasters
// that second full decode is what was hanging the page. Here we parse
// once and build a georaster-compatible object by hand from the same
// decoded data, so GeoRasterLayer never has to re-decode the TIFF.
async function loadTifDataHelper(arrayBuffer) {
  const tif = await GeoTIFF.fromArrayBuffer(arrayBuffer);
  const image = await tif.getImage();
  const bbox = image.getBoundingBox();
  const fileDir = image.getFileDirectory();

  let nodata = fileDir.GDAL_NODATA !== undefined ? parseFloat(fileDir.GDAL_NODATA) : null;
  const rasters = await image.readRasters({ interleave: false });

  const width = image.getWidth();
  const height = image.getHeight();
  const pixelW = (bbox[2] - bbox[0]) / width;
  const pixelH = (bbox[3] - bbox[1]) / height;

  return {
    data: rasters[0],
    nodata: nodata,
    width: width,
    height: height,
    originX: bbox[0],
    originY: bbox[3],
    pixelW: pixelW,
    pixelH: pixelH,
    bbox: bbox // [xmin, ymin, xmax, ymax]
  };
}

async function init() {
  const btnPop = document.getElementById('btn-population');
  const btnPm25 = document.getElementById('btn-pm25');

  // --- 1. POPULATION LOAD ---
  try {
    console.log("Loading Population Data...");
    const popResp = await fetch(CONFIG.populationTifPath);
    if (!popResp.ok) throw new Error(`HTTP ${popResp.status} fetching population TIF`);
    const popBuf = await popResp.arrayBuffer();

    rawTifInfo.population = await loadTifDataHelper(popBuf);

    mapLayerPop = createRasterLayer(rawTifInfo.population, getPopColor, 4);
    console.log("Population visual layer generated.");
    if (btnPop) {
      btnPop.textContent = '👁 Toggle Population';
      btnPop.disabled = false;
    }
  } catch (err) {
    if (btnPop) btnPop.textContent = 'Pop Error';
    console.error('Failed to load Population TIF:', err);
  }

  // --- 2. PM2.5 LOAD ---
  try {
    console.log("Loading PM2.5 Data...");
    const pmResp = await fetch(CONFIG.pm25TifPath);
    if (!pmResp.ok) throw new Error(`HTTP ${pmResp.status} fetching PM2.5 TIF`);
    const pmBuf = await pmResp.arrayBuffer();

    rawTifInfo.pm25 = await loadTifDataHelper(pmBuf);

    mapLayerPm25 = createRasterLayer(rawTifInfo.pm25, getPmColor, 5);
    console.log("PM2.5 visual layer generated.");
    if (btnPm25) {
      btnPm25.textContent = '👁 Toggle PM2.5';
      btnPm25.disabled = false;
    }
  } catch (err) {
    if (btnPm25) btnPm25.textContent = 'PM2.5 Error';
    console.error('Failed to load PM2.5 TIF:', err);
  }
}

// ── LAYER TOGGLE EVENT LISTENERS ──────────────────────────────
document.getElementById('btn-population')?.addEventListener('click', function() {
  if (!mapLayerPop) return;
  if (map.hasLayer(mapLayerPop)) {
    map.removeLayer(mapLayerPop);
    this.classList.remove('active');
  } else {
    map.addLayer(mapLayerPop);
    this.classList.add('active');
  }
  updateLegend();
});

document.getElementById('btn-pm25')?.addEventListener('click', function() {
  if (!mapLayerPm25) return;
  if (map.hasLayer(mapLayerPm25)) {
    map.removeLayer(mapLayerPm25);
    this.classList.remove('active');
  } else {
    map.addLayer(mapLayerPm25);
    this.classList.add('active');
  }
  updateLegend();
});

// ── GRID EXTRACTION & HEALTH MATH ────────────────────────────
function computeGrid01(bbox) {
  const res = 0.01;
  const ncols = Math.round((bbox.neLng - bbox.swLng) / res);
  const nrows = Math.round((bbox.neLat - bbox.swLat) / res);
  const cells = [];

  for (let row = 0; row < nrows; row++){
    const cellSwLat = bbox.swLat + row * res;
    const cellNeLat = bbox.swLat + (row + 1) * res;
    for (let col = 0; col < ncols; col++){
      const cellSwLng = bbox.swLng + col * res;
      const cellNeLng = bbox.swLng + (col + 1) * res;
      cells.push({ sw_long: cellSwLng, sw_lat: cellSwLat, ne_long: cellNeLng, ne_lat: cellNeLat });
    }
  }
  return cells;
}

function calculateCellImpact(c, baselineDeathRate, frac25) {
  const popInfo = rawTifInfo.population;
  const pmInfo = rawTifInfo.pm25;
  if (!popInfo || !pmInfo) return null;

  const colMin = Math.max(0, Math.ceil((c.sw_long - popInfo.originX) / popInfo.pixelW - 0.5));
  const colMax = Math.min(popInfo.width - 1, Math.floor((c.ne_long - popInfo.originX) / popInfo.pixelW - 0.5));
  const rowMin = Math.max(0, Math.ceil((popInfo.originY - c.ne_lat) / popInfo.pixelH - 0.5));
  const rowMax = Math.min(popInfo.height - 1, Math.floor((popInfo.originY - c.sw_lat) / popInfo.pixelH - 0.5));

  let cellPop = 0, pmSum = 0, pmCount = 0;

  for (let r = rowMin; r <= rowMax; r++) {
    const y = popInfo.originY - (r + 0.5) * popInfo.pixelH;
    for (let col = colMin; col <= colMax; col++) {
      const x = popInfo.originX + (col + 0.5) * popInfo.pixelW;
      const popVal = popInfo.data[r * popInfo.width + col];

      if (popVal > 0 && popVal !== popInfo.nodata) {
        cellPop += Number(popVal);

        const pmCol = Math.floor((x - pmInfo.originX) / pmInfo.pixelW);
        const pmRow = Math.floor((pmInfo.originY - y) / pmInfo.pixelH);

        if (pmCol >= 0 && pmCol < pmInfo.width && pmRow >= 0 && pmRow < pmInfo.height) {
          const pmVal = pmInfo.data[pmRow * pmInfo.width + pmCol];
          if (pmVal > 0 && pmVal !== pmInfo.nodata) {
            pmSum += Number(pmVal);
            pmCount++;
          }
        }
      }
    }
  }

  if (cellPop === 0) return null;

  const avgPm25 = pmCount > 0 ? (pmSum / pmCount) : 0;

  const z = Math.max(avgPm25 - X0, 0);
  const dum1 = THETA * Math.log(1 + z / ALPHA);
  const dum2 = 1 + Math.exp(-(z - MU) / NU);
  const HR = Math.exp(dum1 / dum2);
  const AF = (HR - 1) / HR;

  const popAdult = cellPop * frac25;
  const mortalityCases = AF * (baselineDeathRate / 1000) * popAdult;

  return { pop: cellPop, pm25: avgPm25, mortality: mortalityCases };
}

// ── HEATMAP RENDERING ────────────────────────────────────────
const heatmapLayer = L.featureGroup().addTo(map);

function getHeatmapColor(val, maxVal) {
  if (maxVal === 0 || val === 0) return 'transparent';
  const ratio = val / maxVal;
  if (ratio > 0.8) return '#bd0026';
  if (ratio > 0.6) return '#f03b20';
  if (ratio > 0.4) return '#fd8d3c';
  if (ratio > 0.2) return '#fecc5c';
  return '#ffffb2';
}

function renderHealthImpacts() {
  if (!activeBounds) return alert("Please draw a bounding box first.");

  heatmapLayer.clearLayers();

  // 1. Read input values directly from HTML elements
  const baselineDeathRate = parseFloat(document.getElementById('deathRate').value) || 6.6;
  const frac25 = (parseFloat(document.getElementById('pop25').value) || 70) / 100;
  
  const gdp = parseFloat(document.getElementById('gdp').value) || 0;
  const gdpRef = parseFloat(document.getElementById('gdpRef').value) || 1;
  const vslRef = parseFloat(document.getElementById('vslRef').value) || 0;
  const elasticity = parseFloat(document.getElementById('elasticity').value) || 0;

  // 2. Compute dynamic GDP correction and adjusted VSL
  const gdpCorrection = (gdp > 0 && gdpRef > 0) ? Math.pow(gdp / gdpRef, elasticity) : 1;
  const VSL = vslRef * gdpCorrection;

  const bbox = { swLng: activeBounds.getWest(), swLat: activeBounds.getSouth(), neLng: activeBounds.getEast(), neLat: activeBounds.getNorth() };
  const cells = computeGrid01(bbox);

  const gridData = [];
  let totalMortality = 0, totalPop = 0, pmSum = 0, pmCount = 0;

  cells.forEach(c => {
    const impact = calculateCellImpact(c, baselineDeathRate, frac25);
    if (impact) {
      gridData.push({ bounds: [[c.sw_lat, c.sw_long], [c.ne_lat, c.ne_long]], ...impact });
      totalMortality += impact.mortality;
      totalPop += impact.pop;
      if (impact.pm25 > 0) {
        pmSum += impact.pm25;
        pmCount++;
      }
    }
  });

  const avgBoxPm = pmCount > 0 ? (pmSum / pmCount) : 0;
  const totalMortalityCostUSD = totalMortality * VSL;

  const lat1 = bbox.swLat * Math.PI / 180;
  const lat2 = bbox.neLat * Math.PI / 180;
  const dLng = Math.abs(bbox.neLng - bbox.swLng) * Math.PI / 180;
  const areaKm2 = 6371.0088 * 6371.0088 * dLng * Math.abs(Math.sin(lat2) - Math.sin(lat1));

  // Update UI Stats
  updateText('stat-area', `${areaKm2.toLocaleString(undefined, { maximumFractionDigits: 0 })} km²`);
  updateText('stat-pop-total', Math.round(totalPop).toLocaleString('en-US'));
  updateText('stat-avg-pm25', `${avgBoxPm.toFixed(1)} µg/m³`);
  updateText('totalMortalityCount', Math.round(totalMortality).toLocaleString('en-US'));
  updateText('totalMortalityCost', fmtMoney(totalMortalityCostUSD));

  // 3. Compute Morbidity costs using gdpCorrection
  const z = Math.max(avgBoxPm - X0, 0);
  const { morbidityCostUSD, breakdown } = calculateMorbidity(totalPop, frac25, z, gdpCorrection);
  updateText('totalMorbidityCost', fmtMoney(morbidityCostUSD));
  updateText('totalCombinedCost', fmtMoney(totalMortalityCostUSD + morbidityCostUSD));

  lastBoxResults = {
    areaKm2, totalPop, avgBoxPm,
    baselineDeathRate, frac25: frac25 * 100, vsl: VSL, gdpCorrection,
    totalMortality, totalMortalityCostUSD,
    morbidityCostUSD, combinedCostUSD: totalMortalityCostUSD + morbidityCostUSD,
    breakdown
  };
  const downloadBtn = document.getElementById('btn-download-box-csv');
  if (downloadBtn) downloadBtn.disabled = false;
  updateDrfAoiNote();
}

// ── MORBIDITY TABLE with EDITABLE DRFs ───────────────────────
// cases = DRF × relevant population base × (PM2.5 − X0)
// DRFs start at the published defaults (EFFECTS[].drfDefault) and can be
// edited live in the table. Edits only re-run the cheap morbidity maths,
// not the whole grid extraction, so the table responds instantly.

const fmtDrf = n => String(n);

function parseDrf(raw) {
  const s = String(raw).trim().replace(/,/g, '');
  if (s === '') return NaN;
  const n = Number(s);                       // accepts 0.0004 and 4e-4
  return (isFinite(n) && n >= 0) ? n : NaN;
}

function setupDrfHeader(table) {
  if (!table) return;
  let headRow = table.querySelector('thead tr');
  if (!headRow) {
    const thead = table.createTHead();
    headRow = thead.insertRow();
    headRow.innerHTML = '<th>Health effect</th><th>Cases / yr</th><th>Cost</th>';
  }
  if (headRow.querySelector('.drf-th')) return;
  const th = document.createElement('th');
  th.className = 'drf-th';
  th.innerHTML = `<span class="drf-th-title">DRF <span class="drf-th-edit">✎ editable</span></span>` +
                 `<span class="drf-th-sub">per person per µg/m³ above ${X0}</span>`;
  headRow.insertBefore(th, headRow.children[1] || null);
}

function setupDrfToolbar(table) {
  if (!table || document.getElementById('drf-toolbar')) return;
  const bar = document.createElement('div');
  bar.id = 'drf-toolbar';
  bar.className = 'drf-toolbar';
  bar.innerHTML = `
    <div class="drf-hint">
      <span class="drf-hint-icon" aria-hidden="true">✎</span>
      <div>
        <strong>The DRF values are editable.</strong>
        Click any value in the DRF column to change it and results update instantly.
        Scientific notation works (e.g. <code>4e-5</code>).
        <div class="drf-formula">cases = DRF × population base × (PM2.5 − ${X0})</div>
        <div class="drf-aoi-note" id="drf-aoi-note">Draw an area on the map to see how your changes affect cases and costs.</div>
      </div>
    </div>
    <div class="drf-toolbar-actions">
      <span class="drf-badge hidden" id="drf-edited-badge">0 edited</span>
      <button type="button" class="drf-reset-all" id="drf-reset-all" disabled>↺ Reset all to defaults</button>
    </div>`;
  table.parentNode.insertBefore(bar, table);
  document.getElementById('drf-reset-all').addEventListener('click', resetAllDrf);
}

function buildMorbidityRows() {
  const tbody = document.getElementById('morbidity-body');
  if (!tbody) return;
  const table = tbody.closest('table');
  setupDrfHeader(table);
  setupDrfToolbar(table);

  tbody.innerHTML = EFFECTS.map((eff, i) => `
    <tr id="morb-row-${i}">
      <td class="effect-name">
        <div class="name">${eff.name}</div>
        <div class="acronym">${eff.acr} · ${BASE_LABEL[eff.base]}</div>
      </td>
      <td class="drf-cell">
        <div class="drf-field" id="drf-field-${i}">
          <input type="text" inputmode="decimal" class="drf-input" id="drf-input-${i}"
                 data-idx="${i}" value="${fmtDrf(eff.drf)}" autocomplete="off" spellcheck="false"
                 title="Click to edit this coefficient"
                 aria-label="Dose-response coefficient for ${eff.name}">
          <button type="button" class="drf-reset hidden" data-idx="${i}"
                  title="Reset to default (${fmtDrf(eff.drfDefault)})"
                  aria-label="Reset ${eff.name} coefficient to default">↺</button>
        </div>
        <div class="drf-msg" id="drf-msg-${i}"></div>
      </td>
      <td><span class="impact-val" id="morb-cases-${i}">—</span></td>
      <td><span class="cost-val" id="morb-cost-${i}">—</span></td>
    </tr>
  `).join('');

  bindDrfEvents(tbody);
  updateDrfToolbar();
}

function bindDrfEvents(tbody) {
  tbody.addEventListener('focusin', e => {
    if (e.target.matches('.drf-input')) e.target.select();   // click = ready to overtype
  });

  tbody.addEventListener('input', e => {
    if (!e.target.matches('.drf-input')) return;
    const i = +e.target.dataset.idx;
    const v = parseDrf(e.target.value);
    if (isNaN(v)) { setDrfInvalid(i); return; }              // keep last valid value in use
    EFFECTS[i].drf = v;
    onDrfChanged(i);
  });

  tbody.addEventListener('focusout', e => {                  // tidy the box on leave
    if (!e.target.matches('.drf-input')) return;
    const i = +e.target.dataset.idx;
    e.target.value = fmtDrf(EFFECTS[i].drf);
    refreshDrfRowState(i);
  });

  tbody.addEventListener('keydown', e => {
    if (e.target.matches('.drf-input') && (e.key === 'Enter' || e.key === 'Escape')) e.target.blur();
  });

  tbody.addEventListener('click', e => {
    const btn = e.target.closest('.drf-reset');
    if (btn) resetDrf(+btn.dataset.idx);
  });
}

function setDrfInvalid(i) {
  document.getElementById(`drf-field-${i}`)?.classList.add('invalid');
  const msg = document.getElementById(`drf-msg-${i}`);
  if (msg) {
    msg.textContent = 'Enter a number ≥ 0, e.g. 0.0004 or 4e-4';
    msg.className = 'drf-msg visible error';
  }
}

function refreshDrfRowState(i) {
  const eff = EFFECTS[i];
  const edited = eff.drf !== eff.drfDefault;
  const field = document.getElementById(`drf-field-${i}`);
  const msg = document.getElementById(`drf-msg-${i}`);
  field?.classList.remove('invalid');
  field?.classList.toggle('edited', edited);
  field?.querySelector('.drf-reset')?.classList.toggle('hidden', !edited);
  if (msg) {
    msg.textContent = edited ? `default ${fmtDrf(eff.drfDefault)}` : '';
    msg.className = 'drf-msg' + (edited ? ' visible' : '');
  }
}

function updateDrfToolbar() {
  const n = EFFECTS.filter(e => e.drf !== e.drfDefault).length;
  const badge = document.getElementById('drf-edited-badge');
  const resetAll = document.getElementById('drf-reset-all');
  if (badge) {
    badge.textContent = `${n} edited`;
    badge.classList.toggle('hidden', n === 0);
  }
  if (resetAll) resetAll.disabled = (n === 0);
}

function updateDrfAoiNote() {
  document.getElementById('drf-aoi-note')?.classList.toggle('hidden', !!lastBoxResults);
}

function onDrfChanged(i) {
  refreshDrfRowState(i);
  updateDrfToolbar();
  refreshMorbidityOnly();
  const row = document.getElementById(`morb-row-${i}`);
  if (row && lastBoxResults) {                               // brief highlight on the row that moved
    row.classList.remove('drf-flash');
    void row.offsetWidth;
    row.classList.add('drf-flash');
  }
}

function resetDrf(i) {
  EFFECTS[i].drf = EFFECTS[i].drfDefault;
  const input = document.getElementById(`drf-input-${i}`);
  if (input) input.value = fmtDrf(EFFECTS[i].drf);
  onDrfChanged(i);
}

function resetAllDrf() {
  EFFECTS.forEach((eff, i) => {
    eff.drf = eff.drfDefault;
    const input = document.getElementById(`drf-input-${i}`);
    if (input) input.value = fmtDrf(eff.drf);
    refreshDrfRowState(i);
  });
  updateDrfToolbar();
  refreshMorbidityOnly();
}

// Re-run only the morbidity maths from the last box's totals
function refreshMorbidityOnly() {
  if (!lastBoxResults) return;
  const r = lastBoxResults;
  const z = Math.max(r.avgBoxPm - X0, 0);
  const { morbidityCostUSD, breakdown } = calculateMorbidity(r.totalPop, r.frac25 / 100, z, r.gdpCorrection);
  r.morbidityCostUSD = morbidityCostUSD;
  r.combinedCostUSD = r.totalMortalityCostUSD + morbidityCostUSD;
  r.breakdown = breakdown;
  updateText('totalMorbidityCost', fmtMoney(morbidityCostUSD));
  updateText('totalCombinedCost', fmtMoney(r.combinedCostUSD));
}

function calculateMorbidity(totalPop, frac25, z, gdpCorrection = 1) {
  const popAdult = totalPop * frac25;
  const popUnder25 = totalPop - popAdult;
  const popByBase = { all: totalPop, adult: popAdult, under25: popUnder25 };

  let morbidityCostUSD = 0;
  const breakdown = [];
  EFFECTS.forEach((eff, i) => {
    const basePop = popByBase[eff.base];
    const cases = eff.drf * basePop * z;
    const costUSD = cases * eff.cost * gdpCorrection;
    morbidityCostUSD += costUSD;
    breakdown.push({ acr: eff.acr, name: eff.name, drf: eff.drf, edited: eff.drf !== eff.drfDefault, cases, costUSD });
    updateText(`morb-cases-${i}`, Math.round(cases).toLocaleString('en-US'));
    updateText(`morb-cost-${i}`, fmtMoney(costUSD));
  });

  return { morbidityCostUSD, breakdown };
}

// Bind full recalculation to the population / economic input fields
['deathRate', 'pop25', 'vsl', 'vslRef', 'gdp', 'gdpRef', 'elasticity'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', function() {
    if (activeBounds) renderHealthImpacts();
  });
});

document.getElementById('morbidity-toggle')?.addEventListener('click', function() {
  const content = document.getElementById('morbidity-content');
  if (!content) return;
  const isOpen = !content.classList.contains('hidden');
  content.classList.toggle('hidden', isOpen);
  this.classList.toggle('open', !isOpen);
});

buildMorbidityRows();
document.getElementById('btn-show-heatmap')?.addEventListener('click', renderHealthImpacts);

document.getElementById('btn-clear-heatmap')?.addEventListener('click', function() {
  heatmapLayer.clearLayers();
  this.classList.add('hidden');
});

// ── BOX RESULTS CSV EXPORT ─────────────────────────────────────
function buildBoxResultsCsv(r) {
  const rows = [
    ['Metric', 'Value'],
    ['Area (km2)', r.areaKm2.toFixed(0)],
    ['Total Population', Math.round(r.totalPop)],
    ['Average PM2.5 (ug/m3)', r.avgBoxPm.toFixed(2)],
    ['Baseline Death Rate (per 1000)', r.baselineDeathRate],
    ['Population Aged 25+ (%)', r.frac25.toFixed(1)],
    ['Value of Statistical Life (USD)', r.vsl],
    [''],
    ['Estimated Mortality (cases/yr)', r.totalMortality.toFixed(2)],
    ['Cost of Mortality (USD)', r.totalMortalityCostUSD.toFixed(2)],
    ['Total Morbidity Cost (USD)', r.morbidityCostUSD.toFixed(2)],
    ['Combined Mortality + Morbidity Cost (USD)', r.combinedCostUSD.toFixed(2)],
    [''],
    ['Morbidity Effect', 'DRF used', 'Cases/yr', 'Cost (USD)']
  ];

  r.breakdown.forEach(b => {
    rows.push([`${b.name} (${b.acr})`, b.drf + (b.edited ? ' (edited)' : ''), b.cases.toFixed(2), b.costUSD.toFixed(2)]);
  });

  if (r.breakdown.some(b => b.edited)) {
    rows.push([''], ['Note', 'DRF values marked (edited) differ from the default coefficients']);
  }

  return rows.map(row => row.map(cell => {
    const s = String(cell);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
}

document.getElementById('btn-download-box-csv')?.addEventListener('click', function() {
  if (!lastBoxResults) return;
  const csv = buildBoxResultsCsv(lastBoxResults);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'box_results.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// Run application
init();