import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import mysql from 'mysql2/promise';
import { loadConfig } from '../config';

async function columnExists(connection: mysql.Connection, table: string, column: string): Promise<boolean> {
  const [rows] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT 1 AS present
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
     LIMIT 1`,
    [table, column],
  );
  return rows.length > 0;
}

async function indexExists(connection: mysql.Connection, table: string, index: string): Promise<boolean> {
  const [rows] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT 1 AS present
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
     LIMIT 1`,
    [table, index],
  );
  return rows.length > 0;
}

async function constraintExists(connection: mysql.Connection, table: string, name: string): Promise<boolean> {
  const [rows] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT 1 AS present
     FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?
     LIMIT 1`,
    [table, name],
  );
  return rows.length > 0;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const connection = await mysql.createConnection({
    host: config.dbHost,
    port: config.dbPort,
    user: config.dbUser,
    password: config.dbPassword,
    database: config.dbName,
    timezone: 'Z',
    multipleStatements: true,
  });
  const before = await connection.query<mysql.RowDataPacket[]>(
    `SELECT
       (SELECT COUNT(*) FROM contacts) AS contacts,
       (SELECT COUNT(*) FROM campaigns) AS campaigns,
       (SELECT COUNT(*) FROM campaign_recipients) AS recipients,
       (SELECT COUNT(*) FROM suppression_list) AS suppressions`,
  );
  try {
    if (!(await columnExists(connection, 'contacts', 'is_contacted'))) {
      await connection.query(
        `ALTER TABLE contacts
           ADD COLUMN is_contacted TINYINT(1) NOT NULL DEFAULT 0 AFTER missing_info,
           ADD COLUMN last_contacted_at DATETIME NULL AFTER is_contacted,
           ADD COLUMN contact_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER last_contacted_at,
           ADD COLUMN last_campaign_id BIGINT UNSIGNED NULL AFTER contact_count`,
      );
    }
    if (!(await indexExists(connection, 'contacts', 'idx_contacts_outreach'))) {
      await connection.query('ALTER TABLE contacts ADD KEY idx_contacts_outreach (is_contacted, eligibility_status)');
    }
    if (!(await indexExists(connection, 'contacts', 'idx_contacts_last_campaign'))) {
      await connection.query('ALTER TABLE contacts ADD KEY idx_contacts_last_campaign (last_campaign_id)');
    }
    if (!(await constraintExists(connection, 'contacts', 'fk_contacts_last_campaign'))) {
      await connection.query(
        `ALTER TABLE contacts
           ADD CONSTRAINT fk_contacts_last_campaign
           FOREIGN KEY (last_campaign_id) REFERENCES campaigns (id) ON DELETE SET NULL`,
      );
    }
    if (!(await indexExists(connection, 'campaign_recipients', 'idx_recipients_contact_status'))) {
      await connection.query(
        'ALTER TABLE campaign_recipients ADD KEY idx_recipients_contact_status (contact_id, status)',
      );
    }
    await connection.query(
      `UPDATE contacts c
       JOIN (
         SELECT contact_id, COUNT(*) AS contact_count, MAX(sent_at) AS last_contacted_at
         FROM campaign_recipients
         WHERE status IN ('accepted', 'delivered', 'bounced', 'complained')
         GROUP BY contact_id
       ) stats ON stats.contact_id = c.id
       SET c.is_contacted = 1,
           c.contact_count = stats.contact_count,
           c.last_contacted_at = stats.last_contacted_at
       WHERE c.contact_count = 0`,
    );
    await connection.query(
      `UPDATE contacts c
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
         AND c.last_campaign_id IS NULL`,
    );
    const after = await connection.query<mysql.RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM contacts) AS contacts,
         (SELECT COUNT(*) FROM campaigns) AS campaigns,
         (SELECT COUNT(*) FROM campaign_recipients) AS recipients,
         (SELECT COUNT(*) FROM suppression_list) AS suppressions,
         (SELECT COUNT(*) FROM contacts WHERE is_contacted = 1) AS contacted`,
    );
    const migrationFile = resolve(__dirname, '../../../database/migrations/20261102_contact_outreach.sql');
    readFileSync(migrationFile, 'utf8');
    console.log(JSON.stringify({
      applied: true,
      before: before[0][0],
      after: after[0][0],
    }));
  } finally {
    await connection.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Migration failed.';
  console.error(JSON.stringify({ applied: false, error: message }));
  process.exitCode = 1;
});
