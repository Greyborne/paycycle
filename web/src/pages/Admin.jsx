import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtDate } from '../format.js';

export default function Admin() {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api('/admin/users')
      .then((d) => setUsers(d.users))
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <p className="form-error" role="alert">{error}</p>;
  if (!users) return <div className="page-loading">Loading…</div>;

  return (
    <div className="admin-page">
      <section className="card">
        <h2>Users</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Household</th>
              <th>Role</th>
              <th className="num">Members</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.email}
                  {u.isSelf && <span className="muted small"> (you)</span>}
                  {u.isAdmin && <> <span className="badge badge-current">Admin</span></>}
                </td>
                <td>{u.household ?? <span className="muted">—</span>}</td>
                <td>{u.role ?? <span className="muted">—</span>}</td>
                <td className="num">{u.householdSize ?? <span className="muted">—</span>}</td>
                <td>{fmtDate(String(u.createdAt).slice(0, 10))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
