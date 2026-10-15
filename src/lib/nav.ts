import type { Role } from './types';

export const HOME: Record<Role, string> = {
  kam: '/requests',
  treasury: '/rate-desk',
  admin: '/team',
  manager: '/team',
  analyst: '/analysis',
};

export const PAGES: Record<Role, string[]> = {
  kam: ['/requests', '/follow-ups', '/clients', '/team', '/rates', '/log', '/chat'],
  treasury: ['/rate-desk', '/quoted-progress', '/lost-requests', '/desk-history', '/analysis', '/rates', '/log', '/chat'],
  admin: ['/team', '/requests', '/rate-desk', '/quoted-progress', '/lost-requests', '/desk-history', '/follow-ups', '/clients', '/analytics', '/analysis', '/kpis', '/rates', '/log', '/chat', '/admin'],
  manager: ['/team', '/requests', '/lost-requests', '/follow-ups', '/clients', '/analytics', '/kpis', '/rates', '/log', '/chat'],
  analyst: ['/analysis', '/analytics', '/rates'],
};

export const NAV: Record<Role, { to: string; ka: string; en: string; badge?: 'followups' | 'queue' | 'losses' | 'chat' }[]> = {
  kam: [
    { to: '/requests', ka: 'მოთხოვნები', en: 'Requests' },
    { to: '/follow-ups', ka: 'დაბრუნება', en: 'Follow-ups', badge: 'followups' },
    { to: '/clients', ka: 'ჩემი კლიენტები', en: 'My clients' },
    { to: '/rates', ka: 'კურსები', en: 'Rates' },
    { to: '/team', ka: 'ჩემი ციფრები', en: 'My numbers' },
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
    { to: '/log', ka: 'ჟურნალი', en: 'Log' },
    { to: '/chat', ka: 'ჩატი', en: 'Chat', badge: 'chat' },
  ],
  analyst: [
    { to: '/analysis', ka: 'ანალიზი', en: 'Analysis' },
    { to: '/analytics', ka: 'ანალიტიკა', en: 'Analytics' },
    { to: '/rates', ka: 'კურსები', en: 'Rates' },
  ],
};

/** Phone tabs. Analyst has none: analysis stays on a computer, and rates stay on the desktop site. */
export const PHONE_NAV: Record<Role, { to: string; ka: string; en: string; badge?: 'followups' | 'queue' | 'losses' | 'chat' }[]> = {
  kam: [
    { to: '/requests', ka: 'მოთხოვნები', en: 'Requests' },
    { to: '/follow-ups', ka: 'დაბრუნება', en: 'Follow-ups', badge: 'followups' },
    { to: '/rates', ka: 'კურსები', en: 'Rates' },
    { to: '/chat', ka: 'ჩატი', en: 'Chat', badge: 'chat' },
    { to: '/clients', ka: 'კლიენტები', en: 'Clients' },
  ],
  treasury: [
    { to: '/rate-desk', ka: 'მაგიდა', en: 'Desk', badge: 'queue' },
    { to: '/lost-requests', ka: 'დაკარგული', en: 'Lost', badge: 'losses' },
    { to: '/rates', ka: 'კურსები', en: 'Rates' },
    { to: '/chat', ka: 'ჩატი', en: 'Chat', badge: 'chat' },
    { to: '/quoted-progress', ka: 'მიმდინარეობა', en: 'Progress' },
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

export function isPhonePage(role: Role, path: string): boolean {
  return PHONE_NAV[role].some((item) => item.to === path);
}
