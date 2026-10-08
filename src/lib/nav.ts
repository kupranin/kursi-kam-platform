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
  treasury: ['/rate-desk', '/rates', '/log', '/chat'],
  admin: ['/team', '/requests', '/rate-desk', '/follow-ups', '/clients', '/analytics', '/analysis', '/kpis', '/rates', '/log', '/chat', '/admin'],
  manager: ['/team', '/requests', '/follow-ups', '/clients', '/analytics', '/kpis', '/rates', '/log', '/chat'],
  analyst: ['/analysis', '/analytics'],
};

export const NAV: Record<Role, { to: string; ka: string; en: string; badge?: 'followups' | 'queue' }[]> = {
  kam: [
    { to: '/requests', ka: 'მოთხოვნები', en: 'Requests' },
    { to: '/follow-ups', ka: 'დაბრუნება', en: 'Follow-ups', badge: 'followups' },
    { to: '/clients', ka: 'ჩემი კლიენტები', en: 'My clients' },
    { to: '/rates', ka: 'კურსები', en: 'Rates' },
    { to: '/team', ka: 'ჩემი ციფრები', en: 'My numbers' },
    { to: '/log', ka: 'ჟურნალი', en: 'Log' },
    { to: '/chat', ka: 'ჩატი', en: 'Chat' },
  ],
  treasury: [
    { to: '/rate-desk', ka: 'კურსის მაგიდა', en: 'Rate desk', badge: 'queue' },
    { to: '/rates', ka: 'კურსები', en: 'Rates' },
    { to: '/log', ka: 'ჟურნალი', en: 'Log' },
    { to: '/chat', ka: 'ჩატი', en: 'Chat' },
  ],
  admin: [
    { to: '/team', ka: 'გუნდი', en: 'Team' },
    { to: '/requests', ka: 'მოთხოვნები', en: 'Requests' },
    { to: '/rate-desk', ka: 'კურსის მაგიდა', en: 'Rate desk', badge: 'queue' },
    { to: '/follow-ups', ka: 'დაბრუნება', en: 'Follow-ups' },
    { to: '/clients', ka: 'კლიენტები', en: 'Clients' },
    { to: '/analytics', ka: 'ანალიტიკა', en: 'Analytics' },
    { to: '/analysis', ka: 'ანალიზი', en: 'Analysis' },
    { to: '/kpis', ka: 'KPI', en: 'KPI' },
    { to: '/rates', ka: 'კურსები', en: 'Rates' },
    { to: '/log', ka: 'ჟურნალი', en: 'Log' },
    { to: '/chat', ka: 'ჩატი', en: 'Chat' },
    { to: '/admin', ka: 'ადმინი', en: 'Admin' },
  ],
  manager: [
    { to: '/team', ka: 'გუნდი', en: 'Team' },
    { to: '/requests', ka: 'მოთხოვნები', en: 'Requests' },
    { to: '/follow-ups', ka: 'დაბრუნება', en: 'Follow-ups' },
    { to: '/clients', ka: 'კლიენტები', en: 'Clients' },
    { to: '/analytics', ka: 'ანალიტიკა', en: 'Analytics' },
    { to: '/kpis', ka: 'KPI', en: 'KPI' },
    { to: '/rates', ka: 'კურსები', en: 'Rates' },
    { to: '/log', ka: 'ჟურნალი', en: 'Log' },
    { to: '/chat', ka: 'ჩატი', en: 'Chat' },
  ],
  analyst: [
    { to: '/analysis', ka: 'ანალიზი', en: 'Analysis' },
    { to: '/analytics', ka: 'ანალიტიკა', en: 'Analytics' },
  ],
};
