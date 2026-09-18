import { parquetReadObjects } from 'https://cdn.jsdelivr.net/npm/hyparquet@1.31.1/+esm'

const maplibregl = window.maplibregl

// ColorBrewer palettes
const SEQ_CENSUS = ['#f0f9e8', '#ccebc5', '#a8ddb5', '#7bccc4', '#4eb3d3', '#2b8cbe', '#08589e']
const DIV_CENSUS = ['#8c510a', '#bf812d', '#dfc27d', '#f6e8c3', '#c7eae5', '#80cdc1', '#35978f', '#01665e']
const SEQ_VOTE = ['#fcfbfd', '#efedf5', '#dadaeb', '#bcbddc', '#9e9ac8', '#807dba', '#6a51a3', '#4a1486']
const NA_COLOR = '#e8e6e1'
const Z_BREAKS = [-1.5, -1, -0.5, 0, 0.5, 1, 1.5]
const VOTE_BREAKS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]

const $ = (id) => document.getElementById(id)

// Minimal element builder: h('div', {class: 'x'}, 'text', childEl, ...)
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') Object.assign(el.style, v)
    else el.setAttribute(k, v)
  }
  el.append(...children.filter((c) => c != null))
  return el
}

async function loadParquet(url) {
  const buf = await (await fetch(url)).arrayBuffer()
  return parquetReadObjects({ file: buf })
}

// ---- Formatting --------------------------------------------------------------
const fmtPct = (v, d = 1) => `${(v * 100).toFixed(d)}%`
const fmtZ = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} SD`
const fmtValue = (v, kind) => (v == null ? 'No data' : kind === 'z' ? fmtZ(v) : fmtPct(v))

// ---- Classification ----------------------------------------------------------
function quantileBreaks(values, n) {
  const v = values.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return []
  const breaks = []
  for (let i = 1; i < n; i++) {
    const q = v[Math.min(v.length - 1, Math.floor((i * v.length) / n))]
    if (!breaks.length || q > breaks[breaks.length - 1]) breaks.push(q)
  }
  return breaks
}

// Pick `k` colours spread evenly across a palette
function spread(palette, k) {
  if (k >= palette.length) return palette.slice()
  if (k === 1) return [palette[palette.length - 1]]
  return Array.from({ length: k }, (_, i) => palette[Math.round((i * (palette.length - 1)) / (k - 1))])
}

function colorExpression(breaks, colors) {
  const step = ['step', ['feature-state', 'v'], colors[0]]
  breaks.forEach((b, i) => step.push(b, colors[i + 1]))
  return ['case', ['!=', ['typeof', ['feature-state', 'v']], 'number'], NA_COLOR, step]
}

function renderLegend(el, title, breaks, colors, fmt) {
  const row = (swatch, label) => h('div', { class: 'legend-row' }, swatch, label)
  const rows = colors.map((c, i) => {
    const lo = i === 0 ? null : breaks[i - 1]
    const hi = i === colors.length - 1 ? null : breaks[i]
    const label = lo == null ? `< ${fmt(hi)}` : hi == null ? `≥ ${fmt(lo)}` : `${fmt(lo)} – ${fmt(hi)}`
    return row(h('span', { class: 'swatch', style: { background: c } }), label)
  })
  rows.reverse()
  rows.push(row(h('span', { class: 'swatch swatch-na' }), 'No data'))
  el.replaceChildren(h('div', { class: 'legend-title' }, title), ...rows)
}

// ---- Maps --------------------------------------------------------------------
// OpenFreeMap vector basemap (free, no API key); the choropleth is inserted
// beneath its first label layer so place names stay readable.
const BASE_STYLE = 'https://tiles.openfreemap.org/styles/positron'

function makeMap(container, tracts, bounds) {
  const map = new maplibregl.Map({
    container,
    style: BASE_STYLE,
    bounds,
    fitBoundsOptions: { padding: 16 },
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: { compact: true, customAttribution: 'Boundaries: Statistics Canada' },
  })
  map.touchZoomRotate.disableRotation()
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')

  const ready = new Promise((resolve) => {
    map.on('load', () => {
      const firstLabel = map.getStyle().layers.find((l) => l.type === 'symbol')?.id
      map.addSource('tracts', { type: 'geojson', data: tracts, promoteId: 'ct' })
      map.addLayer({
        id: 'fill',
        type: 'fill',
        source: 'tracts',
        paint: { 'fill-color': NA_COLOR, 'fill-opacity': 0.85 },
      }, firstLabel)
      map.addLayer({
        id: 'outline',
        type: 'line',
        source: 'tracts',
        paint: { 'line-color': '#ffffff', 'line-width': 0.4, 'line-opacity': 0.8 },
      }, firstLabel)
      map.addLayer({
        id: 'hover',
        type: 'line',
        source: 'tracts',
        paint: {
          'line-color': '#111',
          'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2.2, 0],
        },
      }, firstLabel)
      resolve(map)
    })
  })
  return { map, ready }
}

function syncMaps(a, b) {
  let syncing = false
  const follow = (src, dst) => () => {
    if (syncing) return
    syncing = true
    dst.jumpTo({ center: src.getCenter(), zoom: src.getZoom() })
    syncing = false
  }
  a.on('move', follow(a, b))
  b.on('move', follow(b, a))
}

// ---- App ---------------------------------------------------------------------
async function main() {
  const [meta, tracts, censusRows, electionRows] = await Promise.all([
    fetch('data/meta.json').then((r) => r.json()),
    fetch('data/tracts.geojson').then((r) => r.json()),
    loadParquet('data/census.parquet'),
    loadParquet('data/elections.parquet'),
  ])

  const tractIds = tracts.features.map((f) => f.properties.ct)
  const tractName = new Map(tracts.features.map((f) => [f.properties.ct, f.properties.name]))

  // census: year -> ct -> row ; elections: "year|cand" -> ct -> share
  const censusByYear = new Map()
  for (const r of censusRows) {
    if (!censusByYear.has(r.year)) censusByYear.set(r.year, new Map())
    censusByYear.get(r.year).set(r.ct, r)
  }
  const elections = new Map()
  for (const r of electionRows) {
    const key = `${r.year}|${r.candidate}`
    if (!elections.has(key)) elections.set(key, new Map())
    elections.get(key).set(r.ct, r.share)
  }

  const varById = new Map(meta.variables.map((v) => [v.id, v]))
  const electionByYear = new Map(meta.elections.map((e) => [e.year, e]))

  // Bounds of all tracts
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity]
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0])
      minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1])
    } else c.forEach(walk)
  }
  tracts.features.forEach((f) => walk(f.geometry.coordinates))
  const bounds = [[minX, minY], [maxX, maxY]]

  // ---- State (initialised from URL hash, so views can be shared) ----
  const state = {
    cvar: 'imstimmi_pct', cyear: 2021, cscale: 'year', call: false,
    eyear: 2023, ecand: null, escale: 'fixed',
  }
  const hash = new URLSearchParams(location.hash.slice(1))
  if (varById.has(hash.get('cvar'))) state.cvar = hash.get('cvar')
  if (hash.get('cyear')) state.cyear = +hash.get('cyear')
  if (hash.get('cscale') === 'all') state.cscale = 'all'
  if (hash.get('call') === '1') state.call = true
  if (electionByYear.has(+hash.get('eyear'))) state.eyear = +hash.get('eyear')
  if (hash.get('ecand')) state.ecand = hash.get('ecand')
  if (hash.get('escale') === 'quantile') state.escale = 'quantile'
  if (!varById.get(state.cvar).curated) state.call = true

  const writeHash = () => {
    const p = new URLSearchParams({
      cvar: state.cvar, cyear: state.cyear, cscale: state.cscale, call: state.call ? 1 : 0,
      eyear: state.eyear, ecand: state.ecand, escale: state.escale,
    })
    history.replaceState(null, '', `#${p}`)
  }

  // ---- Controls ----
  const selVar = $('census-var'), selCYear = $('census-year'), selCScale = $('census-scale'), chkAll = $('census-all')
  const selCand = $('election-cand'), selEYear = $('election-year'), selEScale = $('election-scale')

  function fillVarSelect() {
    const groups = new Map()
    for (const v of meta.variables) {
      if (!state.call && !v.curated) continue
      if (!groups.has(v.group)) groups.set(v.group, [])
      groups.get(v.group).push(v)
    }
    selVar.replaceChildren(...[...groups].map(([g, vs]) =>
      h('optgroup', { label: g }, ...vs.map((v) => new Option(v.label, v.id)))))
    if (!varById.get(state.cvar).curated && !state.call) state.cvar = 'imstimmi_pct'
    selVar.value = state.cvar
  }

  function fillCensusYears() {
    const years = varById.get(state.cvar).years
    selCYear.replaceChildren(...years.map((y) => new Option(y, y)))
    if (!years.includes(state.cyear)) state.cyear = years[years.length - 1]
    selCYear.value = state.cyear
  }

  // Candidates are matched across elections by full name, since the column id
  // can differ between years (e.g. "tory" vs "tory_john").
  const people = new Map() // label -> [{ year, id }], ascending by year
  for (const e of meta.elections) {
    for (const c of e.candidates) {
      if (!people.has(c.label)) people.set(c.label, [])
      people.get(c.label).push({ year: e.year, id: c.id })
    }
  }
  const OTHER = 'All other candidates'
  const lastName = (label) => label.split(' ').pop()
  const peopleSorted = [...people.keys()].sort((a, b) =>
    (a === OTHER) - (b === OTHER) || lastName(a).localeCompare(lastName(b)) || a.localeCompare(b))

  const currentPerson = () =>
    electionByYear.get(state.eyear)?.candidates.find((c) => c.id === state.ecand)?.label

  // Default to the top candidate of the latest election if the hash is invalid
  if (!currentPerson()) {
    const latest = meta.elections[meta.elections.length - 1]
    if (!electionByYear.has(state.eyear)) state.eyear = latest.year
    state.ecand = electionByYear.get(state.eyear).candidates[0].id
  }

  selCand.replaceChildren(...peopleSorted.map((label) => {
    const years = people.get(label).map((r) => r.year)
    return new Option(`${label} (${years.join(', ')})`, label)
  }))

  // Restrict the year list to the elections the selected candidate ran in
  function fillElectionControls(person) {
    const runs = people.get(person)
    if (!runs.some((r) => r.year === state.eyear)) state.eyear = runs[runs.length - 1].year
    state.ecand = runs.find((r) => r.year === state.eyear).id
    selCand.value = person
    selEYear.replaceChildren(...runs.map((r) => new Option(r.year, r.year)))
    selEYear.value = state.eyear
    selEYear.disabled = runs.length === 1
  }

  chkAll.checked = state.call
  selCScale.value = state.cscale
  selEScale.value = state.escale
  fillVarSelect()
  fillCensusYears()
  fillElectionControls(currentPerson())

  // ---- Maps ----
  const left = makeMap('map-census', tracts, bounds)
  const right = makeMap('map-election', tracts, bounds)
  await Promise.all([left.ready, right.ready])
  syncMaps(left.map, right.map)
  $('loading').hidden = true

  const current = { census: new Map(), election: new Map() }

  function censusValues(year) {
    const rows = censusByYear.get(year)
    return new Map(tractIds.map((ct) => [ct, rows?.get(ct)?.[state.cvar] ?? null]))
  }

  function updateCensus() {
    const v = varById.get(state.cvar)
    const values = censusValues(state.cyear)
    current.census = values

    let breaks, colors
    if (v.kind === 'z') {
      breaks = Z_BREAKS
      colors = DIV_CENSUS
      selCScale.disabled = true
    } else {
      selCScale.disabled = false
      const pool = state.cscale === 'all'
        ? v.years.flatMap((y) => [...censusValues(y).values()])
        : [...values.values()]
      breaks = quantileBreaks(pool, SEQ_CENSUS.length)
      colors = spread(SEQ_CENSUS, breaks.length + 1)
    }

    for (const [ct, val] of values) left.map.setFeatureState({ source: 'tracts', id: ct }, { v: val })
    left.map.setPaintProperty('fill', 'fill-color', colorExpression(breaks, colors))

    const fmt = v.kind === 'z' ? (x) => (x > 0 ? `+${x}` : `${x}`) : (x) => fmtPct(x, 0)
    renderLegend($('legend-census'), v.kind === 'z' ? 'SD from tract mean' : v.label, breaks, colors, fmt)

    const vals = [...values.values()].filter((x) => x != null).sort((a, b) => a - b)
    const median = vals.length ? vals[Math.floor(vals.length / 2)] : null
    $('census-note').replaceChildren(
      h('strong', {}, v.label), `, ${state.cyear}. `,
      v.kind === 'z'
        ? 'Standard deviations from the tract mean for that census year.'
        : `Median tract: ${median == null ? 'n/a' : fmtPct(median)}.`,
    )
    writeHash()
  }

  function updateElection() {
    const e = electionByYear.get(state.eyear)
    const cand = e.candidates.find((c) => c.id === state.ecand)
    const shares = elections.get(`${state.eyear}|${state.ecand}`) ?? new Map()
    const values = new Map(tractIds.map((ct) => [ct, shares.get(ct) ?? null]))
    current.election = values

    let breaks, colors
    if (state.escale === 'fixed') {
      breaks = VOTE_BREAKS
      colors = SEQ_VOTE
    } else {
      breaks = quantileBreaks([...values.values()], SEQ_VOTE.length)
      colors = spread(SEQ_VOTE, breaks.length + 1)
    }

    for (const [ct, val] of values) right.map.setFeatureState({ source: 'tracts', id: ct }, { v: val })
    right.map.setPaintProperty('fill', 'fill-color', colorExpression(breaks, colors))
    renderLegend($('legend-election'), `${cand.label}, ${state.eyear}`, breaks, colors,
      (x) => fmtPct(x, state.escale === 'fixed' ? 0 : 1))

    $('election-note').replaceChildren(
      h('strong', {}, cand.label), `, ${state.eyear}. Citywide share, election day: ${fmtPct(cand.city_share)}.`,
    )
    writeHash()
  }

  // ---- Linked hover ----
  let hovered = null
  function readout(el, ct, label, value) {
    el.replaceChildren(
      h('div', { class: 'ct' }, `Tract ${tractName.get(ct) ?? ct}`),
      h('div', {}, label),
      h('div', { class: 'val' }, value),
    )
    el.hidden = false
  }

  function setHover(ct) {
    if (ct === hovered) return
    for (const m of [left.map, right.map]) {
      if (hovered) m.setFeatureState({ source: 'tracts', id: hovered }, { hover: false })
      if (ct) m.setFeatureState({ source: 'tracts', id: ct }, { hover: true })
    }
    hovered = ct
    if (!ct) {
      $('readout-census').hidden = true
      $('readout-election').hidden = true
      return
    }
    const v = varById.get(state.cvar)
    const cand = electionByYear.get(state.eyear).candidates.find((c) => c.id === state.ecand)
    readout($('readout-census'), ct, `${v.label}, ${state.cyear}`, fmtValue(current.census.get(ct), v.kind))
    readout($('readout-election'), ct, `${cand.label}, ${state.eyear}`, fmtValue(current.election.get(ct), 'pct'))
  }

  for (const m of [left.map, right.map]) {
    m.on('mousemove', 'fill', (ev) => {
      m.getCanvas().style.cursor = 'crosshair'
      setHover(ev.features[0]?.id ?? null)
    })
    m.on('mouseleave', 'fill', () => {
      m.getCanvas().style.cursor = ''
      setHover(null)
    })
  }

  const refreshHover = () => { const ct = hovered; hovered = null; setHover(ct) }

  // ---- Wire controls ----
  selVar.addEventListener('change', () => { state.cvar = selVar.value; fillCensusYears(); updateCensus(); refreshHover() })
  selCYear.addEventListener('change', () => { state.cyear = +selCYear.value; updateCensus(); refreshHover() })
  selCScale.addEventListener('change', () => { state.cscale = selCScale.value; updateCensus() })
  chkAll.addEventListener('change', () => { state.call = chkAll.checked; fillVarSelect(); fillCensusYears(); updateCensus() })
  selEYear.addEventListener('change', () => { state.eyear = +selEYear.value; fillElectionControls(selCand.value); updateElection(); refreshHover() })
  selCand.addEventListener('change', () => { fillElectionControls(selCand.value); updateElection(); refreshHover() })
  selEScale.addEventListener('change', () => { state.escale = selEScale.value; updateElection() })

  updateCensus()
  updateElection()
}

main().catch((err) => {
  console.error(err)
  const el = $('loading')
  el.hidden = false
  el.classList.add('error')
  el.textContent = `Could not load the app: ${err.message}`
})
