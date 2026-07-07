-- Giving support columns on people. finance marks the finance team (giving
-- admin access); stripe_customer_id links a person to their Stripe customer
-- for recurring giving + the customer portal. Harmless on D1 deployments —
-- the giving module itself is Supabase-only.
ALTER TABLE people ADD COLUMN finance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE people ADD COLUMN stripe_customer_id TEXT;
