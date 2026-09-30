-- Supabase schema for Life-Maxxing-Protocol sync, free tier friendly
-- Run in Supabase SQL editor

create table if not exists public.local_sync (
  device_id text not null,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (device_id, key)
);

-- Optional: enable realtime
alter publication supabase_realtime add table public.local_sync;

-- RLS (optional, can be disabled for MVP)
alter table public.local_sync enable row level security;

create policy "device can read own" on public.local_sync
  for select using (device_id = current_setting('app.device_id', true));

create policy "device can write own" on public.local_sync
  for insert with check (device_id = current_setting('app.device_id', true));

create policy "device can update own" on public.local_sync
  for update using (device_id = current_setting('app.device_id', true));

-- Helper to set device id per session via RPC or client
-- For anon key usage, you can skip RLS and rely on device_id in client.
