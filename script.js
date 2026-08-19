/* ---- Fixed GEMM model constants (Burnett et al. 2018) ---- */
const THETA = 0.143, ALPHA = 1.6, MU = 15.5, NU = 36.8, X0 = 2.4;

/* ---- Morbidity effects: base = 'all' | 'adult' | 'under25' ---- */
const EFFECTS = [
  {acr:"ACB", name:"Adult Chronic Bronchitis",     drf:0.00004,  cost:300000, base:"adult"},
  {acr:"CAB", name:"Child Acute Bronchitis",        drf:0.000544, cost:300000, base:"under25"},
  {acr:"RHA", name:"Respiratory Hospital Admission",drf:0.000012, cost:1000,   base:"all"},
  {acr:"CHA", name:"Cardiac Hospital Admission",    drf:0.000005, cost:100000, base:"adult"},
  {acr:"ERV", name:"Emergency Room Visit",          drf:0.000235, cost:1000,   base:"all"},
  {acr:"AA",  name:"Asthma Attacks",                drf:0.0029,   cost:50,     base:"all"},
  {acr:"RAD", name:"Restricted Activity Days",      drf:0.03828,  cost:500,    base:"adult"},
  {acr:"RSD", name:"Respiratory Symptom Days",      drf:0.183,    cost:30,     base:"all"},
];
const DEFAULTS = JSON.parse(JSON.stringify(EFFECTS));

const BASE_SLIDER_MAX = {ACB:2000000, CAB:2000000, RHA:6000, CHA:600000, ERV:6000, AA:300, RAD:3000, RSD:200};
const BASE_LABEL = {all:"population base: all ages", adult:"population base: adult 25+", under25:"population base: under 25"};

const CURRENCY = {
  USD:{symbol:"$", rate:1},
  INR:{symbol:"₹", rate:87},
  EUR:{symbol:"€", rate:0.92},
  GBP:{symbol:"£", rate:0.79},
  JPY:{symbol:"¥", rate:148},
  AUD:{symbol:"A$", rate:1.52},
};

const $ = id => document.getElementById(id);
const pm25Input = $('pm25'), popInput = $('population'), deathRateInput = $('deathRate'),
      pop25Input = $('pop25'), gdpInput = $('gdp'), gdpRefInput = $('gdpRef'),
      vslRefInput = $('vslRef'), elasticityInput = $('elasticity');
const tbody = $('effectsBody');
const currencySelect = $('currencySelect'), fxRateInput = $('fxRate'), fxCodeSpan = $('fxCode');

function fmtInt(n){ return Math.round(n).toLocaleString('en-US'); }
function fmtMoney(n, symbol){
  if(!isFinite(n)) n = 0;
  let out;
  if(Math.abs(n) >= 1e9) out = (n/1e9).toFixed(1)+"B";
  else if(Math.abs(n) >= 1e6) out = Math.round(n/1e6)+"M";
  else out = Math.round(n).toLocaleString('en-US');
  return symbol + out;
}

function buildRows(){
  tbody.innerHTML = "";
  EFFECTS.forEach((eff, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="effect-name">
        <div class="name">${eff.name}</div>
        <div class="acronym">${eff.acr}</div>
        <div class="pop-base">${BASE_LABEL[eff.base]}</div>
      </td>
      <td>
        <input type="number" class="drf-input" data-idx="${i}" data-field="drf" value="${eff.drf}" step="any" min="0">
      </td>
      <td class="cost-cell">
        <div class="cost-row-top">
          <span class="currency-sym">$</span>
          <input type="number" class="cost-num" data-idx="${i}" data-field="costnum" value="${eff.cost}" min="0" step="1">
        </div>
        <input type="range" class="cost-slider" data-idx="${i}" data-field="costslider" min="0" max="${BASE_SLIDER_MAX[eff.acr]}" step="${Math.max(1, Math.round(BASE_SLIDER_MAX[eff.acr]/500))}" value="${eff.cost}">
      </td>
      <td><span class="impact-val" id="impact-${i}">—</span></td>
      <td><span class="cost-val" id="cost-${i}">—</span></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('input[data-field="drf"]').forEach(el=>{
    el.addEventListener('input', e=>{
      EFFECTS[+e.target.dataset.idx].drf = parseFloat(e.target.value) || 0;
      calculate();
    });
  });
  tbody.querySelectorAll('input[data-field="costnum"]').forEach(el=>{
    el.addEventListener('input', e=>{
      const idx = +e.target.dataset.idx;
      const val = parseFloat(e.target.value) || 0;
      EFFECTS[idx].cost = val;
      const slider = tbody.querySelector(`input[data-field="costslider"][data-idx="${idx}"]`);
      if(val > +slider.max) slider.max = val * 1.2;
      slider.value = val;
      calculate();
    });
  });
  tbody.querySelectorAll('input[data-field="costslider"]').forEach(el=>{
    el.addEventListener('input', e=>{
      const idx = +e.target.dataset.idx;
      const val = parseFloat(e.target.value) || 0;
      EFFECTS[idx].cost = val;
      tbody.querySelector(`input[data-field="costnum"][data-idx="${idx}"]`).value = val;
      calculate();
    });
  });
}

function calculate(){
  const pm25 = parseFloat(pm25Input.value) || 0;
  const popTotal = parseFloat(popInput.value) || 0;
  const y0 = (parseFloat(deathRateInput.value) || 0) / 1000;
  const frac25 = (parseFloat(pop25Input.value) || 0) / 100;
  const gdp = parseFloat(gdpInput.value) || 0;
  const gdpRef = parseFloat(gdpRefInput.value) || 1;
  const vslRef = parseFloat(vslRefInput.value) || 0;
  const elasticity = parseFloat(elasticityInput.value) || 0;

  const code = currencySelect.value;
  const rate = parseFloat(fxRateInput.value) || CURRENCY[code].rate;
  const symbol = CURRENCY[code].symbol;

  /* GEMM hazard ratio */
  const z = Math.max(pm25 - X0, 0);
  const dum1 = THETA * Math.log(1 + z / ALPHA);
  const dum2 = 1 + Math.exp(-(z - MU) / NU);
  const HR = Math.exp(dum1 / dum2);
  const AF = (HR - 1) / HR;

  const popAdult = popTotal * frac25;
  const popUnder25 = popTotal - popAdult;

  const mortalityCases = AF * y0 * popAdult;
  const VSL = vslRef * Math.pow(gdp / gdpRef, elasticity);
  const mortalityCostUSD = mortalityCases * VSL;

  /* Morbidity */
  let morbidityCostUSD = 0;
  const popByBase = {all: popTotal, adult: popAdult, under25: popUnder25};
  EFFECTS.forEach((eff, i) => {
    const basePop = popByBase[eff.base];
    const cases = eff.drf * basePop;
    const costUSD = cases * eff.cost;
    morbidityCostUSD += costUSD;
    document.getElementById(`impact-${i}`).textContent = fmtInt(cases);
    document.getElementById(`cost-${i}`).textContent = fmtMoney(costUSD, '$');
  });

  const combinedCostUSD = mortalityCostUSD + morbidityCostUSD;

  $('totalMortalityCount').textContent = fmtInt(mortalityCases);
  $('totalMortalityCost').textContent = fmtMoney(mortalityCostUSD * rate, symbol);
  $('totalMorbidityCost').textContent = fmtMoney(morbidityCostUSD * rate, symbol);
  $('totalCombinedCost').textContent = fmtMoney(combinedCostUSD * rate, symbol);

  if(code === 'USD'){
    $('totalMortalityCostUSD').textContent = '';
    $('totalMorbidityCostUSD').textContent = '';
    $('totalCombinedCostUSD').textContent = '';
  } else {
    $('totalMortalityCostUSD').textContent = '≈ ' + fmtMoney(mortalityCostUSD, '$') + ' USD';
    $('totalMorbidityCostUSD').textContent = '≈ ' + fmtMoney(morbidityCostUSD, '$') + ' USD';
    $('totalCombinedCostUSD').textContent = '≈ ' + fmtMoney(combinedCostUSD, '$') + ' USD';
  }

  $('diagHR').textContent = HR.toFixed(2);
  $('diagAF').textContent = (AF*100).toFixed(1) + '%';
  $('diagVSL').textContent = fmtMoney(VSL, '$');
}

[pm25Input, popInput, deathRateInput, pop25Input, gdpInput, gdpRefInput, vslRefInput, elasticityInput]
  .forEach(el => el.addEventListener('input', calculate));

currencySelect.addEventListener('change', ()=>{
  const code = currencySelect.value;
  fxRateInput.value = CURRENCY[code].rate;
  fxCodeSpan.textContent = code;
  calculate();
});
fxRateInput.addEventListener('input', calculate);

$('resetBtn').addEventListener('click', ()=>{
  DEFAULTS.forEach((d, i)=>{
    EFFECTS[i].drf = d.drf;
    EFFECTS[i].cost = d.cost;
  });
  buildRows();
  calculate();
});

buildRows();
fxRateInput.value = CURRENCY[currencySelect.value].rate;
fxCodeSpan.textContent = currencySelect.value;
calculate();