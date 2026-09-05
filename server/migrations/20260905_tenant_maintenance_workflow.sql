BEGIN;

CREATE TABLE IF NOT EXISTS tenant_maintenance_request_assignments (
  user_id             BIGINT NOT NULL,
  request_id          BIGINT NOT NULL,
  member_user_id      BIGINT NOT NULL,
  assigned_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id),
  CONSTRAINT tenant_maintenance_assignment_request_fk
    FOREIGN KEY (user_id, request_id)
    REFERENCES tenant_maintenance_requests(user_id, id) ON DELETE CASCADE,
  CONSTRAINT tenant_maintenance_assignment_membership_fk
    FOREIGN KEY (user_id, member_user_id)
    REFERENCES account_memberships(account_user_id, member_user_id)
    ON DELETE CASCADE,
  CONSTRAINT tenant_maintenance_assignment_time_valid
    CHECK (updated_at >= assigned_at)
);
CREATE INDEX IF NOT EXISTS idx_tenant_maintenance_assignment_member
  ON tenant_maintenance_request_assignments(user_id, member_user_id, request_id);

CREATE TABLE IF NOT EXISTS tenant_maintenance_request_events (
  id                               BIGSERIAL PRIMARY KEY,
  user_id                          BIGINT NOT NULL,
  request_id                       BIGINT NOT NULL,
  event_type                       TEXT NOT NULL,
  actor_user_id                    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_email_snapshot             TEXT NOT NULL DEFAULT '',
  previous_assignee_user_id        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  previous_assignee_email_snapshot TEXT NOT NULL DEFAULT '',
  new_assignee_user_id             BIGINT REFERENCES users(id) ON DELETE SET NULL,
  new_assignee_email_snapshot      TEXT NOT NULL DEFAULT '',
  previous_status                  TEXT,
  new_status                       TEXT,
  note                             TEXT NOT NULL DEFAULT '',
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tenant_maintenance_event_request_fk
    FOREIGN KEY (user_id, request_id)
    REFERENCES tenant_maintenance_requests(user_id, id) ON DELETE CASCADE,
  CONSTRAINT tenant_maintenance_event_type_valid
    CHECK (event_type IN ('assignment_changed','status_changed')),
  CONSTRAINT tenant_maintenance_event_status_values_valid CHECK (
    previous_status IS NULL OR previous_status IN
      ('new','acknowledged','in_progress','resolved','cancelled')
  ),
  CONSTRAINT tenant_maintenance_event_new_status_values_valid CHECK (
    new_status IS NULL OR new_status IN
      ('new','acknowledged','in_progress','resolved','cancelled')
  ),
  CONSTRAINT tenant_maintenance_event_shape_valid CHECK (
    (
      event_type='assignment_changed'
      AND previous_status IS NULL
      AND new_status IS NULL
      AND previous_assignee_user_id IS DISTINCT FROM new_assignee_user_id
    )
    OR
    (
      event_type='status_changed'
      AND previous_assignee_user_id IS NULL
      AND new_assignee_user_id IS NULL
      AND previous_status IS NOT NULL
      AND new_status IS NOT NULL
      AND previous_status<>new_status
    )
  ),
  CONSTRAINT tenant_maintenance_event_content_valid CHECK (
    char_length(actor_email_snapshot) <= 320
    AND char_length(previous_assignee_email_snapshot) <= 320
    AND char_length(new_assignee_email_snapshot) <= 320
    AND char_length(note) <= 500
  )
);
CREATE INDEX IF NOT EXISTS idx_tenant_maintenance_event_request
  ON tenant_maintenance_request_events(user_id, request_id, created_at, id);

DO $$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'tro_bill_runtime', 'tro_bill_runtime_sql', 'tro_bill_app'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format(
        'GRANT UPDATE (status, updated_at) ON tenant_maintenance_requests TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_maintenance_request_assignments TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT SELECT, INSERT ON tenant_maintenance_request_events TO %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON tenant_maintenance_request_events FROM %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE tenant_maintenance_request_events_id_seq TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

SELECT
  to_regclass('public.tenant_maintenance_request_assignments') IS NOT NULL
    AS tenant_maintenance_assignments_ready,
  to_regclass('public.tenant_maintenance_request_events') IS NOT NULL
    AS tenant_maintenance_events_ready,
  to_regclass('public.idx_tenant_maintenance_assignment_member') IS NOT NULL
    AS tenant_maintenance_assignment_index_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='tenant_maintenance_assignment_membership_fk'
  ) AS tenant_maintenance_membership_fk_ready,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime_sql') THEN
    has_column_privilege(
      'tro_bill_runtime_sql', 'tenant_maintenance_requests', 'status', 'UPDATE'
    )
    AND NOT has_column_privilege(
      'tro_bill_runtime_sql', 'tenant_maintenance_requests', 'description', 'UPDATE'
    )
    AND has_table_privilege(
      'tro_bill_runtime_sql', 'tenant_maintenance_request_assignments', 'INSERT'
    )
    AND has_table_privilege(
      'tro_bill_runtime_sql', 'tenant_maintenance_request_events', 'INSERT'
    )
    AND NOT has_table_privilege(
      'tro_bill_runtime_sql', 'tenant_maintenance_request_events', 'DELETE'
    )
  ELSE TRUE END AS tenant_maintenance_workflow_runtime_ready,
  NOT EXISTS (
    SELECT 1
    FROM tenant_maintenance_request_assignments assignment
    LEFT JOIN account_memberships membership
      ON membership.account_user_id=assignment.user_id
     AND membership.member_user_id=assignment.member_user_id
    WHERE membership.member_user_id IS NULL
  ) AS tenant_maintenance_assignment_ownership_ready;
