import { useEffect, useState } from 'react';
import { api } from './api.js';

// Household accounts, with live balances. `active` excludes archived ones
// (for pickers); pages that manage accounts use the full list.
export function useAccounts() {
  const [accounts, setAccounts] = useState(null);
  const reload = () => api('/accounts').then((d) => setAccounts(d.accounts));
  useEffect(() => { reload(); }, []);
  return {
    accounts,
    active: (accounts || []).filter((a) => !a.archived),
    reload,
  };
}
