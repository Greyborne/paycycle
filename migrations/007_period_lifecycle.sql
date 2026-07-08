-- Pay-period lifecycle: closing a period is a manual, deliberate action.
-- closed_at NULL = not closed. closed_snapshot freezes the reconciliation
-- numbers at close time: {"total": <cents>, "accounts": {"<accountId>": <cents>}}
-- (per-account cleared balances) so a closed period's Cleared balance never
-- recalculates afterwards.
ALTER TABLE pay_periods ADD COLUMN closed_at TIMESTAMPTZ;
ALTER TABLE pay_periods ADD COLUMN closed_snapshot JSONB;
