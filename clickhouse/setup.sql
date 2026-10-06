-- =====================================================================
-- Run on ClickHouse by the data team, before Supabase migration 4.
-- Lines marked ADJUST must be changed to your real table and column names.
-- =====================================================================

-- 1. One view with exactly what the KAM platform needs, nothing more.
--    Client IDs are cleaned here: trailing ".0" removed and the leading
--    zero of 10-digit personal IDs restored.
CREATE OR REPLACE VIEW kursi.kam_client_transactions AS                 -- ADJUST database name
SELECT
    toString(t.transaction_id)                                  AS tx_id,          -- ADJUST
    toDateTime(t.created_at, 'UTC')                             AS tx_time,        -- ADJUST
    toDate(t.created_at, 'Asia/Tbilisi')                        AS tx_date,        -- ADJUST
    replaceRegexpOne(trimBoth(toString(t.sender_id)), '\\.0+$', '') AS client_id_raw, -- ADJUST
    if(match(client_id_raw, '^[0-9]{10}$'), concat('0', client_id_raw), client_id_raw) AS client_id,
    toString(t.segment)                                         AS segment,        -- ADJUST
    toString(t.operation_type)                                  AS operation_type, -- ADJUST
    toString(t.payment_status)                                  AS payment_status, -- ADJUST
    toFloat64(t.abs_gel)                                        AS abs_gel,
    toFloat64(t.cross_gel)                                      AS cross_gel,
    toFloat64(t.total_income)                                   AS total_income,   -- already includes cross income
    toFloat64(t.spread_income)                                  AS spread_income,
    toFloat64(t.revaluation_income)                             AS revaluation     -- ADJUST
FROM kursi.transactions AS t                                                       -- ADJUST source table
WHERE t.operation_type NOT IN ('position-close-in-bank', 'fastoo', 'bitnet', 'unipay');
-- ADJUST the list above to the exact values used for non-client operations.

-- 2. A read-only user that can read only that view.
CREATE USER IF NOT EXISTS kam_platform_reader
    IDENTIFIED WITH sha256_password BY 'CHANGE_ME_LONG_RANDOM_PASSWORD'
    SETTINGS readonly = 1;
GRANT SELECT ON kursi.kam_client_transactions TO kam_platform_reader;
-- Depending on the ClickHouse version and view settings, the reader may
-- also need SELECT on the source table. If so, grant only these columns:
-- GRANT SELECT(transaction_id, created_at, sender_id, segment, operation_type,
--              payment_status, abs_gel, cross_gel, total_income, spread_income,
--              revaluation_income) ON kursi.transactions TO kam_platform_reader;

-- 3. Network: open the ClickHouse native port (9000 by default) only to
--    the Supabase project's outbound traffic, through the firewall, and
--    check with Supabase which outbound addresses to allow.
