\pset footer off
insert into private.import_requests (row_no, request_date, client_id, client_name, kam_email, sells_currency, gets_currency, amount, rate, legacy_status, legacy_loss_reason) values
 (1, '2026-07-03', '404551203', 'Saguramo Wines', 'd.arbolishvili@kursi.ge', 'GEL', 'USD', '60,000', '2.71', 'შედგა', null),
 (2, '15/08/2026', '1024011876', 'Vake Design Studio', 'n.philauri@kursi.ge', null, null, null, null, 'არ შედგა', 'კურსი'),
 (3, '2026-08-20', '12AB', 'Broken ID', 'n.philauri@kursi.ge', 'USD', 'GEL', '5000', '2.7', null, null),
 (4, 'yesterday', '405123987', 'Nova LLC', 'n.philauri@kursi.ge', 'USD', 'GEL', '5000', '2.7', null, null),
 (5, '2026-08-21', '405118274', 'Rustavi Steel', '', 'USD', 'GEL', '90000', '2.7', null, null);
select * from private.run_history_import();
select row_no, imported_request_id is not null as imported, import_error from private.import_requests order by row_no;
select email, full_name, role, auth_user_id is null as no_login from public.profiles where email = 'd.arbolishvili@kursi.ge';
select * from private.run_history_import();  -- second run: nothing new
