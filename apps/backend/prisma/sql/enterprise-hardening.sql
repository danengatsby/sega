-- Enterprise PostgreSQL objects for SEGA accounting.
-- Apply after `prisma db push`:
-- prisma db execute --file prisma/sql/enterprise-hardening.sql --schema prisma/schema.prisma

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE SCHEMA IF NOT EXISTS app_private;

-- Performance indexes for critical API routes:
-- - GET /api/invoices (company filter + search + sort)
-- - GET /api/accounts (company filter + search + sort)
-- - GET /api/reports/dashboard-bi (open docs filtered by status/date)
CREATE INDEX IF NOT EXISTS idx_invoice_company_issue_date_id
  ON public."Invoice" ("companyId", "issueDate" DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_invoice_company_due_date_id
  ON public."Invoice" ("companyId", "dueDate" DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_invoice_company_status_due_issue
  ON public."Invoice" ("companyId", status, "dueDate" ASC, "issueDate" ASC);

CREATE INDEX IF NOT EXISTS idx_supplier_invoice_company_status_due_received
  ON public."SupplierInvoice" ("companyId", status, "dueDate" ASC, "receivedDate" ASC);

CREATE INDEX IF NOT EXISTS idx_invoice_number_trgm
  ON public."Invoice" USING gin (number gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_invoice_description_trgm
  ON public."Invoice" USING gin (description gin_trgm_ops)
  WHERE description IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_partner_name_trgm
  ON public."Partner" USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_partner_cui_trgm
  ON public."Partner" USING gin (cui gin_trgm_ops)
  WHERE cui IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_account_company_code_name
  ON public."Account" ("companyId", code ASC, name ASC);

CREATE INDEX IF NOT EXISTS idx_account_company_created_code
  ON public."Account" ("companyId", "createdAt" DESC, code ASC);

CREATE INDEX IF NOT EXISTS idx_account_code_trgm
  ON public."Account" USING gin (code gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_account_name_trgm
  ON public."Account" USING gin (name gin_trgm_ops);

CREATE OR REPLACE FUNCTION app_private.current_company_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  company_id_text text;
BEGIN
  company_id_text := NULLIF(current_setting('app.company_id', true), '');
  IF company_id_text IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN company_id_text::uuid;
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.current_user_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  user_id_text text;
BEGIN
  user_id_text := NULLIF(current_setting('app.user_id', true), '');
  IF user_id_text IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN user_id_text::uuid;
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.company_row_visible(row_company_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT app_private.current_company_id() IS NULL
      OR row_company_id IS NULL
      OR row_company_id = app_private.current_company_id();
$$;

CREATE OR REPLACE FUNCTION app_private.set_request_context(
  p_company_id uuid,
  p_user_id uuid,
  p_user_email text DEFAULT NULL,
  p_user_role text DEFAULT NULL,
  p_session_id uuid DEFAULT NULL,
  p_ip_address text DEFAULT NULL,
  p_user_agent text DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('app.company_id', COALESCE(p_company_id::text, ''), true);
  PERFORM set_config('app.user_id', COALESCE(p_user_id::text, ''), true);
  PERFORM set_config('app.user_email', COALESCE(p_user_email, ''), true);
  PERFORM set_config('app.user_role', COALESCE(p_user_role, ''), true);
  PERFORM set_config('app.session_id', COALESCE(p_session_id::text, ''), true);
  PERFORM set_config('app.ip_address', COALESCE(p_ip_address, ''), true);
  PERFORM set_config('app.user_agent', COALESCE(p_user_agent, ''), true);
  PERFORM set_config('app.audit_reason', COALESCE(p_reason, ''), true);
END;
$$;

CREATE OR REPLACE FUNCTION app_private.clear_request_context()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('app.company_id', '', true);
  PERFORM set_config('app.user_id', '', true);
  PERFORM set_config('app.user_email', '', true);
  PERFORM set_config('app.user_role', '', true);
  PERFORM set_config('app.session_id', '', true);
  PERFORM set_config('app.ip_address', '', true);
  PERFORM set_config('app.user_agent', '', true);
  PERFORM set_config('app.audit_reason', '', true);
END;
$$;

DO $$
DECLARE
  table_name text;
  scoped_tables text[] := ARRAY[
    'UserCompanyMembership',
    'AccountingPeriod',
    'Account',
    'JournalEntry',
    'StockItem',
    'StockMovement',
    'StockLot',
    'Partner',
    'Invoice',
    'SupplierInvoice',
    'SupplierInvoiceApproval',
    'ApprovalDelegation',
    'Payment',
    'SupplierPayment',
    'Asset',
    'Employee',
    'PayrollRun',
    'AuditLog',
    'BankStatement',
    'BankStatementLine',
    'OpenBankingConnection',
    'OpenBankingSyncRun',
    'RevisalDelivery',
    'ExportJob',
    'DashboardSnapshot'
  ];
BEGIN
  FOREACH table_name IN ARRAY scoped_tables LOOP
    IF to_regclass(format('public.%I', table_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);

    EXECUTE format('DROP POLICY IF EXISTS p_rls_select ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY p_rls_select ON public.%I FOR SELECT USING (app_private.company_row_visible("companyId"))',
      table_name
    );

    EXECUTE format('DROP POLICY IF EXISTS p_rls_insert ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY p_rls_insert ON public.%I FOR INSERT WITH CHECK (app_private.company_row_visible("companyId"))',
      table_name
    );

    EXECUTE format('DROP POLICY IF EXISTS p_rls_update ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY p_rls_update ON public.%I FOR UPDATE USING (app_private.company_row_visible("companyId")) WITH CHECK (app_private.company_row_visible("companyId"))',
      table_name
    );

    EXECUTE format('DROP POLICY IF EXISTS p_rls_delete ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY p_rls_delete ON public.%I FOR DELETE USING (app_private.company_row_visible("companyId"))',
      table_name
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."updatedAt" = NOW();
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOR table_name IN
    SELECT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name = 'updatedAt'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_set_updated_at ON public.%I', table_name);
    EXECUTE format(
      'CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at()',
      table_name
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.audit_row_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor_user_id uuid;
  actor_user_email text;
  actor_user_role_text text;
  actor_user_role "Role";
  actor_session_id uuid;
  actor_company_id uuid;
  actor_ip text;
  actor_user_agent text;
  actor_reason text;
  row_company_id_text text;
  row_company_id uuid;
  row_id_text text;
  row_id uuid;
  row_user_id_text text;
  row_user_id uuid;
  before_payload jsonb;
  after_payload jsonb;
BEGIN
  actor_user_id := app_private.current_user_id();
  actor_user_email := NULLIF(current_setting('app.user_email', true), '');
  actor_user_role_text := NULLIF(current_setting('app.user_role', true), '');
  actor_company_id := app_private.current_company_id();
  actor_session_id := NULL;
  actor_ip := NULLIF(current_setting('app.ip_address', true), '');
  actor_user_agent := NULLIF(current_setting('app.user_agent', true), '');
  actor_reason := NULLIF(current_setting('app.audit_reason', true), '');

  BEGIN
    actor_session_id := NULLIF(current_setting('app.session_id', true), '')::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      actor_session_id := NULL;
  END;

  IF TG_OP = 'DELETE' THEN
    before_payload := to_jsonb(OLD);
    after_payload := NULL;
    row_company_id_text := before_payload ->> 'companyId';
    row_id_text := before_payload ->> 'id';
    row_user_id_text := COALESCE(before_payload ->> 'createdById', before_payload ->> 'userId');
  ELSE
    before_payload := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END;
    after_payload := to_jsonb(NEW);
    row_company_id_text := after_payload ->> 'companyId';
    row_id_text := after_payload ->> 'id';
    row_user_id_text := COALESCE(after_payload ->> 'createdById', after_payload ->> 'userId');
  END IF;

  BEGIN
    row_company_id := row_company_id_text::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      row_company_id := NULL;
  END;

  BEGIN
    row_id := row_id_text::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      row_id := NULL;
  END;

  BEGIN
    row_user_id := row_user_id_text::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      row_user_id := NULL;
  END;

  IF actor_user_id IS NULL THEN
    actor_user_id := row_user_id;
  END IF;

  IF actor_user_id IS NOT NULL AND (actor_user_email IS NULL OR actor_user_role_text IS NULL) THEN
    SELECT u.email, u.role::text
    INTO actor_user_email, actor_user_role_text
    FROM public."User" u
    WHERE u.id = actor_user_id
    LIMIT 1;
  END IF;

  BEGIN
    actor_user_role := actor_user_role_text::"Role";
  EXCEPTION
    WHEN invalid_text_representation THEN
      actor_user_role := NULL;
  END;

  INSERT INTO public."AuditLog" (
    id,
    "companyId",
    "userId",
    "userEmail",
    "userRole",
    "sessionId",
    "tableName",
    "recordId",
    "action",
    "reason",
    "ipAddress",
    "userAgent",
    "oldValues",
    "newValues",
    "beforeData",
    "afterData",
    "timestamp"
  )
  VALUES (
    gen_random_uuid(),
    COALESCE(row_company_id, actor_company_id),
    actor_user_id,
    actor_user_email,
    actor_user_role,
    actor_session_id,
    TG_TABLE_NAME,
    row_id,
    TG_OP,
    actor_reason,
    actor_ip,
    actor_user_agent,
    before_payload,
    after_payload,
    before_payload,
    after_payload,
    NOW()
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOR table_name IN
    SELECT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name = 'id'
      AND c.table_name NOT IN ('AuditLog', '_prisma_migrations')
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_all_rows ON public.%I', table_name);
    EXECUTE format(
      'CREATE TRIGGER trg_audit_all_rows AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app_private.audit_row_change()',
      table_name
    );
  END LOOP;
END;
$$;

DROP MATERIALIZED VIEW IF EXISTS public.mv_balance_sheet CASCADE;
CREATE MATERIALIZED VIEW public.mv_balance_sheet AS
SELECT
  COALESCE(je."companyId", a."companyId") AS company_id,
  a.id AS account_id,
  a.code AS account_code,
  a.name AS account_name,
  a.type::text AS account_type,
  COALESCE(SUM(jl.debit), 0)::numeric(18, 2) AS total_debit,
  COALESCE(SUM(jl.credit), 0)::numeric(18, 2) AS total_credit,
  COALESCE(SUM(jl.debit - jl.credit), 0)::numeric(18, 2) AS balance
FROM public."Account" a
LEFT JOIN public."JournalLine" jl ON jl."accountId" = a.id
LEFT JOIN public."JournalEntry" je ON je.id = jl."entryId"
GROUP BY COALESCE(je."companyId", a."companyId"), a.id, a.code, a.name, a.type;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_balance_sheet_company_account
  ON public.mv_balance_sheet (company_id, account_id);

DROP MATERIALIZED VIEW IF EXISTS public.mv_monthly_pl CASCADE;
CREATE MATERIALIZED VIEW public.mv_monthly_pl AS
SELECT
  je."companyId" AS company_id,
  date_trunc('month', je.date)::date AS period_month,
  COALESCE(SUM(CASE WHEN a.type = 'REVENUE' THEN (jl.credit - jl.debit) ELSE 0 END), 0)::numeric(18, 2) AS revenue_total,
  COALESCE(SUM(CASE WHEN a.type = 'EXPENSE' THEN (jl.debit - jl.credit) ELSE 0 END), 0)::numeric(18, 2) AS expense_total,
  COALESCE(
    SUM(CASE WHEN a.type = 'REVENUE' THEN (jl.credit - jl.debit) ELSE 0 END) -
    SUM(CASE WHEN a.type = 'EXPENSE' THEN (jl.debit - jl.credit) ELSE 0 END),
    0
  )::numeric(18, 2) AS net_result
FROM public."JournalLine" jl
JOIN public."JournalEntry" je ON je.id = jl."entryId"
JOIN public."Account" a ON a.id = jl."accountId"
GROUP BY je."companyId", date_trunc('month', je.date)::date;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_monthly_pl_company_period
  ON public.mv_monthly_pl (company_id, period_month);

DROP MATERIALIZED VIEW IF EXISTS public.mv_aging_receivables CASCADE;
CREATE MATERIALIZED VIEW public.mv_aging_receivables AS
WITH invoice_balances AS (
  SELECT
    i.id AS invoice_id,
    i."companyId" AS company_id,
    i.number AS invoice_number,
    i."partnerId" AS partner_id,
    p.name AS partner_name,
    i."issueDate"::date AS issue_date,
    i."dueDate"::date AS due_date,
    i.total::numeric(18, 2) AS total_amount,
    COALESCE(SUM(pay.amount), 0)::numeric(18, 2) AS paid_amount,
    GREATEST(i.total - COALESCE(SUM(pay.amount), 0), 0)::numeric(18, 2) AS outstanding_amount
  FROM public."Invoice" i
  LEFT JOIN public."Partner" p ON p.id = i."partnerId"
  LEFT JOIN public."Payment" pay ON pay."invoiceId" = i.id
  WHERE i.status <> 'CANCELLED'
  GROUP BY
    i.id,
    i."companyId",
    i.number,
    i."partnerId",
    p.name,
    i."issueDate",
    i."dueDate",
    i.total
)
SELECT
  company_id,
  invoice_id,
  invoice_number,
  partner_id,
  partner_name,
  issue_date,
  due_date,
  total_amount,
  paid_amount,
  outstanding_amount,
  GREATEST((CURRENT_DATE - due_date), 0) AS days_overdue,
  CASE
    WHEN due_date >= CURRENT_DATE THEN 'CURRENT'
    WHEN CURRENT_DATE - due_date BETWEEN 1 AND 30 THEN 'DUE_1_30'
    WHEN CURRENT_DATE - due_date BETWEEN 31 AND 60 THEN 'DUE_31_60'
    WHEN CURRENT_DATE - due_date BETWEEN 61 AND 90 THEN 'DUE_61_90'
    ELSE 'DUE_90_PLUS'
  END AS aging_bucket
FROM invoice_balances
WHERE outstanding_amount > 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_aging_receivables_invoice
  ON public.mv_aging_receivables (invoice_id);
CREATE INDEX IF NOT EXISTS idx_mv_aging_receivables_company_bucket
  ON public.mv_aging_receivables (company_id, aging_bucket);

DROP MATERIALIZED VIEW IF EXISTS public.mv_aging_payables CASCADE;
CREATE MATERIALIZED VIEW public.mv_aging_payables AS
WITH supplier_invoice_balances AS (
  SELECT
    si.id AS supplier_invoice_id,
    si."companyId" AS company_id,
    si.number AS invoice_number,
    si."supplierId" AS supplier_id,
    s.name AS supplier_name,
    si."receivedDate"::date AS received_date,
    si."dueDate"::date AS due_date,
    si.total::numeric(18, 2) AS total_amount,
    COALESCE(SUM(sp.amount), 0)::numeric(18, 2) AS paid_amount,
    GREATEST(si.total - COALESCE(SUM(sp.amount), 0), 0)::numeric(18, 2) AS outstanding_amount
  FROM public."SupplierInvoice" si
  LEFT JOIN public."Partner" s ON s.id = si."supplierId"
  LEFT JOIN public."SupplierPayment" sp ON sp."supplierInvoiceId" = si.id
  WHERE si.status <> 'CANCELLED'
  GROUP BY
    si.id,
    si."companyId",
    si.number,
    si."supplierId",
    s.name,
    si."receivedDate",
    si."dueDate",
    si.total
)
SELECT
  company_id,
  supplier_invoice_id,
  invoice_number,
  supplier_id,
  supplier_name,
  received_date,
  due_date,
  total_amount,
  paid_amount,
  outstanding_amount,
  GREATEST((CURRENT_DATE - due_date), 0) AS days_overdue,
  CASE
    WHEN due_date >= CURRENT_DATE THEN 'CURRENT'
    WHEN CURRENT_DATE - due_date BETWEEN 1 AND 30 THEN 'DUE_1_30'
    WHEN CURRENT_DATE - due_date BETWEEN 31 AND 60 THEN 'DUE_31_60'
    WHEN CURRENT_DATE - due_date BETWEEN 61 AND 90 THEN 'DUE_61_90'
    ELSE 'DUE_90_PLUS'
  END AS aging_bucket
FROM supplier_invoice_balances
WHERE outstanding_amount > 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_aging_payables_invoice
  ON public.mv_aging_payables (supplier_invoice_id);
CREATE INDEX IF NOT EXISTS idx_mv_aging_payables_company_bucket
  ON public.mv_aging_payables (company_id, aging_bucket);

DROP MATERIALIZED VIEW IF EXISTS public.mv_cashflow_forecast CASCADE;
CREATE MATERIALIZED VIEW public.mv_cashflow_forecast AS
WITH receivables AS (
  SELECT
    i."companyId" AS company_id,
    i."dueDate"::date AS due_date,
    GREATEST(i.total - COALESCE(SUM(pay.amount), 0), 0)::numeric(18, 2) AS outstanding_amount
  FROM public."Invoice" i
  LEFT JOIN public."Payment" pay ON pay."invoiceId" = i.id
  WHERE i.status <> 'CANCELLED'
  GROUP BY i.id, i."companyId", i."dueDate", i.total
),
payables AS (
  SELECT
    si."companyId" AS company_id,
    si."dueDate"::date AS due_date,
    GREATEST(si.total - COALESCE(SUM(sp.amount), 0), 0)::numeric(18, 2) AS outstanding_amount
  FROM public."SupplierInvoice" si
  LEFT JOIN public."SupplierPayment" sp ON sp."supplierInvoiceId" = si.id
  WHERE si.status <> 'CANCELLED'
  GROUP BY si.id, si."companyId", si."dueDate", si.total
),
movements AS (
  SELECT company_id, due_date AS forecast_date, outstanding_amount AS expected_inflow, 0::numeric(18, 2) AS expected_outflow
  FROM receivables
  WHERE outstanding_amount > 0
  UNION ALL
  SELECT company_id, due_date AS forecast_date, 0::numeric(18, 2) AS expected_inflow, outstanding_amount AS expected_outflow
  FROM payables
  WHERE outstanding_amount > 0
)
SELECT
  company_id,
  forecast_date,
  SUM(expected_inflow)::numeric(18, 2) AS expected_inflow,
  SUM(expected_outflow)::numeric(18, 2) AS expected_outflow,
  SUM(expected_inflow - expected_outflow)::numeric(18, 2) AS net_cashflow
FROM movements
WHERE forecast_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + 90)
GROUP BY company_id, forecast_date;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_cashflow_forecast_company_date
  ON public.mv_cashflow_forecast (company_id, forecast_date);

DROP MATERIALIZED VIEW IF EXISTS public.mv_vat_summary CASCADE;
CREATE MATERIALIZED VIEW public.mv_vat_summary AS
WITH vat_lines AS (
  SELECT
    i."companyId" AS company_id,
    date_trunc('month', i."issueDate")::date AS period_month,
    i.vat::numeric(18, 2) AS vat_collected,
    0::numeric(18, 2) AS vat_deductible
  FROM public."Invoice" i
  WHERE i.status <> 'CANCELLED'
  UNION ALL
  SELECT
    si."companyId" AS company_id,
    date_trunc('month', si."receivedDate")::date AS period_month,
    0::numeric(18, 2) AS vat_collected,
    si.vat::numeric(18, 2) AS vat_deductible
  FROM public."SupplierInvoice" si
  WHERE si.status <> 'CANCELLED'
)
SELECT
  company_id,
  period_month,
  SUM(vat_collected)::numeric(18, 2) AS vat_collected,
  SUM(vat_deductible)::numeric(18, 2) AS vat_deductible,
  SUM(vat_collected - vat_deductible)::numeric(18, 2) AS vat_net
FROM vat_lines
GROUP BY company_id, period_month;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_vat_summary_company_period
  ON public.mv_vat_summary (company_id, period_month);

CREATE OR REPLACE FUNCTION app_private.refresh_reporting_materialized_views()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW public.mv_balance_sheet;
  REFRESH MATERIALIZED VIEW public.mv_monthly_pl;
  REFRESH MATERIALIZED VIEW public.mv_aging_receivables;
  REFRESH MATERIALIZED VIEW public.mv_aging_payables;
  REFRESH MATERIALIZED VIEW public.mv_cashflow_forecast;
  REFRESH MATERIALIZED VIEW public.mv_vat_summary;
END;
$$;
