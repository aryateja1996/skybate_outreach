-- Skybate AI Outreach schema
-- Requires MySQL 8.0+
--
--   mysql -u root -p < database/schema.sql

CREATE DATABASE IF NOT EXISTS skybate_outreach
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE skybate_outreach;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  role ENUM('admin', 'operator') NOT NULL DEFAULT 'operator',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sessions (
  id CHAR(64) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  csrf_token CHAR(64) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS contacts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(320) NOT NULL,
  email_normalized VARCHAR(320) NOT NULL,
  contact_name VARCHAR(255) NULL,
  company_name VARCHAR(255) NULL,
  designation VARCHAR(255) NULL,
  website VARCHAR(500) NULL,
  source VARCHAR(255) NULL,
  eligibility_status ENUM('eligible', 'invalid_email', 'suppressed') NOT NULL DEFAULT 'eligible',
  missing_info TINYINT(1) NOT NULL DEFAULT 0,
  is_contacted TINYINT(1) NOT NULL DEFAULT 0,
  last_contacted_at DATETIME NULL,
  contact_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_campaign_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_contacts_email_normalized (email_normalized),
  KEY idx_contacts_eligibility (eligibility_status),
  KEY idx_contacts_company (company_name),
  KEY idx_contacts_missing (missing_info),
  KEY idx_contacts_outreach (is_contacted, eligibility_status),
  KEY idx_contacts_last_campaign (last_campaign_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS import_batches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  filename VARCHAR(255) NOT NULL,
  total_rows INT UNSIGNED NOT NULL,
  inserted_count INT UNSIGNED NOT NULL,
  duplicate_count INT UNSIGNED NOT NULL,
  invalid_count INT UNSIGNED NOT NULL,
  missing_email_count INT UNSIGNED NOT NULL,
  missing_info_count INT UNSIGNED NOT NULL,
  suppressed_count INT UNSIGNED NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_import_batches_created (created_at),
  CONSTRAINT fk_import_batches_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS import_previews (
  id CHAR(36) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  filename VARCHAR(255) NOT NULL,
  rows_json JSON NOT NULL,
  summary_json JSON NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_import_previews_expires (expires_at),
  CONSTRAINT fk_import_previews_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS email_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  style VARCHAR(50) NOT NULL DEFAULT 'professional',
  subject VARCHAR(500) NOT NULL,
  body MEDIUMTEXT NOT NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  ai_generated TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_templates_default (is_default),
  CONSTRAINT fk_templates_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ai_generation_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  status ENUM('success', 'fallback', 'error') NOT NULL,
  model VARCHAR(100) NULL,
  error_code VARCHAR(100) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ai_logs_created (created_at),
  CONSTRAINT fk_ai_logs_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS campaigns (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  template_id BIGINT UNSIGNED NULL,
  subject VARCHAR(500) NOT NULL,
  body MEDIUMTEXT NOT NULL,
  sender_name VARCHAR(255) NOT NULL,
  sender_email VARCHAR(320) NOT NULL,
  status ENUM('draft', 'previewed', 'approved', 'sending', 'paused', 'completed', 'cancelled', 'failed') NOT NULL DEFAULT 'draft',
  total_recipients INT UNSIGNED NOT NULL DEFAULT 0,
  recipient_limit INT UNSIGNED NOT NULL,
  send_rate_per_second DECIMAL(8, 2) NOT NULL DEFAULT 1.00,
  batch_size INT UNSIGNED NOT NULL DEFAULT 5,
  max_attempts INT UNSIGNED NOT NULL DEFAULT 3,
  circuit_breaker_threshold INT UNSIGNED NOT NULL DEFAULT 5,
  consecutive_failures INT UNSIGNED NOT NULL DEFAULT 0,
  circuit_breaker_tripped TINYINT(1) NOT NULL DEFAULT 0,
  dry_run TINYINT(1) NOT NULL DEFAULT 1,
  approved_at TIMESTAMP NULL,
  approved_by BIGINT UNSIGNED NULL,
  started_at TIMESTAMP NULL,
  paused_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,
  cancelled_at TIMESTAMP NULL,
  sending_lock_token VARCHAR(64) NULL,
  sending_lock_acquired_at TIMESTAMP NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_campaigns_status (status),
  KEY idx_campaigns_created (created_at),
  CONSTRAINT chk_campaign_recipient_limit CHECK (recipient_limit > 0),
  CONSTRAINT chk_campaign_send_rate CHECK (send_rate_per_second > 0),
  CONSTRAINT chk_campaign_batch_size CHECK (batch_size > 0),
  CONSTRAINT fk_campaigns_template FOREIGN KEY (template_id) REFERENCES email_templates (id) ON DELETE SET NULL,
  CONSTRAINT fk_campaigns_approved_by FOREIGN KEY (approved_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_campaigns_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  campaign_id BIGINT UNSIGNED NOT NULL,
  contact_id BIGINT UNSIGNED NOT NULL,
  personalized_subject VARCHAR(500) NOT NULL,
  personalized_body MEDIUMTEXT NOT NULL,
  status ENUM(
    'pending',
    'sending',
    'retry_wait',
    'simulated',
    'accepted',
    'delivered',
    'bounced',
    'complained',
    'failed',
    'suppressed',
    'cancelled'
  ) NOT NULL DEFAULT 'pending',
  provider_message_id VARCHAR(255) NULL,
  provider_message_id_normalized VARCHAR(255) NULL,
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_error VARCHAR(1000) NULL,
  failure_class ENUM('none', 'transient', 'permanent', 'ambiguous') NOT NULL DEFAULT 'none',
  next_attempt_at TIMESTAMP NULL,
  locked_at TIMESTAMP NULL,
  locked_by VARCHAR(64) NULL,
  sent_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_campaign_contact (campaign_id, contact_id),
  KEY idx_recipients_contact_status (contact_id, status),
  KEY idx_recipients_queue (campaign_id, status, next_attempt_at),
  KEY idx_recipients_message (provider_message_id_normalized),
  CONSTRAINT fk_recipients_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE RESTRICT,
  CONSTRAINT fk_recipients_contact FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS email_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  campaign_recipient_id BIGINT UNSIGNED NULL,
  provider_message_id VARCHAR(255) NULL,
  event_type ENUM('send', 'delivery', 'bounce', 'complaint', 'reject', 'rendering_failure', 'delivery_delay') NOT NULL,
  event_key CHAR(64) NOT NULL,
  payload_json JSON NULL,
  occurred_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_email_events_key (event_key),
  KEY idx_email_events_recipient (campaign_recipient_id),
  KEY idx_email_events_message (provider_message_id),
  CONSTRAINT fk_email_events_recipient FOREIGN KEY (campaign_recipient_id) REFERENCES campaign_recipients (id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS suppression_list (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email_normalized VARCHAR(320) NOT NULL,
  reason ENUM('unsubscribe', 'hard_bounce', 'complaint', 'manual') NOT NULL,
  source VARCHAR(255) NULL,
  notes VARCHAR(500) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_suppression_email (email_normalized),
  KEY idx_suppression_active (active, reason),
  CONSTRAINT fk_suppression_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS unsubscribe_tokens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  contact_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  used_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_unsubscribe_token_hash (token_hash),
  KEY idx_unsubscribe_contact (contact_id),
  CONSTRAINT fk_unsubscribe_contact FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_user_id BIGINT UNSIGNED NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id BIGINT UNSIGNED NULL,
  metadata_json JSON NULL,
  ip_address VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_entity (entity_type, entity_id),
  KEY idx_audit_action (action),
  KEY idx_audit_created (created_at),
  CONSTRAINT fk_audit_user FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

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

-- Databases created before delivery-delay tracking need the extra event type.
ALTER TABLE email_events
  MODIFY COLUMN event_type ENUM(
    'send',
    'delivery',
    'bounce',
    'complaint',
    'reject',
    'rendering_failure',
    'delivery_delay'
  ) NOT NULL;
