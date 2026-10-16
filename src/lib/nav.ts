import type { Role } from './types';

export const HOME: Record<Role, string> = {
  kam: '/requests',
  treasury: '/rate-desk',
  admin: '/team',
  manager: '/team',
  analyst: '/analysis',
};

export const PAGES: Record<Role, string[]> = {
  kam: ['/requests', '/follow-ups', '/clients', '/team', '/analytics', '/rates', '/log', '/chat', '/more'],
  treasury: ['/rate-desk', '/quoted-progress', '/lost-requests', '/desk-history', '/analysis', '/rates', '/log', '/chat', '/more'],
  admin: ['/team', '/requests', '/rate-desk', '/quoted-progress', '/lost-requests', '/desk-history', '/follow-ups', '/clients', '/analytics', '/analysis', '/kpis', '/rates', '/competitiveness', '/log', '/chat', '/admin'],
  manager: ['/team', '/requests', '/lost-requests', '/follow-ups', '/clients', '/analytics', '/kpis', '/rates', '/competitiveness', '/log', '/chat'],
  analyst: ['/analysis', '/analytics', '/rates', '/competitiveness'],
};

export const NAV: Record<Role, { to: string; ka: string; en: string; badge?: 'followups' | 'queue' | 'losses' | 'chat' }[]> = {
  kam: [
    { to: '/requests', ka: 'მოთხოვნები', en: 'Requests' },
    { to: '/follow-ups', ka: 'დაბრუნება', en: 'Follow-ups', badge: 'followups' },
    { to: '/clients', ka: 'ჩემი კლიენტები', en: 'My clients' },
    { to: '/rates', ka: 'კურსები', en: 'Rates' },
    { to: '/team', ka: 'ჩემი ციფრები', en: 'My numbers' },
    { to: '/analytics', ka: 'ანალიტიკა', en: 'Analytics' },
    { to: '/log', ka: 'ჟურნალი', en: 'Log' },
    { to: '/chat', ka: 'ჩატი', en: 'Chat', badge: 'chat' },
  ],
  treasury: [
    { to: '/rate-desk', ka: 'კურსის მაგიდა', en: 'Rate desk', badge: 'queue' },
    { to: '/quoted-progress', ka: 'გაცემულის მიმდინარეობა', en: 'Quoted progress' },
    { to: '/lost-requests', ka: 'დაკარგული მოთხოვნები', en: 'Lost requests', badge: 'losses' },
    { to: '/desk-history', ka: 'ისტორია', en: 'History' },
    { to: '/analysis', ka: 'ანალიზი', en: 'Analysis' },
    { to: '/rates', ka: 'კურსები', en: 'Rates' },
    { to: '/log', ka: 'ჟურნალი', en: 'Log' },
    { to: '/chat', ka: 'ჩატი', en: 'Chat', badge: 'chat' },
  ],
  admin: [
    { to: '/team', ka: 'გუნდი', en: 'Team' },
    { to: '/requests', ka: 'მოთხოვნები', en: 'Requests' },
    { to: '/rate-desk', ka: 'კურსის მაგიდა', en: 'Rate desk', badge: 'queue' },
    { to: '/quoted-progress', ka: 'გაცემულის მიმდინარეობა', en: 'Quoted progress' },
    { to: '/lost-requests', ka: 'დაკარგული მოთხოვნები', en: 'Lost requests', badge: 'losses' },
    { to: '/desk-history', ka: 'ისტორია', en: 'History' },
    { to: '/follow-ups', ka: 'დაბრუნება', en: 'Follow-ups' },
    { to: '/clients', ka: 'კლიენტები', en: 'Clients' },
    { to: '/analytics', ka: 'ანალიტიკა', en: 'Analytics' },
    { to: '/analysis', ka: 'ანალიზი', en: 'Analysis' },
    { to: '/kpis', ka: 'KPI', en: 'KPI' },
    { to: '/rates', ka: 'კურსები', en: 'Rates' },
    { to: '/competitiveness', ka: 'კონკურენტუნარიანობა', en: 'Competitiveness' },
    { to: '/log', ka: 'ჟურნალი', en: 'Log' },
    { to: '/chat', ka: 'ჩატი', en: 'Chat', badge: 'chat' },
    { to: '/admin', ka: 'ადმინი', en: 'Admin' },
  ],
  manager: [
    { to: '/team', ka: 'გუნდი', en: 'Team' },
    { to: '/requests', ka: 'მოთხოვნები', en: 'Requests' },
    { to: '/lost-requests', ka: 'დაკარგული მოთხოვნები', en: 'Lost requests', badge: 'losses' },
    { to: '/follow-ups', ka: 'დაბრუნება', en: 'Follow-ups' },
    { to: '/clients', ka: 'კლიენტები', en: 'Clients' },
    { to: '/analytics', ka: 'ანალიტიკა', en: 'Analytics' },
    { to: '/kpis', ka: 'KPI', en: 'KPI' },
    { to: '/rates', ka: 'კურსები', en: 'Rates' },
    { to: '/competitiveness', ka: 'კონკურენტუნარიანობა', en: 'Competitiveness' },
    { to: '/log', ka: 'ჟურნალი', en: 'Log' },
    { to: '/chat', ka: 'ჩატი', en: 'Chat', badge: 'chat' },
  ],
  analyst: [
    { to: '/analysis', ka: 'ანალიზი', en: 'Analysis' },
    { to: '/analytics', ka: 'ანალიტიკა', en: 'Analytics' },
    { to: '/rates', ka: 'კურსები', en: 'Rates' },
    { to: '/competitiveness', ka: 'კონკურენტუნარიანობა', en: 'Competitiveness' },
  ],
};

export type PhoneBadge = 'followups' | 'queue' | 'losses' | 'chat' | 'action';
export type PhoneIcon = 'home' | 'plus' | 'chat' | 'rates' | 'more';

export interface PhoneTab {
  to: string;
  ka: string;
  en: string;
  badge?: PhoneBadge;
  icon?: PhoneIcon;
}

/** Phone tabs. Analyst has none: analysis stays on a computer, and rates stay on the desktop site. */
export const PHONE_NAV: Record<Role, PhoneTab[]> = {
  kam: [
    { to: '/requests', ka: 'საქმე', en: 'Home', badge: 'action', icon: 'home' },
    { to: '/requests/new', ka: 'ახალი', en: 'New', icon: 'plus' },
    { to: '/chat', ka: 'ჩატი', en: 'Chat', badge: 'chat', icon: 'chat' },
    { to: '/more', ka: 'სხვა', en: 'More', icon: 'more' },
  ],
  treasury: [
    { to: '/rate-desk', ka: 'მაგიდა', en: 'Desk', badge: 'queue', icon: 'home' },
    { to: '/chat', ka: 'ჩატი', en: 'Chat', badge: 'chat', icon: 'chat' },
    { to: '/more', ka: 'სხვა', en: 'More', icon: 'more' },
  ],
  admin: [
    { to: '/rate-desk', ka: 'მაგიდა', en: 'Desk', badge: 'queue' },
    { to: '/requests', ka: 'მოთხოვნები', en: 'Requests' },
    { to: '/lost-requests', ka: 'დაკარგული', en: 'Lost', badge: 'losses' },
    { to: '/chat', ka: 'ჩატი', en: 'Chat', badge: 'chat' },
    { to: '/rates', ka: 'კურსები', en: 'Rates' },
  ],
  manager: [
    { to: '/requests', ka: 'მოთხოვნები', en: 'Requests' },
    { to: '/lost-requests', ka: 'დაკარგული', en: 'Lost', badge: 'losses' },
    { to: '/chat', ka: 'ჩატი', en: 'Chat', badge: 'chat' },
    { to: '/rates', ka: 'კურსები', en: 'Rates' },
  ],
  analyst: [],
};

const PHONE_HOME: Record<Exclude<Role, 'analyst'>, string> = {
  kam: '/requests',
  treasury: '/rate-desk',
  admin: '/rate-desk',
  manager: '/requests',
};

export function phoneHome(role: Role): string | null {
  if (role === 'analyst') return null;
  return PHONE_HOME[role];
}

/** Pages a KAM opens from More. Not primary tabs, and not a change to desktop nav. */
const KAM_MORE_PAGES = new Set(['/rates', '/clients', '/follow-ups']);

/** Treasury pages that stay under More. Desktop nav is unchanged. */
const TREASURY_MORE_PAGES = new Set(['/lost-requests', '/rates', '/quoted-progress', '/desk-history', '/log']);

export function isPhonePage(role: Role, path: string): boolean {
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  if (PHONE_NAV[role].some((item) => normalized === item.to || normalized.startsWith(item.to + '/'))) return true;
  if (role === 'kam' && KAM_MORE_PAGES.has(normalized)) return true;
  return role === 'treasury' && TREASURY_MORE_PAGES.has(normalized);
}
