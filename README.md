# Toronto Elections and Social Geography 1997-2023

Static web app with two linked maps of Toronto's 2021 census tracts: census
variables (left) and mayoral vote shares (right).

## Layout

- `prep/build_data.R` — builds everything in `docs/data/` from the raw files in
  the project root (`ct2021tor.shp`, `ct_long_by_time_20250121.dta`,
  `tor_electoral_ct2021_pct.dta`, `tor_varname_lookup.csv`).
- `docs/` — the site (plain HTML/CSS/JS, no build step).
  - `data/tracts.geojson` — simplified tract boundaries
  - `data/census.parquet` — census variables, one row per tract × census year
  - `data/elections.parquet` — vote shares, one row per tract × election × candidate
  - `data/meta.json` — variable labels/groups, candidate names, citywide shares

Parquet files are read in the browser with [hyparquet](https://github.com/hyparam/hyparquet);
maps use [MapLibre GL](https://maplibre.org) with the OpenFreeMap Positron basemap.

## Rebuild data

```bash
Rscript prep/build_data.R
```

Variable labels, groups and the curated list are set in that script
(`extra_labels`, `group_of`, `curated`). Candidate names are in `full_names`.

## Run locally

```bash
python3 -m http.server 8765 --directory docs
```

Then open http://localhost:8765.

## Deploy to GitHub Pages

Push the repo to GitHub, then Settings → Pages → Deploy from a branch →
`main` / `/docs`. Only `docs/` is served, but the raw `.dta` / shapefiles
will be in the repo unless you add them to `.gitignore`.
