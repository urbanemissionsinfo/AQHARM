// ── CONFIGURATION & CONSTANTS ────────────────────────────────
const CONFIG = {
  populationTifPath: 'data/landscan-southasia-2024-compressed.tif',
  pm25TifPath: 'data/meanpm25_india_wustl_2023_zstd.tif'
};

/* GEMM model constants (Burnett et al. 2018) */
const THETA = 0.143, ALPHA = 1.6, MU = 15.5, NU = 36.8, X0 = 2.4;

// ── UI HELPER (PREVENTS ERRORS ON MISSING DOM ELEMENTS) ───────
function updateText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// ── MAP INIT ────────────────────────────────────────────────--
const map = L.map('map', { center: [22.5, 82.0], zoom: 5, zoomControl: true });

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

// Trigger calculations immediately when the box is drawn
map.on(L.Draw.Event.CREATED, function (e) {
  drawnItems.clearLayers();
  drawnItems.addLayer(e.layer);
  activeBounds = e.layer.getBounds();
  updateAOIState(true);
  calculateBoxResults();
});

// Update calculations if the box is edited/resized
map.on(L.Draw.Event.EDITED, function (e) {
  e.layers.eachLayer(function (layer) { activeBounds = layer.getBounds(); });
  calculateBoxResults();
});

map.on(L.Draw.Event.DELETED, function () {
  clearBoundingBox();
});

function clearBoundingBox() {
  drawnItems.clearLayers();
  activeBounds = null;
  updateAOIState(false);

  updateText('stat-area', 'Full Extent');
  updateText('stat-pop-total', '0');
  updateText('stat-avg-pm25', '—');
  updateText('totalMortalityCount', '—');
  updateText('totalMortalityCost', '—');
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

// ── RASTER LAYER GENERATOR ────────────────────────────────────
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

// ── GEOTIFF LOADER ───────────────────────────────────────────
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
    bbox: bbox
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

// ── CALCULATION EXECUTION (NO HEATMAP VISUALS) ───────────────
function calculateBoxResults() {
  if (!activeBounds) return; // No box drawn
  if (!rawTifInfo.population || !rawTifInfo.pm25) {
    console.warn("Rasters are still loading. Cannot calculate yet.");
    return;
  }

  const deathRateEl = document.getElementById('deathRate');
  const pop25El = document.getElementById('pop25');
  const vslEl = document.getElementById('vsl');

  const baselineDeathRate = deathRateEl ? parseFloat(deathRateEl.value) || 6.6 : 6.6;
  const frac25 = pop25El ? (parseFloat(pop25El.value) || 70) / 100 : 0.70;
  const vsl = vslEl ? parseFloat(vslEl.value) || 0 : 0;

  const bbox = { swLng: activeBounds.getWest(), swLat: activeBounds.getSouth(), neLng: activeBounds.getEast(), neLat: activeBounds.getNorth() };
  const cells = computeGrid01(bbox);

  let totalMortality = 0, totalPop = 0, pmSum = 0, pmCount = 0;

  // Process math behind the scenes silently 
  cells.forEach(c => {
    const impact = calculateCellImpact(c, baselineDeathRate, frac25);
    if (impact) {
      totalMortality += impact.mortality;
      totalPop += impact.pop;
      if (impact.pm25 > 0) {
        pmSum += impact.pm25;
        pmCount++;
      }
    }
  });

  // Calculate Aggregates
  const avgBoxPm = pmCount > 0 ? (pmSum / pmCount) : 0;
  const totalCost = totalMortality * vsl;

  // Approximate Area in km²
  const lat1 = bbox.swLat * Math.PI / 180;
  const lat2 = bbox.neLat * Math.PI / 180;
  const dLng = Math.abs(bbox.neLng - bbox.swLng) * Math.PI / 180;
  const areaKm2 = 6371.0088 * 6371.0088 * dLng * Math.abs(Math.sin(lat2) - Math.sin(lat1));

  // Update UI Elements
  updateText('stat-area', `${areaKm2.toLocaleString(undefined, { maximumFractionDigits: 0 })} km²`);
  updateText('stat-pop-total', Math.round(totalPop).toLocaleString('en-US'));
  updateText('stat-avg-pm25', `${avgBoxPm.toFixed(1)} µg/m³`);
  updateText('totalMortalityCount', Math.round(totalMortality).toLocaleString('en-US'));

  let costStr = "$" + Math.round(totalCost).toLocaleString('en-US');
  if (totalCost >= 1e9) costStr = "$" + (totalCost/1e9).toFixed(1) + "B";
  else if (totalCost >= 1e6) costStr = "$" + Math.round(totalCost/1e6) + "M";
  updateText('totalMortalityCost', costStr);
}

// Ensure the results recalculate dynamically if a user changes the inputs 
// while a bounding box is currently drawn
document.getElementById('deathRate')?.addEventListener('input', calculateBoxResults);
document.getElementById('pop25')?.addEventListener('input', calculateBoxResults);
document.getElementById('vsl')?.addEventListener('input', calculateBoxResults);

// Run application
init();