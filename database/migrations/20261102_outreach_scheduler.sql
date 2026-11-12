-- Daily outreach scheduler.
-- Safe to apply more than once. The runner skips existing tables and the
-- default settings row. It does not delete contacts, campaigns, or suppressions.
--
-- Apply with: npm run migrate:scheduler -w backend

CREATE TABLE IF NOT EXISTS outreach_scheduler_settings (
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
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS outreach_scheduler_runs (
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
) ENGINE=InnoDB;

INSERT INTO outreach_scheduler_settings (
  id, status, daily_limit, execution_time, working_days, timezone, ai_personalization
)
SELECT 1, 'disabled', 20, '10:00', '1,2,3,4,5', 'Asia/Kolkata', 0
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM outreach_scheduler_settings WHERE id = 1);
