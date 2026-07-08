import React from 'react';
import { HEALTH_LABELS } from '../format.js';

// Balance-health badge, the spreadsheet's conditional formatting mapped to
// semantic tints: negative (red), danger (amber), ok (blue), healthy (green),
// none (grey). Always paired with the label so state never rides on color
// alone.
export default function HealthBadge({ health, children }) {
  return (
    <span className={`badge health-${health}`}>
      {children ?? HEALTH_LABELS[health] ?? health}
    </span>
  );
}
