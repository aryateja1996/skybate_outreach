# HTTP API

The API is rooted at `/api` except for the public unsubscribe page. Authenticated requests use an httpOnly session cookie named `sid`. Mutating requests also send the `X-CSRF-Token` header returned by login or `GET /api/auth/me`.

Errors use this shape and do not include stack traces:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed.", "details": {} } }
```

## Public

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Database ping and current mode (`dry_run` or `live`) |
| POST | `/api/auth/login` | Body `{ email, password }`. Sets session cookies |
| POST | `/api/auth/logout` | Clears the session |
| GET | `/unsubscribe/:token` | HTML confirmation page |
| POST | `/unsubscribe/:token` | Suppresses the address. JSON when `Accept: application/json` |
| POST | `/api/webhooks/ses` | Verified Amazon SNS notifications. See the AWS checklist |

## Signed-in reads

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/auth/me` | Current user and CSRF token |
| GET | `/api/system/status` | Mode, dry-run reasons, sender identity, and sending caps. No secrets |
| GET | `/api/dashboard/stats` | Database counts plus `sendingMode` |
| GET | `/api/contacts` | `page`, `pageSize`, `search`, `eligibility`, `missingInfo` |
| GET | `/api/contacts/:id` | One contact |
| GET | `/api/contacts/export` | `.xlsx` download. Formula-like cells are prefixed |
| GET | `/api/templates` | Saved templates |
| GET | `/api/campaigns` | Campaign history |
| GET | `/api/campaigns/:id` | Campaign plus suppressed and ineligible counts |
| GET | `/api/campaigns/:id/recipients` | Personalized recipients |
| GET | `/api/campaigns/:id/events` | Report counts and provider events |
| GET | `/api/suppression` | Suppression records |

`GET /api/campaigns/:id/events` distinguishes:

- `simulated`: dry-run only
- `accepted`: SES accepted the submission, including messages that later bounced or drew a complaint
- `delivered`: confirmed by a delivery event

## Signed-in changes

These require `X-CSRF-Token`. Administrator role is required for import commit, template save, approval, start, pause, cancel, suppression, and the SES connection check.

| Method | Path | Body |
| --- | --- | --- |
| POST | `/api/system/ses-check` | Empty. Dry-run does not open SMTP. Live mode verifies the connection and does not send mail |
| POST | `/api/contacts/import/preview` | Multipart file field `file` and optional `mapping` JSON |
| POST | `/api/contacts/import/commit` | `{ "previewId" }` |
| PATCH | `/api/contacts/:id` | Name, company, designation, website, source, email |
| POST | `/api/templates/generate` | `{ purpose, style }`. Does not save or send |
| POST | `/api/templates` | `{ name, style, subject, body }` |
| PATCH | `/api/templates/:id` | Any of those fields |
| POST | `/api/campaigns` | See below |
| PATCH | `/api/campaigns/:id` | Edits draft content and returns it to draft |
| POST | `/api/campaigns/:id/generate-previews` | Rebuilds personalized messages |
| POST | `/api/campaigns/:id/approve` | `{ "confirmRecipientCount" }` |
| POST | `/api/campaigns/:id/start` | `{ "confirmRecipientCount" }` |
| POST | `/api/campaigns/:id/pause` | Empty |
| POST | `/api/campaigns/:id/cancel` | Empty |
| POST | `/api/suppression` | `{ email, reason, notes }` |
| POST | `/api/suppression/:id/lift` | `{ "confirmEmail" }`. Not used by campaign sending |

Campaign create body:

```json
{
  "name": "October vendor empanelment",
  "templateId": 1,
  "subject": "Vendor Empanelment Request | IT Staffing Services | Skybate Technologies",
  "body": "Hi {{contact_name}}, ...",
  "senderName": "Sreekar Kondaveeti",
  "recipientLimit": 10,
  "contactIds": [1, 2],
  "selectEligible": false
}
```

Use either `contactIds` or `"selectEligible": true`. The server rejects the request when the limit is above `MAX_RECIPIENTS_PER_CAMPAIGN`, when any selected contact is ineligible or suppressed, or when the confirmed count does not match.

Placeholders: `{{contact_name}}`, `{{company_name}}`, `{{designation}}`, `{{website}}`, `{{email}}`.

Suppression reasons: `unsubscribe`, `hard_bounce`, `complaint`, `manual`.

## Webhook

`POST /api/webhooks/ses` accepts an Amazon SNS envelope. The API verifies the SNS signature against the signing certificate, and only when `SigningCertURL` is an `https://sns.<region>.amazonaws.com` URL. The topic ARN must equal `SES_SNS_TOPIC_ARN`. If that variable is empty, the endpoint refuses every request.

Duplicate events are ignored using a unique event key. A second delivery of the same notification does not change counts or add another suppression row.

Subscription confirmation is recorded. The subscribe URL is fetched only when `SES_SNS_AUTO_CONFIRM=true` and the URL host is an Amazon SNS endpoint.
