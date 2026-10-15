import type { PhoneIcon } from '../../lib/nav';

export default function TabIcon({ name }: { name: PhoneIcon }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className: 'tabbar-icon',
  };
  if (name === 'home') {
    return (
      <svg {...common}>
        <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5z" />
      </svg>
    );
  }
  if (name === 'plus') {
    return (
      <svg {...common}>
        <path d="M12 5v14M5 12h14" />
      </svg>
    );
  }
  if (name === 'chat') {
    return (
      <svg {...common}>
        <path d="M6 17.5 3.5 20V6.5A2 2 0 0 1 5.5 4.5h13a2 2 0 0 1 2 2V15a2 2 0 0 1-2 2H6z" />
      </svg>
    );
  }
  if (name === 'rates') {
    return (
      <svg {...common}>
        <path d="M4 16.5 9 11l3 3 7-8" />
        <path d="M15 6h4v4" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}
