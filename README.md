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
| GET | `/api/records?patient_id=&kind=` | Patient file entries: `vitals`, `medical`, `mdhistory`, `beu`, `schedule`, `payment`, `treatment`, `consultation`, `operation`, `investigation`, `lab`, `echo`, `xray`, `homecare`, `prescription`, `medlist`, `documents`. Any column can be used as an exact-match filter |
| POST | `/api/sales` | `{method:"Cash"\|"Bank", items:[{medicine_id, qty}]}`; atomic; price and stock come from the database |
| GET | `/api/sales?limit=5000` | Recent sales; default limit is 200 and maximum is 5,000 |
| GET | `/api/reports/medicine-sales?from=&to=&limit=5000` | Itemized medicine sales within an optional date range |
| DELETE | `/api/sales/:saleId/items/:itemId` | Admin only; removes one sale line, restores its medicine stock, and recalculates the sale total |
| POST | `/api/ocr` | Authenticated raw JPG/PNG/WebP image (max 2 MB); extracts English and Khmer text for Sample file templates |
| GET | `/api/reports/daily?days=30` | `[{day, n, amt}]` |
| GET | `/api/dashboard` | Counts and today's revenue |

Resources: `patients`, `appointments`, `ipd`, `doctors`, `payslips`, `expenses`, `medicines`, `records`, `services`, `labs`, `echo`, `diagnoses`, `prescriptions`, `symptoms`, `addresses`, `files`, `chat`. Fields per resource are defined in `db.js`. The Report page combines patient `payment` records and POS sales as income, and uses the `expenses` resource for manually entered expenses. Expenses have `name`, optional `category`, `date` (YYYY-MM-DD), integer `unit_price` and `quantity`, `amount` (unit price × quantity, in KHR), and optional `notes`; they use the standard authenticated resource endpoints, and deletion is admin-only.

Patient Care includes a Patients **Follow Up** tab for tracking patients, and a separate Follow Up page for scheduling follow-up appointments. The **Follow Up** button in Update Bed Information moves a patient directly into the Patients Follow Up tab without creating an appointment or changing the patient's IPD/bed status; this membership is stored in the patient's `follow_up` field. The **Done** icon on a patient in the Follow Up tab completes their active follow-up appointments, closes any active IPD admission, clears the follow-up flag, and returns them to OPD. Scheduled follow-up appointments use the `appointments` resource with `type: "Follow Up"`, `patient_id`, date, time, doctor, status, optional `reminder_date`, `reminder_status` (`Pending` or `Sent`), and notes. Reminders are tracked in the app for staff to send and mark as sent; the system does not automatically contact patients.
Sample file templates store a title and sanitized rich-text `content` in the `files` resource. OCR runs on the backend with Tesseract.js; the first request downloads and caches the English and Khmer language data on the server, so outbound internet access is needed once. Uploaded OCR images are processed in memory and are not stored by the OCR route.

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
