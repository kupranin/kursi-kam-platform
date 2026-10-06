-- =====================================================================
-- KAM platform, migration 2 of 6: who can see and change what
--
-- Default is deny. Signed-out visitors (anon) get nothing. Signed-in
-- users get only what the row-level policies below allow, and most
-- writes go through the functions in migration 3, which check the
-- caller themselves.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helper functions used by the policies
-- ---------------------------------------------------------------------
create or replace function private.my_profile_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select p.id
  from public.profiles p
  where p.auth_user_id = (select auth.uid()) and p.active
$$;

create or replace function private.my_role()
returns text
language sql stable security definer set search_path = ''
as $$
  select p.role
  from public.profiles p
  where p.auth_user_id = (select auth.uid()) and p.active
$$;

-- admin or manager: may read everything
create or replace function private.can_see_all()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(private.my_role() in ('admin', 'manager'), false)
$$;

-- admin, and (if the rule is switched on) signed in with a second factor
create or replace function private.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(private.my_role() = 'admin', false)
     and (
       not (select r.admin_requires_mfa from public.rules r)
       or coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
     )
$$;

-- may write: KAMs and admins (managers are read-only)
create or replace function private.can_write()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(private.my_role() in ('admin', 'kam'), false)
$$;

-- client is in the caller's book: they logged a request for it, or it is assigned to them
create or replace function private.is_my_client(p_client_id text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
           select 1 from public.requests r
           where r.client_id = p_client_id and r.kam_id = private.my_profile_id()
         )
      or exists (
           select 1 from public.clients c
           where c.client_id = p_client_id and c.assigned_kam_id = private.my_profile_id()
         )
$$;

-- Postgres lets everyone execute new functions unless revoked, and a
-- per-schema default cannot undo that. So every migration that adds
-- functions to private ends with an explicit lock-down like this one.
revoke execute on all functions in schema private from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function
  private.my_profile_id(), private.my_role(), private.can_see_all(),
  private.is_admin(), private.can_write(), private.is_my_client(text)
to authenticated;

-- ---------------------------------------------------------------------
-- Table privileges (row-level policies narrow these further)
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all tables in schema private from anon, authenticated;

grant select on
  public.profiles, public.clients, public.requests, public.transactions,
  public.winback_actions, public.loss_reasons, public.rules, public.audit_log
to authenticated;

grant update (name, assigned_kam_id) on public.clients to authenticated;    -- admins only, see policy
grant update, delete on public.requests to authenticated;                   -- admins only, see policy
grant insert, update on public.loss_reasons to authenticated;               -- admins only, see policy
grant update (month_grace_days, winback_window_days, tier_a_min_gel, tier_b_min_gel,
              admin_requires_mfa, request_delete_minutes)
  on public.rules to authenticated;                                         -- admins only, see policy

-- ---------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.clients         enable row level security;
alter table public.requests        enable row level security;
alter table public.transactions    enable row level security;
alter table public.winback_actions enable row level security;
alter table public.loss_reasons    enable row level security;
alter table public.rules           enable row level security;
alter table public.audit_log       enable row level security;

-- profiles: yourself, or everyone if you can see all
create policy profiles_read on public.profiles for select to authenticated
  using (auth_user_id = (select auth.uid()) or (select private.can_see_all()));

-- clients: the ones in your book, or all
create policy clients_read on public.clients for select to authenticated
  using ((select private.can_see_all()) or private.is_my_client(client_id));
create policy clients_admin_update on public.clients for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- requests: your own, or all
create policy requests_read on public.requests for select to authenticated
  using (kam_id = (select private.my_profile_id()) or (select private.can_see_all()));
create policy requests_admin_update on public.requests for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy requests_admin_delete on public.requests for delete to authenticated
  using ((select private.is_admin()));

-- transactions: those of clients in your book, or all
create policy transactions_read on public.transactions for select to authenticated
  using ((select private.can_see_all()) or private.is_my_client(client_id));

-- win-back log: for clients in your book, or all
create policy winback_read on public.winback_actions for select to authenticated
  using ((select private.can_see_all()) or private.is_my_client(client_id));

-- loss reasons and rules: everyone signed in reads; admins change
create policy loss_reasons_read on public.loss_reasons for select to authenticated using (true);
create policy loss_reasons_admin_insert on public.loss_reasons for insert to authenticated
  with check ((select private.is_admin()));
create policy loss_reasons_admin_update on public.loss_reasons for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

create policy rules_read on public.rules for select to authenticated using (true);
create policy rules_admin_update on public.rules for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- audit log: admins only, read-only for everyone
create policy audit_admin_read on public.audit_log for select to authenticated
  using ((select private.is_admin()));

-- ---------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------
create or replace function private.audit_row()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
begin
  if tg_op = 'UPDATE' and v_old = v_new then
    return new;
  end if;
  insert into public.audit_log (actor_profile_id, action, table_name, row_key, old_data, new_data)
  values (
    private.my_profile_id(),
    lower(tg_op),
    tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'client_id', v_row ->> 'code'),
    v_old,
    v_new
  );
  return coalesce(new, old);
end;
$$;

create trigger audit_profiles        after insert or update or delete on public.profiles        for each row execute function private.audit_row();
create trigger audit_clients         after insert or update or delete on public.clients         for each row execute function private.audit_row();
create trigger audit_requests        after insert or update or delete on public.requests        for each row execute function private.audit_row();
create trigger audit_winback_actions after insert                     on public.winback_actions for each row execute function private.audit_row();
create trigger audit_loss_reasons    after insert or update or delete on public.loss_reasons    for each row execute function private.audit_row();
create trigger audit_rules           after update                     on public.rules           for each row execute function private.audit_row();

-- stamp who last changed the rules
create or replace function private.stamp_rules()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := private.my_profile_id();
  return new;
end;
$$;
create trigger stamp_rules before update on public.rules for each row execute function private.stamp_rules();
