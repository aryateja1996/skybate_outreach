# Troubleshooting

## The API will not start

- `Invalid environment configuration` means a value in `backend/.env` does not match the expected type. `ADMIN_PASSWORD` must be at least 12 characters when it is set.
- `DATA_STORE=memory cannot be used when NODE_ENV=production` is intentional.
- A MySQL connection error means the database in `database/schema.sql` has not been created, or `DB_HOST`, `DB_USER`, `DB_PASSWORD`, or `DB_NAME` is wrong. The health check returns 503 when the database cannot be reached.
- For a local interface without MySQL, set `DATA_STORE=memory` and keep `NODE_ENV=development`.

## I cannot sign in

- The administrator is created only when the users table is empty and both `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set. If the table already has users, changing those variables does not reset the password.
- The browser must be on an origin listed in `CORS_ORIGINS`. Local development uses `http://localhost:5173`.
- If the session cookie disappears immediately, `COOKIE_SECURE=true` on plain HTTP will drop it. Use `COOKIE_SECURE=false` on localhost.

## Import fails

- Only `.xlsx` workbooks are accepted. `.xls` is rejected. In Excel, use Save As and choose Excel Workbook (`.xlsx`).
- The first row must be headings. Map the email column when the preview says a mapping is required.
- Files larger than `MAX_UPLOAD_BYTES` (default 10 MB) and sheets with more than `MAX_IMPORT_ROWS` data rows (default 6000) are rejected.
- A preview expires after two hours. Upload the file again.
- Duplicate addresses are skipped. They are counted on the dashboard from import history, not inserted a second time.

## A campaign will not start

The start response lists every failed check. Common ones:

- Previews have not been generated, or the campaign was edited after approval and returned to draft.
- `confirmRecipientCount` does not match the recipient total.
- A recipient is suppressed, has an invalid address, or is otherwise ineligible.
- The recipient limit is missing or smaller than the selected list.
- Live mode is only partly configured. Dry-run stays on until every live flag and SES value is present. The dashboard lists the reasons.
- The sender address does not match `SES_FROM_EMAIL`.

Approval by itself never sends.

## Check the SES SMTP connection

From the repository root:

```bash
npm run smtp:check -w backend
```

This loads `backend/.env`, connects to `SES_SMTP_HOST` with the same STARTTLS settings the mailer uses, and authenticates. It calls Nodemailer's connection check only. It does not send a message, and it does not change `DRY_RUN`, `SENDING_ENABLED`, or `SES_ACCOUNT_APPROVED`.

The output includes the host, port, sender address, and whether a username and password are present. It does not print those credentials. A successful check prints `"connected": true`.

`POST /api/system/ses-check` still does not open SMTP while the server is in dry-run mode. Use the command above for the connection test.

## Dry-run results look like deliveries

Simulated rows use the status `simulated`. Confirmed delivery is only the status `delivered`, which requires a verified SES delivery event. Accepted means SES took the message; it does not mean the inbox received it.

## Sending stopped on its own

- Restarting the API pauses campaigns that were in `sending` and marks any in-flight recipient as an ambiguous failure. Those recipients are not retried, because the message might already have been accepted. Start the campaign again only after reviewing them.
- The circuit breaker pauses a campaign after `CIRCUIT_BREAKER_THRESHOLD` consecutive transport failures. Fix the cause, then start it again.
- Pause and cancel both stop the queue. Cancel also marks recipients that had not been sent.

## Unsubscribe link fails

- The link must hit `PUBLIC_API_URL`, which defaults to `http://localhost:4000`. In production that URL must be public HTTPS.
- A token that was never issued, or that was altered, returns an invalid-link page. It does not reveal whether an address exists.

## Temporary HTTPS tunnel for the SES webhook

Use this only to let Amazon SNS reach the API on this Mac. Leave `DRY_RUN=true` and `SENDING_ENABLED=false`. Do not install a tunnel from the application, and do not change the AWS topic from this repository.

The health check is `GET /api/health`. It returns `ok` and `mode` only.

No environment change is required for the webhook. Keep these as they are:

- `DRY_RUN=true`
- `SENDING_ENABLED=false`
- `SES_SNS_AUTO_CONFIRM=false`
- `SES_SNS_TOPIC_ARN` set to the Mumbai topic `skybate-outreach-events`
- `TRUST_PROXY=false`
- `COOKIE_SECURE=false`
- `PUBLIC_API_URL=http://localhost:4000`

`TRUST_PROXY` and `COOKIE_SECURE` do not decide whether an SNS message is accepted. The webhook ignores `X-Forwarded-Proto` and session cookies. A forwarded header cannot skip the SNS signature check or the `TopicArn` comparison. Leave both false so local sign-in at `http://localhost:5173` continues to receive its session cookie. `PUBLIC_API_URL` is used for unsubscribe links, not for the SNS subscription.

1. Start the API with `npm run dev -w backend`. It listens on port 4000.
2. Start a temporary HTTPS tunnel yourself, aimed at `http://127.0.0.1:4000`. Do not point it at the Vite port.
3. Check `https://<tunnel-host>/api/health`. The body should be `{"ok":true,"mode":"dry_run"}`.
4. In the existing Mumbai SNS topic, subscribe `https://<tunnel-host>/api/webhooks/ses` over HTTPS. Because `SES_SNS_AUTO_CONFIRM=false`, confirm that subscription in the AWS console. A 200 from the API does not by itself confirm the subscription.
5. Send an unsigned POST to `https://<tunnel-host>/api/webhooks/ses`. It must return 401 `SNS_UNVERIFIED` and must not add a row to `email_events`.
6. `GET https://<tunnel-host>/api/campaigns` must return 401. `GET https://<tunnel-host>/.env` must return 404.
7. Stop the tunnel when the test is finished and remove the tunnel subscription from the topic. The topic itself can stay.

SNS posts `text/plain` JSON. The API parses that content type and then verifies the signature against an `https://sns.<region>.amazonaws.com` certificate. The topic must match `SES_SNS_TOPIC_ARN`. A duplicate notification still updates nothing after the first stored event.

## SES webhook returns 401 or 503

- 503 means `SES_SNS_TOPIC_ARN` is empty.
- 401 means the signature failed, the certificate URL is not an Amazon SNS host, or the topic ARN does not match.
- An unverified request does not change recipient status or the suppression list.

## Tests

`npm test` does not use MySQL and does not send mail. If a test fails after a local code change, run `npm run typecheck` as well. The backend test file `backend/src/routes/api.test.ts` covers import, authorization, dry-run, pause, cancel, retries, and SES event idempotency.
