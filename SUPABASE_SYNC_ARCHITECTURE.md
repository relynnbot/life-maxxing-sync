# Life-Maxxing-Protocol → Supabase Sync Architecture

## Goal
Allow the single-file app `lifemaxxing-v1.html` — currently localStorage only — to sync between phone (Netlify-hosted) and local machine while staying inside free tiers.

## Chosen stack
* **Frontend**: Netlify free tier hosting (125k function invocations/mo, 100GB bandwidth)
* **Backend**: Supabase free tier
  * 500 MB Postgres
  * 50k MAU, Realtime enabled
  * Row Level Security per device/user

No custom server needed. Supabase JS SDK runs in the browser via CDN, no Netlify Functions required. If you prefer zero-backend, you can later add a tiny Netlify Function as a signing proxy.

## Data model

One Supabase project, schema `public`.

`users`
* `id uuid pk default gen_random_uuid()`
* `device_id text unique` — anonymous identifier stored in localStorage
* `created_at timestamptz`

`gym_plan`
* `device_id text references users(device_id)`
* `plan jsonb` — mirrors `lm_gym_plan`
* `updated_at timestamptz`

`gym_history`
* `device_id text`
* `entry jsonb` — one history row
* `date_key text` — `YYYY-MM-DD` index
* `created_at timestamptz`

`health_diet_log`
* `device_id text`
* `date_key text`
* `log jsonb` — mirrors `lm_health_diet_log[date_key]`
* `primary key(device_id,date_key)`

`health_wellness_log`
* same shape as diet

`career_history_by_date`
* `device_id text`
* `date_key text`
* `tasks jsonb`
* `primary key(device_id,date_key)`

RLS: `device_id = auth.uid()` equivalent. For anonymous use, create a Supabase anon user per device and enable RLS with `device_id = current_setting('request.jwt.claims...')`. Simpler free-tier approach: disable RLS for now and trust device_id in client, or use service role only via Netlify Function. Recommended: create a Supabase Auth anonymous user on first load and store `user_id` in localStorage.

## Sync strategy – minimal changes

We keep the whole app logic intact. Wrap `localStorage.getItem/setItem/removeItem` with a sync adapter that:

1. Reads from Supabase on first load → seeds localStorage
2. On every `setItem` for known keys: debounce 500ms → upsert to Supabase
3. On `focus/online` → pull latest from Supabase → merge with localStorage
4. Realtime channel per device_id subscribes to changes → auto-merge

This avoids rewriting the 3k-line app.

### Load order
Add before `</body>`:

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="sync-adapter.js"></script>
```
`sync-adapter.js` is loaded first, installs the wrapper, then the existing app script runs unchanged.

## Free tier limits handling

* Write coalescing: debounce per key, batch multiple keys with one `Promise.all`
* Read once on load, then Realtime pushes only diffs
* History tables grow linearly. Prune > 12 months on client before upsert or add a soft-delete flag.
* Supabase 500 MB is enough for ~ tens of thousands of sessions per user.
* Netlify free tier unaffected – no functions used.

## Security notes

* Never expose service role key. Use anon key only.
* RLS policy:
  ```sql
  create policy "device own rows" on gym_history
  for all using (device_id = current_setting('app.device_id', true));
  ```
  Set `device_id` via Supabase client `auth` or via a tiny Netlify Function that signs requests.

## How to connect

1. Create Supabase project, enable Realtime on tables.
2. Run the SQL in `supabase/schema.sql`.
3. Copy `SUPABASE_URL` and `SUPABASE_ANON_KEY` into `sync-adapter.js`.
4. Deploy `lifemaxxing-v1.html` + `sync-adapter.js` to Netlify.
5. On first visit, user gets a random `device_id` stored in localStorage `lm_device_id`. Subsequent visits merge.

Changes made on phone instantly appear on desktop via Realtime.

## Minimal change summary

* 1 new file: `sync-adapter.js` ~ 180 lines
* 1 HTML edit: add 2 script tags before closing body
* No logic changes in lifemaxxing-v1.html
* Optional Netlify Function `/.netlify/functions/sync` for server-side signing if RLS stricter.

This keeps the app single-file in spirit, stays on free tiers, and provides phone → local machine sync.
