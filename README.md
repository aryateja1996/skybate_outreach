# Skybate AI Outreach

Outreach desk for Skybate Technologies Pvt. Ltd. It imports B2B contacts from Excel, cleans and deduplicates them, drafts vendor-empanelment email, and sends only after a person approves a campaign and then starts it.

Real email is off unless an administrator turns it on. Local development does not need AWS credentials.

## What the app will not do

- It does not email anyone because a row appeared in a spreadsheet.
- Approval does not send. Start is a separate action.
- Dry-run mode never opens an SMTP connection. Simulated results are labeled and are not deliveries.
- Provider acceptance is counted separately from confirmed delivery.
- Suppressed addresses are checked again immediately before each send.
- A restart pauses any campaign that was sending. It does not resume automatically.

## Requirements

- Node.js 20 or newer
- MySQL 8 for normal use
- Optional: an OpenAI API key for drafting. Without it, the standard template is used.
- Optional: Amazon SES SMTP credentials, only when live sending is intentionally enabled

## Project layout

```text
frontend/     React, Vite, TypeScript
backend/      Express, TypeScript
database/     schema.sql
docs/         API, AWS checklist, troubleshooting
examples/     sample-contacts.xlsx
```

## Database

```bash
mysql -u root -p < database/schema.sql
```

Create a database user that can use `skybate_outreach`, then put that user in `backend/.env`. The schema does not insert passwords or cloud credentials. The first boot creates an administrator from `ADMIN_EMAIL` and `ADMIN_PASSWORD` when the users table is empty, and inserts the default empanelment template when no templates exist.

## Configure

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Edit `backend/.env`. Use a password of at least 12 characters. Leave the live-sending flags at their defaults:

```text
DRY_RUN=true
SENDING_ENABLED=false
LIVE_SENDING_CONFIRMATION=
SES_ACCOUNT_APPROVED=false
```

`DATA_STORE=memory` runs the API without MySQL for a local look at the interface. Do not use it when `NODE_ENV=production`. The memory store is also what the automated tests use. It is not the production database.

## Install and run

From the repository root:

```bash
npm install
npm run dev
```

- App: http://localhost:5173
- API: http://localhost:4000
- Health: http://localhost:4000/api/health

Sign in with the administrator email and password from `backend/.env`.

Other commands:

```bash
npm test
npm run typecheck
npm run build
npm run sample:excel
```

`npm test` uses an in-memory database and a fake mail transport. It does not send email.

## Daily workflow

1. Import an `.xlsx` file, map columns, and review duplicates, invalid addresses, and missing names. Commit does not send email. Legacy `.xls` files are rejected; save the workbook as `.xlsx`.
2. Write or generate a template. Generated text can be edited. Generation does not send.
3. Create a campaign with an explicit recipient limit. The default cap is 25 and is set by `MAX_RECIPIENTS_PER_CAMPAIGN`.
4. Generate previews and read the personalized sample. Missing names become "Hello,". Missing companies become "your organization".
5. Approve. This only records approval.
6. Start. In the default configuration this simulates sending and stores the result as simulated.

Each live message is addressed to one recipient. The queue is database-backed, rate-limited, and can be paused or cancelled. Transient SMTP failures retry with backoff up to `MAX_SEND_ATTEMPTS`. Permanent failures and ambiguous timeouts are not retried. Repeated failures trip a circuit breaker and pause the campaign.

## Unsubscribe

Live and dry-run sends append a Skybate identity and a unique unsubscribe link. The link uses a random token, not an internal contact id. Confirming it suppresses that address immediately. Opening the link does not unsubscribe; the request must be submitted.

## Enabling real SES sending

Do this only after the [AWS deployment checklist](docs/AWS_DEPLOYMENT.md). All of the following must be true, or the server stays in dry-run and explains why on the dashboard:

- `DRY_RUN=false`
- `SENDING_ENABLED=true`
- `LIVE_SENDING_CONFIRMATION=I_UNDERSTAND_THIS_SENDS_REAL_EMAIL`
- `SES_ACCOUNT_APPROVED=true`
- `SES_SMTP_HOST`, `SES_SMTP_PORT`, `SES_SMTP_USER`, and `SES_SMTP_PASSWORD` are set
- `SES_FROM_EMAIL` is the verified identity, default `sreekar.k@skybate.in`

A campaign started in dry-run stays a dry-run even if the server is later switched to live. Start a new campaign after enabling live sending.

The sender address on a campaign is always the configured `SES_FROM_EMAIL`. The display name can be edited.

## Further reading

- [API reference](docs/API.md)
- [AWS deployment checklist](docs/AWS_DEPLOYMENT.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
