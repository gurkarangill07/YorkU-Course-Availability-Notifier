-- CourseNotif database schema (PostgreSQL)
-- Maps:
-- 1) user email
-- 2) each user email -> list of entered courses
-- 3) each course (cart_id) -> os + course_name
-- 4) one shared latest JSP/XHR file for all users
-- 5) one shared VSB login/session for all users
-- 6) email OTP auth sessions for API access control
-- 7) durable notification delivery attempts + retries

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_email_has_at CHECK (POSITION('@' IN email) > 1)
);

-- Passwordless authentication OTP challenges (email-based one-time codes).
CREATE TABLE IF NOT EXISTS auth_otp_challenges (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT auth_otp_challenges_email_has_at CHECK (POSITION('@' IN email) > 1)
);

-- Browser/API auth sessions bound to users.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS courses (
  cart_id TEXT PRIMARY KEY,
  course_name TEXT NOT NULL,
  os INTEGER NOT NULL DEFAULT 0 CHECK (os >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A user can track many courses.
-- The same course can be tracked by many users.
CREATE TABLE IF NOT EXISTS user_courses (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cart_id TEXT NOT NULL REFERENCES courses(cart_id) ON DELETE CASCADE,
  display_name TEXT,
  tracking_status TEXT NOT NULL DEFAULT 'active'
    CHECK (tracking_status IN ('active', 'paused', 'notified', 'invalid')),
  notified_at TIMESTAMPTZ,
  invalid_attempts INTEGER NOT NULL DEFAULT 0 CHECK (invalid_attempts >= 0),
  invalid_notified_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  last_observed_os INTEGER CHECK (last_observed_os >= 0),
  requires_fresh_scan BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_courses_user_id_cart_id_unique UNIQUE (user_id, cart_id)
);

-- Durable notification queue/attempt log for course-open emails.
CREATE TABLE IF NOT EXISTS notification_attempts (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('course_open')),
  idempotency_key TEXT NOT NULL UNIQUE,
  suppression_key TEXT,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  user_course_id BIGINT REFERENCES user_courses(id) ON DELETE SET NULL,
  cart_id TEXT NOT NULL,
  to_email TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'retrying', 'sent', 'failed', 'suppressed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  next_retry_at TIMESTAMPTZ,
  last_attempted_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  suppressed_until TIMESTAMPTZ,
  provider_message_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migration guards for older versions:
ALTER TABLE notification_attempts
  ADD COLUMN IF NOT EXISTS suppression_key TEXT;
ALTER TABLE notification_attempts
  ADD COLUMN IF NOT EXISTS payload_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE notification_attempts
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 5;
ALTER TABLE notification_attempts
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
ALTER TABLE notification_attempts
  ADD COLUMN IF NOT EXISTS last_attempted_at TIMESTAMPTZ;
ALTER TABLE notification_attempts
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
ALTER TABLE notification_attempts
  ADD COLUMN IF NOT EXISTS suppressed_until TIMESTAMPTZ;
ALTER TABLE notification_attempts
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE notification_attempts
  ADD COLUMN IF NOT EXISTS last_error TEXT;

-- Stores one shared latest JSP/XHR file for the whole app (not user-specific).
CREATE TABLE IF NOT EXISTS shared_latest_jsp_file (
  singleton_id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton_id = 1),
  file_name TEXT NOT NULL CHECK (LOWER(RIGHT(file_name, 4)) = '.jsp'),
  jsp_body TEXT NOT NULL,
  source_path TEXT,
  payload_hash TEXT,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Stores one shared VSB login/session for your machine/app (not user-specific).
-- Keep credentials out of this table; store encrypted session cookie/token only.
CREATE TABLE IF NOT EXISTS shared_vsb_session (
  singleton_id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton_id = 1),
  session_state TEXT NOT NULL DEFAULT 'not_connected'
    CHECK (session_state IN ('not_connected', 'ok', 'expired', 'needs_reauth')),
  encrypted_session_blob BYTEA,
  session_expires_at TIMESTAMPTZ,
  last_validated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT shared_vsb_session_blob_required_when_ok CHECK (
    (session_state = 'ok' AND encrypted_session_blob IS NOT NULL) OR
    (session_state <> 'ok')
  )
);

-- Migration guard for older versions of this table:
-- ensures rerunning schema updates old constraint behavior.
ALTER TABLE shared_vsb_session
  DROP CONSTRAINT IF EXISTS shared_vsb_session_blob_required_when_connected;
ALTER TABLE shared_vsb_session
  DROP CONSTRAINT IF EXISTS shared_vsb_session_blob_required_when_ok;
ALTER TABLE shared_vsb_session
  ADD CONSTRAINT shared_vsb_session_blob_required_when_ok CHECK (
    (session_state = 'ok' AND encrypted_session_blob IS NOT NULL) OR
    (session_state <> 'ok')
  );

-- Migration guard for newer user course naming behavior:
ALTER TABLE user_courses
  ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE user_courses
  ADD COLUMN IF NOT EXISTS tracking_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE user_courses
  ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;
ALTER TABLE user_courses
  ADD COLUMN IF NOT EXISTS invalid_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_courses
  ADD COLUMN IF NOT EXISTS invalid_notified_at TIMESTAMPTZ;
ALTER TABLE user_courses
  ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
ALTER TABLE user_courses
  ADD COLUMN IF NOT EXISTS last_observed_os INTEGER CHECK (last_observed_os >= 0);
ALTER TABLE user_courses
  ADD COLUMN IF NOT EXISTS requires_fresh_scan BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE user_courses
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE user_courses
  DROP CONSTRAINT IF EXISTS user_courses_tracking_status_check;
ALTER TABLE user_courses
  ADD CONSTRAINT user_courses_tracking_status_check
  CHECK (tracking_status IN ('active', 'paused', 'notified', 'invalid'));

CREATE INDEX IF NOT EXISTS idx_user_courses_user_id ON user_courses(user_id);
CREATE INDEX IF NOT EXISTS idx_user_courses_cart_id ON user_courses(cart_id);
CREATE INDEX IF NOT EXISTS idx_user_courses_tracking_status ON user_courses(tracking_status);
CREATE INDEX IF NOT EXISTS idx_notification_attempts_due
  ON notification_attempts(status, next_retry_at, id);
CREATE INDEX IF NOT EXISTS idx_notification_attempts_suppression
  ON notification_attempts(event_type, suppression_key, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_attempts_user_course
  ON notification_attempts(user_course_id);
CREATE INDEX IF NOT EXISTS idx_shared_vsb_session_state ON shared_vsb_session(session_state);
CREATE INDEX IF NOT EXISTS idx_auth_otp_challenges_email_created_at
  ON auth_otp_challenges(email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_token_hash ON auth_sessions(token_hash);

COMMIT;
