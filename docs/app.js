import { parquetReadObjects } from 'https://cdn.jsdelivr.net/npm/hyparquet@1.31.1/+esm'

const maplibregl = window.maplibregl

// ColorBrewer palettes
const SEQ_CENSUS = ['#f0f9e8', '#ccebc5', '#a8ddb5', '#7bccc4', '#4eb3d3', '#2b8cbe', '#08589e']
const DIV_CENSUS = ['#8c510a', '#bf812d', '#dfc27d', '#f6e8c3', '#c7eae5', '#80cdc1', '#35978f', '#01665e']
const SEQ_VOTE = ['#fcfbfd', '#efedf5', '#dadaeb', '#bcbddc', '#9e9ac8', '#807dba', '#6a51a3', '#4a1486']
const NA_COLOR = '#e8e6e1'
const Z_BREAKS = [-1.5, -1, -0.5, 0, 0.5, 1, 1.5]
const VOTE_BREAKS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]
// 0-100% in 10-point bins
const PERCENT_BREAKS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]

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
const fmtCount = (v) => (v == null ? 'n/a' : Math.round(v).toLocaleString('en-CA'))

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

// Interpolate a palette to `k` colours, for class counts the palette lacks
function ramp(palette, k) {
  const rgb = palette.map((c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)))
  return Array.from({ length: k }, (_, i) => {
    const pos = (i * (rgb.length - 1)) / (k - 1)
    const lo = Math.floor(pos), hi = Math.min(rgb.length - 1, lo + 1), f = pos - lo
    const mix = rgb[lo].map((c, j) => Math.round(c + (rgb[hi][j] - c) * f))
    return `#${mix.map((c) => c.toString(16).padStart(2, '0')).join('')}`
  })
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

// ---- Markdown ----------------------------------------------------------------
// Enough Markdown for the About page, rendered straight to DOM nodes
function inlineNodes(text) {
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)\s]+)\)/g
  const out = []
  let at = 0
  for (const m of text.matchAll(pattern)) {
    if (m.index > at) out.push(text.slice(at, m.index))
    if (m[1] != null) out.push(h('code', {}, m[1]))
    else if (m[2] != null) out.push(h('strong', {}, m[2]))
    else if (m[3] != null) out.push(h('em', {}, m[3]))
    else out.push(h('a', { href: m[5], rel: 'noopener noreferrer' }, m[4]))
    at = m.index + m[0].length
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}

function renderMarkdown(src) {
  const frag = document.createDocumentFragment()
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  let i = 0

  const listItems = (marker) => {
    const items = []
    while (i < lines.length && marker.test(lines[i])) {
      let text = lines[i].replace(marker, '')
      i++
      // wrapped list items are indented on the following lines
      while (i < lines.length && /^\s{2,}\S/.test(lines[i])) { text += ` ${lines[i].trim()}`; i++ }
      items.push(h('li', {}, ...inlineNodes(text)))
    }
    return items
  }

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      frag.append(h(`h${heading[1].length}`, {}, ...inlineNodes(heading[2])))
      i++
    } else if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      frag.append(h('hr'))
      i++
    } else if (/^\s*[-*]\s+/.test(line)) {
      frag.append(h('ul', {}, ...listItems(/^\s*[-*]\s+/)))
    } else if (/^\s*\d+\.\s+/.test(line)) {
      frag.append(h('ol', {}, ...listItems(/^\s*\d+\.\s+/)))
    } else if (/^>\s?/.test(line)) {
      const quote = []
      while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, '')); i++ }
      frag.append(h('blockquote', {}, h('p', {}, ...inlineNodes(quote.join(' ')))))
    } else {
      const para = []
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>\s?|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])) {
        para.push(lines[i].trim())
        i++
      }
      frag.append(h('p', {}, ...inlineNodes(para.join(' '))))
    }
  }
  return frag
}

// ---- Correlation -------------------------------------------------------------
// Regularized incomplete beta, for the two-sided p-value of Pearson's r
function betacf(a, b, x) {
  const tiny = 1e-30
  let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - (qab * x) / qap
  if (Math.abs(d) < tiny) d = tiny
  d = 1 / d
  let h = d
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 3e-7) break
  }
  return h
}

function lgamma(z) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]
  let x = z, y = z, tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let ser = 1.000000000190015
  for (let j = 0; j < 6; j++) ser += g[j] / ++y
  return -tmp + Math.log((2.5066282746310005 * ser) / x)
}

function ibeta(a, b, x) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const front = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) +
    a * Math.log(x) + b * Math.log(1 - x))
  return x < (a + 1) / (a + b + 2)
    ? (front * betacf(a, b, x)) / a
    : 1 - (front * betacf(b, a, 1 - x)) / b
}

// Pearson correlation over the tracts where both variables are present
function pearson(pairs) {
  const n = pairs.length
  if (n < 5) return null
  let sx = 0, sy = 0
  for (const [x, y] of pairs) { sx += x; sy += y }
  const mx = sx / n, my = sy / n
  let sxy = 0, sxx = 0, syy = 0
  for (const [x, y] of pairs) {
    const dx = x - mx, dy = y - my
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy
  }
  if (sxx === 0 || syy === 0) return null
  const r = sxy / Math.sqrt(sxx * syy)
  const df = n - 2
  const t2 = (r * r * df) / Math.max(1e-12, 1 - r * r)
  const p = ibeta(df / 2, 0.5, df / (df + t2))   // two-sided
  return { r, n, p }
}

const fmtP = (p) => (p < 0.001 ? 'p < 0.001' : `p = ${p.toFixed(3)}`)
const fmtR = (r) => `${r < 0 ? '−' : '+'}${Math.abs(r).toFixed(2)}`

// ---- Maps --------------------------------------------------------------------
// OpenFreeMap vector basemap (free, no API key); the choropleth is inserted
// beneath its first label layer so place names stay readable.
const BASE_STYLE = 'https://tiles.openfreemap.org/styles/positron'

const FIT_OPTIONS = { padding: 16 }

// Zoom in / zoom out / back to the whole city, in one control group
function navControl(map, bounds) {
  return {
    onAdd() {
      const button = (cls, label, onClick) => {
        const b = h('button', { class: cls, type: 'button', title: label, 'aria-label': label },
          h('span', { class: 'maplibregl-ctrl-icon', 'aria-hidden': 'true' }))
        b.addEventListener('click', onClick)
        return b
      }
      return h('div', { class: 'maplibregl-ctrl maplibregl-ctrl-group' },
        button('maplibregl-ctrl-zoom-in', 'Zoom in', () => map.zoomIn()),
        button('maplibregl-ctrl-zoom-out', 'Zoom out', () => map.zoomOut()),
        button('ctrl-fit', 'Zoom out to the whole city', () => map.fitBounds(bounds, FIT_OPTIONS)))
    },
    onRemove() {},
  }
}

function makeMap(container, tracts, bounds) {
  const map = new maplibregl.Map({
    container,
    style: BASE_STYLE,
    bounds,
    fitBoundsOptions: FIT_OPTIONS,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: { compact: true, customAttribution: 'Boundaries: Statistics Canada' },
  })
  map.touchZoomRotate.disableRotation()
  map.addControl(navControl(map, bounds), 'top-right')

  // Never zoom out past the whole city, and keep it in view when panning.
  // The limit depends on the panel size, so recompute whenever that changes.
  const [[west, south], [east, north]] = bounds
  const padX = (east - west) * 0.04
  const padY = (north - south) * 0.04
  map.setMaxBounds([[west - padX, south - padY], [east + padX, north + padY]])

  const limitZoom = () => {
    const camera = map.cameraForBounds(bounds, FIT_OPTIONS)
    if (camera) map.setMinZoom(camera.zoom - 0.01)
  }
  map.on('load', limitZoom)
  map.on('resize', limitZoom)

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
  const [meta, tracts, censusRows, electionRows, turnoutRows] = await Promise.all([
    fetch('data/meta.json').then((r) => r.json()),
    fetch('data/tracts.geojson').then((r) => r.json()),
    loadParquet('data/census.parquet'),
    loadParquet('data/elections.parquet'),
    loadParquet('data/turnout.parquet'),
  ])

  const tractIds = tracts.features.map((f) => f.properties.ct)
  const tractName = new Map(tracts.features.map((f) => [f.properties.ct, f.properties.name]))
  const tractGeog = new Map(tracts.features.map((f) => [f.properties.ct, f.properties]))

  // census: year -> ct -> row ; elections: "year|cand" -> ct -> {share, votes}
  const censusByYear = new Map()
  for (const r of censusRows) {
    if (!censusByYear.has(r.year)) censusByYear.set(r.year, new Map())
    censusByYear.get(r.year).set(r.ct, r)
  }
  const elections = new Map()
  for (const r of electionRows) {
    const key = `${r.year}|${r.candidate}`
    if (!elections.has(key)) elections.set(key, new Map())
    elections.get(key).set(r.ct, { share: r.share, votes: r.votes })
  }
  // Denominators per tract and election: "year|ct" -> {votes_cast, eligible}
  const turnout = new Map(turnoutRows.map((r) =>
    [`${r.year}|${r.ct}`, { cast: r.votes_cast, eligible: r.eligible }]))

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
    cvar: 'imstimmi_pct', cyear: 2021, cscale: 'quantile', call: false,
    eyear: 2023, ecand: null, escale: 'quantile', eall: false,
  }
  const hash = new URLSearchParams(location.hash.slice(1))
  if (varById.has(hash.get('cvar'))) state.cvar = hash.get('cvar')
  if (hash.get('cyear')) state.cyear = +hash.get('cyear')
  if (hash.get('cscale') === 'percent') state.cscale = 'percent'
  if (hash.get('call') === '1') state.call = true
  if (electionByYear.has(+hash.get('eyear'))) state.eyear = +hash.get('eyear')
  if (hash.get('ecand')) state.ecand = hash.get('ecand')
  if (hash.get('escale') === 'fixed') state.escale = 'fixed'
  if (hash.get('eall') === '1') state.eall = true
  if (!varById.get(state.cvar).curated) state.call = true

  const writeHash = () => {
    const p = new URLSearchParams({
      cvar: state.cvar, cyear: state.cyear, cscale: state.cscale, call: state.call ? 1 : 0,
      eyear: state.eyear, ecand: state.ecand, escale: state.escale, eall: state.eall ? 1 : 0,
    })
    history.replaceState(null, '', `#${p}`)
  }

  // ---- Controls ----
  const selVar = $('census-var'), selCYear = $('census-year'), selCScale = $('census-scale'), chkAll = $('census-all')
  const selCand = $('election-cand'), selEYear = $('election-year'), selEScale = $('election-scale')
  const chkECand = $('election-all')

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
    const v = varById.get(state.cvar)
    selCYear.replaceChildren(...v.years.map((y) => new Option(y, y)))
    if (!v.years.includes(state.cyear)) state.cyear = v.years[v.years.length - 1]
    selCYear.value = state.cyear
    // Scores, proximity measures and distance are measured once, not per census
    $('census-year-field').hidden = v.fixed_in_time
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

  // Everyone in the data took at least 1% of the citywide vote; the short list
  // is the top six of those who took more than 2%.
  function candidatesFor(year) {
    const all = electionByYear.get(year).candidates
    if (state.eall) return all
    const short = all.filter((c) => c.city_share > 0.02).slice(0, 6)
    // never hide the current selection
    const selected = all.find((c) => c.id === state.ecand)
    if (year === state.eyear && selected && !short.includes(selected)) short.push(selected)
    return short
  }

  const electionYears = meta.elections.map((e) => e.year).sort((a, b) => b - a)

  // Candidates grouped by election year, newest first
  function fillCandSelect() {
    selCand.replaceChildren(...electionYears.map((y) =>
      h('optgroup', { label: y },
        ...candidatesFor(y).map((c) => new Option(c.label, `${y}|${c.id}`)))))
    selCand.value = `${state.eyear}|${state.ecand}`
  }

  // Restrict the year list to the elections the selected candidate ran in
  function fillYearSelect() {
    const runs = people.get(currentPerson())
      .filter((r) => r.year === state.eyear || candidatesFor(r.year).some((c) => c.id === r.id))
    selEYear.replaceChildren(...runs.map((r) => new Option(r.year, r.year)))
    selEYear.value = state.eyear
    selEYear.disabled = runs.length === 1
  }

  function fillElectionControls() {
    fillCandSelect()
    fillYearSelect()
  }

  chkAll.checked = state.call
  chkECand.checked = state.eall
  selCScale.value = state.cscale
  selEScale.value = state.escale
  fillVarSelect()
  fillCensusYears()
  fillElectionControls()

  // ---- Maps ----
  const left = makeMap('map-census', tracts, bounds)
  const right = makeMap('map-election', tracts, bounds)
  await Promise.all([left.ready, right.ready])
  syncMaps(left.map, right.map)
  $('loading').hidden = true

  const current = { census: new Map(), election: new Map() }

  // updateCensus/updateElection both fire on one interaction; recompute once
  let corrQueued = false
  const updateCorrelationsLater = () => {
    if (corrQueued) return
    corrQueued = true
    queueMicrotask(() => { corrQueued = false; updateCorrelations() })
  }

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
    } else if (state.cscale === 'percent') {
      selCScale.disabled = false
      breaks = PERCENT_BREAKS
      colors = ramp(SEQ_CENSUS, PERCENT_BREAKS.length + 1)
    } else {
      selCScale.disabled = false
      breaks = quantileBreaks([...values.values()], SEQ_CENSUS.length)
      colors = spread(SEQ_CENSUS, breaks.length + 1)
    }

    for (const [ct, val] of values) left.map.setFeatureState({ source: 'tracts', id: ct }, { v: val })
    left.map.setPaintProperty('fill', 'fill-color', colorExpression(breaks, colors))

    const fmt = v.kind === 'z' ? (x) => (x > 0 ? `+${x}` : `${x}`) : (x) => fmtPct(x, 0)
    renderLegend($('legend-census'), v.kind === 'z' ? 'SD from tract mean' : v.label, breaks, colors, fmt)

    const vals = [...values.values()].filter((x) => x != null).sort((a, b) => a - b)
    const median = vals.length ? vals[Math.floor(vals.length / 2)] : null
    updateCorrelationsLater()
    $('census-note').replaceChildren(
      h('strong', {}, v.label), v.fixed_in_time ? '. ' : `, ${state.cyear}. `,
      v.fixed_in_time
        ? 'Measured once, not by census year. Standard deviations from the tract mean.'
        : v.kind === 'z'
          ? 'Standard deviations from the tract mean for that census year.'
          : `Median tract: ${median == null ? 'n/a' : fmtPct(median)}.`,
    )
    writeHash()
  }

  function updateElection() {
    const e = electionByYear.get(state.eyear)
    const cand = e.candidates.find((c) => c.id === state.ecand)
    const rows = elections.get(`${state.eyear}|${state.ecand}`) ?? new Map()
    const values = new Map(tractIds.map((ct) => [ct, rows.get(ct)?.share ?? null]))
    current.election = values
    current.electionVotes = new Map(tractIds.map((ct) => [ct, rows.get(ct)?.votes ?? null]))

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

    updateCorrelationsLater()
    $('election-note').replaceChildren(
      h('strong', {}, cand.label), `, ${state.eyear}. Citywide share, election day: ${fmtPct(cand.city_share)} ` +
      `(${fmtCount(cand.city_votes)} of ${fmtCount(e.city_votes_cast)} votes).`,
    )
    writeHash()
  }

  // ---- Linked hover ----
  // Second line of the census readout: the counts behind a share, or the
  // nominal value behind a z-score.
  const NOMINAL = {
    dollars: (x) => `$${Math.round(x).toLocaleString('en-CA')}`,
    per_km2: (x) => `${fmtCount(x)} people per km²`,
    km: (x) => `${x.toFixed(1)} km`,
    score100: (x) => `${x.toFixed(0)} out of 100`,
    index: (x) => `Index ${x.toFixed(3)} (0–1)`,
  }

  function censusDetail(v, ct) {
    const row = censusByYear.get(state.cyear)?.get(ct)
    if (!row) return null
    if (v.kind === 'z') {
      const nom = row[v.nom]
      return nom == null ? null : NOMINAL[v.unit](nom)
    }
    const num = row[v.num]
    const den = row[v.den]
    if (num == null || den == null) return null
    return `${fmtCount(num)} of ${fmtCount(den)} — ${v.den_label}`
  }

  let hovered = null
  function readout(el, ct, label, value, ...detail) {
    const g = tractGeog.get(ct) ?? {}
    el.replaceChildren(
      h('div', { class: 'ct' }, `Tract ${tractName.get(ct) ?? ct}`),
      h('div', { class: 'place' }, [g.nname, g.oldcity].filter(Boolean).join(' · ')),
      h('div', { class: 'place' }, g.ward ? `Ward ${+g.ward} ${g.wardname}` : ''),
      h('div', {}, label),
      h('div', { class: 'val' }, value),
      ...detail.filter(Boolean).map((d) => h('div', { class: 'detail' }, d)),
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
    readout($('readout-census'), ct, v.fixed_in_time ? v.label : `${v.label}, ${state.cyear}`,
      fmtValue(current.census.get(ct), v.kind), censusDetail(v, ct))
    const votes = current.electionVotes.get(ct)
    const den = turnout.get(`${state.eyear}|${ct}`)
    readout($('readout-election'), ct, `${cand.label}, ${state.eyear}`,
      fmtValue(current.election.get(ct), 'pct'),
      votes == null ? null : `${fmtCount(votes)} of ${fmtCount(den?.cast)} votes cast`,
      den?.eligible == null ? null
        : `Turnout ${fmtPct(den.cast / den.eligible, 0)} of ${fmtCount(den.eligible)} eligible`)
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

  // ---- Correlations drawer ----
  const drawer = $('corr-drawer'), corrToggle = $('corr-toggle')
  const svgNS = 'http://www.w3.org/2000/svg'
  const s = (tag, attrs = {}, ...kids) => {
    const el = document.createElementNS(svgNS, tag)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    el.append(...kids.filter((x) => x != null))
    return el
  }

  // Charts are drawn to fill whatever width flex gave their container
  const widthOf = (id) => Math.max(180, Math.floor($(id).clientWidth) - 2)

  // Vote share against one census variable, over tracts holding both
  function pairsFor(varId) {
    const rows = censusByYear.get(state.cyear)
    const out = []
    for (const ct of tractIds) {
      const x = rows?.get(ct)?.[varId]
      const y = current.election.get(ct)
      if (x != null && y != null) out.push([x, y])
    }
    return out
  }

  function scatter(pairs, v, stat, W) {   // stat drawn inside the plot area
    const H = Math.round(Math.min(275, Math.max(185, W * 0.78)))
    const m = { l: 48, r: 8, t: 8, b: 40 }
    if (!pairs.length) return s('svg', { width: W, height: H })
    const xs = pairs.map((p) => p[0]), ys = pairs.map((p) => p[1])
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
    const sx = (x) => m.l + ((x - x0) / (x1 - x0 || 1)) * (W - m.l - m.r)
    const sy = (y) => H - m.b - ((y - y0) / (y1 - y0 || 1)) * (H - m.t - m.b)
    const tick = (x, y, text, anchor) => s('text', { x, y, 'text-anchor': anchor, class: 'ax' }, text)
    const fmtX = (x) => (v.kind === 'z' ? x.toFixed(1) : fmtPct(x, 0))
    // trim an axis title that would run past the plot
    const fit = (text, px) => (text.length * 5.6 <= px ? text : `${text.slice(0, Math.max(6, Math.floor(px / 5.6) - 1))}…`)

    // least-squares line through the cloud
    const n = pairs.length
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n
    let sxy = 0, sxx = 0
    for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2 }
    const slope = sxx ? sxy / sxx : 0
    const line = s('line', {
      x1: sx(x0), y1: sy(my + slope * (x0 - mx)), x2: sx(x1), y2: sy(my + slope * (x1 - mx)),
      class: 'fit',
    })

    // keep the readout clear of the cloud: opposite corner to the trend
    const rising = slope > 0
    const statX = rising ? m.l + 8 : W - m.r - 8
    const anchor = rising ? 'start' : 'end'
    const sig = stat && stat.p < 0.05
    const readout = !stat ? [s('text', { x: statX, y: m.t + 12, 'text-anchor': anchor, class: 'stat' }, 'Not enough data')]
      : [s('text', { x: statX, y: m.t + 12, 'text-anchor': anchor, class: 'stat' }, `r = ${fmtR(stat.r)}`),
         s('text', { x: statX, y: m.t + 26, 'text-anchor': anchor, class: 'ax' },
           `${fmtP(stat.p)} · ${stat.n} tracts${sig ? '' : ' · n.s.'}`)]

    return s('svg', { width: W, height: H, role: 'img' },
      s('line', { x1: m.l, y1: H - m.b, x2: W - m.r, y2: H - m.b, class: 'axis' }),
      s('line', { x1: m.l, y1: m.t, x2: m.l, y2: H - m.b, class: 'axis' }),
      ...pairs.map(([x, y]) => s('circle', { cx: sx(x).toFixed(1), cy: sy(y).toFixed(1), r: 1.7, class: 'pt' })),
      stat && stat.p < 0.05 ? line : null,
      ...readout,
      tick(m.l, H - m.b + 13, fmtX(x0), 'start'),
      tick(W - m.r, H - m.b + 13, fmtX(x1), 'end'),
      tick(m.l - 6, sy(y0), fmtPct(y0, 0), 'end'),
      tick(m.l - 6, sy(y1) + 8, fmtPct(y1, 0), 'end'),
      // axis titles
      s('text', {
        x: m.l + (W - m.l - m.r) / 2, y: H - 6, 'text-anchor': 'middle', class: 'axlab',
      }, fit(v.label, W - m.l - m.r)),
      s('text', {
        x: 12, y: m.t + (H - m.b - m.t) / 2, 'text-anchor': 'middle', class: 'axlab',
        transform: `rotate(-90 12 ${m.t + (H - m.b - m.t) / 2})`,
      }, 'Vote share'))
  }

  function bars(ranked, { W, rowH, height, onPick }) {
    const labelW = Math.round(Math.min(230, Math.max(90, W * 0.46)))
    const valX = W - 2
    const barW = Math.max(60, W - labelW - Math.round(W * 0.11))
    const mid = labelW + barW / 2
    const rows = ranked.map((d, i) => {
      const y = i * rowH
      const w = Math.abs(d.r) * (barW / 2)
      const g = s('g', { class: `bar${d.selected ? ' sel' : ''}`, role: 'button', tabindex: '0' },
        s('rect', { x: 0, y, width: W, height: rowH, class: 'hit' }),
        s('text', { x: labelW - 8, y: y + rowH - 4, 'text-anchor': 'end', class: 'lab' }, d.label),
        s('rect', {
          x: d.r < 0 ? mid - w : mid, y: y + 4, width: Math.max(1, w), height: rowH - 8,
          class: d.r < 0 ? 'neg' : 'pos',
        }),
        s('text', { x: valX, y: y + rowH - 4, 'text-anchor': 'end', class: 'val' }, fmtR(d.r)))
      const pick = () => onPick(d)
      g.addEventListener('click', pick)
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick() } })
      return g
    })
    return s('svg', { width: W, height },
      ...rows,
      s('line', { x1: mid, y1: 0, x2: mid, y2: ranked.length * rowH, class: 'zero' }))
  }

  function updateCorrelations() {
    const v = varById.get(state.cvar)
    const cand = electionByYear.get(state.eyear).candidates.find((c) => c.id === state.ecand)
    const stat = pearson(pairsFor(state.cvar))

    if (drawer.hidden) return

    const censusYear = v.fixed_in_time ? '' : `, ${state.cyear}`
    $('corr-scatter-title').textContent = `${cand.label} ${state.eyear} × ${v.label}${censusYear}`
    $('corr-scatter').replaceChildren(
      scatter(pairsFor(state.cvar), v, stat, widthOf('corr-scatter')))

    const ranked = meta.variables
      .filter((x) => (state.call || x.curated) && x.years.includes(state.cyear))
      .map((x) => ({ ...x, ...(pearson(pairsFor(x.id)) ?? {}), selected: x.id === state.cvar }))
      .filter((x) => x.r != null && x.p < 0.05)
      .sort((a, b) => b.r - a.r)
    const topVars = ranked.length > 10 ? [...ranked.slice(0, 5), ...ranked.slice(-5)] : ranked

    // ---- How like other candidates' maps is this one? ----
    const mine = elections.get(`${state.eyear}|${state.ecand}`) ?? new Map()
    const others = []
    for (const e of meta.elections) {
      for (const c of candidatesFor(e.year)) {
        if (e.year === state.eyear && c.id === state.ecand) continue
        const rows = elections.get(`${e.year}|${c.id}`) ?? new Map()
        const pairs = []
        for (const ct of tractIds) {
          const x = rows.get(ct)?.share
          const y = mine.get(ct)?.share
          if (x != null && y != null) pairs.push([x, y])
        }
        const st = pearson(pairs)
        if (st && st.p < 0.05) others.push({ year: e.year, id: c.id, label: `${c.label} ${e.year}`, ...st })
      }
    }
    others.sort((a, b) => b.r - a.r)
    // the most alike at the top, the most unlike at the bottom
    const alike = others.length > 10
      ? [...others.slice(0, 5), ...others.slice(-5)]
      : others

    $('corr-rank-title').textContent =
      `What neighbourhood characteristics are most or least associated with voting for ${cand.label} in ${state.eyear}?`
    const wBars = widthOf('corr-bars'), wCand = widthOf('corr-cand-bars')
    const rowH = Math.round(Math.min(22, Math.max(16, Math.min(wBars, wCand) / 21)))
    const barsHeight = Math.max(1, topVars.length, alike.length) * rowH

    $('corr-bars').replaceChildren(topVars.length
      ? bars(topVars, {
          W: wBars, rowH, height: barsHeight,
          onPick: (d) => {
            state.cvar = d.id
            selVar.value = d.id
            fillCensusYears()
            updateCensus()
            refreshHover()
          },
        })
      : h('p', { class: 'corr-stat' }, 'No significant correlations'))

    $('corr-cand-title').textContent =
      `Who had the most or least similar electoral map to ${cand.label} in ${state.eyear}?`
    $('corr-cand-bars').replaceChildren(alike.length
      ? bars(alike, {
          W: wCand, rowH, height: barsHeight,
          onPick: (d) => {
            state.eyear = d.year
            state.ecand = d.id
            fillElectionControls()
            updateElection()
            syncCensusYear()
            refreshHover()
          },
        })
      : h('p', { class: 'corr-stat' }, 'No significant correlations'))
  }

  // Redraw the charts at their new size when the layout changes
  let lastWidths = ''
  const redrawIfResized = () => {
    if (drawer.hidden) return
    const now = ['corr-bars', 'corr-scatter', 'corr-cand-bars'].map(widthOf).join('x')
    if (now === lastWidths) return
    lastWidths = now
    updateCorrelations()
  }
  new ResizeObserver(redrawIfResized).observe(drawer)
  addEventListener('resize', redrawIfResized)

  // ---- About page ----
  const about = $('about'), aboutToggle = $('about-toggle')
  const panels = document.querySelector('.panels'), siteFooter = document.querySelector('.site-footer')
  let aboutLoaded = false

  async function showAbout(open) {
    about.hidden = !open
    panels.hidden = open
    siteFooter.hidden = open
    if (open) drawer.hidden = true
    corrToggle.setAttribute('aria-expanded', String(!drawer.hidden))
    aboutToggle.setAttribute('aria-expanded', String(open))
    if (!open) {
      left.map.resize()
      right.map.resize()
      return
    }
    if (aboutLoaded) return
    aboutLoaded = true
    try {
      const md = await fetch('about.md').then((r) => {
        if (!r.ok) throw new Error(`${r.status}`)
        return r.text()
      })
      $('about-body').replaceChildren(renderMarkdown(md))
    } catch (err) {
      aboutLoaded = false
      $('about-body').replaceChildren(h('p', {}, `Could not load about.md: ${err.message}`))
    }
  }

  aboutToggle.addEventListener('click', () => showAbout(about.hidden))
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !about.hidden) showAbout(false) })

  corrToggle.addEventListener('click', () => {
    if (!about.hidden) showAbout(false)
    drawer.hidden = !drawer.hidden
    corrToggle.setAttribute('aria-expanded', String(!drawer.hidden))
    updateCorrelations()
    left.map.resize()
    right.map.resize()
  })

  // ---- Wire controls ----
  selVar.addEventListener('change', () => { state.cvar = selVar.value; fillCensusYears(); updateCensus(); refreshHover() })
  selCYear.addEventListener('change', () => { state.cyear = +selCYear.value; updateCensus(); refreshHover() })
  selCScale.addEventListener('change', () => { state.cscale = selCScale.value; updateCensus() })
  chkAll.addEventListener('change', () => { state.call = chkAll.checked; fillVarSelect(); fillCensusYears(); updateCensus() })
  // Move the census map to the year with data closest to the election
  // (ties go to the earlier census).
  function syncCensusYear() {
    if (varById.get(state.cvar).fixed_in_time) return
    const years = varById.get(state.cvar).years
    const nearest = years.reduce((best, y) =>
      Math.abs(y - state.eyear) < Math.abs(best - state.eyear) ? y : best)
    if (nearest === state.cyear) return
    state.cyear = nearest
    selCYear.value = nearest
    updateCensus()
  }

  const onElectionChange = () => {
    fillElectionControls()
    updateElection()
    syncCensusYear()
    refreshHover()
  }
  selCand.addEventListener('change', () => {
    const [year, id] = selCand.value.split('|')
    state.eyear = +year
    state.ecand = id
    onElectionChange()
  })
  selEYear.addEventListener('change', () => {
    // keep the same candidate, in the year just picked
    const person = currentPerson()
    state.eyear = +selEYear.value
    state.ecand = people.get(person).find((r) => r.year === state.eyear).id
    onElectionChange()
  })
  chkECand.addEventListener('change', () => { state.eall = chkECand.checked; onElectionChange() })
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
