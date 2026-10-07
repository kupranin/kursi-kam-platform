export type Role = 'admin' | 'manager' | 'treasury' | 'kam';

export interface Profile {
  id: string;
  full_name: string;
  email: string;
  role: Role;
}

export type QuoteState = 'asking' | 'quoted' | 'expired' | 'declined';

export interface RequestRow {
  id: number;
  kam_id: string;
  kam_name: string | null;
  client_id: string;
  client_name: string | null;
  client_kind: string;
  requested_at: string;
  request_date: string;
  sells_currency: string | null;
  gets_currency: string | null;
  amount: number | null;
  gets_amount?: number | null;
  client_rate?: number | null;
  rate: number | null;
  note: string | null;
  loss_reason_note?: string | null;
  loss_reason: string | null;
  source: 'app' | 'import';
  went_through: boolean;
  outcome: 'went_through' | 'waiting' | 'did_not_go_through';
  asked_at: string;
  quote_status: 'asking' | 'quoted' | 'declined';
  rate_valid_until: string | null;
  quoted_at: string | null;
  decline_reason: string | null;
  quote_state: QuoteState;
}

export interface Rules {
  month_grace_days: number | null;
  winback_window_days: number;
  tier_a_min_gel: number;
  tier_b_min_gel: number;
  admin_requires_mfa: boolean;
  request_delete_minutes: number;
  default_quote_minutes: number;
  app_url: string | null;
  treasury_alert_seconds: number;
  expiry_warning_minutes: number;
  updated_at: string;
  updated_by: string | null;
}

export interface LossReason {
  code: string;
  label_en: string;
  label_ka: string;
  sort_order: number;
  active: boolean;
}

export interface ClientMatch {
  client_id: string;
  name: string | null;
  kind: string;
  last_request_date: string | null;
  last_sells_currency: string | null;
  last_gets_currency: string | null;
}

export interface WinbackRow {
  client_id: string;
  client_name: string | null;
  client_kind: string;
  owner_id: string;
  owner_name: string;
  tier: 'A' | 'B' | 'C';
  last_request: string;
  last_deal: string | null;
  prior_turnover_gel: number;
  max_request_gel: number | null;
  last_reason: string | null;
  step: string;
  step_at: string | null;
}

export interface QueueRow {
  request_id: number;
  asked_at: string;
  waiting_seconds: number;
  kam_name: string;
  client_id: string;
  client_name: string | null;
  client_kind: string;
  is_new_client: boolean;
  sells_currency: string;
  gets_currency: string;
  amount: number | null;
  gets_amount?: number | null;
  client_rate?: number | null;
  note: string | null;
  loss_reason_note?: string | null;
  last_rate: number | null;
  last_rate_at: string | null;
  standard_rate: number | null;
  nbg_rate: number | null;
  last_given_today: number | null;
}

export interface QuoteToday {
  request_id: number;
  client_name: string | null;
  kam_name: string;
  sells_currency: string;
  gets_currency: string;
  amount: number | null;
  gets_amount?: number | null;
  client_rate?: number | null;
  note?: string | null;
  loss_reason_note?: string | null;
  rate: number;
  quoted_at: string;
  valid_until: string;
  quote_state: QuoteState;
  went_through: boolean;
}

export interface ReferenceRate {
  source: 'standard' | 'nbg';
  currency: string;
  quote_currency: string;
  buy: number | null;
  sell: number | null;
  official: number | null;
  as_of: string;
}

export interface SummaryRow {
  kam_id: string;
  kam_name: string;
  clients: number;
  turnover: number;
  turnover_not_successful: number;
  income: number;
  income_per_1m_turnover: number | null;
  requests_judged: number;
  requests_won: number;
  win_rate_pct: number | null;
}

export interface PortfolioRow {
  client_id: string;
  client_name: string | null;
  client_kind: string;
  owner_id: string;
  owner_name: string;
  requests_in_window: number;
  turnover: number;
  turnover_not_successful: number;
  income: number;
  transactions: number;
}

export const CURRENCIES = ['GEL', 'USD', 'EUR', 'GBP'];

export const ROLE_NAMES: Record<Role, string> = {
  admin: 'Admin',
  manager: 'Manager',
  treasury: 'Treasury',
  kam: 'KAM',
};

export interface StaffPerson {
  id: string;
  full_name: string;
  role: Role;
  active: boolean;
}

export interface StaffMessage {
  id: number;
  sender_id: string;
  recipient_id: string;
  body: string;
  created_at: string;
}
