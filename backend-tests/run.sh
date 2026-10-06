#!/usr/bin/env bash
# Runs the backend tests on a plain local PostgreSQL 15+ (not on Supabase).
# A local table stands in for ClickHouse; migrations 4 and 6 are skipped.
# Usage: DB=kamtest ./tests/run.sh      (needs createdb/psql rights)
set -euo pipefail
cd "$(dirname "$0")"
DB="${DB:-kamtest}"
dropdb --if-exists "$DB"; createdb "$DB"
M=../supabase/migrations
for f in stubs.sql $M/20261006000100_core_schema.sql $M/20261006000200_security.sql $M/20261006000300_logic.sql fake_ch.sql $M/20261006000500_sync.sql $M/20261006000700_client_autofill.sql $M/20261006000800_treasury.sql $M/20261006000900_reference_rates.sql $M/20261006001000_notifications.sql $M/20261006001200_admin_tools.sql $M/20261006001300_went_through_after_request.sql 01_users.sql; do
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"
done
for f in 02_requests.sql 03_sync.sql 04_numbers_and_access.sql 05_lockdown.sql 06_writes.sql 07_import.sql 08_mfa_and_switch_off.sql 09_autofill.sql 10_new_client_name.sql 11_treasury.sql 12_rates.sql 13_notifications.sql 14_admin_tools.sql 15_after_request.sql; do
  echo "=== $f"; psql -q -d "$DB" -f "$f"
done 2>&1 | tee results.txt
echo
echo "Checks that did not pass (should be 0):"
grep -c "NOTICE:  FAIL" results.txt || true
