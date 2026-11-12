# Skybate AI Outreach Agent — Project Audit

Audit date: 2 November 2026.  
Scope: read-only inspection of the repository, the local MySQL database `skybate_outreach`, the running API on port 4000, and the Cloudflare Quick Tunnel host currently configured in `PUBLIC_API_URL`.  
No source file other than this report was edited. No database row, environment variable, AWS resource, or campaign was changed. No email was sent.

Verified means observed in this audit: a passing test, a read-only query, a verify-only SMTP handshake, or an HTTP response from the running system. Configured means present in code or environment and not exercised against the live service during this audit.

## 1. Executive summary

The application is a local monorepo for B2B vendor-empanelment outreach. The React desk talks to an Express API. The API uses MySQL, drafts with OpenAI or a fixed template, and can send through Amazon SES SMTP in Mumbai. SES events are designed to return through an SNS HTTPS subscription and `POST /api/webhooks/ses`.

The desk is safe to leave running. `DRY_RUN` is true, `SENDING_ENABLED` is false, and the live-sending confirmation phrase is absent, so the process mode is `dry_run`. SMTP authentication to `email-smtp.ap-south-1.amazonaws.com:587` succeeded in verify-only mode. `messageSent` was false. The configured tunnel answers `GET /api/health` with `{"ok":true,"mode":"dry_run"}`. An unsigned webhook post returns 401.

Two configuration facts block a reliable local demo and a future live test:

- The outreach-tracking code reads `contacts.is_contacted` and `contacts.last_campaign_id`. Those columns are not in the live database. The migration file exists and has not been applied. Contact lists, the dashboard, and campaign creation against MySQL will fail until it is applied. Automated tests still pass because they use an in-memory store.
- `SES_SNS_AUTO_CONFIRM` is currently `true`. The running API logged `SNS subscription confirmation received` with `autoConfirm: true`. The audit request expected this flag to be false. It was not changed.

No SES notification has been stored. `email_events` has 0 rows. The confirmed SNS subscription has not been proven with a real delivery, bounce, or complaint.

Automated results this audit: backend 48 passed, frontend 3 passed, both typechecks passed, backend and frontend production builds passed. There is no failing test in the suite. The suite does not open MySQL, SMTP, OpenAI, or AWS.

## 2. Current architecture

### Runtime

npm workspaces: `frontend` and `backend`. Node 20 or newer. One command, `npm run dev`, starts both through `concurrently`. There is no Docker image, process manager, or Windows service definition.

| Piece | Role |
|---|---|
| `frontend` | React 18, Vite 6, TypeScript, Tailwind, React Router 6. Dev server port 5173 proxies `/api` and `/unsubscribe` to port 4000. |
| `backend` | Express 4, TypeScript, run with `tsx`. Listens on port 4000. |
| MySQL 8 | Database `skybate_outreach` on `127.0.0.1:3306`. Pool via `mysql2`, parameterized queries, `utf8mb4`. |
| OpenAI | Chat Completions, model `gpt-4o-mini`, key only on the server. |
| Amazon SES SMTP | `email-smtp.ap-south-1.amazonaws.com`, port 587, STARTTLS. Sender `sales@skybate.in`. |
| Amazon SNS | Topic `skybate-outreach-events` in `ap-south-1`. Webhook `POST /api/webhooks/ses`. |
| Cloudflare Quick Tunnel | Host in `PUBLIC_API_URL` at audit time: `welding-once-sydney-contribute.trycloudflare.com`. Quick Tunnel hostnames change when the tunnel is restarted. |

The API process loads configuration once at startup, pings MySQL, bootstraps the admin user if the users table is empty, pauses any campaign left in `sending`, and then ticks the send queue once per second. A restart does not resume an in-flight recipient. That recipient is marked failed with class `ambiguous`.

### Frontend structure

Routes: `/login`, `/`, `/contacts`, `/contacts/:id`, `/contacts/import`, `/campaigns`, `/campaigns/new`, `/campaigns/:id`, `/campaigns/:id/report`, `/templates`, `/suppression`.

Authenticated pages share a layout that reads `GET /api/system/status` and shows a dry-run banner. The client uses Axios with credentials and sends `X-CSRF-Token` on mutations. Pages: dashboard, contacts, contact detail, import, campaigns, campaign detail, campaign report, templates, suppression, login.

### Backend structure

| Area | Location |
|---|---|
| HTTP composition | `backend/src/app.ts`, `backend/src/routes/index.ts` |
| Config and send-mode gate | `backend/src/config.ts`, `backend/src/domain/sendGuards.ts` |
| Contacts and import | `backend/src/services/contacts.ts`, `backend/src/services/excel.ts`, `backend/src/domain/importAnalyze.ts` |
| Campaigns | `backend/src/services/campaigns.ts`, `backend/src/domain/campaignState.ts` |
| Queue | `backend/src/services/sending.ts`, `backend/src/domain/retryPolicy.ts` |
| SMTP | `backend/src/services/mailer.ts` |
| AI | `backend/src/services/ai.ts`, `backend/src/domain/aiDraft.ts` |
| SES events | `backend/src/services/sns.ts`, `backend/src/services/events.ts`, `backend/src/domain/sesEvents.ts` |
| Persistence | `backend/src/store/mysql.ts`, `backend/src/store/memory.ts` |

### External integrations

| Integration | State |
|---|---|
| MySQL | Connected. Counts below are from this audit. |
| SES SMTP | Verify-only handshake succeeded. No message sent. Campaign send does not open SMTP while mode is `dry_run`. |
| SNS webhook | Unsigned post to the configured public host returned 401. Signature verification is present. No stored SES event. |
| OpenAI | Key and model are configured. This audit did not call OpenAI. The three stored generation logs are errors. The newest code is `insufficient_quota`. |
| Cloudflare Tunnel | The host in `PUBLIC_API_URL` responded during this audit. The tunnel is a Quick Tunnel, not a named permanent hostname. |

### Authentication and authorization

Sessions live in MySQL. The session id is an httpOnly cookie named `sid`. A separate cookie carries the CSRF token. Mutating `/api` routes compare `X-CSRF-Token` with the session token using a timing-safe compare. Login, logout, the SNS webhook, and the public unsubscribe routes do not use that header.

Roles are `admin` and `operator`. Operators can draft. Approval, start, pause, cancel, import commit, template save, suppression changes, and the SES check require admin. Follow-up selection of an already contacted address also requires admin in the new campaign code.

`COOKIE_SECURE` is false and `TRUST_PROXY` is false. That matches local HTTP login at `http://localhost:5173`. It is not a production cookie setup.

### Email sending infrastructure

Live mode requires every one of these at process start: `DRY_RUN=false`, `SENDING_ENABLED=true`, `LIVE_SENDING_CONFIRMATION` exactly `I_UNDERSTAND_THIS_SENDS_REAL_EMAIL`, `SES_ACCOUNT_APPROVED=true`, complete SMTP credentials, and a sender name and address. Today the first three gates keep the mode at `dry_run`. `SES_ACCOUNT_APPROVED` is already true, so it will not block a later live start.

The worker claims campaigns with status `sending`, then claims due recipients with `FOR UPDATE SKIP LOCKED`. The configured cap is 25 recipients per campaign, 1 message per second, and a batch of 5. A campaign records `dry_run` when it starts. A dry-run campaign never opens SMTP. If a live campaign later finds that the process is no longer live, it pauses instead of sending.

SMTP acceptance sets recipient status `accepted` and, in the new code, increments contact outreach counters. SES Delivery is a later event and is not the same status. Simulated rows stay `simulated`.

### AI integration

The server asks `gpt-4o-mini` for JSON `{subject, body}`. Drafts that invent placements, client names, team sizes, unexpected URLs, or the wrong greeting are rejected. A missing key, a provider error, or a rejected draft returns the standard Skybate template and a visible notice. Generation does not send mail.

### Deployment and runtime setup

The production build emits `backend/dist` and `frontend/dist`. Nothing in the repo installs that build on a server. The public HTTPS endpoint is a temporary Cloudflare Quick Tunnel aimed at this Mac. `PUBLIC_API_URL` is the origin used for unsubscribe links. It is not the SNS subscription setting. The SNS endpoint is configured in AWS, which this audit did not query.

## 3. Implemented features

These exist in code and have automated coverage on the in-memory store, a fake mailer, and mocked SNS payloads, unless a live check is named.

### Contact management

| Feature | Classification | Evidence |
|---|---|---|
| Excel `.xlsx` import, column mapping, preview, commit | Fully implemented and verified in tests. Live file has 2 import batches and 3,605 contacts. | Import tests. Live counts. Browser walk-through was not repeated. |
| Email validation | Fully implemented and verified in tests. | 81 live rows are `invalid_email`. |
| Duplicate detection | Fully implemented and verified in tests. | Unique `email_normalized`. Duplicates are counted on the import batch, not stored as extra contacts. |
| Search | Implemented. Basic search does not need the new columns. | API query parameters. Not re-exercised in the browser. |
| Eligibility categories | Fully implemented. | `eligible`, `invalid_email`, `suppressed`. Live: 3,524 eligible, 81 invalid, 0 suppressed. |
| Suppression list | Fully implemented and verified in tests. | Live table is empty, so a real unsubscribe or bounce has not been stored. |
| Export formula neutralization | Fully implemented and verified in tests. | Cells starting with `=`, `+`, `-`, or `@` are prefixed. |

### Campaign management

| Feature | Classification | Evidence |
|---|---|---|
| Create, preview, approve, typed count, separate start | Fully implemented and verified in tests. | Live campaigns: 2 completed dry runs, 1 cancelled dry run. 11 recipients `simulated`, 1 `cancelled`. |
| Recipient limit and rate limit | Fully implemented. | Enforced at 25, 1/sec, batch 5. Copied onto the campaign at creation. |
| Pause, cancel, circuit breaker, startup recovery | Fully implemented and verified in tests. | Restart marks an in-flight send ambiguous and does not retry it. |
| Dry-run execution | Fully implemented and verified. | API health and startup log both report `dry_run`. SMTP verify did not send. |

### Email management

| Feature | Classification | Evidence |
|---|---|---|
| Personalization | Fully implemented and verified in tests. | Blank name becomes `Hello,`. Blank company becomes `your organization`. |
| Templates | Implemented. | One template row. Save is admin-only. |
| Fallback template | Fully implemented and verified in tests. | Used when AI is unavailable or the draft fails validation. |
| SMTP adapter | Implemented. Connectivity verified without sending. | `connected: true`, `messageSent: false`, host Mumbai, port 587. |
| List-Unsubscribe headers | Implemented for live sends only. | Not exercised, because no live send has been made. |
| Unsubscribe token flow | Fully implemented and verified in tests. | Token is 32 random bytes, stored as SHA-256. `GET` shows a form. `POST` suppresses. A second `POST` does not add another suppression row. |
| Public unsubscribe shape | Verified on the tunnel. | `GET /unsubscribe` with no token returned 404. The real link is `{PUBLIC_API_URL}/unsubscribe/{token}`. |

### Analytics, security, and events that the tests cover

| Feature | Classification | Evidence |
|---|---|---|
| Audit log writes for import, approve, start, cancel | Implemented. | 7 live audit rows in those four actions. |
| Session, CSRF, admin gates | Fully implemented and verified in tests. | Anonymous campaign list returned 401 locally in tests. |
| SNS signature and topic checks | Implemented. Rejection verified. | Unsigned public post returned 401 `SNS_UNVERIFIED`. A non-Amazon certificate URL is rejected in tests. |
| SES event mapping | Fully implemented and verified as pure functions and mocked API cases. | Send, delivery, permanent bounce, transient bounce, complaint, reject, rendering failure, delivery delay. |
| Event deduplication | Implemented and verified on the memory store. | Unique `event_key`. Duplicate complaint and delivery-delay posts do not apply twice. |

## 4. Partially implemented features

| Feature | Why it is partial |
|---|---|
| Global “previously contacted” tracking | Code, UI, and memory-store tests exist. The live `contacts` table has no `is_contacted`, `last_contacted_at`, `contact_count`, or `last_campaign_id`. `database/migrations/20261102_contact_outreach.sql` has not been applied. |
| Dashboard and contact list on MySQL | `getDashboardStats` sums `is_contacted`. Contact queries join `campaigns` on `c.last_campaign_id`. Those statements will fail on the current database. |
| Follow-up selection | The API requires an admin and an explicit `followUpContactIds` list, and tests cover that on the memory store. It cannot run against MySQL until the columns exist. |
| Outreach history page | `GET /api/contacts/:id/outreach` and `ContactDetailPage` exist. Not browser-tested. The contact query behind it uses the missing column. |
| SES event pipeline end to end | Signature checks, parsing, dedup, and status rules are implemented. `email_events` is empty, so SES → SNS → tunnel → MySQL has not delivered a real notification into this database. |
| AI drafting | The fallback path works in tests. The stored logs show the provider has been failing, most recently for quota. Billing was not rechecked in this audit. |
| Deliverability DNS | Not part of the application. A prior public DNS read showed SPF without `amazonses.com` and DMARC `p=none`. DNS was not re-queried in this audit, so treat that as stale until checked again. |

## 5. Missing features

| Feature | Classification |
|---|---|
| Confirmed inbox delivery in this database | Not observed. Zero event rows. |
| Open and click tracking | Not implemented. |
| IMAP or reply detection | Not implemented. |
| Automatic follow-up scheduling | Not implemented. Explicit manual follow-up is the only design. |
| Multi-user admin UI for creating operators | Not implemented. One user row exists. |
| Windows service, installer, or scheduled task | Not implemented. |
| Permanent hostname, TLS terminator, backups, or process supervisor | Not implemented. |
| ESLint job | Not implemented. |
| Tests that open the real MySQL database | Not implemented, by design. |

## 6. Database audit

Live engine: InnoDB. Thirteen tables. Approximate `information_schema` counts are estimates. Exact `COUNT(*)` values are listed.

### Tables and relationships

| Table | Rows | Primary key | Notable unique keys and foreign keys |
|---|---|---|---|
| `users` | 1 | `id` | Unique `email`. |
| `sessions` | 6 | `id` (char 64) | `user_id` → `users`. Index on `expires_at`. |
| `contacts` | 3,605 | `id` | Unique `email_normalized`. Indexes on eligibility, company, missing-info. No outreach columns. |
| `import_batches` | 2 | `id` | `created_by` → `users`. |
| `import_previews` | 0 | `id` (char 36) | `user_id` → `users`. Expiry index. |
| `email_templates` | 1 | `id` | `created_by` → `users`. |
| `ai_generation_logs` | 3 | `id` | `created_by` → `users`. |
| `campaigns` | 3 | `id` | FKs to template, approver, creator. Checks: recipient limit, rate, and batch size greater than 0. |
| `campaign_recipients` | 12 | `id` | Unique `(campaign_id, contact_id)`. FKs to campaign and contact, `ON DELETE RESTRICT`. Queue index `(campaign_id, status, next_attempt_at)`. Message-id index. |
| `email_events` | 0 | `id` | Unique `event_key`. FK to recipient `ON DELETE SET NULL`. Enum includes `delivery_delay`. |
| `suppression_list` | 0 | `id` | Unique `email_normalized`. Index `(active, reason)`. |
| `unsubscribe_tokens` | 11 | `id` | Unique `token_hash`. FK to contact `ON DELETE CASCADE`. |
| `audit_logs` | 7 | `id` | Indexes on entity, action, and time. |

Eleven of twelve recipients are `simulated`. One is `cancelled`. Both completed campaigns and the cancelled campaign are `dry_run = 1`. Suppression is empty. Eleven unsubscribe token hashes exist from dry-run footer generation. They do not mean eleven people unsubscribed.

### Duplicate prevention and integrity

- One stored row per normalized email.
- One recipient row per contact per campaign.
- One SES event row per idempotency key.
- One active suppression row per normalized email. A repeat unsubscribe updates that row.
- Contact deletes are restricted while a campaign recipient points at them.
- Import commit and campaign create run inside a transaction in the MySQL store.
- Recipient claims use `FOR UPDATE SKIP LOCKED`.

### Drift and consistency risks

- `database/schema.sql` now declares `is_contacted`, `last_contacted_at`, `contact_count`, `last_campaign_id`, and `idx_contacts_outreach` on `contacts`. The live table does not have them. The migration script `npm run migrate:outreach -w backend` is the idempotent applicator. It was not run.
- The live recipient table has `fk_recipients_contact` on `contact_id` and does not have the extra `idx_recipients_contact_status` index from that migration. The foreign-key index still supports contact lookups.
- `schema.sql` does not add `fk_contacts_last_campaign` inside `CREATE TABLE`, because `campaigns` is created later. The migration adds that foreign key. A brand-new database built only from `schema.sql` would have the columns and no foreign key until the migration runs.
- Re-applying all of `schema.sql` to this database is unsafe. `CREATE TABLE IF NOT EXISTS` will not add the new columns, and a later `ADD CONSTRAINT` would fail or no-op incorrectly. Use the outreach migration only.
- `information_schema.TABLE_ROWS` is an estimate. The exact contact count is 3,605, not the estimate 3,616.
- Dashboard duplicate totals are the sum of `import_batches.duplicate_count`, not a count of stored duplicate contacts.
- There is no migration history table. The only versioned change file is `database/migrations/20261102_contact_outreach.sql`, plus the delivery-delay enum change already present in the live `email_events.event_type` column.

## 7. SES and SNS integration status

Configured and checked without sending mail:

| Check | Result |
|---|---|
| Region and topic name | `ap-south-1`, `skybate-outreach-events`. The full ARN was not printed. |
| SMTP | Verify-only connected. Port 587, STARTTLS, sender `sales@skybate.in`. |
| Process mode | `dry_run`. |
| `DRY_RUN` | `true`. |
| `SENDING_ENABLED` | `false`. |
| `SES_SNS_AUTO_CONFIRM` | `true` in the environment loaded by this audit. The latest API log line also says `autoConfirm: true`. This does not match the expected `false`. |
| Tunnel health | `GET https://welding-once-sydney-contribute.trycloudflare.com/api/health` returned 200 `{"ok":true,"mode":"dry_run"}`. |
| Unsigned webhook | `POST` of a text/plain notification without a signature returned 401 `SNS_UNVERIFIED`. |
| Stored events | 0. |

### Event flow in code

1. SES publishes to the configuration set destination. The configuration set name `skybate-outreach-tracking` and destination name `skybate_events` are AWS-side. This audit did not call AWS APIs, so those names are taken from the operator’s statement, not from an AWS read.
2. SNS posts an envelope to `/api/webhooks/ses`. Raw message delivery is assumed off. The code requires an SNS envelope and JSON-parses the `Message` string. A raw SES body with no signature is rejected.
3. The certificate URL must be `https://sns.<region>.amazonaws.com`. The signature is checked. `TopicArn` must equal `SES_SNS_TOPIC_ARN`.
4. `SubscriptionConfirmation` returns `{ok:true, confirmation:true}`. If auto-confirm is true and the URL host is `sns.<region>.amazonaws.com`, the process fetches that URL. That is the current setting. A 200 by itself does not confirm a subscription when auto-confirm is false. With auto-confirm true, a verified confirmation message can confirm the subscription.
5. `Notification` messages call `applySesEvent`. Unknown message ids are stored with a null recipient and do not change a campaign row. Matching uses the normalized SMTP message id.
6. Duplicate keys return `duplicate: true` and do not change status or `contact_count`. Contact counts change only in the SMTP-acceptance transaction, which dry-run does not run.
7. Transient SMTP failures retry up to 3 times. Permanent failures, timeouts, and unknown errors after an SMTP attempt do not retry.

### What is not end-to-end tested

- A real SES Send, Delivery, hard bounce, complaint, reject, rendering failure, or delivery delay landing in `email_events`.
- A signed SNS fixture produced with a test key. Tests reject bad signatures. They do not accept a locally signed envelope.
- Webhook tests for permanent bounce, transient bounce, and reject go through status functions, not a full HTTP request for every type. Complaint, delivery, and delivery delay do have HTTP tests with a fake verifier.
- The Quick Tunnel hostname in AWS may differ from `PUBLIC_API_URL` after the next tunnel restart. This audit proved the host currently in `PUBLIC_API_URL`. It did not read the SNS subscription endpoint from AWS.

## 8. Security assessment

| Control | Assessment |
|---|---|
| Passwords | bcrypt. Admin password length is rejected under 12 characters when set. The value was not printed. |
| Sessions | Random id, expiry, server-side row. httpOnly session cookie. |
| CSRF | Required on authenticated mutations. Webhook and unsubscribe are intentionally exempt. Unsubscribe authorization is the unguessable token. |
| Roles | Admin gates are on the routes that change sending, imports, templates, and suppression. |
| SQL injection | Queries use placeholders. Table names are not taken from users. |
| File upload | 10 MB limit, 6,000-row limit, `.xlsx` only. |
| XSS on the unsubscribe page | Token and sender are escaped. |
| Unsubscribe token | 32 random bytes, only the SHA-256 hash is stored. A short or unknown token does not suppress. |
| SNS | Signature and exact topic are required. The unsigned tunnel post confirmed the rejection. |
| Secrets in the frontend bundle | The production bundle from this audit contains no `sk-proj-`, `OPENAI_API_KEY`, or `SES_SMTP_PASSWORD`. |
| Secret logging | The logger redacts keys that look like passwords, tokens, and SMTP fields. The confirmation log line does not include the SubscribeURL. |
| Cookie security | `COOKIE_SECURE=false` is correct for local HTTP and wrong for a public HTTPS login host. |
| Auto-confirm | Now true. A verified subscription-confirmation post can call AWS. That is broader than the earlier false setting. |
| Account-approved flag | Already true. It does not enable sending while the other gates fail. It will be one less brake later. |
| Rate limits | 300 API requests, 10 logins, and 30 unsubscribe requests per 15 minutes outside tests. |
| Error bodies | Unhandled errors return a generic `INTERNAL_ERROR` without a stack. |

No penetration test was performed.

## 9. Test results

| Check | Result |
|---|---|
| Backend Vitest | 4 files, 48 passed, 0 failed. |
| Frontend Vitest | 1 file, 3 passed, 0 failed. |
| Backend `tsc --noEmit` | Passed. |
| Frontend `tsc --noEmit` | Passed. |
| Backend production build | Passed. |
| Frontend production build | Passed. `dist/assets/index-OiU0WD2F.js` is 351.91 kB, CSS 11.90 kB. |

The frontend tests only check metric labels. They do not render pages.

Coverage that exists:

- Auth and CSRF.
- Import, invalid email, duplicates, export neutralization.
- Dry-run send with zero SMTP calls.
- Suppression after approval skips SMTP.
- Pause, cancel, retry classes, startup recovery.
- AI fallback and quota-error redaction.
- SES status mapping, complaint suppression, delivery delay, duplicate events.
- Outreach exclusion, follow-up admin gate, dry-run not marking contacts, SMTP acceptance counting once, delivery not incrementing the count. These use the memory store.
- Tunnel headers do not count as an SNS signature.

Untested workflows:

- Any test against `skybate_outreach`.
- Browser passes for the new contact filters, contact detail page, and follow-up dialog.
- A real signed SNS notification through Cloudflare.
- OpenAI success after credits are added.
- A one-recipient live send.
- SPF, DKIM, and DMARC alignment at send time.

## 10. Performance assessment

The current caps are the main performance control. A campaign cannot contain more than 25 recipients, and the worker sends at 1 per second. Three thousand six hundred contacts are a small table for MySQL. Five thousand contacts fit under the 6,000-row import cap.

| Area | Assessment |
|---|---|
| Excel import | ExcelJS reads the workbook in the API process. Commit inserts in chunks of 200 inside one transaction. A 5,000-row file is acceptable. A much larger file will hold a transaction and memory. |
| Contact list | Page size is capped at 100. Search uses `LIKE '%term%'` on email, name, company, and designation. That will not use the unique email index for a contains-search. Fine at this size. |
| Campaign picker | Loads 100 never-contacted rows. It does not page through 3,500 eligible contacts. |
| Queue | One process, one tick per second, row locks with `SKIP LOCKED`. Concurrent API processes are not designed. Two Node processes would both tick. |
| Events | Unique key lookup is indexed. An unmatched message id still inserts an event. |
| Memory | The workbook and JSON body limits are 10 MB and 2 MB. The API does not stream the Excel parse. |
| Recovery | A crash during `sending` pauses the campaign and does not retry an ambiguous recipient. That favors not sending twice over automatic completion. |

Recommended improvements, in order: apply the outreach migration before relying on the new screens, keep one API process, and add a contact search that can target the normalized email with a prefix when the operator pastes a full address. Do not add a queue product for 25-message campaigns.

## 11. Known issues

1. Live MySQL is behind the code. Dashboard, contact fetch, and new-campaign queries reference columns that are not in `contacts`. Impact: the running API can return 500 on the main desk screens even though tests pass.
2. `SES_SNS_AUTO_CONFIRM` is true. Impact: the process may confirm a future SNS subscription by fetching Amazon’s URL. The earlier operating rule was to confirm only in the AWS console.
3. `email_events` is empty. Impact: delivery, bounce, and complaint behavior is unproven on this tunnel.
4. OpenAI logs show `insufficient_quota` and older `request_failed`. Impact: operators see the standard template until billing works. Not rechecked today.
5. `PUBLIC_API_URL` points at a Quick Tunnel. Impact: unsubscribe links in a message die when the tunnel process stops or the hostname changes. The SNS subscription has the same problem if it still names an older hostname such as `projection-brilliant-plays-tire.trycloudflare.com`.
6. `GET /unsubscribe` without a token is 404. Impact: operators who open the path alone think the route is missing. The message link must include the token.
7. SPF was previously observed without `include:amazonses.com`. Impact: a later live message can be rejected or spam-foldered even when SMTP accepts it. Re-check DNS before any live test.
8. `SES_ACCOUNT_APPROVED=true` while the other send gates are off. Impact: none today. It removes one check on the day live mode is enabled.
9. Frontend tests do not cover the new screens. Impact: a broken contact query is invisible to `npm test`.
10. `liftSuppression` only scans the first 100 suppression rows when matching the typed address. Impact: low while the table is empty.

## 12. Prioritized recommendations

### Critical

| Issue | Business impact | Next step |
|---|---|---|
| Outreach columns are not in MySQL | The desk cannot reliably list contacts or build a campaign on the real database. | Take a backup, then run `npm run migrate:outreach -w backend` once and restart the API. Do not re-run all of `schema.sql`. |
| Quick Tunnel is the public HTTPS name | A confirmed SNS subscription and any unsubscribe link stop working when the tunnel hostname changes. | Before a live test, point AWS and `PUBLIC_API_URL` at the same current host, then confirm health and an unsigned webhook 401. |

### High

| Issue | Business impact | Next step |
|---|---|---|
| Auto-confirm is true | A verified confirmation post can subscribe an endpoint without a console click. | Set `SES_SNS_AUTO_CONFIRM=false` and restart when you want the previous manual rule. This audit did not change it. |
| No stored SES event | Bounce and complaint suppression will not protect the list until a real event arrives. | After the first controlled send, confirm one linked `email_events` row. |
| DNS alignment not rechecked | Mail can leave SES and still fail recipient servers. | Re-read SPF, DKIM, and DMARC before any live send. |
| OpenAI quota | Drafts fall back to the standard template. | Add credits, then generate one draft. Do not treat fallback text as an AI success. |

### Medium

| Issue | Business impact | Next step |
|---|---|---|
| Campaign UI lists only 100 contacts | A chosen test address may be hidden. | Keep the eligible-fill box off and select one visible address, or add search on that screen. |
| Memory-only tests | A schema mismatch ships while CI is green. | Add one migration smoke check that the expected columns exist. Do not point the suite at production data. |
| Cookie flags | Fine locally. Unsafe if the login page is later served on the public HTTPS host. | Set `COOKIE_SECURE=true` and `TRUST_PROXY=true` only when login itself is behind HTTPS. |

### Low

| Issue | Business impact | Next step |
|---|---|---|
| Suppression lift scans 100 rows | A large suppression list could refuse a valid lift. | Look up the row by id first. |
| No open or click metrics | Reports cannot show engagement. | Leave this until after delivery events work. |
| Frontend test depth | UI regressions are manual. | Add a few page tests after the MySQL migration is in place. |

## 13. Development roadmap

Estimates assume one developer who already knows this repo. They are build time, not calendar time with AWS review delays.

### Phase 1: Core functionality and reliability

Features: apply the outreach migration, restart, and confirm contact list, dashboard, and a dry-run campaign still work. Set auto-confirm back to false if manual confirmation is still the rule. Keep one API process.

Dependencies: MySQL backup. No new packages.

Effort: 0.5–1 day.

Acceptance: `GET /api/health` is `dry_run`. Contact and dashboard requests return 200. `is_contacted` exists. Existing 3,605 contacts, 3 campaigns, and 0 suppressions are still present. Tests and typecheck pass. No email is sent.

### Phase 2: Contact management and outreach intelligence

Features: prove never-contacted filtering on MySQL, show outreach history for a simulated contact, and keep suppressed and invalid addresses out of selection.

Dependencies: Phase 1 columns.

Effort: 2–3 days, including a browser pass.

Acceptance: a memory-store test and one local MySQL read show a never-contacted contact can be selected and a previously accepted contact cannot, unless an admin marks follow-up. Suppression still wins.

### Phase 3: Campaign management improvements

Features: search on the campaign picker, a clear one-recipient test path, and a pause control check. No automatic follow-up scheduler.

Dependencies: Phase 1. The existing approval and typed-count flow.

Effort: 2–3 days.

Acceptance: an operator can find one chosen address, preview shows that address only, approval does not send, and start while `dry_run` simulates one row.

### Phase 4: Email analytics and lead management

Features: store the first real SES events, show accepted versus delivered versus bounced on the report, and keep `contact_count` from moving on a duplicate delivery. Reply tracking stays out of scope.

Dependencies: a stable HTTPS webhook, a confirmed SNS subscription on that exact URL, and one controlled live send decided separately.

Effort: 3–5 days after the send is allowed.

Acceptance: one `email_events` row links to the recipient. A repeated notification does not change `contact_count`. A complaint or permanent bounce suppresses. A delivery delay does not.

### Phase 5: Security and production readiness

Features: permanent hostname, `COOKIE_SECURE` and `TRUST_PROXY` only in that deployment, `SES_SNS_AUTO_CONFIRM=false`, secret scanning in the bundle, backups, and a single-host process supervisor. Re-check SPF, DKIM, and DMARC.

Dependencies: a real DNS name and a host that is not a laptop Quick Tunnel.

Effort: 3–5 days, plus DNS propagation.

Acceptance: login works only over HTTPS, the webhook still returns 401 when unsigned, health shows the intended mode, and a restore drill can read the contact count.

### Phase 6: Windows migration and deployment

Features: run the same Node API and the built frontend on Windows with MySQL. Use a Windows service or Task Scheduler only to keep one process up. Keep environment variables out of the repo.

Dependencies: Phases 1 and 5. No architecture change.

Effort: 2–3 days for a single-machine setup.

Acceptance: `npm run build`, API health, a dry-run campaign, and a webhook 401 succeed on that machine. Live sending stays behind the same four flags.

## 14. Production-readiness assessment

Not production-ready.

What is ready: the dry-run product path, SMTP authentication without sending, webhook rejection of unsigned posts, unsubscribe token handling, and a green automated suite and production build.

What blocks production: the unapplied contact-column migration, a temporary tunnel, auto-confirm left on, zero stored SES events, OpenAI quota not rechecked, local cookie settings, no backups or process supervisor, and no proof of DNS alignment.

What blocks the first controlled live email, even after the migration: a stable public unsubscribe and webhook URL, SNS confirmed on that URL, DNS that authorizes SES, a one-address campaign with the fill option off, and an explicit decision to change `DRY_RUN`, `SENDING_ENABLED`, and the confirmation phrase. Those three were not changed in this audit.

---

This report describes the tree and database as inspected on 2 November 2026. Quick Tunnel hostnames and the auto-confirm flag can change without a code edit. Re-read `GET /api/health` and the startup log after the next restart before relying on the hostnames above.
