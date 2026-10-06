-- Local table standing in for the ClickHouse foreign table
create schema ch;
create table ch.client_transactions (
  tx_id text, tx_time timestamp, tx_date date, client_id text, segment text, operation_type text,
  payment_status text, abs_gel double precision, cross_gel double precision, total_income double precision,
  spread_income double precision, revaluation double precision
);
