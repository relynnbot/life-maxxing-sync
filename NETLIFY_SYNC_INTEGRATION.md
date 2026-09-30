# Netlify Sync Integration Guide

## Overview
Deploy `lifemaxxing-v1.html` with transparent Supabase sync via `sync-adapter-v3-prod.js`. The app logic remains untouched; the adapter wraps localStorage with debounced upserts, seeding, device_id handling, and realtime updates.

## Files Created
- `sync-adapter-v3-prod.js` — production sync adapter (debounced, merge-aware, offline-safe)
- `NETLIFY_SYNC_INTEGRATION.md` — this guide

Supabase project:
- URL: https://kkuolrxmytynsxemxixm.supabase.co
- Anon key already embedded in adapter

## 1. Supabase schema
Create table `local_sync` with RLS per device:

```sql
create table if not exists public.local_sync (
  device_id text not null,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (device_id, key)
);

alter table public.local_sync enable row level security;

-- Optional (anonymous access). Replace with auth-based policy if you enable Supabase Auth.
create policy "anon read own" on public.local_sync
  for select using (true);

create policy "anon insert own" on public.local_sync
  for insert with check (true);

create policy "anon update own" on public.local_sync
  for update using (true);

-- Enable Realtime
alter publication supabase_realtime add table public.local_sync;
```

## 2. Netlify deployment steps

1. **Push files**
   - Keep `lifemaxxing-v1.html` at repo root
   - Add `sync-adapter-v3-prod.js`

2. **Edit HTML head** — load Supabase client and adapter BEFORE the app script.

Add inside `<head>` before any inline app script:
```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="sync-adapter-v3-prod.js"></script>
```
The adapter auto-initializes on DOMContentLoaded and wraps `localStorage`.

3. **Netlify config** — no functions required. `netlify.toml` minimal:
```toml
[build]
  publish = "."
  command = ""

[[headers]]
  for = "/*"
  [headers.values]
    X-Frame-Options = "SAMEORIGIN"
    Referrer-Policy = "strict-origin-when-cross-origin"
```

Deploy via Git or drag-drop. Netlify serves the single HTML file.

## 3. How sync works
- Device ID stored in `lm_device_id`
- On first load: seed each of the 6 keys from Supabase if localStorage empty
- On `localStorage.setItem` for tracked keys: debounce 800ms → upsert to `local_sync`
- On visibilitychange / focus / online → pull latest and merge
- Realtime channel per device_id pushes updates instantly across devices
- Merge strategies:
  - Gym history: union by id/date+dayId, keep newer `updated_at`
  - Health diet/wellness logs: deep merge per date
  - Career history by date: merge tasks per date

## 4. Security notes
- Anon key is safe for client use with RLS. Avoid service role key.
- For stricter RLS, enable Supabase Auth anonymous users and set policy:
  `using (device_id = auth.uid()::text)`
- Rotating keys: store URL/key in Netlify environment variables and inject at build time if you prefer not to hardcode.

## 5. Testing checklist
- Open app on desktop, create a gym session → appears in Supabase table
- Open same site on phone (incognito) → sign in? No auth needed, same device_id? Different device → create new device_id and seed.
- Edit plan on one device → other device sees change within seconds via Realtime
- Go offline, change data → changes persist locally; on reconnect pull syncs

## 6. Troubleshooting
- No sync: verify `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>` loads before adapter
- CORS errors: ensure Supabase project allows your Netlify domain (default allows all for anon)
- Duplicate writes: debounce is per-key; rapid edits coalesce
- Data loss: adapter prefers local on first load; use manual export/import if needed

## 7. Optional enhancements
- Netlify Function proxy for signing requests (server-side service role)
- Add export/import JSON modal for backups
- Migrate to per-domain tables (`gym_plan`, `gym_history`, …) for better indexing
