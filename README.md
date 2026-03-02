# CourseNotif

CourseNotif monitors tracked courses and notifies users when seats open (`os > 0`) using VSB `getClassData.jsp` responses.

## Current status (implemented)

- PostgreSQL-backed persistence (`users`, `courses`, `user_courses`, shared JSP cache, shared session state).
- Express API + single-page web UI (`index.html`) for:
  - passwordless sign-in via email OTP
  - adding/listing/removing tracked courses
  - optional per-user custom course display name
- Monitoring worker (`src/worker.js`) with modes:
  - `--init-login`
  - `--init-login --keep-open`
  - `--once`
  - loop mode (default)
  - `--check-new-course <userId> <cartId>`
- VSB source modes:
  - `browser` (Playwright automation and live response capture)
  - `filesystem` (read JSP files from directory)
  - `db` (reuse latest cached JSP from DB)
- Session resilience in browser mode:
  - auto re-login support
  - shared session expiry tracking and owner alert emails
  - browser context auto-recovery when Playwright context/page is closed unexpectedly
- Notifications are sent using SMTP via `nodemailer` (`src/notification.js`).

## Key files

- `src/apiServer.js`: API server + static UI serving
- `index.html`: frontend
- `src/worker.js`: monitor runner CLI
- `src/monitorService.js`: monitoring flow and session-failure handling
- `src/vsbBrowserSource.js`: Playwright automation and JSP capture
- `src/vsbSource.js`: source mode switcher (`browser` / `filesystem` / `db`)
- `src/jspParser.js`: parser for JSON/XML-like JSP payload variants
- `src/db.js`: PostgreSQL access layer
- `db/schema.sql`: schema and compatibility migration guards
- `scripts/*.sh`: env loader, supervisor scripts, and launchd helpers

## Setup

1. Install dependencies and browser

```bash
npm install
npx playwright install chromium
```

2. Configure environment variables

You can start from the template:

```bash
cp .env.example .env.local
```

Minimum required:

```bash
export DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DB_NAME"
```

Common runtime settings:

```bash
export PORT="3000"
export MONITOR_INTERVAL_SECONDS="60"
export SESSION_DURATION_MINUTES="90"
export VSB_REFRESH_INTERVAL_MINUTES="15"
export OWNER_ALERT_EMAIL="you@example.com"   # optional owner alert target
```

SMTP notification settings (Gmail example):

```bash
export SMTP_HOST="smtp.gmail.com"
export SMTP_PORT="465"
export SMTP_SECURE="true"
export SMTP_USER="yourgmail@gmail.com"
export SMTP_PASS="your_gmail_app_password"
export SMTP_PASS_AUTH="your_auth_gmail_app_password"
export SMTP_FROM="CourseNotif <yourgmail@gmail.com>"
```

Passwordless auth settings:

```bash
export AUTH_OTP_TTL_MINUTES="10"
export AUTH_OTP_RESEND_COOLDOWN_SECONDS="60"
export AUTH_OTP_MAX_FAILED_ATTEMPTS="5"
export AUTH_SESSION_DAYS="30"
export AUTH_COOKIE_SECURE="false"
export OTP_PEPPER="change_this_random_secret"
```

Gmail requirement:

- Enable 2-Step Verification on the Gmail account.
- Generate an App Password and set it as `SMTP_PASS`.

Source mode:

```bash
export VSB_SOURCE_MODE="browser"             # browser | filesystem | db
```

Browser mode essentials:

```bash
export VSB_URL="https://your-vsb-url"
export VSB_USER_DATA_DIR=".data/vsb-profile"
export VSB_HEADLESS="false"
```

Browser mode selectors and timing (optional overrides):

```bash
export VSB_SEARCH_SELECTOR="input[placeholder*='Course Number, Title']"
export VSB_FALL_WINTER_SELECTOR="input[type='radio']"
export VSB_DROPDOWN_OPTION_SELECTOR="[role='option'], .dropdown-item, .ui-menu-item, li"
export VSB_COURSE_ROW_SELECTOR="tr, li, .course, .course-row, .selection, .block, [class*='course']"
export VSB_COURSE_PRESENCE_SELECTOR="tr, li, .course, .course-row, .selection, .block, [class*='course']"
export VSB_COURSE_CHECKBOX_SELECTOR="input[type='checkbox'], [role='checkbox']"
export VSB_CHECKBOX_TIMEOUT_MS="6000"
export VSB_SEARCH_TIMEOUT_MS="15000"
export VSB_DROPDOWN_TIMEOUT_MS="10000"
export VSB_CAPTURE_WAIT_MS="2000"
export VSB_LOGIN_WAIT_SECONDS="600"
```

Browser mode session and auto re-login (optional, recommended):

```bash
export VSB_SYNC_TRACKED_COURSES_ON_START="true"
export VSB_SYNC_TRACKED_COURSES_LIMIT="50"
export VSB_LOGGED_OUT_SELECTOR="input[type='password'], form[action*='login'], button[type='submit']"

export VSB_AUTO_RELOGIN_ENABLED="true"
export VSB_LOGIN_USERNAME="your_username_or_email"
export VSB_LOGIN_PASSWORD="your_password"
export VSB_LOGIN_USERNAME_SELECTOR="input[type='email'], input[name='username'], input[name='user']"
export VSB_LOGIN_PASSWORD_SELECTOR="input[type='password']"
export VSB_LOGIN_SUBMIT_SELECTOR="button[type='submit'], input[type='submit'], button[name='login']"
export VSB_LOGIN_CONTINUE_SELECTOR="a[href*='schedulebuilder.yorku.ca'], a:has-text('Visual Schedule Builder')"
export VSB_POST_LOGIN_WAIT_MS="1500"
```

Filesystem mode only:

```bash
export JSP_SOURCE_DIR="/absolute/path/to/jsp/files"
```

3. Apply schema

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

If `psql` is not on PATH (common on macOS/Homebrew), use:

```bash
/opt/homebrew/opt/postgresql@16/bin/psql "$DATABASE_URL" -f db/schema.sql
```

## Run

Start API + UI:

```bash
npm run web
```

Open `http://localhost:3000`.

Initialize shared browser session (browser mode):

```bash
npm run monitor:init-login
```

Note: `monitor:init-login` exits after session setup and closes the Playwright browser context.

Keep browser open after login (manual verification/debug):

```bash
npm run monitor:init-login:keep-open
```

Single monitor pass:

```bash
npm run monitor:once
```

Continuous loop:

```bash
npm run monitor:loop
```

Immediate forced check for one user-course:

```bash
node src/worker.js --check-new-course <userId> <cartId>
```

Syntax smoke check:

```bash
npm run smoke
```

## Local env helpers (`.env.local`)

Use wrapper scripts if you keep env vars in `.env.local`:

```bash
npm run web:local
npm run monitor:init-login:local
npm run monitor:init-login:keep-open:local
npm run monitor:once:local
npm run monitor:loop:local
```

The wrapper script is `scripts/with-env.sh`.

## Background worker operations

Supervisor loop (manual start/stop):

```bash
bash scripts/start-monitor-supervisor.sh
bash scripts/stop-monitor-supervisor.sh
```

Logs:

- `/tmp/coursenotif_monitor_supervisor.out.log`
- `/tmp/coursenotif_monitor_supervisor.err.log`

macOS launchd (auto restart / login session):

```bash
bash scripts/install-monitor-launchd.sh
bash scripts/uninstall-monitor-launchd.sh
```

## API endpoints

- `GET /api/health`
- `GET /api/auth/me`
- `POST /api/auth/send-otp`
- `POST /api/auth/verify-otp`
- `POST /api/auth/logout`
- `GET /api/tracked-courses` (auth required)
- `POST /api/tracked-courses` (auth required)
- `DELETE /api/tracked-courses/:id` (auth required)

## Current limitations

- No delivery history/retry queue persisted in DB yet.
- OTP auth is implemented, but no external identity provider and no distributed/session revocation dashboard.
- No dedicated unit/integration test suite yet.
