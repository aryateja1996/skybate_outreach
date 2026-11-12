-- Contact outreach tracking.
-- Safe to apply more than once. The runner skips columns, indexes, and the
-- foreign key when they already exist. It does not delete contacts, campaign
-- recipients, or suppression rows.
--
-- Apply with: npm run migrate:outreach -w backend
--
-- is_contacted, last_contacted_at, contact_count, and last_campaign_id are
-- filled only from recipient rows whose SMTP status was accepted. Later
-- delivery, bounce, and complaint updates stay on campaign_recipients.
-- Simulated and failed rows are not counted.

ALTER TABLE contacts
  ADD COLUMN is_contacted TINYINT(1) NOT NULL DEFAULT 0 AFTER missing_info,
  ADD COLUMN last_contacted_at DATETIME NULL AFTER is_contacted,
  ADD COLUMN contact_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER last_contacted_at,
  ADD COLUMN last_campaign_id BIGINT UNSIGNED NULL AFTER contact_count;

ALTER TABLE contacts
  ADD KEY idx_contacts_outreach (is_contacted, eligibility_status),
  ADD KEY idx_contacts_last_campaign (last_campaign_id);

ALTER TABLE contacts
  ADD CONSTRAINT fk_contacts_last_campaign
  FOREIGN KEY (last_campaign_id) REFERENCES campaigns (id) ON DELETE SET NULL;

ALTER TABLE campaign_recipients
  ADD KEY idx_recipients_contact_status (contact_id, status);

UPDATE contacts c
JOIN (
  SELECT contact_id, COUNT(*) AS contact_count, MAX(sent_at) AS last_contacted_at
  FROM campaign_recipients
  WHERE status IN ('accepted', 'delivered', 'bounced', 'complained')
  GROUP BY contact_id
) stats ON stats.contact_id = c.id
SET c.is_contacted = 1,
    c.contact_count = stats.contact_count,
    c.last_contacted_at = stats.last_contacted_at
WHERE c.contact_count = 0;

UPDATE contacts c
JOIN (
  SELECT r.contact_id, r.campaign_id
  FROM campaign_recipients r
  INNER JOIN (
    SELECT contact_id, MAX(id) AS recipient_id
    FROM campaign_recipients
    WHERE status IN ('accepted', 'delivered', 'bounced', 'complained')
    GROUP BY contact_id
  ) latest ON latest.recipient_id = r.id
) picked ON picked.contact_id = c.id
SET c.last_campaign_id = picked.campaign_id
WHERE c.is_contacted = 1
  AND c.last_campaign_id IS NULL;
