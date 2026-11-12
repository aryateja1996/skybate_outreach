import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import mysql from 'mysql2/promise';
import { loadConfig } from '../config';

async function tableExists(connection: mysql.Connection, table: string): Promise<boolean> {
  const [rows] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT 1 AS present
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
     LIMIT 1`,
    [table],
  );
  return rows.length > 0;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.dbName !== 'skybate_outreach') {
    throw new Error('Refusing to migrate a database other than skybate_outreach.');
  }
  const connection = await mysql.createConnection({
    host: config.dbHost,
    port: config.dbPort,
    user: config.dbUser,
    password: config.dbPassword,
    database: config.dbName,
    timezone: 'Z',
    multipleStatements: false,
  });
  const migrationFile = resolve(__dirname, '../../../database/migrations/20261102_outreach_scheduler.sql');
  readFileSync(migrationFile, 'utf8');
  try {
    const [before] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM contacts) AS contacts,
         (SELECT COUNT(*) FROM campaigns) AS campaigns,
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM email_templates) AS templates`,
    );
    if (!(await tableExists(connection, 'outreach_scheduler_settings'))) {
      await connection.query(
        `CREATE TABLE outreach_scheduler_settings (
           id TINYINT UNSIGNED NOT NULL,
           status ENUM('disabled', 'enabled', 'paused', 'completed') NOT NULL DEFAULT 'disabled',
           daily_limit INT UNSIGNED NOT NULL DEFAULT 20,
           execution_time CHAR(5) NOT NULL DEFAULT '10:00',
           working_days VARCHAR(32) NOT NULL DEFAULT '1,2,3,4,5',
           timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
           template_id BIGINT UNSIGNED NULL,
           ai_personalization TINYINT(1) NOT NULL DEFAULT 0,
           start_date DATE NULL,
           last_run_at DATETIME NULL,
           next_run_at DATETIME NULL,
           last_error VARCHAR(500) NULL,
           last_success_at DATETIME NULL,
           updated_by BIGINT UNSIGNED NULL,
           created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
           PRIMARY KEY (id),
           CONSTRAINT chk_scheduler_settings_singleton CHECK (id = 1),
           CONSTRAINT chk_scheduler_daily_limit CHECK (daily_limit >= 1),
           CONSTRAINT fk_scheduler_template FOREIGN KEY (template_id) REFERENCES email_templates (id) ON DELETE SET NULL,
           CONSTRAINT fk_scheduler_updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
         ) ENGINE=InnoDB`,
      );
    }
    if (!(await tableExists(connection, 'outreach_scheduler_runs'))) {
      await connection.query(
        `CREATE TABLE outreach_scheduler_runs (
           id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
           scheduled_date DATE NOT NULL,
           batch_number INT UNSIGNED NOT NULL,
           campaign_id BIGINT UNSIGNED NULL,
           status ENUM('running', 'completed', 'failed', 'cancelled') NOT NULL,
           trigger_source ENUM('schedule', 'manual') NOT NULL,
           selected_count INT UNSIGNED NOT NULL DEFAULT 0,
           error_message VARCHAR(500) NULL,
           started_at DATETIME NOT NULL,
           finished_at DATETIME NULL,
           created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
           PRIMARY KEY (id),
           UNIQUE KEY uq_scheduler_run_date (scheduled_date),
           KEY idx_scheduler_runs_status (status, started_at),
           KEY idx_scheduler_runs_campaign (campaign_id),
           CONSTRAINT fk_scheduler_run_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE SET NULL
         ) ENGINE=InnoDB`,
      );
    }
    await connection.query(
      `INSERT INTO outreach_scheduler_settings (
         id, status, daily_limit, execution_time, working_days, timezone, ai_personalization
       )
       SELECT 1, 'disabled', 20, '10:00', '1,2,3,4,5', 'Asia/Kolkata', 0
       FROM DUAL
       WHERE NOT EXISTS (SELECT 1 FROM outreach_scheduler_settings WHERE id = 1)`,
    );
    const [after] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM contacts) AS contacts,
         (SELECT COUNT(*) FROM campaigns) AS campaigns,
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM email_templates) AS templates,
         (SELECT COUNT(*) FROM outreach_scheduler_settings) AS settings,
         (SELECT status FROM outreach_scheduler_settings WHERE id = 1) AS scheduler_status`,
    );
    console.log(JSON.stringify({ applied: true, before: before[0], after: after[0] }));
  } finally {
    await connection.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Migration failed.';
  console.error(JSON.stringify({ applied: false, error: message }));
  process.exitCode = 1;
});
