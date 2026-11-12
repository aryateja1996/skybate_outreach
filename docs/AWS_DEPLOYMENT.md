# AWS deployment checklist

This checklist does not create AWS resources. Complete it before setting the live-sending flags. Until then the application stays in dry-run and will not open an SMTP connection.

## Application hosting

- Run the API on Node.js 20 with `NODE_ENV=production` and `DATA_STORE=mysql`.
- Put MySQL 8 on RDS in a private subnet. Apply `database/schema.sql`.
- Serve the frontend build behind the same site as the API, or set `CORS_ORIGINS`, `PUBLIC_APP_URL`, and `PUBLIC_API_URL` to the real HTTPS origins.
- Set `COOKIE_SECURE=true`. Use `COOKIE_SAMESITE=none` only when the browser must send the session cookie across sites.
- Set `TRUST_PROXY=true` when a load balancer terminates TLS.
- Store secrets in the host's secret manager. Do not bake them into the image or the frontend bundle.

## SES identity

- Verify the domain `skybate.in` and the From address in `SES_FROM_EMAIL` (the application default is `sreekar.k@skybate.in`).
- Publish the SES DKIM records. Publish SPF and DMARC for the domain.
- Create SMTP credentials. Put them in `SES_SMTP_USER` and `SES_SMTP_PASSWORD`. These are SMTP credentials, not an access key embedded in source.
- Use port `587` with STARTTLS, or port `465` with TLS. The transport requires TLS 1.2 or newer.
- Leave the account in the SES sandbox until every test recipient is verified. Set `SES_ACCOUNT_APPROVED=true` only after AWS has granted production access, or while every intended recipient is a verified sandbox identity.
- Read the account's maximum send rate. Set `SES_MAX_SEND_RATE` and `SES_MAX_BATCH_SIZE` at or below that quota. The defaults are 1 message per second and 5 per batch.
- Keep `MAX_RECIPIENTS_PER_CAMPAIGN` small for the first live campaign.

## Events

- Create a configuration set.
- Add an event destination for send, delivery, bounce, complaint, reject, delivery delay, and rendering failure.
- Deliver those events to an SNS topic.
- Subscribe `https://<public-api>/api/webhooks/ses` to that topic over HTTPS.
- Set `SES_SNS_TOPIC_ARN` to that topic. The webhook rejects every notification until this is set, and it rejects notifications for any other topic.
- Confirm the subscription. With `SES_SNS_AUTO_CONFIRM=true`, the API confirms only after the SNS signature verifies and only when the SubscribeURL host is `sns.<region>.amazonaws.com`. Otherwise confirm the subscription from the AWS console.
- Bounce and complaint notifications suppress the address. Transient bounces are recorded and do not suppress.

## Last step

Set these together, then restart the API and read the dashboard banner:

```text
DRY_RUN=false
SENDING_ENABLED=true
LIVE_SENDING_CONFIRMATION=I_UNDERSTAND_THIS_SENDS_REAL_EMAIL
SES_ACCOUNT_APPROVED=true
```

Call `POST /api/system/ses-check` as an administrator. It checks the SMTP connection and does not send a message. Then approve a campaign whose recipient count you have typed back, and start it as a separate action.

Campaigns that were started while dry-run was on stay simulated. Create a new campaign after live mode is enabled.
