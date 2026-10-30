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

Docker / Synology: reserve `192.168.101.12` for the NAS in your router, then use Synology Container Manager to create a Project from the repository folder containing `compose.yaml`. Copy `.env.nas.example` to `.env`, replace both placeholder values with separate strong secrets, and start the project. The app is available on the local network at `http://192.168.101.12:3000`. The app port is bound only to that NAS address; PostgreSQL and application data use persistent Docker volumes.

This direct HTTP address is not encrypted. Keep it on a trusted local network and do not expose port 3000 to the internet. Use DSM's HTTPS reverse proxy if remote access or encrypted connections are needed.

## Configuration (.env)

| Variable          | Description                                       | Default                                                    |
| ----------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| `DATABASE_URL`    | Full PostgreSQL connection string                 | `postgresql://postgres:password@127.0.0.1:5432/sovanvitou` |
| `PGHOST`          | PostgreSQL host                                   | `127.0.0.1`                                                |
| `PGPORT`          | PostgreSQL port                                   | `5432`                                                     |
| `PGUSER`          | PostgreSQL username                               | `postgres`                                                 |
| `PGPASSWORD`      | PostgreSQL password                               | `""`                                                       |
| `PGDATABASE`      | PostgreSQL database name                          | `sovanvitou`                                               |
| `PGSSL`           | Set `true` for SSL (e.g. Supabase, Neon, AWS RDS) | `false`                                                    |
| `JWT_SECRET`      | 32+ random characters for signing tokens          | (auto-generated in DB)                                     |
| `PORT`            | HTTP port                                         | `3000`                                                     |
| `TZ_OFFSET_HOURS` | UTC timezone offset (7 for Cambodia)              | `7`                                                        |

## Roles and permissions

The first account is an administrator and has all permissions. Administrators can create staff accounts in Settings and grant independent **View, Create, Edit, Delete, and Print** permissions for patient records; appointments/IPD; clinical records; pharmacy/services/POS; finance/reports; doctors/payroll; templates/reference data; clinic settings; and user management. Staff can only access the sections and actions granted to their account. Existing staff accounts without a saved permission matrix keep the previous staff defaults.

## Print templates

Users with clinic-settings access can open **Administration → Print Templates** to design shared print headers and footers for printable forms. Users with print permission can use the saved shared template when printing without needing clinic-settings access. Add labels, clinic fields, lines, logos, tables, and summaries; move or resize items on the grid, then edit their typography, colors, visibility, and table columns in Properties. Page size, orientation, margins, font, and text size are also configurable. Selecting **Auto** preserves a form's built-in page layout. Use **Preview** to check the design before saving.

## API (all JSON, `Authorization: Bearer <token>`)

| Method         | Path                                               | Notes                                                                                                                                                                                                                                                                       |
| -------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET            | `/api/health`                                      | No auth                                                                                                                                                                                                                                                                     |
| GET            | `/api/auth/status`                                 | `{needsSetup}`; no auth                                                                                                                                                                                                                                                     |
| POST           | `/api/auth/setup`                                  | First admin only, works once                                                                                                                                                                                                                                                |
| POST           | `/api/auth/login`                                  | Returns `{token, user}`; token lasts 12 h                                                                                                                                                                                                                                   |
| GET            | `/api/auth/me`                                     | Current user                                                                                                                                                                                                                                                                |
| POST           | `/api/auth/password`                               | `{current, password}`; change your own password                                                                                                                                                                                                                             |
| GET/PUT        | `/api/clinic`                                      | Clinic settings; requires clinic-settings view/edit permission                                                                                                                                                                                                               |
| POST           | `/api/uploads`                                     | Raw JPG/PNG/WebP body (max 2 MB); returns `{photo}` to store on a record                                                                                                                                                                                                    |
| GET/POST       | `/api/users`                                      | Requires user-management view/create permission; newly created accounts use custom permissions                                                                                                                                                                               |
| PUT/DELETE     | `/api/users/:id`                                  | Requires user-management edit/delete permission; cannot change your own staff permissions, delete your own account, or delete an administrator account                                                                                                                       |
| GET/POST       | `/api/<resource>`                                  | Requires the resource's corresponding view/create permission; `?q=` search, `?limit=&offset=`; `X-Total-Count` header                                                                                                                                                       |
| GET/PUT/DELETE | `/api/<resource>/:id`                              | Requires the corresponding view/edit/delete permission                                                                                                                                                                                                                       |
| GET            | `/api/records?patient_id=&kind=`                   | Patient file entries are filtered by clinical, appointment/IPD, and finance permissions. Record kinds include `vitals`, `medical`, `mdhistory`, `beu`, `schedule`, `payment`, `treatment`, `consultation`, `operation`, `investigation`, `lab`, `echo`, `xray`, `homecare`, `prescription`, `medlist`, and `documents`. Any column can be used as an exact-match filter |
| POST           | `/api/sales`                                       | `{method:"Cash"\|"Bank", items:[{medicine_id, qty}]}`; atomic; price and stock come from the database                                                                                                                                                                       |
| GET            | `/api/sales?limit=5000`                            | Recent sales; default limit is 200 and maximum is 5,000                                                                                                                                                                                                                     |
| GET            | `/api/reports/medicine-sales?from=&to=&limit=5000` | Itemized medicine sales within an optional date range                                                                                                                                                                                                                       |
| DELETE         | `/api/sales/:saleId/items/:itemId`                 | Requires pharmacy/services/POS delete permission; removes one sale line, restores its medicine stock, and recalculates the sale total                                                                                                                                       |
| POST           | `/api/ocr`                                         | Authenticated raw JPG/PNG/WebP image (max 2 MB); extracts English and Khmer text for Sample file templates                                                                                                                                                                  |
| POST           | `/api/patients/import-xlsx`                        | Authenticated Excel workbook import; requires a `name` column, supports up to 1,000 patients, and imports rows atomically                                                                                                                                                  |
| GET            | `/api/reports/daily?days=30`                       | `[{day, n, amt}]`                                                                                                                                                                                                                                                           |
| GET            | `/api/dashboard`                                   | Counts and today's revenue                                                                                                                                                                                                                                                  |

Resources: `patients`, `appointments`, `ipd`, `doctors`, `payslips`, `expenses`, `medicines`, `records`, `services`, `labs`, `echo`, `diagnoses`, `prescriptions`, `symptoms`, `addresses`, `files`, `chat`. Fields per resource are defined in `db.js`. The Report page combines patient `payment` records and POS sales as income, and uses the `expenses` resource for manually entered expenses. Expenses have `name`, optional `category`, `date` (YYYY-MM-DD), integer `unit_price` and `quantity`, `amount` (unit price × quantity, in KHR), and optional `notes`; they use the standard authenticated resource endpoints, and deletion is admin-only.

The Patients page imports `.xlsx` files with a header row. Supported patient columns include `name`, `latin_name`, `age`, `age_unit`, `dob`, `sex`/`gender`, `phone`, `addr`/`address`, `type`, `room`, `bed`, `unpaid`, `khmer`, `nssf`, `pet`, `follow_up`, `diagnosis`, `nssf_id`, `national_id`, `complaints`, `history`, and `reg_date`. Boolean columns accept Yes/No, true/false, or 1/0. Existing patient IDs are not reused; imported rows create new patients.

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
