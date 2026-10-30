# Angeles Arcade Guestbook

Tiny zero-dependency Node service that powers the guestbook wall on the
Angeles Productions Arcade (https://angeles-productions-arcade.onrender.com).

- `GET /api/entries` — newest-first list of signatures
- `POST /api/entries` — `{name, message}` (no account; honeypot + rate limit + no-links rule)
- `DELETE /api/entries` — requires header `x-admin-token: <ADMIN_TOKEN>` and body `{ts}`

Storage: Upstash Redis list `guestbook:entries` via the REST API.
Set in Render: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `ADMIN_TOKEN`.
Without the Upstash vars it runs in-memory (local dev only — entries vanish on restart).
