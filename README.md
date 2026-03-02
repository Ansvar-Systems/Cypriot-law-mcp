# Cypriot Law MCP Server

**The Cyprus Law Portal alternative for the AI age.**

[![npm version](https://badge.fury.io/js/@ansvar%2Fcypriot-law-mcp.svg)](https://www.npmjs.com/package/@ansvar/cypriot-law-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP-Registry-blue)](https://registry.modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![GitHub stars](https://img.shields.io/github/stars/Ansvar-Systems/Cypriot-law-mcp?style=social)](https://github.com/Ansvar-Systems/Cypriot-law-mcp)
[![CI](https://github.com/Ansvar-Systems/Cypriot-law-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Ansvar-Systems/Cypriot-law-mcp/actions/workflows/ci.yml)
[![Daily Data Check](https://github.com/Ansvar-Systems/Cypriot-law-mcp/actions/workflows/check-updates.yml/badge.svg)](https://github.com/Ansvar-Systems/Cypriot-law-mcp/actions/workflows/check-updates.yml)
[![Database](https://img.shields.io/badge/database-pre--built-green)](docs/EU_INTEGRATION_GUIDE.md)
[![Provisions](https://img.shields.io/badge/provisions-42%2C208-blue)](docs/EU_INTEGRATION_GUIDE.md)

Query **1,678 Cypriot statutes** -- from Ο περί Προστασίας Δεδομένων Προσωπικού Χαρακτήρα Νόμος and Ποινικός Κώδικας to Αστικός Κώδικας, εταιρικό δίκαιο, and more -- directly from Claude, Cursor, or any MCP-compatible client.

If you're building legal tech, compliance tools, or doing Cypriot legal research, this is your verified reference database.

Built by [Ansvar Systems](https://ansvar.eu) -- Stockholm, Sweden

---

## Why This Exists

Cypriot legal research means navigating cylaw.org and the cyprus.gov.cy legislation portal across statutes in both Greek and English -- Cyprus has a unique legal system combining common law heritage with EU membership. Whether you're:

- A **lawyer** validating citations in a brief or contract
- A **compliance officer** checking Cypriot GDPR implementation or financial services obligations
- A **legal tech developer** building tools on Cypriot law
- A **researcher** tracing EU directive transposition across Cyprus's bilingual legal system

...you shouldn't need dozens of browser tabs and manual cross-referencing between Greek and English texts. Ask Claude. Get the exact provision. With context.

This MCP server makes Cypriot law **searchable, cross-referenceable, and AI-readable**.

---

## Quick Start

### Use Remotely (No Install Needed)

> Connect directly to the hosted version -- zero dependencies, nothing to install.

**Endpoint:** `https://cypriot-law-mcp.vercel.app/mcp`

| Client | How to Connect |
|--------|---------------|
| **Claude.ai** | Settings > Connectors > Add Integration > paste URL |
| **Claude Code** | `claude mcp add cypriot-law --transport http https://cypriot-law-mcp.vercel.app/mcp` |
| **Claude Desktop** | Add to config (see below) |
| **GitHub Copilot** | Add to VS Code settings (see below) |

**Claude Desktop** -- add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cypriot-law": {
      "type": "url",
      "url": "https://cypriot-law-mcp.vercel.app/mcp"
    }
  }
}
```

**GitHub Copilot** -- add to VS Code `settings.json`:

```json
{
  "github.copilot.chat.mcp.servers": {
    "cypriot-law": {
      "type": "http",
      "url": "https://cypriot-law-mcp.vercel.app/mcp"
    }
  }
}
```

### Use Locally (npm)

```bash
npx @ansvar/cypriot-law-mcp
```

**Claude Desktop** -- add to `claude_desktop_config.json`:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "cypriot-law": {
      "command": "npx",
      "args": ["-y", "@ansvar/cypriot-law-mcp"]
    }
  }
}
```

**Cursor / VS Code:**

```json
{
  "mcp.servers": {
    "cypriot-law": {
      "command": "npx",
      "args": ["-y", "@ansvar/cypriot-law-mcp"]
    }
  }
}
```

---

## Example Queries

Once connected, just ask naturally:

- *"Αναζήτηση διατάξεων για 'προστασία δεδομένων' στην κυπριακή νομοθεσία"*
- *"Τι λέει ο Ποινικός Κώδικας για τα εγκλήματα στον κυβερνοχώρο;"*
- *"Βρες διατάξεις του Αστικού Κώδικα σχετικά με αποζημίωση"*
- *"Ποια νομοθεσία ρυθμίζει τις εταιρείες στην Κύπρο;"*
- *"What does the Cypriot GDPR implementation law say about data subject rights?"*
- *"Which Cyprus laws implement the NIS2 Directive?"*
- *"Search for provisions about financial services licensing in Cyprus"*
- *"Validate the citation 'Άρθρο 5 του Νόμου περί Προστασίας Δεδομένων'"*

---

## What's Included

| Category | Count | Details |
|----------|-------|---------|
| **Statutes** | 1,678 statutes | Comprehensive Cypriot legislation from cylaw.org |
| **Provisions** | 42,208 sections | Full-text searchable with FTS5 |
| **Legal Definitions** | 0 (free tier) | Table reserved, extraction not enabled in current free build |
| **Database Size** | Optimized SQLite | Portable, pre-built |
| **Daily Updates** | Automated | Freshness checks against cylaw.org |

**Verified data only** -- every citation is validated against official sources (cylaw.org). Zero LLM-generated content.

---

## See It In Action

### Why This Works

**Verbatim Source Text (No LLM Processing):**
- All statute text is ingested from cylaw.org and the official Cyprus legislation portal
- Provisions are returned **unchanged** from SQLite FTS5 database rows
- Zero LLM summarization or paraphrasing -- the database contains regulation text, not AI interpretations

**Smart Context Management:**
- Search returns ranked provisions with BM25 scoring (safe for context)
- Provision retrieval gives exact text by statute identifier + article number
- Cross-references help navigate without loading everything at once

**Technical Architecture:**
```
cylaw.org --> Parse --> SQLite --> FTS5 snippet() --> MCP response
               ^                        ^
        Provision parser         Verbatim database query
```

### Traditional Research vs. This MCP

| Traditional Approach | This MCP Server |
|---------------------|-----------------|
| Search cylaw.org by law number | Search by plain Greek or English: *"προστασία δεδομένων συγκατάθεση"* |
| Navigate bilingual Greek/English statutes manually | Get the exact provision with context |
| Manual cross-referencing between laws | `build_legal_stance` aggregates across sources |
| "Is this statute still in force?" -- check manually | `check_currency` tool -- answer in seconds |
| Find EU directive transposition -- dig through EUR-Lex | `get_eu_basis` -- linked EU directives instantly |
| No API, no integration | MCP protocol -- AI-native |

**Traditional:** Search cylaw.org --> Navigate Greek-language pages --> Ctrl+F --> Cross-reference with EU directive --> Check EUR-Lex --> Repeat

**This MCP:** *"Ποιες είναι οι απαιτήσεις του κυπριακού GDPR για τα δικαιώματα των υποκειμένων δεδομένων;"* -- Done.

---

## Available Tools (13)

### Core Legal Research Tools (8)

| Tool | Description |
|------|-------------|
| `search_legislation` | FTS5 full-text search across 42,208 provisions with BM25 ranking. Supports Greek and English queries |
| `get_provision` | Retrieve specific provision by statute identifier + article number |
| `check_currency` | Check if a statute is in force, amended, or repealed |
| `validate_citation` | Validate citation against database -- zero-hallucination check |
| `build_legal_stance` | Aggregate citations from multiple statutes for a legal topic |
| `format_citation` | Format citations per Cypriot conventions |
| `list_sources` | List all available statutes with metadata, coverage scope, and data provenance |
| `about` | Server info, capabilities, dataset statistics, and coverage summary |

### EU Law Integration Tools (5)

| Tool | Description |
|------|-------------|
| `get_eu_basis` | Get EU directives/regulations that a Cypriot statute transposes or implements |
| `get_cypriot_implementations` | Find Cypriot laws implementing a specific EU act |
| `search_eu_implementations` | Search EU documents with Cypriot transposition counts |
| `get_provision_eu_basis` | Get EU law references for a specific provision |
| `validate_eu_compliance` | Check transposition status of Cypriot statutes against EU directives |

---

## EU Law Integration

Cyprus is a full EU member state (since 2004) and has transposed the complete body of EU law into Cypriot national legislation.

Key transposition areas:

- **GDPR:** Cyprus transposed Regulation (EU) 2016/679 via the Processing of Personal Data (Protection of Individuals) Law (Law 125(I)/2018)
- **NIS2:** Transposition of the NIS2 Directive (EU) 2022/2555 is underway
- **AML/CFT:** Cyprus implements the full EU Anti-Money Laundering Directive framework
- **Financial services:** Full MiFID II, CRD/CRR, and Solvency II implementation via Cyprus Securities and Exchange Commission (CySEC) framework
- **Company law:** Cypriot company law aligns with EU company law directives

The EU bridge tools allow you to query these transpositions -- finding which Cypriot statute implements a given EU directive, or which EU directive is the basis for a specific Cypriot provision.

> **Note:** Cyprus has a common law heritage (British rule until 1960), so transposition style may differ from continental EU member states. The EU tools reflect transposition relationships in the Cypriot statute database.

---

## Data Sources & Freshness

All content is sourced from authoritative Cypriot legal databases:

- **[cylaw.org](https://www.cylaw.org/)** -- Official Cypriot law database maintained by the Cyprus Bar Association
- **[cyprus.gov.cy](https://www.cyprus.gov.cy/legislation)** -- Official Government of Cyprus legislation portal

### Data Provenance

| Field | Value |
|-------|-------|
| **Authority** | Κυπριακή Δημοκρατία / Republic of Cyprus; Κυπριακός Δικηγορικός Σύλλογος |
| **Retrieval method** | Structured data from cylaw.org and official government portal |
| **Languages** | Greek (primary), English (secondary) |
| **License** | Public domain (Cyprus government official publications) |
| **Coverage** | 1,678 statutes across all legislative domains |

### Automated Freshness Checks (Daily)

A [daily GitHub Actions workflow](.github/workflows/check-updates.yml) monitors all data sources:

| Source | Check | Method |
|--------|-------|--------|
| **Statute amendments** | cylaw.org date comparison | All statutes checked |
| **New statutes** | Official Gazette (Επίσημη Εφημερίδα) | Diffed against database |
| **Repealed statutes** | Status change detection | Flagged automatically |
| **EU transposition** | EUR-Lex Cyprus implementation count | Flagged if divergence detected |

**Verified data only** -- every citation is validated against official sources. Zero LLM-generated content.

---

## Security

This project uses multiple layers of automated security scanning:

| Scanner | What It Does | Schedule |
|---------|-------------|----------|
| **CodeQL** | Static analysis for security vulnerabilities | Weekly + PRs |
| **Semgrep** | SAST scanning (OWASP top 10, secrets, TypeScript) | Every push |
| **Gitleaks** | Secret detection across git history | Every push |
| **Trivy** | CVE scanning on filesystem and npm dependencies | Daily |
| **Docker Security** | Container image scanning + SBOM generation | Daily |
| **Socket.dev** | Supply chain attack detection | PRs |
| **OSSF Scorecard** | OpenSSF best practices scoring | Weekly |
| **Dependabot** | Automated dependency updates | Weekly |

See [SECURITY.md](SECURITY.md) for the full policy and vulnerability reporting.

---

## Important Disclaimers

### Legal Advice

> **THIS TOOL IS NOT LEGAL ADVICE**
>
> Statute text is sourced from cylaw.org and the official Cyprus legislation portal. However:
> - This is a **research tool**, not a substitute for professional legal counsel
> - **Court case coverage is not included** -- do not rely solely on this for case law research
> - **Verify critical citations** against primary sources for court filings
> - **EU cross-references** reflect transposition as captured in statute text, not EUR-Lex authoritative mapping
> - **Bilingual system** -- statutes may exist in both Greek and English; verify the authoritative version against official sources

**Before using professionally, read:** [DISCLAIMER.md](DISCLAIMER.md) | [PRIVACY.md](PRIVACY.md)

### Client Confidentiality

Queries go through the Claude API. For privileged or confidential matters, use on-premise deployment. See [PRIVACY.md](PRIVACY.md) for guidance compliant with Κυπριακός Δικηγορικός Σύλλογος (Cyprus Bar Association) professional responsibility rules.

---

## Documentation

- **[EU Integration Guide](docs/EU_INTEGRATION_GUIDE.md)** -- Detailed EU transposition documentation
- **[EU Usage Examples](docs/EU_USAGE_EXAMPLES.md)** -- Practical EU lookup examples
- **[Security Policy](SECURITY.md)** -- Vulnerability reporting and scanning details
- **[Disclaimer](DISCLAIMER.md)** -- Legal disclaimers and professional use notices
- **[Privacy](PRIVACY.md)** -- Client confidentiality and data handling

---

## Development

### Setup

```bash
git clone https://github.com/Ansvar-Systems/Cypriot-law-mcp
cd Cypriot-law-mcp
npm install
npm run build
npm test
```

### Running Locally

```bash
npm run dev                                       # Start MCP server
npx @anthropic/mcp-inspector node dist/index.js   # Test with MCP Inspector
```

### Data Management

```bash
npm run ingest          # Ingest statutes from cylaw.org
npm run build:db        # Rebuild SQLite database
npm run drift:detect    # Run drift detection against known anchors
npm run check-updates   # Check for source updates
```

### Performance

- **Search Speed:** <100ms for most FTS5 queries
- **Reliability:** 100% ingestion success rate

---

## Related Projects: Complete Compliance Suite

This server is part of **Ansvar's Compliance Suite** -- MCP servers that work together for end-to-end compliance coverage:

### [@ansvar/eu-regulations-mcp](https://github.com/Ansvar-Systems/EU_compliance_MCP)
**Query 49 EU regulations directly from Claude** -- GDPR, AI Act, DORA, NIS2, MiFID II, eIDAS, and more. Full regulatory text with article-level search. `npx @ansvar/eu-regulations-mcp`

### [@ansvar/cypriot-law-mcp](https://github.com/Ansvar-Systems/Cypriot-law-mcp) (This Project)
**Query 1,678 Cypriot statutes directly from Claude** -- Ο περί Προστασίας Δεδομένων Νόμος, Ποινικός Κώδικας, Αστικός Κώδικας, and more. `npx @ansvar/cypriot-law-mcp`

### [@ansvar/security-controls-mcp](https://github.com/Ansvar-Systems/security-controls-mcp)
**Query 261 security frameworks** -- ISO 27001, NIST CSF, SOC 2, CIS Controls, SCF, and more. `npx @ansvar/security-controls-mcp`

### [@ansvar/sanctions-mcp](https://github.com/Ansvar-Systems/Sanctions-MCP)
**Offline-capable sanctions screening** -- OFAC, EU, UN sanctions lists. `pip install ansvar-sanctions-mcp`

**100+ national law MCPs** covering Austria, Belgium, Denmark, Finland, France, Germany, Greece, Ireland, Italy, Luxembourg, Malta, Netherlands, Poland, Portugal, Spain, Sweden, and more EU member states.

---

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Priority areas:
- Court case law expansion (Cypriot courts, Supreme Court)
- EU Regulations MCP integration (full EU law text)
- Historical statute versions and amendment tracking
- English-language text ingestion for dual-language statutes

---

## Roadmap

- [x] Core statute database with FTS5 search
- [x] Full corpus ingestion (1,678 statutes, 42,208 provisions)
- [x] EU law integration tools
- [x] Vercel Streamable HTTP deployment
- [x] npm package publication
- [x] Daily freshness checks
- [ ] Court case law expansion (Supreme Court, District Courts)
- [ ] Historical statute versions (amendment tracking)
- [ ] Expanded English-language text ingestion

---

## Citation

If you use this MCP server in academic research:

```bibtex
@software{cypriot_law_mcp_2026,
  author = {Ansvar Systems AB},
  title = {Cypriot Law MCP Server: AI-Powered Legal Research Tool},
  year = {2026},
  url = {https://github.com/Ansvar-Systems/Cypriot-law-mcp},
  note = {1,678 Cypriot statutes with 42,208 provisions}
}
```

---

## License

Apache License 2.0. See [LICENSE](./LICENSE) for details.

### Data Licenses

- **Statutes & Legislation:** Κυπριακή Δημοκρατία / Republic of Cyprus (public domain, official government publications)
- **EU Metadata:** EUR-Lex (EU public domain)

---

## About Ansvar Systems

We build AI-accelerated compliance and legal research tools for the European market. This MCP server started as our internal reference tool for Cypriot law -- turns out everyone building compliance tools for businesses operating in Cyprus has the same research frustrations.

So we're open-sourcing it. Navigating 1,678 statutes across two languages shouldn't require 47 browser tabs.

**[ansvar.eu](https://ansvar.eu)** -- Stockholm, Sweden

---

<p align="center">
  <sub>Built with care in Stockholm, Sweden</sub>
</p>
