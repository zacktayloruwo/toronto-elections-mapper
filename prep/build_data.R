# Build the static data files for the web app (docs/data/).
# Run from the project root:  Rscript prep/build_data.R

suppressPackageStartupMessages({
  library(sf)
  library(haven)
  library(dplyr)
  library(tidyr)
  library(arrow)
  library(jsonlite)
  library(rmapshaper)
})

out <- "docs/data"
dir.create(out, recursive = TRUE, showWarnings = FALSE)

fmt_id <- function(x) sprintf("%.2f", as.numeric(x))

# ---- Boundaries -------------------------------------------------------------
tracts <- st_read("ct2021tor.shp", quiet = TRUE) |>
  st_transform(4326) |>
  transmute(ct = fmt_id(ctuid2021), name = geoname) |>
  ms_simplify(keep = 0.35, keep_shapes = TRUE)

st_write(tracts, file.path(out, "tracts.geojson"),
         layer_options = c("COORDINATE_PRECISION=5", "RFC7946=YES"),
         delete_dsn = TRUE, quiet = TRUE)

# ---- Census variables -------------------------------------------------------
census <- read_dta("ct_long_by_time_20250121.dta") |>
  zap_labels() |>
  mutate(ct = fmt_id(geosid), year = as.integer(time),
         vminvisi_pct = 1 - vminnvis_pct) |>
  select(-geosid, -time)

lookup <- read.csv("tor_varname_lookup.csv", fileEncoding = "UTF-8-BOM")
curated_ids <- lookup$variable[lookup$keep == 1]

# Labels for variables missing from (or mislabelled in) the lookup table
extra_labels <- c(
  abidabor__ne_pct = "% Indigenous identity (n.e.c.)",
  abidabor1resfina_pct = "% First Nations",
  abidabor1resinuk_pct = "% Inuk",
  abidabor1resmeti_pct = "% Métis",
  abidabormres_pct = "% Multiple Indigenous identities",
  abidnabo_pct = "% Non-Indigenous",
  dwtpatch_pct = "% Attached Housing",
  edcacert_pct = "% College / Trades Certificate",
  edcauniv_pct = "% University Degree",
  ethmasiaeastchin_pct = "% Chinese Origin",
  ethmasiasoutinda_pct = "% East Indian Origin",
  ethmasiasoutpaks_pct = "% Pakistani Origin",
  ethmasiawestleba_pct = "% Lebanese Origin",
  ethmcarihait_pct = "% Haitian Origin",
  ethmeurobritengl_pct = "% English Origin",
  ethmeurobritiris_pct = "% Irish Origin",
  ethmeurobritscot_pct = "% Scottish Origin",
  ethmeuroeastpoli_pct = "% Polish Origin",
  ethmeuroeastukra_pct = "% Ukrainian Origin",
  ethmeurofren_tot_pct = "% French Origin",
  ethmeurosoutgrek_pct = "% Greek Origin",
  lfaainlfempl_pct = "% Employed",
  lfaanolf_pct = "% Not in Labour Force",
  lnmt1resoffifr___pct = "% French Mother Tongue",
  vminvisiweas_pct = "% West Asian",
  vminvisi_pct = "% Visible Minority",
  # Non-percentage variables: z-scores standardized within each census year
  s_ihat_avg__nc = "Avg. Household Income",
  s_ihat_med__nc = "Median Household Income",
  s_iit__avg__nc = "Avg. Individual Income",
  s_iit__med__nc = "Median Individual Income",
  s_popdsqkm__nc = "Population Density",
  s_dist__nc = "Distance from City Hall",
  s_walkscore = "Walk Score",
  s_transitscore = "Transit Score",
  s_bikescore = "Bike Score",
  s_pmi_prox_idx_emp = "Proximity to Jobs",
  s_pmi_prox_idx_pharma = "Proximity to Pharmacy",
  s_pmi_prox_idx_childcare = "Proximity to Childcare",
  s_pmi_prox_idx_health = "Proximity to Health Care",
  s_pmi_prox_idx_grocery = "Proximity to Grocery",
  s_pmi_prox_idx_educpri = "Proximity to Elementary School",
  s_pmi_prox_idx_educsec = "Proximity to Secondary School",
  s_pmi_prox_idx_lib = "Proximity to Library",
  s_pmi_prox_idx_parks = "Proximity to Parks",
  s_pmi_prox_idx_transit = "Proximity to Transit"
)

std_vars <- grep("^s_", names(extra_labels), value = TRUE)
pct_vars <- setdiff(grep("_pct$", names(census), value = TRUE), "hhtnband_pct")
map_vars <- c(pct_vars, std_vars)

group_of <- function(v) {
  case_when(
    grepl("^s_i", v) ~ "Income",
    grepl("^s_", v) ~ "Density, Location & Access",
    grepl("^agec|^mars", v) ~ "Age & Family",
    grepl("^abid|^vmin", v) ~ "Visible Minority & Indigenous Identity",
    grepl("^ethm", v) ~ "Ethnic Origin",
    grepl("^imst|^lnmt", v) ~ "Immigration & Language",
    grepl("^rlgn", v) ~ "Religion",
    grepl("^edca|^lfaa", v) ~ "Education & Labour Force",
    grepl("^occ", v) ~ "Occupation",
    grepl("^dw|^hhtn", v) ~ "Housing",
    grepl("^jwmd", v) ~ "Commuting",
    TRUE ~ "Other"
  )
}

# Curated set: lookup keep == 1, substitutes for lookup vars not in the data,
# and all income measures.
curated <- union(curated_ids, c("edcauniv_pct", "vminvisi_pct",
                                "s_ihat_avg__nc", "s_ihat_med__nc",
                                "s_iit__avg__nc", "s_iit__med__nc",
                                "s_popdsqkm__nc", "s_dist__nc",
                                "s_walkscore", "s_transitscore",
                                "s_pmi_prox_idx_emp", "s_pmi_prox_idx_grocery",
                                "s_pmi_prox_idx_childcare"))

label_of <- function(v) {
  lab <- extra_labels[v]
  from_lookup <- lookup$varname[match(v, lookup$variable)]
  ifelse(is.na(lab), from_lookup, lab) |> unname()
}

vars_meta <- tibble(id = map_vars) |>
  mutate(label = label_of(id),
         group = group_of(id),
         kind = ifelse(id %in% std_vars, "z", "pct"),
         curated = id %in% curated) |>
  filter(!is.na(label)) |>
  # Drop variables with no data at all
  filter(sapply(id, function(v) any(!is.na(census[[v]])))) |>
  arrange(group, label)

# Years in which each variable is available
vars_meta$years <- lapply(vars_meta$id, function(v)
  sort(unique(census$year[!is.na(census[[v]])])))

census_out <- census |>
  select(ct, year, all_of(vars_meta$id)) |>
  mutate(across(all_of(vars_meta$id), ~ round(.x, 4)))

census_schema <- schema(c(list(ct = utf8(), year = int32()),
                          setNames(rep(list(float32()), nrow(vars_meta)),
                                   vars_meta$id)))
census_out <- arrow_table(census_out, schema = census_schema)

write_parquet(census_out, file.path(out, "census.parquet"),
              compression = "snappy")

# ---- Elections --------------------------------------------------------------
elec <- read_dta("tor_electoral_ct2021_pct.dta") |> zap_labels()
elec$ct <- fmt_id(elec$ctuid2021)

pct_cols <- grep("^pct.+\\d{4}$", names(elec), value = TRUE)
elec_long <- elec |>
  select(ct, all_of(pct_cols)) |>
  pivot_longer(-ct, names_to = "col", values_to = "share") |>
  mutate(year = as.integer(sub(".*(\\d{4})$", "\\1", col)),
         candidate = sub("^pct(.+)\\d{4}$", "\\1", col)) |>
  filter(candidate != "pop")          # pctpop2006 is population, not a candidate

# Citywide shares from the city* total columns
city <- elec_long |>
  distinct(col, year, candidate) |>
  mutate(votes = sapply(paste0("city", candidate, year),
                        function(v) if (v %in% names(elec)) elec[[v]][1] else NA_real_)) |>
  group_by(year) |>
  mutate(city_share = votes / sum(votes, na.rm = TRUE)) |>
  ungroup()

# Full names for candidates above the 1% threshold; anything else falls back
# to a name built from the column ("bailao_ana" -> "Ana Bailao").
full_names <- c(
  lastman = "Mel Lastman", hall = "Barbara Hall", gomberg = "Tooker Gomberg",
  anderson = "Enza Anderson", miller = "David Miller", tory = "John Tory",
  tory_john = "John Tory", nunziata = "John Nunziata",
  pitfield = "Jane Pitfield", ledrew = "Stephen LeDrew", ford = NA,
  smitherman = "George Smitherman", pantalone = "Joe Pantalone",
  chow = "Olivia Chow", chow_olivia = "Olivia Chow",
  keesmaat = "Jennifer Keesmaat", goldy = "Faith Goldy",
  gebresellassi = "Saron Gebresellassi", penalosa_gil = "Gil Pe\u00f1alosa",
  brown_chloe_marie = "Chloe Brown", brown_chloe = "Chloe Brown",
  acton_blake = "Blake Acton", climenhaga_sarah = "Sarah Climenhaga",
  luk_tony = "Tony Luk", yan_jack = "Jack Yan", bailao_ana = "Ana Bail\u00e3o",
  saunders_mark = "Mark Saunders", furey_anthony = "Anthony Furey",
  matlow_josh = "Josh Matlow", hunter_mitzie = "Mitzie Hunter",
  saccoccia_chris = "Chris Saccoccia", bradford_brad = "Brad Bradford",
  other = "All other candidates"
)

cand_label <- function(candidate, year) {
  lab <- unname(full_names[candidate])
  lab[candidate == "ford"] <- ifelse(year[candidate == "ford"] == 2010,
                                     "Rob Ford", "Doug Ford")
  auto <- vapply(strsplit(candidate, "_"), function(p) {
    p <- tools::toTitleCase(p)
    paste(c(p[-1], p[1]), collapse = " ")
  }, "")
  ifelse(is.na(lab), auto, lab)
}

# Keep candidates with >= 1% citywide, plus the "other" category
keep_cands <- city |>
  filter(city_share >= 0.01 | candidate == "other") |>
  mutate(label = cand_label(candidate, year)) |>
  arrange(year, candidate == "other", desc(city_share))

elec_out <- elec_long |>
  semi_join(keep_cands, by = c("year", "candidate")) |>
  transmute(ct, year, candidate, share = round(share, 4)) |>
  arrow_table(schema = schema(ct = utf8(), year = int32(),
                              candidate = utf8(), share = float32()))

write_parquet(elec_out, file.path(out, "elections.parquet"),
              compression = "snappy")

elections_meta <- keep_cands |>
  group_by(year) |>
  group_map(~ list(year = .y$year,
                   candidates = lapply(seq_len(nrow(.x)), function(i)
                     list(id = .x$candidate[i], label = .x$label[i],
                          city_share = round(.x$city_share[i], 4)))))

write_json(list(census_years = sort(unique(census$year)),
                variables = vars_meta,
                elections = elections_meta),
           file.path(out, "meta.json"), auto_unbox = TRUE, pretty = TRUE)

message("Wrote ", paste(list.files(out), collapse = ", "))
