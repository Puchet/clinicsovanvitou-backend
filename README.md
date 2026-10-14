# Sovanvitou backend

REST API + web app host for the Sovanvitou hospital management system, backed by **PostgreSQL**.

**Requires Node 22.13 or newer, and PostgreSQL.**

## Run it

```bash
cp .env.example .env        # Configure PostgreSQL connection (DATABASE_URL or PGHOST, PGUSER, etc.)
npm install                 # Install dependencies
npm run migrate             # Optional: migrate data from previous SQLite data/sovanvitou.db
npm run seed                # Optional: load sample data
npm start                   # http://127.0.0.1:3000
npm test                    # API tests + UI logic tests
```

Open the site. On first run it asks you to create the admin account (email + password of 8+ characters). After that it is a normal sign-in page. Admins can add staff accounts through `POST /api/users`.

Docker: `docker build -t sovanvitou . && docker run -p 3000:3000 -e DATABASE_URL=postgresql://user:pass@host:5432/dbname sovanvitou`

## Configuration (.env)

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | Full PostgreSQL connection string | `postgresql://postgres:password@127.0.0.1:5432/sovanvitou` |
| `PGHOST` | PostgreSQL host | `127.0.0.1` |
| `PGPORT` | PostgreSQL port | `5432` |
| `PGUSER` | PostgreSQL username | `postgres` |
| `PGPASSWORD` | PostgreSQL password | `""` |
| `PGDATABASE` | PostgreSQL database name | `sovanvitou` |
| `PGSSL` | Set `true` for SSL (e.g. Supabase, Neon, AWS RDS) | `false` |
| `JWT_SECRET` | 32+ random characters for signing tokens | (auto-generated in DB) |
| `PORT` | HTTP port | `3000` |
| `TZ_OFFSET_HOURS` | UTC timezone offset (7 for Cambodia) | `7` |

## Roles

| Role  | Can do |
|-------|--------|
| staff | Read, create and update everything; run POS sales |
| admin | Everything staff can, plus delete records and manage users |

## API (all JSON, `Authorization: Bearer <token>`)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/health` | No auth |
| GET | `/api/auth/status` | `{needsSetup}`; no auth |
| POST | `/api/auth/setup` | First admin only, works once |
| POST | `/api/auth/login` | Returns `{token, user}`; token lasts 12 h |
| GET | `/api/auth/me` | Current user |
| POST | `/api/auth/password` | `{current, password}`; change your own password |
| GET/PUT | `/api/clinic` | Clinic name, specialty, address, phone, currency (KHR/USD), exchange rate, logo, bank QR, banner, print flags. PUT is admin only |
| POST | `/api/uploads` | Raw JPG/PNG/WebP body (max 2 MB); returns `{photo}` to store on a record |
| GET/POST | `/api/users` | Admin only |
| DELETE | `/api/users/:id` | Admin only |
| GET/POST | `/api/<resource>` | `?q=` search, `?limit=&offset=`; `X-Total-Count` header |
| GET/PUT/DELETE | `/api/<resource>/:id` | DELETE is admin only (except `records`: the author may delete their own) |
| GET | `/api/records?patient_id=&kind=` | Patient file entries: `vitals`, `medical`, `mdhistory`, `beu`, `schedule`, `consultation`, `operation`, `investigation`, `lab`, `echo`, `xray`, `homecare`, `prescription`, `medlist`, `documents`. Any column can be used as an exact-match filter |
| POST | `/api/sales` | `{method:"Cash"\|"Bank", items:[{medicine_id, qty}]}`; atomic; price and stock come from the database |
| GET | `/api/sales` | Last 200 sales |
| GET | `/api/reports/daily?days=30` | `[{day, n, amt}]` |
| GET | `/api/dashboard` | Counts and today's revenue |

Resources: `patients`, `appointments`, `ipd`, `doctors`, `medicines`, `records`, `services`, `labs`, `echo`, `diagnoses`, `prescriptions`, `symptoms`, `addresses`, `files`, `chat`. Fields per resource are defined in `db.js`.

## Files

- `server.js`: routes, validation, static hosting
- `db.js`: PostgreSQL connection pool, schema migrations, query helpers
- `auth.js`: scrypt password hashing, signed tokens
- `seed.js`: sample data and optional admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD`
- `migrate-sqlite-to-pg.js`: migrates existing data from SQLite `data/sovanvitou.db` to PostgreSQL
- `../frontend/`: the frontend (no build step). `index.html` is the page, `styles.css` the styling, `app.js` the app logic and the English/Khmer dictionary. It calls this API on the same origin.
- `test.js`: API tests; `test-ui.js`: runs the real frontend scripts against a live server

## Before real patients use it

This holds medical records, so treat the following as required, not optional:

1. **HTTPS.** Put it behind a reverse proxy (Caddy or nginx) with a certificate. Tokens and passwords are otherwise sent in clear text. Keep `HOST=127.0.0.1` and let the proxy face the internet.
2. **Set `JWT_SECRET`** (32+ random characters) and keep `.env` private.
3. **Regular PostgreSQL backups** using `pg_dump`.
4. Check your local health-data and privacy rules before storing real patient information.
