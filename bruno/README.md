# QueerPulse API — Bruno collection

A [Bruno](https://www.usebruno.com/) collection covering **every REST endpoint** of the
QueerPulse NestJS backend (mirrors `FRONTEND_INTEGRATION.md`).

## Open it

1. Install Bruno (desktop app or `bru` CLI).
2. **Open Collection** → select this `bruno/` folder.
3. Pick the **Local** environment (top-right). It defines `baseUrl` plus id/slug
   placeholders (`slug`, `conversationId`, `eventSlug`, …) — edit these to match
   your data.

## Auth (cookie-based, do this first)

Auth uses **httpOnly JWT cookies**, so Bruno's cookie jar holds the session once set:

1. **Authenticate** — the real flow is `GET /auth/google` → Google consent →
   `GET /auth/google/callback` (sets `access_token` / `refresh_token` / `csrf_token`
   cookies). OAuth can't run headless in Bruno, so either:
   - sign in once in a browser against the same origin and copy the cookies into
     Bruno's **Cookies** jar, or
   - point `baseUrl` at a backend seeded with a test session.
2. **Get the CSRF token** — run **Security → Get CSRF Token**. Its post-response
   script stores the token in the `csrfToken` env var.
3. Now every mutating request (POST/PUT/PATCH/DELETE) automatically sends
   `X-CSRF-Token: {{csrfToken}}`. Safe GETs need no CSRF.

> Skipping step 2 → mutations return **403 "Invalid or missing CSRF token"**.

## Layout

Requests are grouped by domain, ordered to roughly follow a session:
`Auth · Security · Health · Membership · Profiles & Directory · Uploads · Vouching ·
Connections · Messaging · Events · Notifications`.

Each request's **Docs** tab carries the access tier, body notes, rate limits, and
return shape. WebSocket (`/chat`) realtime events are **not** covered here — Bruno is
HTTP-only; see `FRONTEND_INTEGRATION.md` §8.
