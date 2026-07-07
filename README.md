# sample-mail

Cloudflare Email Worker + D1 + GitHub Pages frontend.

![Sample Mail UI](assets/screenshot.svg)

## Features

- Generate random inbox addresses via `/email/create`
- Protect inbox create/read APIs with access tokens
- Manage access tokens in the password-gated Admin UI
- Receive emails through Cloudflare Email Routing and store them in D1
- Read inbox messages via `/email/:address?limit=10`
- Expose sponsor channel config via `/sponsor/info`
- Serve frontend from `GHPAGE` URL directly through Worker (`/` and `/ui`)
- Auto refresh inbox in frontend every 3 seconds

## Quick Start

1. Install dependencies

```bash
npm install
```

2. Create D1 and initialize schema

```bash
wrangler d1 create <db_name>
wrangler d1 execute <db_name> --file ./sql/schema.sql
```

3. Configure `wrangler.toml`

```toml
name = "sample-mail"
main = "src/index.ts"
compatibility_date = "2024-06-06"

[[d1_databases]]
binding = "DB"
database_name = "<db_name>"
database_id = "<your_database_id>"

[vars]
email_domain = "example.com"
forward_address = "a@example.com;b@example.com"
GHPAGE = "https://<your-github-username>.github.io/sample-mail/"
SPONSOR_CURRENCY = "SOL"
SPONSOR_RECEIVE_HASH = "<wallet_or_receive_hash>"
PASSWORD = "<admin_password>"
```

4. Deploy worker

```bash
npm run deploy
```

## Email Routing

Set a catch-all rule in Cloudflare Email Routing to this Worker, for example:

- `*@email_domain -> sample-mail`

Without this rule, emails will not be delivered to the Worker.

### DNS Records

After enabling Cloudflare Email Routing, add or verify the DNS records shown in your Cloudflare dashboard (exact values may vary by account).

- `MX`: Route incoming mail for `email_domain` to Cloudflare Email Routing
- `TXT (SPF)`: Authorize Cloudflare mail gateway for receiving/forwarding
- `TXT (DKIM)`: Enable signing verification if required by dashboard
- `TXT (_dmarc)`: Recommended to reduce spoofing and spam classification

Tip: use the exact record values from the Cloudflare Email Routing page, then test `/email/create` and your inbound mail flow after DNS propagation.

## API

Inbox APIs require an access token created in the Admin UI. Send it as a bearer token:

```http
Authorization: Bearer at_xxx
```

Create inbox:

```http
GET /email/create
```

Response example:

```json
{
    "success": true,
    "data": {
        "fetch_endpoint": "/email/abc123@example.com",
        "address": "abc123@example.com",
        "mode": "catch_all_worker_rule"
    }
}
```

Get messages:

```http
GET /email/{address}?limit=10
```

Admin login:

```http
POST /admin/login
Content-Type: application/json

{"password":"<admin_password>"}
```

List access tokens:

```http
GET /admin/tokens
X-Admin-Password: <admin_password>
```

Create access token:

```http
POST /admin/tokens
Content-Type: application/json
X-Admin-Password: <admin_password>

{"name":"Production client"}
```

Revoke access token:

```http
DELETE /admin/tokens/{id}
X-Admin-Password: <admin_password>
```

Get sponsor info:

```http
GET /sponsor/info
```

Response example:

```json
{
    "success": true,
    "data": {
        "channels": [
            {
                "name": "SOL Transfer",
                "currency": "SOL",
                "receive_hash": "3eTz3jCELZGjH9oJ5WT4u7jSGF98vanLgrkGwFCwYFoo"
            }
        ]
    }
}
```

## Frontend (GitHub Pages)

- Frontend source is `assets/index.html`
- Workflow deploys `assets/` to `gh-pages` automatically
- Worker reads `GHPAGE` and returns that UI from `/`, `/ui`, and `/admin`
- Use the Admin view with `PASSWORD` to create access tokens. Paste an access token into the Inbox advanced settings before creating or reading inboxes.

## Notes

- If `email_domain` is missing, `/email/create` returns a config error
- `forward_address` can be empty; use `;` to separate multiple emails
- If `PASSWORD` is missing, admin token management returns a config error
