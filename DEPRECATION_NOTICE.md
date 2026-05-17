# Cypriot-law-mcp — Deprecation / Path B Notice

**Status:** Repository on hold. License-axis cannot be GREEN-cleared in its present
shape; corpus replacement (Path B) required before this MCP can serve Cypriot
primary law.

## Background

The Phase 1 EU statutory-works audit (2026-05-17) verified the negative finding
that Cyprus Copyright Act 59/1976 has **no state-works carve-out** comparable to
Czech §3, German UrhG §5, NL Auteurswet Art. 11, or the EFTA URG Art. 5 model.
Cyprus 59/1976 Art. 4(c) does the opposite — it **grants** copyright to works
created by the Republic. Path A (a `CY-Statutory-PD` license code) is therefore
refuted; no such code will be added to the Ansvar license catalog.

Source: `docs/superpowers/specs/2026-05-17-cyprus-statutory-pd-verification-and-remediation-design.md`
in Ansvar-Architecture-Documentation.

## Path B requirement

GREEN clearance for a Cypriot-law MCP requires **corpus replacement**, not just a
licence-label change. The replacement corpus splits across three sources, broadly
mirroring the Norwegian-style 3-MCP separation:

1. **EU acquis applicable to Cyprus** — full-text from EUR-Lex, filtered to
   documents that bind Cyprus (all EU regulations + EU directives transposed by
   CY). Licence: `EUR-Lex-Decision-2011-833` (already in catalog, GREEN). Same
   substrate as `eu-regulations`. Estimated record count: thousands.
2. **Cyprus Parliament primary legislation** — statutes published on
   `parliament.cy`. PSI-eligible under Law 143(I)/2021 (CY PSI transposition of
   EU Directive 2019/1024) IF the publisher's reuse-terms page can be retrieved
   and registered in `infrastructure/policy/source-authority-registry.yml`.
   Licence: `Cyprus-PSI` (already in catalog). Estimated record count: hundreds
   of in-force statutes plus amendments.
3. **ECJ rulings involving Cyprus** — `curia.europa.eu` filtered to Cyprus-as-
   party cases. Licence basis: separate catalog entry pending (CJEU reuse policy
   was not retrievable via WebFetch during the 2026-05-17 audit). Estimated
   record count: hundreds.

The Cyprus Supreme Court's own publication channels (the supremecourt.gov.cy
Lotus Domino XML view) reach Cypriot court judgments without going through
`cylaw.org`. PSI re-use does NOT extend to judicial decisions under Law
143(I)/2021, so the licensing basis for the judicial tier must be the Supreme
Court's own portal terms — to be retrieved and recorded in the source-authority
registry as part of Path B Phase 0.

## What the repository currently contains

Per `README.md` (2026-04-26 rebuild):

- No CyLaw-derived statute corpus (removed by file deletion + history rewrite).
- Two active premium-tier adapters: EUR-Lex SPARQL (Cyprus NIM transposition
  measures) and CySEC Circulars (Cyprus-PSI registered).
- Three planned primary-source paths (Supreme Court, parliament.cy, hudoc.echr).

No replacement statute corpus is ingested yet; `npm run build:db` produces an
empty schema until the Path B adapters are wired in.

## Action items before this MCP can flip back to active

- [ ] Phase 0 probe of `supremecourt.gov.cy` Lotus Domino XML — verify reach
      from Hetzner and record the published reuse terms in the
      source-authority registry.
- [ ] Probe `parliament.cy` for the Cyprus House of Representatives statute
      corpus and capture its declared reuse terms (PSI Law 143(I)/2021).
- [ ] Catalog entry for CJEU reuse policy (curia.europa.eu) — verbatim
      retrieval pending; until then the ECJ tier is licence-RED.
- [ ] Build ingestion adapters for each source landing in the corpus.
- [ ] Re-run `scripts/audit-source-legitimacy.py` against `cypriot-law` and
      confirm GREEN before publishing a GHCR image.

## ADR-030 status

`infrastructure/policy/at-risk-mcps.yml` carries `cypriot-law` as a Path B
candidate. Visibility (GitHub repo + GHCR image) remains private until the Path
B corpus lands and a full source-legitimacy audit returns GREEN.

## References

- Cypriot-law verification design: `docs/superpowers/specs/2026-05-17-cyprus-statutory-pd-verification-and-remediation-design.md`
- EFTA-UK audit (companion negative findings): `docs/audits/2026-05-17-eu-copyright-statutory-works-efta-uk-IS-LI-NO-CH-UK.md`
- ADR-030 public visibility rule: `docs/adr/ADR-030-public-visibility-requires-green-licensing.md`
- Norwegian-style 3-MCP split precedent: `norwegian-law` + `norwegian-court-decisions` + `norwegian-parliamentary-debates` + `norwegian-preparatory-works`.
