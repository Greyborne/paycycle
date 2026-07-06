import React from 'react';
import { HEALTH_LABELS } from '../format.js';

// Balance-health badge replicating the spreadsheet's conditional formatting:
// negative (red), danger (pink/magenta), ok (light blue), healthy (solid
// blue), none (grey). Always paired with the label so state never rides on
// color alone.
export default function HealthBadge({ health, children }) {
  return (
    <span className={`badge health-${health}`}>
      {children ?? HEALTH_LABELS[health] ?? health}
    </span>
  );
}
