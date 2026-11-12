# Skybate AI Outreach — integration audit

Date: 19 October 2026  
Scope: repository as it exists, plus read-only checks against the local API, local MySQL, Amazon SES SMTP authentication, public DNS, and the OpenAI error already logged by the running API.  
This audit did not change application code, dependencies, `backend/.env`, or the database. It did not send email and did not turn on live sending.

## Safety state observed

These values were read from the running configuration and were not changed:

| Flag | Value |
| --- | --- |
| `DRY_RUN` | `true` |
| `SENDING_ENABLED` | `false` |
| `SES_ACCOUNT_APPROVED` | `false` |
| `LIVE_SENDING_CONFIRMATION` | not the live-send phrase |
| Effective mode | `dry_run` |
| `GET /api/health` | `{"ok":true,"mode":"dry_run"}` |

`npm run smtp:check -w backend` authenticated to SES and printed `"connected": true, "messageSent": false`. SMTP authentication is not delivery.

## Commands run

| Command | Result |
| --- | --- |
| `npm test` | Backend 35/35 passed. Frontend 3/3 passed. |
| `npm run typecheck` | Backend and frontend passed. |
| `npm run build` | Backend `tsc` and frontend Vite production build passed. |
| `curl http://127.0.0.1:4000/api/health` | 200, `ok: true`, `mode: dry_run`. |
| Read-only MySQL `SHOW TABLES` and `COUNT(*)` | Connected to local `skybate_outreach`. Counts only. No rows dumped. |
| `npm run smtp:check -w backend` | SMTP verify succeeded. No message sent. |
| `POST /api/webhooks/ses` with a dummy JSON body | HTTP 503 `SNS_NOT_CONFIGURED`. |
| `dig` TXT/MX/NS for `skybate.in` | Public DNS only. See external section. |

No ESLint script exists, so lint was not run. The browser was not exercised again in this audit. Automated API tests use an in-memory database and a fake mailer. They are evidence of application logic, not of MySQL, SES delivery, SNS, or OpenAI success.

## How to read a row

- Implementation: `implemented`, `partial`, or `missing` in the repository.
- Configuration: `configured`, `incomplete`, or `unknown` for this machine's `backend/.env` and external accounts.
- Verification: `passed`, `failed`, `blocked`, or `not tested`. `passed` is used only where this audit has a command, test, or live response.

---

## 1. Frontend

| Item | Implementation | Configuration | Verification | Evidence |
| --- | --- | --- | --- | --- |
| Pages and navigation | implemented | configured for local Vite | not tested in the browser this audit | Routes in `frontend/src/App.tsx`: login, dashboard, contacts, import, campaigns, new campaign, campaign detail, report, templates, suppression. Nav in `Layout.tsx`. |
| API client | implemented | `VITE_API_BASE` empty, Vite proxy expected | not tested live | `frontend/src/api/client.ts` sends cookies and `X-CSRF-Token` on mutating requests. |
| Forms and validation | implemented | n/a | not tested in the browser | React Hook Form plus Zod on login, new campaign, and AI writer. Campaign approve/start require typing the recipient count. |
| Loading and errors | partial | n/a | not tested | Pages set an error string from `errorMessage`. Several pages show one line for both loading and error (`CampaignDetailPage`, `CampaignReportPage`). |
| Frontend tests | partial | n/a | passed | `frontend/src/lib/metrics.test.ts`: 3 tests. They cover labels only, not pages, routing, or API calls. |
| Production bundle secrets | implemented | n/a | passed | `frontend/dist/assets/*.js` has no `OPENAI_API_KEY`, `SES_SMTP_PASSWORD`, or `sk-proj-` string. |

Root cause of the frontend test gap: no page or component tests were written. The production build only proves the TypeScript compiles and Vite emits a bundle.

## 2. Backend API, auth, and sessions

| Item | Implementation | Configuration | Verification | Evidence |
| --- | --- | --- | --- | --- |
| Express API | implemented | local port 4000 | passed for health; logic passed in tests | `GET /api/health` returned 200. Routes are registered in `backend/src/routes/index.ts`. |
| Validation and errors | implemented | n/a | passed | `api.test.ts` "requires authentication and a valid CSRF token". Error handler does not return stack traces. |
| Sessions | implemented | cookie not marked Secure | passed in memory tests; live session rows exist | `sessions` table count: 3. `sid` is httpOnly. CSRF cookie is separate. `COOKIE_SECURE=false` and `TRUST_PROXY=false`, which is correct for local HTTP and incomplete for EC2 HTTPS. |
| Authorization | implemented | one user in MySQL | passed in tests | Operators cannot approve. Admin is required for import commit, template save, approve, start, suppression, and SES check. Live role of the single database user was not inspected. |
| Health | implemented | MySQL reachable | passed | `{"ok":true,"mode":"dry_run"}`. |

## 3. MySQL

| Item | Implementation | Configuration | Verification | Evidence |
| --- | --- | --- | --- | --- |
| Pool and ping | implemented | local `127.0.0.1:3306`, database `skybate_outreach`, user and password present | passed | `DATA_STORE=mysql`. Pool in `createMysqlStore`. Running API passed `store.ping()` before listen, and health ping succeeded. |
| Schema | implemented as one SQL file | applied | passed for table presence | `database/schema.sql` is the only migration. Tables present: `users`, `sessions`, `contacts`, `import_batches`, `import_previews`, `email_templates`, `ai_generation_logs`, `campaigns`, `campaign_recipients`, `email_events`, `suppression_list`, `unsubscribe_tokens`, `audit_logs`. Column-by-column drift was not diffed. |
| Transactions and locking | implemented | n/a | not tested against MySQL | `withTransaction` and `FOR UPDATE SKIP LOCKED` exist in `backend/src/store/mysql.ts`. Automated tests use `MemoryStore` only. |
| Persistence | implemented | populated | passed for counts | contacts 3604 (eligible 3523, invalid_email 81), campaigns 1, campaign_recipients 10, email_templates 1, users 1, audit_logs 3, ai_generation_logs 3, email_events 0, suppression_list 0. |

Root cause of the MySQL test gap: `backend/src/test/helpers.ts` forces the memory store. A MySQL regression would not fail `npm test`.

## 4. Excel import and export

| Item | Implementation | Configuration | Verification | Evidence |
| --- | --- | --- | --- | --- |
| Preview, mapping, duplicates, invalid email, missing name | implemented | upload limits from env | passed in API test; live import exists | `api.test.ts` "previews duplicates, invalid emails, and missing names without sending". Live DB: 1 import batch, 3604 contacts, 81 invalid addresses. |
| Normalization | implemented | n/a | passed | `domain.test.ts` "normalizes and rejects invalid addresses". Unique key is normalized email. |
| Formula safety | implemented | n/a | passed | `api.test.ts` "prefixes formula-like export cells" and `domain.test.ts` "prefixes spreadsheet formulas during export". |
| Legacy `.xls` | missing | n/a | not tested live | `.xls` is rejected in `backend/src/services/excel.ts`. Save as `.xlsx`. |

The live import was not repeated in this audit. The counts show a previous import persisted. Duplicate rows are counted on the batch, not stored as extra contacts.

## 5. OpenAI

| Item | Implementation | Configuration | Verification | Evidence |
| --- | --- | --- | --- | --- |
| Env loading and client | implemented | key present, prefix `sk-proj`, model `gpt-4o-mini` | passed for loading; failed for generation | Key was not printed. Client is created only when the key is non-empty (`createOpenAiClient`). |
| Live generation | implemented | billing/quota exhausted | failed | Running API log: HTTP 429, `providerCode` `credit_balance_exhausted`, `providerType` `insufficient_quota`, `errorCode` `insufficient_quota`. Message: no credits remaining. |
| Fallback template | implemented | n/a | passed | Same request path returns the standard template and notice "The AI service was unavailable...". `ai.test.ts` "keeps the standard template when OpenAI rejects the request". |
| Sanitized errors | implemented | development logging | passed | Development log includes status, provider code, and detail. The test asserts the API key string is removed. |
| Generation log | implemented | 3 rows | passed for storage | `insufficient_quota` / `gpt-4o-mini`: 1 row. Older `request_failed` / `gpt-4o-mini`: 2 rows, from the previous generic catch before quota was classified. |
| Model access | unknown beyond the quota error | model name is `gpt-4o-mini` | blocked | A 429 credit error happens before a successful completion, so model access was not proven. |

Root cause: the OpenAI project for this key has no remaining credits. This is not an invalid model name, a missing key, or an application fallback bug. Authentication succeeded far enough for OpenAI to return a billing error rather than 401.

## 6. Templates and personalization

| Item | Implementation | Configuration | Verification | Evidence |
| --- | --- | --- | --- | --- |
| Default template | implemented | 1 saved template | passed in unit tests | Missing name becomes "Hello,". Missing company becomes "your organization". `domain.test.ts` "uses a neutral greeting when the contact name is missing". |
| Editable AI output | implemented | n/a | not tested in the browser | The writer copies the response into editable subject and body fields. Saving is a separate `POST /api/templates`. Generation does not send. |
| Subject rendering | implemented | n/a | passed in unit test | Placeholders are replaced per contact before queueing. |

## 7. Campaigns and queue

| Item | Implementation | Configuration | Verification | Evidence |
| --- | --- | --- | --- | --- |
| Create, select, preview, approve, typed confirmation | implemented | recipient cap default 25 | passed in API tests; one live dry-run campaign exists | `api.test.ts` "personalizes missing names, blocks suppressed contacts, and simulates a dry run". Live audit actions: `contacts_imported` 1, `campaign_approved` 1, `campaign_started` 1. |
| Queue execution | implemented | rate 1/sec, batch 5 unless env overrides | passed as simulation | All 10 live recipients have status `simulated`. `campaigns.dry_run` is 1. Status is `completed`. |
| Retries and ambiguous outcomes | implemented | max attempts default 3 | passed with fake mailer | `api.test.ts` "retries transient failures up to the limit and does not retry ambiguous outcomes" and "stops retrying after the attempt limit". |
| Duplicate send prevention | implemented | n/a | passed in tests | Unique `(campaign_id, contact_id)`. Restart pauses `sending` campaigns and does not retry an in-flight recipient (`pauses an in-progress campaign on startup instead of retrying it`). |
| Status transitions | implemented | n/a | passed | `domain.test.ts` "refuses to start a draft or send an unapproved campaign". Approval does not start sending. |

The live campaign is evidence of a dry-run completion, not of SES delivery. `email_events` is 0.

## 8. Amazon SES SMTP

| Item | Implementation | Configuration | Verification | Evidence |
| --- | --- | --- | --- | --- |
| SMTP verify without sending | implemented | host `email-smtp.ap-southeast-2.amazonaws.com`, port 587, STARTTLS, username and password present | passed | `npm run smtp:check -w backend`: `"connected": true, "messageSent": false`. |
| Sender identity in the app | implemented | `sales@skybate.in`, display name present | passed for configuration | Printed by the verify command. The app forces campaign From to this address. |
| Production access flag | implemented | `SES_ACCOUNT_APPROVED=false` | blocked for live send, by design | Live guards refuse sending until this is true. SMTP login does not prove the account is out of the SES sandbox. |
| Delivery | not established | no SES events stored | not tested | No test message was sent. `email_events` count is 0. |

Root cause of "not delivered": this audit refused to send, and the app is in dry-run. Authentication and delivery are different. The verify command only does connect, STARTTLS, and AUTH.

## 9. Dry-run and live-send protection

| Item | Implementation | Configuration | Verification | Evidence |
| --- | --- | --- | --- | --- |
| Dry-run does not open SMTP for campaign send | implemented | dry-run on | passed | `mailer.test.ts` "does not open SMTP while the mailer is in dry-run mode". Live recipients are `simulated`, not `accepted` or `delivered`. |
| All safeguards required before live start | implemented | live flags off | passed | `domain.test.ts` "blocks live sending when SES checks are incomplete". `evaluateSendGuards` checks approval, recipient limit, eligibility, suppression, rate, batch, dry-run off, sending enabled, confirmation phrase, credentials, sender match, and `SES_ACCOUNT_APPROVED`. |
| Typed confirmation | implemented | n/a | passed in API tests | Approve and start both require `confirmRecipientCount`. |
| Audit log | implemented | 3 rows | passed for the actions present | `campaign_approved`, `campaign_started`, `contacts_imported`. |
| In-app SES check while dry-run | implemented | n/a | not re-called | `POST /api/system/ses-check` returns skipped and does not open SMTP while dry-run is on. Use `npm run smtp:check -w backend` for the connection test. |

Live sending remains disabled.

## 10. Unsubscribe and suppression

| Item | Implementation | Configuration | Verification | Evidence |
| --- | --- | --- | --- | --- |
| Opaque unsubscribe token | implemented | 10 tokens for 10 recipients | passed in code path; no live unsubscribe submitted | Tokens are stored as hashes. The public page does not use the contact id as authorization. |
| Suppression reasons | implemented | list empty | passed in API tests | Reasons: unsubscribe, hard bounce, complaint, manual. `api.test.ts` blocks suppressed contacts and skips a recipient suppressed after approval. |
| Complaint and permanent bounce | implemented | no events received | not tested live | SES complaint and permanent bounce write suppression inside `applySesEvent`. |
| Hardcoded sender on the public page | partial | conflicts with configured sender | not tested in the browser | `unsubscribePage` prints `sreekar.k@skybate.in` while `SES_FROM_EMAIL` is `sales@skybate.in`. |

## 11. Amazon SES / SNS events

| Item | Implementation | Configuration | Verification | Evidence |
| --- | --- | --- | --- | --- |
| Webhook authentication | implemented | `SES_SNS_TOPIC_ARN` empty, auto-confirm false | blocked live; unit behavior passed | Live `POST /api/webhooks/ses` returned 503 `SNS_NOT_CONFIGURED`. With a topic set, tests reject an unverified body with 401 (`api.test.ts` "applies a verified SES event once and suppresses complaints"). Certificate URL allowlist is tested in `domain.test.ts`. |
| Subscription confirmation | implemented | not configured | not tested live | Confirmation is accepted only after signature verification and topic match. Auto-confirm is off. |
| Delivery, bounce, complaint, reject, rendering failure | implemented | no destination observed | passed for parser logic only | `parseSesMessage` accepts those types. A later Send event does not downgrade Delivery (`domain.test.ts`). |
| Delay | missing | n/a | not tested | `DeliveryDelay` is not in `EVENT_TYPES`. Those notifications would be ignored. |
| Idempotency | implemented | `email_events` empty | passed in API test | Duplicate event key does not double-count. |
| Event destination in AWS | unknown | not in this repo | not tested | No configuration set, SNS topic, or HTTPS subscription can be confirmed from the app. The topic ARN is unset, so none is connected. |

## 12. IMAP and reply monitoring

| Item | Implementation | Configuration | Verification | Evidence |
| --- | --- | --- | --- | --- |
| IMAP polling or inbound mailbox | missing | no IMAP host, user, or mailbox variables | not tested | No IMAP client, poller, or reply route exists under `backend/src` or `frontend/src`. Nodemailer mentions of IMAP are inside `node_modules` and are unused. |

Status: planned only. Do not treat reply detection as working.

## 13. Logs and secret handling

| Item | Implementation | Configuration | Verification | Evidence |
| --- | --- | --- | --- | --- |
| Secret redaction | implemented | n/a | passed | `mailer.test.ts` "redacts SMTP usernames and passwords". AI failure test strips an `sk-proj-` value. Logger redacts keys matching password, SMTP, token, cookie, and `sesUser`. |
| Operational logs | partial | development | passed for the OpenAI failure line | The running API logged the quota error without the key. Startup log is `Outreach API listening` with port and mode only. |
| Audit log contents | implemented | 3 actions | passed for action names | Metadata bodies were not printed in this audit. |

## 14. AWS EC2 readiness

| Item | Implementation | Configuration | Verification | Evidence |
| --- | --- | --- | --- | --- |
| Deployment checklist | documented | not applied | not tested on EC2 | `docs/AWS_DEPLOYMENT.md`. No EC2, RDS, systemd, PM2, Docker, or backup script is in the repo. |
| Production env | partial | still development | blocked | `NODE_ENV=development`. `CORS_ORIGINS`, `PUBLIC_APP_URL`, and `PUBLIC_API_URL` are localhost. `COOKIE_SECURE=false`. `TRUST_PROXY=false`. |
| HTTPS | missing in the app | n/a | not tested | TLS is expected at a load balancer. It is not configured here. |
| Health check | implemented | local | passed locally | `GET /api/health`. |
| Backups | missing | n/a | not tested | No backup or restore command. |
| Process manager | missing | a `tsx watch` dev process is running | not a production process | Terminal is `npm run dev` in `backend`. |

---

## Local application issues

1. OpenAI calls fail closed into the standard template. The editor message is generic. The development log now has the real provider code. Generation still cannot succeed until credits exist.
2. Automated tests never open MySQL. The live database is connected and populated, but the MySQL SQL paths are unverified by `npm test`.
3. Frontend tests do not cover pages, forms, or navigation. There is no lint script.
4. The public unsubscribe page hardcodes `sreekar.k@skybate.in` instead of the configured sender `sales@skybate.in`.
5. SES delay notifications are not parsed.
6. IMAP reply monitoring is not implemented.
7. `POST /api/system/ses-check` will not connect while dry-run is on. That is intentional. The safe command is `npm run smtp:check -w backend`.
8. Two older `ai_generation_logs` rows say `request_failed` because that was the generic code before quota classification.

## External AWS, OpenAI, and DNS issues

1. OpenAI billing: HTTP 429 `credit_balance_exhausted` / `insufficient_quota` for model `gpt-4o-mini`. Add credits on the project that owns this key. Do not paste the key into another tool.
2. SES sandbox or production access is unknown. `SES_ACCOUNT_APPROVED=false`. SMTP AUTH succeeded in `ap-southeast-2`. That does not authorize sending and does not prove production access.
3. SNS is not connected. `SES_SNS_TOPIC_ARN` is empty. The webhook returns 503. No configuration set or subscription could be observed. `email_events` is empty.
4. SPF for `skybate.in` does not include Amazon SES. The public TXT record authorizes the A/MX hosts, two IPv4 addresses, `include:_spf.hostingcosmos.com`, and `include:antispamcloud.com`, with `-all`. There is no `include:amazonses.com`. Mail from SES can authenticate at SMTP and still fail receiver SPF checks.
5. DMARC is `p=none` with aggregate reports to `dmarc-reports@skybate.in`. It monitors; it does not reject.
6. DKIM selectors for SES were not looked up because the selectors are not in the repo. Treat SES DKIM as unverified.
7. MX is `0 skybate.in.` Nameservers are `ns101.hostingcosmos.com` and `ns102.hostingcosmos.com`. That is the hosting mailbox DNS, not an app IMAP integration.
8. EC2 HTTPS, RDS, secrets manager, process manager, and backups are not set up in this repository.

## Priority

1. Leave live sending off. Do not set `DRY_RUN=false`, `SENDING_ENABLED=true`, or `SES_ACCOUNT_APPROVED=true` until the items below are done.
2. Add OpenAI credits, then generate one draft and confirm `ai_generation_logs.status` becomes `success`.
3. Before any real send: verify the SES identity for `sales@skybate.in`, publish SES DKIM, add SES to SPF, confirm whether the account is still in the sandbox, set a configuration set to SNS, set `SES_SNS_TOPIC_ARN`, and confirm the HTTPS subscription.
4. Point the public unsubscribe page at the configured sender address.
5. Add a MySQL test run against a disposable database, or accept that `npm test` does not cover SQL.
6. Decide whether reply monitoring is required. It needs a new IMAP design; it is not a configuration switch.
7. For EC2: `NODE_ENV=production`, `DATA_STORE=mysql`, HTTPS, `COOKIE_SECURE=true`, `TRUST_PROXY=true`, real `CORS_ORIGINS` and public URLs, a process manager, health checks, and database backups.

## Checks not run, and the safe command

| Check | Why it was not run | Safe command |
| --- | --- | --- |
| Browser pass of every page | Not repeated against the populated MySQL database in this audit | Start backend and frontend, sign in, and walk import, campaign preview, approve, and dry-run start. Do not turn off dry-run. |
| ESLint | No lint script | Do not add one during an audit. Add a script only as a separate change. |
| SES production-access API | SMTP credentials cannot call `GetAccount` | In the SES console for `ap-southeast-2`, read account status and the verified identity for `sales@skybate.in`. Do not send a test message from the app. |
| SNS subscription state | Topic ARN is empty | After the topic exists, set `SES_SNS_TOPIC_ARN` and confirm the subscription in the console. A dummy POST already proves the app refuses work before that. |
| DKIM lookup | Selector names are unknown | `dig +short TXT <selector>._domainkey.skybate.in` after SES shows the selectors. |
| OpenAI success call | The account has no credits; another call would only repeat 429 | After billing is fixed: `POST /api/templates/generate` from the AI writer. It does not send email. |
| IMAP login | No implementation and no IMAP settings | Do not probe the mailbox until an IMAP design exists. |
| MySQL test suite | Tests are hard-wired to memory | A future test job can point `DATA_STORE=mysql` at an empty database and apply `database/schema.sql`. Do not point it at `skybate_outreach`. |
| Live send | Forbidden by this audit | Do not run a campaign start with live flags. Dry-run completion is the safe proof. |
