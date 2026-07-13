import React from 'react';

// Minimal 24-viewbox stroke icons, sized/colored by CSS via currentColor.
const Icon = ({ children, ...props }) => (
  <svg
    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}
  >
    {children}
  </svg>
);

export const HomeIcon = () => (
  <Icon><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M9.5 21v-6h5v6" /></Icon>
);

export const CalendarIcon = () => (
  <Icon><rect x="3" y="5" width="18" height="16" rx="2.5" /><path d="M3 10h18" /><path d="M8 3v4M16 3v4" /></Icon>
);

export const TagIcon = () => (
  <Icon><path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9Z" /><circle cx="8.5" cy="8.5" r="1.4" /></Icon>
);

export const ImportIcon = () => (
  <Icon><path d="M12 3v11" /><path d="m7.5 10.5 4.5 4 4.5-4" /><path d="M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></Icon>
);

export const ChartIcon = () => (
  <Icon><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-8" /><path d="M22 20H2" /></Icon>
);

export const GearIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19 12a7 7 0 0 0-.14-1.4l2-1.55-2-3.46-2.35.95a7 7 0 0 0-2.42-1.4L13.7 2.6h-3.4l-.39 2.54a7 7 0 0 0-2.42 1.4l-2.35-.95-2 3.46 2 1.55a7 7 0 0 0 0 2.8l-2 1.55 2 3.46 2.35-.95a7 7 0 0 0 2.42 1.4l.39 2.54h3.4l.39-2.54a7 7 0 0 0 2.42-1.4l2.35.95 2-3.46-2-1.55A7 7 0 0 0 19 12Z" />
  </Icon>
);

export const BellIcon = () => (
  <Icon><path d="M18 9a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 15 18 9" /><path d="M10 20a2.2 2.2 0 0 0 4 0" /></Icon>
);

export const MenuIcon = () => (
  <Icon><path d="M4 6h16M4 12h16M4 18h16" /></Icon>
);

export const ListIcon = () => (
  <Icon><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" strokeWidth="2.6" /></Icon>
);

export const SlidersIcon = () => (
  <Icon><path d="M4 8h9M17 8h3M4 16h3M11 16h9" /><circle cx="15" cy="8" r="2.2" /><circle cx="9" cy="16" r="2.2" /></Icon>
);

export const CollapseIcon = () => (
  <Icon><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9.5 4v16" /><path d="m16 10-2 2 2 2" /></Icon>
);

export const SunIcon = () => (
  <Icon><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Icon>
);

export const MoonIcon = () => (
  <Icon><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></Icon>
);

export const MonitorIcon = () => (
  <Icon><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></Icon>
);

export const ShieldIcon = () => (
  <Icon><path d="M12 3 5 6v5c0 5 3 8 7 9 4-1 7-4 7-9V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></Icon>
);

export const SignOutIcon = () => (
  <Icon><path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4" /><path d="m15 16 4-4-4-4" /><path d="M19 12H9" /></Icon>
);
