# Toronto Elections and Social Geography 1997-2023

Static web app with two linked maps of Toronto's 2021 census tracts: census
variables (left) and mayoral vote shares (right).

## Layout

- `prep/build_data.R` — builds everything in `docs/data/`. Election data and
  boundaries come from the project root (`ct2021tor.shp`,
  `tor_electoral_ct2021_pct.dta`, `tor_varname_lookup.csv`). Census data is read
  (never written) from the book's census construction project, where the counts
  and nominal values live:
  `1_data_toronto/10 census data construction/.RData`. That workspace's
  `longbytime_harm6` is the table produced just before the census pipeline
  standardizes the continuous variables and drops the counts; this script
  repeats that standardization, reproducing the published `s_*` variables.
- `docs/` — the site (plain HTML/CSS/JS, no build step).
  - `data/tracts.geojson` — simplified tract boundaries, with ward, old city
    and neighbourhood names joined from `3_spatial/2_ct2021_toronto/`
  - `data/census.parquet` — census variables, one row per tract × census year:
    each share with its count and table total, and each z-score with its
    nominal value (dollars, people/km², km, score)
  - `data/elections.parquet` — vote share and vote count, one row per tract × election × candidate
  - `data/turnout.parquet` — votes cast and eligible voters per tract × election
    (eligible voters are missing for 2022 and 2023)
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
