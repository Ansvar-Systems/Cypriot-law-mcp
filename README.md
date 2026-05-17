# Cypriot Law MCP

<!-- ANSVAR-CTA-BEGIN -->
> ### ▶ Try this MCP instantly via Ansvar Gateway
> **50 free queries/day · no card required · OAuth signup at [ansvar.eu/gateway](https://ansvar.eu/gateway)**
>
> One endpoint, one OAuth signup, access from any MCP-compatible client.

### Connect

**Claude Code** (one line):

```bash
claude mcp add ansvar --transport http https://gateway.ansvar.eu/mcp
```

**Claude Desktop / Cursor** — add to `claude_desktop_config.json` (or `mcp.json`):

```json
{
  "mcpServers": {
    "ansvar": {
      "type": "url",
      "url": "https://gateway.ansvar.eu/mcp"
    }
  }
}
```

**Claude.ai** — Settings → Connectors → Add custom connector → paste `https://gateway.ansvar.eu/mcp`

First request opens an OAuth flow at [ansvar.eu/gateway](https://ansvar.eu/gateway). After signup, your client is bound to your account; tier (free / premium / team / company) determines fan-out, quota, and which downstream MCPs are reachable.

---

## Self-host this MCP

You can also clone this repo and build the corpus yourself. The schema,
fetcher, and tool implementations all live here. What is not in the repo is
the pre-built database — TDM and standards-licensing constraints on the
upstream sources mean we host the corpus on Ansvar infrastructure rather
than redistribute it as a public artifact.

Build your own: run this repo's ingestion script (entry-point varies per
repo — typically `scripts/ingest.sh`, `npm run ingest`, or `make ingest`;
check the repo root).
<!-- ANSVAR-CTA-END -->


Model Context Protocol (MCP) server for Cypriot legal compliance, sourced from primary government and EU portals only.

## Out of scope: cylaw.org (CyLaw / KINOP / CyLII)

**This server does not ingest, redistribute, or display content from `cylaw.org`** (the Cyprus Law Portal operated by the Cyprus Bar Association via KINOP / CyLII). CyLaw's terms of service prohibit bulk extraction, indexing, and redistribution of its compilation, and we respect those terms.

Any future Cypriot statute corpus will come from primary government sources only — the Supreme Court of Cyprus's own publication channels, the Official Gazette of the Republic of Cyprus, and the parliamentary record at `parliament.cy`. We will not source statutes from CyLaw under any circumstance unless and until KINOP grants written authorisation.

The previous version of this repository contained a CyLaw-derived statute seed corpus and a CyLaw scraper. Both were removed in 2026-04-26 (file deletion + git history rewrite + removal from all branches and tags). The current code path does not fetch from `cylaw.org`.

## Status (2026-04-26)

This repository is being rebuilt around a primary-source-only ingestion model. No replacement statute corpus is committed yet; `npm run build:db` produces an empty schema until the primary-source adapters listed below are wired in.

## Data sources (active premium-tier adapters)

| Source | Authority | Records |
|---|---|---|
| EUR-Lex SPARQL (Cyprus NIM) | Publications Office of the EU | 6,377 NIM transposition measures |
| CySEC Circulars | Cyprus Securities and Exchange Commission | 943 circular metadata records |
| GDPRhub Cyprus DPA decisions | noyb (CC BY-SA 4.0) | 33 decision summaries |

## Data sources (planned, not yet ingested)

- `supremecourt.gov.cy` — Lotus Domino XML view direct (Phase 0 probe confirmed reachable from Hetzner)
- `parliament.cy` — primary-source path (probe pending)
- `hudoc.echr.coe.int` — Cyprus respondent cases (blocked by Cloudflare bot protection at probe time)

## Tools

- `search_legislation` — full-text search across statutes (FTS5 with BM25)
- `search_eu_implementations` — EU directives transposed into Cypriot national law
- `search_agency_guidance` — premium-tier search across CySEC + DPA decisions
- `search_case_law` — premium-tier search across primary-source case law (auto-hidden until corpus populated)
- `get_provision`, `validate_citation`, `format_citation`, `check_currency`, etc.

`tools/list` returns only the surfaces that have data; tools without data are auto-hidden via capability gating in `src/tools/registry.ts`.

## Build

```bash
npm install
npm run build       # tsc → dist/
npm run build:db    # produces empty schema until primary-source adapters land
npm run build:db:paid  # adds premium-tier schema
```

## License

Apache-2.0 for the code. Each data source ships with its own license; see `list_sources` tool output at runtime.
