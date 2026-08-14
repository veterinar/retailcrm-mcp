# retailcrm-mcp

Production-grade MCP server for **RetailCRM** e-commerce CRM. **39 tools** + 2 prompt skills for managing orders, customers, products, inventory, payments, tasks, references, and analytics via API v5.

API traffic is transported by the official [`retailcrm/api-client-php`](https://github.com/retailcrm/api-client-php) client, pinned to **6.15.32**, invoked from Node through a PHP bridge (`bin/retailcrm-api.php`). The server ships as a self-contained Docker image — no host PHP or Composer required.

Forked from [theYahia/retailcrm-mcp](https://github.com/theYahia/retailcrm-mcp) (MIT).

## Output is token-efficient by default

Read tools return a **compact, shaped summary** of only the fields an agent needs — not the full RetailCRM payload. Control verbosity per call:

| Param | Effect |
|-------|--------|
| _(default)_ | `detail:"summary"` — essential fields + a `pagination` block |
| `detail:"full"` | All shaped fields (line items, delivery, payments, address…) |
| `raw:true` | The untouched RetailCRM response (for debugging) |

> ⚠️ **v3 was a breaking change** vs v2: default output is the shaped summary instead of raw JSON. Pass `raw:true` to restore the old payload.

## Tools (39)

### Orders
| Tool | Description |
|------|-------------|
| `list_orders` | List orders by status, customer, number, date range |
| `get_order` | Get one order by ID or externalId |
| `create_order` | Create an order; link an existing customer (`customer_id`/`customer_external_id`) or create one inline |
| `update_order` | Update status, customer, delivery, comments |
| `orders_history` | Order change history incl. status transitions (incremental sync) |

### Customers
| Tool | Description |
|------|-------------|
| `list_customers` | Search customers by name, email, phone, date |
| `get_customer` | Get one customer by ID or externalId |
| `create_customer` | Create a customer |
| `update_customer` | Edit an existing customer |
| `merge_customers` | Merge duplicates (destructive) |
| `customers_history` | Customer change log (growth/churn, incremental sync) |

### Products & inventory
| Tool | Description |
|------|-------------|
| `list_products` | Catalog products by name, group, active, price |
| `list_product_groups` | Product category tree |
| `store_inventories` | Stock levels & cost prices per offer/warehouse |

### Payments
| Tool | Description |
|------|-------------|
| `order_payment_create` | Record a payment on an order |
| `order_payment_edit` | Edit a payment |
| `order_payment_delete` | Delete a payment (destructive) |

### Notes & tasks
| Tool | Description |
|------|-------------|
| `customer_notes_list` / `customer_notes_create` / `customer_notes_delete` | Free-text customer notes |
| `tasks_list` / `tasks_create` / `tasks_edit` | Follow-up tasks/reminders |

### Marketing & finance
| Tool | Description |
|------|-------------|
| `list_segments` | Customer segments (RFM/marketing cohorts) |
| `list_costs` / `create_cost` | Expense records for margin analytics |

### Files
| Tool | Description |
|------|-------------|
| `files_list` / `files_get` / `files_upload` | Attach & retrieve files (raw octet-stream upload) |

### References
| Tool | Description |
|------|-------------|
| `list_statuses` / `list_delivery_types` / `list_payment_types` / `list_stores` | Order/delivery/payment/store reference data |
| `list_sites` | Sites the API key can act on (fill the `site` param) |
| `list_countries` / `list_order_types` / `list_order_methods` | Address & order reference data |

### Analytics
| Tool | Description |
|------|-------------|
| `get_orders_summary` | Period-scoped order stats: exact count + revenue, AOV, status distribution |
| `get_customers_summary` | New-customer count for a date range |

## Prompt Skills (2)

| Skill | Description |
|-------|-------------|
| `new-orders` | Quick daily overview of today's orders |
| `customer-search` | Find a customer by name, email, or phone |

## Setup

1. In RetailCRM, go to **Settings > Integration > API keys**.
2. Create an API key with the required permissions (orders, customers, store, references). For a **multi-site** key, pass the `site` code on create/edit tools (see `list_sites`).
3. Note your domain (the `yourstore` part of `yourstore.retailcrm.ru`).

## Environment Variables

Secrets are provided via environment variables only — never on the command line, in config files, or in logs.

| Variable | Required | Description |
|----------|----------|-------------|
| `RETAILCRM_DOMAIN` | Yes | Your RetailCRM domain (e.g. `yourstore.retailcrm.ru`) |
| `RETAILCRM_API_KEY` | Yes | API key (sent via the `X-API-KEY` header by the PHP client) |
| `RETAILCRM_READONLY` | No | `1` to expose only read tools (hide create/update/merge/delete) |
| `RETAILCRM_RATE_LIMIT` | No | Client-side requests/second cap (RetailCRM allows ~10/s) |
| `RETAILCRM_PHP_BIN` | No | PHP executable for the local (non-Docker) path (default `php`) |
| `RETAILCRM_PHP_BRIDGE` | No | Path to `bin/retailcrm-api.php` (set automatically in Docker) |
| `PORT` / `HOST` | No | HTTP server bind (default `3000` / `127.0.0.1`, `--http` mode only) |
| `RETAILCRM_HTTP_ALLOWED_HOSTS` | No | Comma-separated allowed `Host` values for DNS-rebinding protection |
| `RETAILCRM_DNS_PROTECTION` | No | `off` to disable DNS-rebinding protection (HTTP mode) |

> `RETAILCRM_URL` is still accepted as a fallback for `RETAILCRM_DOMAIN`.

## Docker (recommended)

Build the self-contained image (Node + PHP CLI/cURL + compiled server + PHP bridge + Composer production dependencies — official `retailcrm/api-client-php` **6.15.32**):

```bash
docker build -t retailcrm-mcp:3.1.0 .
```

Run over stdio:

```bash
docker run --rm -i \
  -e RETAILCRM_DOMAIN=yourstore.retailcrm.ru \
  -e RETAILCRM_API_KEY=your-api-key \
  retailcrm-mcp:3.1.0
```

Run the Streamable HTTP server instead by appending `--http`:

```bash
docker run --rm -p 127.0.0.1:3000:3000 \
  -e RETAILCRM_DOMAIN=yourstore.retailcrm.ru \
  -e RETAILCRM_API_KEY=your-api-key \
  -e HOST=0.0.0.0 \
  retailcrm-mcp:3.1.0 --http
```

### Usage with Claude Desktop / MCP clients

```json
{
  "mcpServers": {
    "retailcrm": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i", "--init",
        "-e", "RETAILCRM_DOMAIN",
        "-e", "RETAILCRM_API_KEY",
        "retailcrm-mcp:3.1.0"
      ],
      "env": {
        "RETAILCRM_DOMAIN": "yourstore.retailcrm.ru",
        "RETAILCRM_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Optional: local Node + PHP + Composer

If you prefer not to use Docker, run the same stack locally:

```bash
# 1. Node dependencies + compile
npm install
npm run build

# 2. PHP dependencies (Composer >= 2; plugins and scripts disabled)
composer install --no-dev --no-interaction --no-progress --no-scripts --no-plugins --optimize-autoloader

# 3. Run (stdio)
RETAILCRM_DOMAIN=yourstore.retailcrm.ru \
RETAILCRM_API_KEY=your-api-key \
node dist/index.js

# Or the HTTP server
RETAILCRM_DOMAIN=yourstore.retailcrm.ru \
RETAILCRM_API_KEY=your-api-key \
node dist/index.js --http
```

Requires Node >= 18 and PHP >= 8.1 with the cURL, JSON, mbstring, and openssl extensions.

## Architecture & the raw-upload exception

- All normal RetailCRM traffic (GET and form POST) goes through the official
  `retailcrm/api-client-php` **6.15.32** client (`SimpleClientFactory::createClient` +
  `CustomMethods`/`CustomApiMethod`), executed inside `bin/retailcrm-api.php`.
- The Node client (`src/client.ts`) talks to the bridge over JSON on stdin/stdout
  with a versioned, fail-closed protocol: malformed, empty, or non-JSON bridge
  output is always an error, never success.
- **`files_upload` is the one documented compatibility exception.** The official
  v6.15.32 `FilesUploadRequest` does not preserve this MCP's `?filename=` query
  parameter and caller MIME type, so the bridge performs that single call with
  PHP cURL — same normalized origin, `X-API-KEY` header, 15-second timeout, and
  bounded error handling. Every other tool uses the official client.
- Retry policy is unchanged: 3 attempts, `429` always retried, timeout/5xx retried
  for GETs only (never for ambiguous POSTs), optional client-side rate gate.

## Demo Prompts

**1. Daily order overview:** "Show me all orders created today with status 'new'. Summarize the total count and revenue."

**2. Customer lookup and order history:** "Find the customer with email anna@example.com. Show their full profile and recent orders."

**3. Stock check:** "Is the product with externalId SKU-42 in stock, and in which warehouse?"

## Webhooks / Triggers

RetailCRM does not support API-created webhooks. Use **Triggers** in the admin panel (Settings > Triggers) to send HTTP requests to external endpoints on order/customer events.

## Error Handling

- **Rate limits / 5xx:** automatic retry with exponential backoff + jitter (up to 3 attempts).
- **API errors:** RetailCRM error details are parsed and returned to the model as a tool result with `isError: true`, so the agent can self-correct (e.g. retry with `by:"externalId"`).
- **Timeouts:** 15-second whole-call timeout, enforced by terminating the bridge process.

## Development

```bash
npm install
npm test          # vitest (mock-based; no live API key needed)
npm run lint      # eslint
npm run typecheck # tsc --noEmit
npm run dev       # stdio dev mode (tsx)
npm run build     # clean + compile to dist/
```

## License

MIT — upstream © Yahia (theYahia/retailcrm-mcp); `retailcrm/api-client-php` is MIT © RetailCRM.
