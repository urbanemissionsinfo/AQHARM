// ── CONFIGURATION & CONSTANTS ────────────────────────────────
const CONFIG = {
  populationTifPath: 'data/landscan-southasia-2024-compressed.tif',
  pm25TifPath: 'data/meanpm25_india_wustl_2023_zstd.tif'
};

/* GEMM model constants (Burnett et al. 2018) */
const THETA = 0.143, ALPHA = 1.6, MU = 15.5, NU = 36.8, X0 = 2.4;

// ── MAP INIT ──────────────────────────────────────────────────
const map = L.map('map', { center: [22.5, 82.0], zoom: 5, zoomControl: true });

L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
  attribution: 'Tiles &copy; Esri',
  maxZoom: 18
}).addTo(map);

// ── STATE VARIABLES ───────────────────────────────────────────
const layers = {
  population: null,
  pm25: null
};

let rawTifInfo = {
  population: null,
  pm25: null
};
let activeBounds = null;

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

document.getElementById('drawRectBtn').addEventListener('click', function() {
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
});

map.on(L.Draw.Event.EDITED, function (e) {
  e.layers.eachLayer(function (layer) { activeBounds = layer.getBounds(); });
});

map.on(L.Draw.Event.DELETED, function () {
  clearBoundingBox();
});

function clearBoundingBox() {
  drawnItems.clearLayers();
  activeBounds = null;
  heatmapLayer.clearLayers();
  updateAOIState(false);

  document.getElementById('stat-area').textContent = 'Full Extent';
  document.getElementById('stat-pop-total').textContent = '0';
  document.getElementById('stat-avg-pm25').textContent = '—';
  document.getElementById('totalMortalityCount').textContent = '—';
  document.getElementById('totalMortalityCost').textContent = '—';
}

function updateAOIState(hasBox) {
  const statusEl = document.getElementById('selection-status');
  const clearBtn = document.getElementById('btn-clear-box');
  if (hasBox) {
    statusEl.textContent = "Filtered Box Area";
    statusEl.style.color = "#164D12";
    clearBtn.classList.remove('hidden');
  } else {
    statusEl.textContent = "Entire Extent";
    statusEl.style.color = "#6b7268";
    clearBtn.classList.add('hidden');
  }
}

document.getElementById('btn-clear-box').addEventListener('click', clearBoundingBox);

// ── GEOTIFF LOADER ────────────────────────────────────────────
async function loadTifData(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);

  const arrayBuffer = await resp.arrayBuffer();
  const tif = await GeoTIFF.fromArrayBuffer(arrayBuffer);
  const image = await tif.getImage();
  const bbox = image.getBoundingBox();
  const fileDir = image.getFileDirectory();

  let nodata = fileDir.GDAL_NODATA !== undefined ? parseFloat(fileDir.GDAL_NODATA) : null;
  const rasters = await image.readRasters({ interleave: false });

  return {
    data: rasters[0],
    nodata: nodata,
    width: image.getWidth(),
    height: image.getHeight(),
    originX: bbox[0],
    originY: bbox[3],
    pixelW: (bbox[2] - bbox[0]) / image.getWidth(),
    pixelH: (bbox[3] - bbox[1]) / image.getHeight()
  };
}

// ── RASTER LAYER GENERATOR (tile-based, aligns perfectly with base map) ──
function createRasterLayer(tifInfo, colorScaleFn) {
  const layer = L.gridLayer({ opacity: 0.7, zIndex: 5 });

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
            const [r, g, b, a] = colorScaleFn(val);
            pixels[idx] = r;
            pixels[idx + 1] = g;
            pixels[idx + 2] = b;
            pixels[idx + 3] = a;
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

// ── COLOR SCALES & LEGEND ─────────────────────────────────────
function getPopulationColor(val) {
  if (val < 10)      return [255, 255, 178, 100];
  if (val < 50)      return [254, 204, 92,  160];
  if (val < 200)     return [253, 141, 60,  200];
  if (val < 500)     return [240, 59,  32,  230];
  return [189, 0, 38, 255];
}

function getPm25Color(val) {
  if (val <= 12)  return [0, 200, 83, 150];
  if (val <= 35)  return [255, 235, 59, 180];
  if (val <= 55)  return [255, 152, 0, 200];
  if (val <= 150) return [244, 67, 54, 220];
  return [136, 14, 79, 240];
}

const LegendControl = L.Control.extend({
  options: { position: 'bottomright' },
  onAdd: function() {
    const div = L.DomUtil.create('div', 'info legend');
    div.id = 'map-legend';
    div.style.background = 'white';
    div.style.padding = '10px 14px';
    div.style.borderRadius = '8px';
    div.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
    div.style.border = '1px solid #dde0d8';
    div.style.fontFamily = 'inherit';
    div.style.fontSize = '0.8rem';
    div.style.lineHeight = '1.4';
    div.style.color = '#1a1e18';
    div.innerHTML = '<b>Legend</b><br><span style="color:#6b7268;">Toggle a layer to view details</span>';
    return div;
  }
});

const legend = new LegendControl().addTo(map);

function updateLegend() {
  const legendDiv = document.getElementById('map-legend');
  const hasPop = map.hasLayer(layers.population);
  const hasPm25 = map.hasLayer(layers.pm25);

  if (!hasPop && !hasPm25) {
    legendDiv.innerHTML = '<b>Legend</b><br><span style="color:#6b7268;">No layers active</span>';
    return;
  }

  let html = '';
  if (hasPop) {
    html += `<b>Population Density</b><br>` +
      `<i style="background:rgba(255,255,178,0.8); width:12px; height:12px; display:inline-block; margin-right:5px;"></i> &lt; 10<br>` +
      `<i style="background:rgba(254,204,92,0.8); width:12px; height:12px; display:inline-block; margin-right:5px;"></i> 10 – 49<br>` +
      `<i style="background:rgba(253,141,60,0.8); width:12px; height:12px; display:inline-block; margin-right:5px;"></i> 50 – 199<br>` +
      `<i style="background:rgba(240,59,32,0.8); width:12px; height:12px; display:inline-block; margin-right:5px;"></i> 200 – 499<br>` +
      `<i style="background:rgba(189,0,38,0.8); width:12px; height:12px; display:inline-block; margin-right:5px;"></i> &ge; 500<br>`;
  }

  if (hasPop && hasPm25) {
    html += `<hr style="border:none; border-top:1px solid #dde0d8; margin:6px 0;">`;
  }

  if (hasPm25) {
    html += `<b>PM2.5 (µg/m³)</b><br>` +
      `<i style="background:rgba(0,200,83,0.8); width:12px; height:12px; display:inline-block; margin-right:5px;"></i> 0 – 12<br>` +
      `<i style="background:rgba(255,235,59,0.8); width:12px; height:12px; display:inline-block; margin-right:5px;"></i> 12 – 35<br>` +
      `<i style="background:rgba(255,152,0,0.8); width:12px; height:12px; display:inline-block; margin-right:5px;"></i> 35 – 55<br>` +
      `<i style="background:rgba(244,67,54,0.8); width:12px; height:12px; display:inline-block; margin-right:5px;"></i> 55 – 150<br>` +
      `<i style="background:rgba(136,14,79,0.8); width:12px; height:12px; display:inline-block; margin-right:5px;"></i> &gt; 150<br>`;
  }

  legendDiv.innerHTML = html;
}

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

    const baselineDeathRate = parseFloat(document.getElementById('deathRate').value) || 6.6;
    const frac25 = (parseFloat(document.getElementById('pop25').value) || 70) / 100;
    const vsl = parseFloat(document.getElementById('vsl').value) || 0;

    const bbox = { swLng: activeBounds.getWest(), swLat: activeBounds.getSouth(), neLng: activeBounds.getEast(), neLat: activeBounds.getNorth() };
    const cells = computeGrid01(bbox);

    const gridData = [];
    let totalMortality = 0;
    let totalPop = 0;
    let pmSum = 0;
    let pmCount = 0;

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

    const maxMortality = Math.max(...gridData.map(d => d.mortality));

    gridData.forEach(d => {
        if (d.mortality === 0) return;

        const rect = L.rectangle(d.bounds, {
            color: '#000000', weight: 0.5,
            fillColor: getHeatmapColor(d.mortality, maxMortality),
            fillOpacity: 0.7
        });

        rect.bindTooltip(`
            <div style="text-align:center;">
                <b>Premature Mortality:</b> ${d.mortality.toFixed(2)} cases/yr<br>
                <b>Local PM2.5:</b> ${d.pm25.toFixed(1)} µg/m³<br>
                <b>Cell Population:</b> ${d.pop.toFixed(0)}
            </div>
        `);

        heatmapLayer.addLayer(rect);
    });

    const avgBoxPm = pmCount > 0 ? (pmSum / pmCount) : 0;
    const totalCost = totalMortality * vsl;

    const lat1 = bbox.swLat * Math.PI / 180;
    const lat2 = bbox.neLat * Math.PI / 180;
    const dLng = Math.abs(bbox.neLng - bbox.swLng) * Math.PI / 180;
    const areaKm2 = 6371.0088 * 6371.0088 * dLng * Math.abs(Math.sin(lat2) - Math.sin(lat1));

    document.getElementById('stat-area').textContent = `${areaKm2.toLocaleString(undefined, { maximumFractionDigits: 0 })} km²`;
    document.getElementById('stat-pop-total').textContent = Math.round(totalPop).toLocaleString('en-US');
    document.getElementById('stat-avg-pm25').textContent = `${avgBoxPm.toFixed(1)} µg/m³`;
    document.getElementById('totalMortalityCount').textContent = Math.round(totalMortality).toLocaleString('en-US');

    let costStr = "$" + Math.round(totalCost).toLocaleString('en-US');
    if (totalCost >= 1e9) costStr = "$" + (totalCost/1e9).toFixed(1) + "B";
    else if (totalCost >= 1e6) costStr = "$" + Math.round(totalCost/1e6) + "M";
    document.getElementById('totalMortalityCost').textContent = costStr;

    document.getElementById('btn-clear-heatmap').classList.remove('hidden');
}

document.getElementById('btn-show-heatmap').addEventListener('click', renderHealthImpacts);

document.getElementById('btn-clear-heatmap').addEventListener('click', function() {
    heatmapLayer.clearLayers();
    this.classList.add('hidden');
});

// ── INIT APPLICATION ─────────────────────────────────────────
async function init() {
  const btnPop = document.getElementById('btn-population');
  const btnPm25 = document.getElementById('btn-pm25');

  try {
    rawTifInfo.population = await loadTifData(CONFIG.populationTifPath);
    layers.population = createRasterLayer(rawTifInfo.population, getPopulationColor);
    btnPop.textContent = 'Toggle Population';
    btnPop.disabled = false;
  } catch (err) {
    btnPop.textContent = 'Pop Error (Check Path)';
    console.error('Failed to load Population TIF:', err);
  }

  try {
    rawTifInfo.pm25 = await loadTifData(CONFIG.pm25TifPath);
    layers.pm25 = createRasterLayer(rawTifInfo.pm25, getPm25Color);
    btnPm25.textContent = 'Toggle PM2.5';
    btnPm25.disabled = false;
  } catch (err) {
    btnPm25.textContent = 'PM2.5 Error (Check Path)';
    console.error('Failed to load PM2.5 TIF:', err);
  }

  function handleToggle(layerName, btnElement) {
    const layer = layers[layerName];
    if (!layer) return;

    if (map.hasLayer(layer)) {
      map.removeLayer(layer);
      btnElement.classList.remove('active');
    } else {
      map.addLayer(layer);
      btnElement.classList.add('active');
    }
    updateLegend();
  }

  btnPop.addEventListener('click', () => handleToggle('population', btnPop));
  btnPm25.addEventListener('click', () => handleToggle('pm25', btnPm25));
}

init();