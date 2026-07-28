import React, { useId, useRef, useState } from 'react';

// Reusable ARIA tabs primitive (WAI-ARIA "automatic activation" pattern).
// Usage: <Tabs tabs={[{ id, label, content }, ...]} defaultTab="general" />
// `tabs[].content` is any renderable node; only the active tab's panel stays
// in the DOM/accessible flow. Arrow keys move + activate, Home/End jump to
// the first/last tab, focus wraps at the ends.
export default function Tabs({ tabs, defaultTab }) {
  const uid = useId();
  const [active, setActive] = useState(defaultTab ?? tabs[0]?.id);
  const tabRefs = useRef([]);

  const activeIndex = Math.max(0, tabs.findIndex((t) => t.id === active));

  function focusTab(index) {
    const wrapped = (index + tabs.length) % tabs.length;
    const tab = tabs[wrapped];
    setActive(tab.id);
    tabRefs.current[wrapped]?.focus();
  }

  function handleKeyDown(e) {
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        focusTab(activeIndex + 1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        focusTab(activeIndex - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusTab(0);
        break;
      case 'End':
        e.preventDefault();
        focusTab(tabs.length - 1);
        break;
      default:
        break;
    }
  }

  const tabId = (id) => `tab-${uid}-${id}`;
  const panelId = (id) => `tabpanel-${uid}-${id}`;

  return (
    <div className="tabs">
      <div className="tabs-list" role="tablist" onKeyDown={handleKeyDown}>
        {tabs.map((tab, i) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(el) => { tabRefs.current[i] = el; }}
              type="button"
              role="tab"
              id={tabId(tab.id)}
              className={`tabs-tab${selected ? ' active' : ''}`}
              aria-selected={selected}
              aria-controls={panelId(tab.id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <div
            key={tab.id}
            role="tabpanel"
            id={panelId(tab.id)}
            aria-labelledby={tabId(tab.id)}
            className="tabs-panel"
            hidden={!selected}
            tabIndex={0}
          >
            {selected ? tab.content : null}
          </div>
        );
      })}
    </div>
  );
}
