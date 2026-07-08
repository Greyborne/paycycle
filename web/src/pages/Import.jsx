import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { fmtMoney } from '../format.js';
import { parseCSV, parseDateCell, parseAmountCell, suggestedRulePattern } from '../csv.js';
import { useAccounts } from '../useAccounts.js';
import BankSync from '../components/BankSync.jsx';

function guessColumn(header, patterns) {
  const lower = header.map((h) => h.toLowerCase());
  for (const p of patterns) {
    const i = lower.findIndex((h) => h.includes(p));
    if (i >= 0) return i;
  }
  return -1;
}

export default function Import() {
  const { user } = useAuth();
  const { base: baseAccounts } = useAccounts();
  const currency = user.currency;
  const [accountId, setAccountId] = useState('');
  const [step, setStep] = useState('paste');
  const [raw, setRaw] = useState('');
  const [grid, setGrid] = useState([]);
  const [hasHeader, setHasHeader] = useState(true);
  const [cols, setCols] = useState({ date: 0, description: 1, amount: 2, bankId: -1 });
  const [dateOrder, setDateOrder] = useState('mdy');
  const [signFlip, setSignFlip] = useState(false); // true when the bank exports withdrawals as positive
  const [rows, setRows] = useState([]);
  const [categories, setCategories] = useState([]);
  const [updatePlanned, setUpdatePlanned] = useState(true);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const activeCategories = useMemo(() => categories.filter((c) => !c.archived), [categories]);

  const toMapping = (text) => {
    const parsed = parseCSV(text);
    if (parsed.length === 0) { setError('No rows found in that file'); return; }
    setGrid(parsed);
    const header = parsed[0].map(String);
    setCols({
      date: Math.max(0, guessColumn(header, ['date'])),
      description: Math.max(0, guessColumn(header, ['description', 'memo', 'payee', 'name', 'detail'])),
      amount: Math.max(0, guessColumn(header, ['amount', 'value'])),
      bankId: guessColumn(header, ['transaction id', 'reference', 'fitid', 'id']),
    });
    setHasHeader(header.some((h) => /[a-z]/i.test(h) && parseAmountCell(h) === null));
    setError(null);
    setStep('map');
  };

  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => toMapping(String(reader.result));
    reader.readAsText(file);
  };

  const toPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      const dataRows = hasHeader ? grid.slice(1) : grid;
      const mapped = [];
      let badRows = 0;
      for (const r of dataRows) {
        const date = parseDateCell(r[cols.date], dateOrder);
        let amount = parseAmountCell(r[cols.amount]);
        if (date === null || amount === null || amount === 0) { badRows += 1; continue; }
        if (signFlip) amount = -amount;
        mapped.push({
          date,
          description: String(r[cols.description] ?? '').trim(),
          amountCents: amount,
          bankId: cols.bankId >= 0 ? String(r[cols.bankId] ?? '').trim() || undefined : undefined,
        });
      }
      if (!mapped.length) throw new Error('No usable rows — check the column mapping and date format');
      const [preview, cats] = await Promise.all([
        api('/import/preview', { method: 'POST', body: { rows: mapped, accountId: accountId ? Number(accountId) : undefined } }),
        api('/categories'),
      ]);
      setCategories(cats.categories);
      setRows(preview.rows.map((r) => ({
        ...r,
        include: !r.duplicate,
        categoryTemplateId: r.suggestedCategoryId,
      })));
      if (badRows) setError(`${badRows} row(s) could not be parsed and were dropped`);
      setStep('preview');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        updatePlanned,
        accountId: accountId ? Number(accountId) : undefined,
        rows: rows.filter((r) => r.include).map((r) => ({
          date: r.date,
          description: r.description,
          amountCents: r.amountCents,
          bankId: r.bankId,
          categoryTemplateId: r.categoryTemplateId ?? null,
          categorizedBy: r.categoryTemplateId ? (r.matchedBy === 'rule' ? 'rule' : 'manual') : undefined,
          // Learn a rule when the user confirmed a match that didn't already
          // come from a rule.
          rulePattern: remember && r.categoryTemplateId && r.matchedBy !== 'rule'
            ? suggestedRulePattern(r.description)
            : undefined,
        })),
      };
      if (!body.rows.length) throw new Error('No rows selected');
      setResult(await api('/import/commit', { method: 'POST', body }));
      setStep('done');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const setRow = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const previewCols = grid[0]?.length || 0;

  return (
    <div className="import-page">
      <BankSync />

      {step === 'paste' && <h2>Import a CSV statement</h2>}
      {step === 'paste' && (
        <section className="card">
          <p className="muted">
            Export a CSV from your bank and drop it here. You&apos;ll map the columns, review suggested
            category matches, and confirm before anything is saved. Rows already imported are detected
            and skipped automatically.
          </p>
          <label>
            CSV file
            <input type="file" accept=".csv,text/csv" onChange={onFile} />
          </label>
          <label>
            …or paste CSV text
            <textarea
              rows={8} value={raw} onChange={(e) => setRaw(e.target.value)}
              placeholder={'Date,Description,Amount\n07/01/2026,ELECTRIC CO PMT,-250.00'}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="btn btn-primary" disabled={!raw.trim()} onClick={() => toMapping(raw)}>Continue</button>
        </section>
      )}

      {step === 'map' && (
        <section className="card">
          <h2>Map columns</h2>
          <div className="field-row">
            {['date', 'description', 'amount'].map((k) => (
              <label key={k}>
                {k[0].toUpperCase() + k.slice(1)} column
                <select value={cols[k]} onChange={(e) => setCols({ ...cols, [k]: Number(e.target.value) })}>
                  {Array.from({ length: previewCols }, (_, i) => (
                    <option key={i} value={i}>
                      {hasHeader ? `${i + 1}: ${grid[0][i]}` : `Column ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label>
              Transaction ID column <span className="muted">(optional — best dedup key)</span>
              <select value={cols.bankId} onChange={(e) => setCols({ ...cols, bankId: Number(e.target.value) })}>
                <option value={-1}>None</option>
                {Array.from({ length: previewCols }, (_, i) => (
                  <option key={i} value={i}>
                    {hasHeader ? `${i + 1}: ${grid[0][i]}` : `Column ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {baseAccounts.length > 1 && (
            <label>
              This statement belongs to
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {baseAccounts.map((a) => (
                  <option key={a.id} value={a.isDefault ? '' : a.id}>{a.name}</option>
                ))}
              </select>
            </label>
          )}
          <div className="field-row">
            <label>
              Date format
              <select value={dateOrder} onChange={(e) => setDateOrder(e.target.value)}>
                <option value="mdy">MM/DD/YYYY (US)</option>
                <option value="dmy">DD/MM/YYYY</option>
              </select>
            </label>
            <label>
              Amount signs
              <select value={signFlip ? 'flip' : 'normal'} onChange={(e) => setSignFlip(e.target.value === 'flip')}>
                <option value="normal">Withdrawals are negative</option>
                <option value="flip">Withdrawals are positive</option>
              </select>
            </label>
            <label className="toggle-archived" style={{ alignSelf: 'end' }}>
              <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
              First row is a header
            </label>
          </div>
          <h3>File preview</h3>
          <div className="table-scroll">
            <table className="table">
              <tbody>
                {grid.slice(0, 5).map((r, i) => (
                  <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          {error && <p className="form-error">{error}</p>}
          <div className="wizard-nav">
            <button className="btn btn-ghost" onClick={() => setStep('paste')}>Back</button>
            <button className="btn btn-primary" disabled={busy} onClick={toPreview}>Preview import</button>
          </div>
        </section>
      )}

      {step === 'preview' && (
        <section className="card">
          <h2>Review {rows.length} rows</h2>
          <p className="muted small">
            Rows matched to a category mark that period&apos;s line item as cleared instead of
            counting as misc. Unmatched rows import as misc transactions. Duplicates are unticked.
          </p>
          <label className="toggle-archived">
            <input type="checkbox" checked={updatePlanned} onChange={(e) => setUpdatePlanned(e.target.checked)} />
            Update matched line items&apos; planned amounts to the actual bank amount
          </label>
          <label className="toggle-archived">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember my matches to auto-suggest them next import
          </label>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr><th /><th>Date</th><th>Description</th><th className="num">Amount</th><th>Category</th><th /></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={r.include ? '' : 'row-muted'}>
                    <td><input type="checkbox" checked={r.include} onChange={(e) => setRow(i, { include: e.target.checked })} /></td>
                    <td>{r.date}</td>
                    <td>{r.description || <span className="muted">—</span>}</td>
                    <td className={`num ${r.amountCents < 0 ? 'amount-neg' : ''}`}>{fmtMoney(r.amountCents, currency)}</td>
                    <td>
                      <select
                        value={r.categoryTemplateId ?? ''}
                        onChange={(e) => setRow(i, { categoryTemplateId: e.target.value ? Number(e.target.value) : null, matchedBy: 'user' })}
                      >
                        <option value="">Misc (uncategorized)</option>
                        <optgroup label="Expenses">
                          {activeCategories.filter((c) => c.type === 'expense').map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Income">
                          {activeCategories.filter((c) => c.type === 'income').map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </optgroup>
                      </select>
                    </td>
                    <td className="muted small">
                      {r.duplicate ? 'duplicate' : r.matchedBy === 'rule' ? 'auto-matched' : r.matchedBy === 'name' ? 'name match' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error && <p className="form-error">{error}</p>}
          <div className="wizard-nav">
            <button className="btn btn-ghost" onClick={() => setStep('map')}>Back</button>
            <button className="btn btn-primary" disabled={busy} onClick={commit}>
              Import {rows.filter((r) => r.include).length} rows
            </button>
          </div>
        </section>
      )}

      {step === 'done' && result && (
        <section className="card">
          <h2>Import complete</h2>
          <ul>
            <li><strong>{result.imported}</strong> transactions imported</li>
            <li><strong>{result.autoCategorized}</strong> auto-categorized by rules</li>
            <li><strong>{result.linked}</strong> line items marked cleared</li>
            {result.needReview > 0 && (
              <li>
                <strong>{result.needReview}</strong> imported uncategorized —{' '}
                <Link to="/transactions">review them</Link>
              </li>
            )}
            {result.moved > 0 && <li><strong>{result.moved}</strong> late-posting bill(s) moved to the period they cleared in</li>}
            {result.replanned > 0 && (
              <li><strong>{result.replanned}</strong> recurring plan(s) updated to match, going forward</li>
            )}
            {result.duplicates > 0 && <li><strong>{result.duplicates}</strong> duplicates skipped</li>}
            {result.skipped > 0 && <li><strong>{result.skipped}</strong> rows outside your open periods skipped</li>}
          </ul>
          {result.drift?.length > 0 && (
            <div className="muted small">
              Updated going forward: {result.drift.map((d) => d.name).join(', ')}.
            </div>
          )}
          <div className="wizard-nav">
            <button className="btn btn-ghost" onClick={() => { setStep('paste'); setRaw(''); setResult(null); }}>
              Import another file
            </button>
            <Link className="btn btn-primary" to="/period/current">View current period</Link>
          </div>
        </section>
      )}
    </div>
  );
}
