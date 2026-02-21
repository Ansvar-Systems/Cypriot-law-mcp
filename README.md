# Cypriot Law MCP

Cypriot law database for cybersecurity compliance via Model Context Protocol (MCP).

## Features

- **Full-text search** across legislation provisions (FTS5 with BM25 ranking)
- **Article-level retrieval** for specific legal provisions
- **Citation validation** to prevent hallucinated references
- **Currency checks** to verify if laws are still in force

## Quick Start

### Claude Code (Remote)
```bash
claude mcp add cypriot-law --transport http https://cypriot-law-mcp.vercel.app/mcp
```

### Local (npm)
```bash
npx @ansvar/cypriot-law-mcp
```

## Data Sources

AI-generated seed data covering 10 key cybersecurity and data protection laws. Full official ingestion pending.

## License

Apache-2.0
