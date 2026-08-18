# Generated SDK + MCP tools

Package: client

Operations (17): getHealth, getReady, getIndex, getReport, getCostsCsv, getCostsMd, getCostsGha, getCosts, getBudgets, getModels, listSpans, listTenants, postTraces, postTracesAlias, getMetrics, getOpenApi, getConfig

Files:
- `client.ts` — TypeScript client stub
- `package.json` — package name `client`
- `client.py` — Python sync client stub (stdlib urllib)
- `client.go` — Go HTTP client stub (stdlib net/http, package client)
- `mcp-tools.json` — MCP tools list
- `mcp-server.mjs` — stdio MCP server (JSON-RPC initialize / tools/list / tools/call; Node, no extra deps)
- `mcp_server.py` — stdio MCP server (same JSON-RPC; Python 3 stdlib urllib, no extra deps)
- `mcp_server.go` — stdio MCP server (same JSON-RPC; Go 1.21+ stdlib net/http, package main, no extra deps)
- `mcp.json` — MCP servers config JSON snippet (paste into Cursor / Claude Desktop / Claude Code)
- `LICENSE` — Apache License 2.0 (always overwritten on generate)
- `NOTICE` — attribution for package `client`
- `.gitignore` — ignore __pycache__, node_modules, .DS_Store (always overwritten on generate)

TypeScript example:

```ts
import { createClient } from "./client";
const client = createClient({ baseUrl: "http://localhost:8080" });
await client.getHealth({});
```

Python example:

```python
from client import create_client  # package: client
client = create_client(base_url="http://localhost:8080")
client.getHealth({})
```

Go example:

```go
import "example.com/gen/client"
c := client.NewClient("http://localhost:8080")
c.GetHealth(map[string]any{})
```

Stdio MCP server:

```bash
MCP_BASE_URL=http://localhost:8080 node mcp-server.mjs
MCP_BASE_URL=http://localhost:8080 python3 mcp_server.py
MCP_BASE_URL=http://localhost:8080 go run mcp_server.go
# newline JSON-RPC on stdin: {"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
```

MCP servers config JSON (paste into Cursor / Claude Desktop / Claude Code).
Relative `args` (`./mcp-server.mjs`) are from this output directory. See `mcp.json`.

```json
{
  "mcpServers": {
    "otel_ai_cost_local_serve_api": {
      "command": "node",
      "args": [
        "./mcp-server.mjs"
      ],
      "env": {
        "MCP_BASE_URL": "http://127.0.0.1:8792"
      }
    },
    "otel_ai_cost_local_serve_api-py": {
      "command": "python3",
      "args": [
        "./mcp_server.py"
      ],
      "env": {
        "MCP_BASE_URL": "http://127.0.0.1:8792"
      }
    },
    "otel_ai_cost_local_serve_api-go": {
      "command": "go",
      "args": [
        "run",
        "./mcp_server.go"
      ],
      "env": {
        "MCP_BASE_URL": "http://127.0.0.1:8792"
      }
    }
  }
}
```

License: Apache-2.0. See `LICENSE` and `NOTICE` (overwritten on each generate).

A generated `.gitignore` excludes __pycache__, *.pyc, node_modules, .DS_Store, and *.egg-info (overwritten on each generate).
