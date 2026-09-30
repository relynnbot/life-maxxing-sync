# Sync Strategy: Life Maxxing Protocol — LocalStorage → Remote with Offline-First

## Current State
- App: lifemaxxing-v1.html single file, vanilla JS
- Persistence: browser localStorage only
  Keys: lm_gym_plan, lm_gym_history, lm_health_diet_log, lm_health_wellness_log, lm_career_history, lm_career_history_by_date
- Hosting target: Netlify (mobile access)
- Requirement: mirror changes to local machine, allow updates via Hermes agent, offline-first

## Architecture Overview

### Offline-First Principles
1. LocalStorage remains source of truth for UI responsiveness
2. All writes happen locally first, then sync in background
3. App works 100% offline, sync queues when online
4. Conflict resolution prefers per-record timestamps + domain-specific merge

### Sync Layer Options

#### Option A: Supabase (recommended for free tier)
- Pros: Realtime subscriptions, Postgres, RLS, 500MB free
- Cons: Client-side anon key exposure
- Implementation already started: sync-adapter.js + SUPABASE_SYNC_ARCHITECTURE.md

#### Option B: Netlify + Git-backed sync
- Local machine repo = source of truth
- Netlify deploys from Git
- Hermes background service pushes/pulls HTML file changes
- localStorage sync via a tiny backend endpoint

#### Option C: Hermes Agent as sync orchestrator
- Hermes runs background cron to pull Netlify site content, diff lifemaxxing-v1.html
- Two-way sync via localStorage export/import JSON blobs stored in Git
- No external DB required

## Recommended Hybrid Strategy

### Layer 1: Storage Adapter (transparent)
Wrap localStorage with a sync adapter that:
- Intercepts getItem/setItem/removeItem for 6 keys
- Maintains a local sync queue in IndexedDB: {key, operation, value, timestamp, deviceId, version}
- Debounces writes 600ms, batches per domain
- Persists queue offline, retries on online

### Layer 2: Remote Store
Use Supabase `local_sync` table:
device_id | key | value (jsonb) | updated_at | version

Alternative: Netlify Function + R2/S3 for JSON blobs per device.

### Layer 3: Background Service via Hermes
Hermes cron job:
- Every 5 min: check Netlify deploy for changes to lifemaxxing-v1.html
- Compare hash with local copy at C:\Users\relyn\life-maxxing-protocol\lifemaxxing-v1.html
- If remote newer: pull via curl, backup local, replace, notify user
- If local newer: git add/commit/push, trigger Netlify rebuild
- Also sync localStorage export blobs to remote store

Hermes agent can also:
- Monitor localStorage changes via a small bridge page that exports JSON
- Push exports to Supabase or Git
- Apply updates from remote to local machine via file writes

## Data Flow

Mobile (Netlify) → Supabase → Desktop Browser localStorage
          ↑                ↓
    Hermes Agent ⇄ Local filesystem

## Offline-First Sync Mechanics

### Write Path
1. User changes data → app calls localStorage.setItem
2. Adapter intercepts → writes to localStorage immediately → enqueues sync operation
3. Background sync worker:
   - If online: debounce → upsert to Supabase with deviceId + updated_at
   - If offline: keep in IndexedDB queue, retry on 'online' event
4. Emit CustomEvent 'lm_sync_update' for UI refresh

### Read Path
1. App reads localStorage
2. On app start / visibilitychange / online:
   - Pull latest from Supabase for each key
   - Compare local ts vs remote updated_at
   - Merge per key

### Realtime
Supabase Realtime channel per deviceId:
- Listen to postgres_changes on local_sync
- On remote change: compare timestamps → update localStorage if newer → dispatch event → UI re-renders

## Conflict Resolution

### Per-Domain Rules

#### Gym
- Granularity: per session entry + plan
- Conflict: two devices edit same day plan
- Resolution: Last-Write-Wins per exercise object using updated_at per exercise
- Merge strategy: deep merge arrays by id, keep both sessions with different dates
- UI: show conflict toast with "Keep local / Keep remote / Merge"

#### Health
- Granularity: per date_key for diet_log and wellness_log
- Diet meals/supplements are booleans/variants → commutative
- Conflict: same date edited on two devices
- Resolution: field-level merge
  - meals: union of done flags, variant = latest timestamp
  - supplements: OR merge
  - wellness habits: OR merge
- Use vector clock per date_key

#### Career
- Granularity: per date_key tasks array
- Conflict: tasks added/edited on both devices
- Resolution: CRDT-like list merge
  - Tasks identified by id (uuid)
  - Status changes: latest timestamp wins per task
  - New tasks: union
  - Deletions: tombstone with deleted_at

### General Conflict Resolution Engine
1. Each record has: {value, updated_at, deviceId, version}
2. On pull:
   - If local updated_at >= remote updated_at → keep local
   - If remote newer → apply remote
   - If timestamps equal but deviceId different → merge
3. For arrays/objects: recursive merge with domain rules
4. Store conflict log in localStorage 'lm_sync_conflicts' for user review

### Offline Queue Handling
- Queue entries have retry count, backoff exponential
- On reconnect:
  - Process queue in order
  - For each entry, fetch current remote version
  - If remote changed since queue entry created → run conflict resolution
  - Apply resolved value

## Netlify Deployment Strategy

### File Sync
1. Keep lifemaxxing-v1.html in Git repo
2. Netlify deploys from main branch
3. Hermes background service:
   - Watches repo for changes via git log
   - Pushes changes to Netlify via GitHub API or CLI
   - Pulls Netlify file to local for editing

### Data Sync Separation
- Code changes → Git → Netlify
- Data changes → localStorage → Supabase → other devices

## Hermes Agent Integration

Create skill: life-maxxing-sync

Functions:
- sync_pull_code(): curl Netlify URL → compare hash → write to local
- sync_push_code(): git add/commit/push lifemaxxing-v1.html
- export_localstorage(): open local dev server, export keys to JSON file
- import_remote_data(): fetch from Supabase, write to localStorage via bridge
- resolve_conflicts(): present diff UI via TUI

Background cron: every 15 min, check for code drift, auto-pull if user opted in.

## Security & Privacy
- deviceId generated via crypto.randomUUID, stored in localStorage lm_device_id
- Supabase RLS: policy WHERE device_id = current_setting('app.device_id')
- For anon key exposure, limit table to device-scoped reads/writes
- Optionally use Netlify Function as proxy to sign requests with service role

## Free Tier Considerations
- Debounce writes, batch upserts
- Prune history >12 months client-side before sync
- Use Supabase Realtime only for active keys, unsubscribe when tab hidden
- Netlify Functions not required; pure CDN + Supabase

## Implementation Steps
1. Finalize sync-adapter.js with IndexedDB queue and conflict resolution
2. Add version/timestamp metadata to each localStorage write
3. Deploy Supabase schema with local_sync table + RLS
4. Add Netlify script tags to lifemaxxing-v1.html
5. Create Hermes cron job for code sync
6. Add UI toast for sync status: Synced / Syncing / Offline / Conflict

## Files Created/Modified
- sync-adapter.js (exists)
- SUPABASE_SYNC_ARCHITECTURE.md (exists)
- lifemaxxing-v1.html needs <script src="sync-adapter.js"> added before app script
- New: sync-strategy.md (this document)
