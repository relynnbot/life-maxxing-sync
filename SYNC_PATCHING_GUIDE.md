# Sync Adapter Patching Guide for lifemaxxing-v1.html

## Current State Audit

- HTML: `C:\Users\relyn/life-maxxing-protocol/lifemaxxing-v1.html`
- Lines: 3,341 / ~163KB
- Already contains in `<head>`:
  ```html
  <script src="https://cdn.jsdelivr.net/npm/js-yaml@4/dist/js-yaml.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  <script src="sync-adapter-v3-prod.js"></script>
  ```
- Inline app script starts ~line 1449 and ends at `</script></body></html>` line 3339-3341.

Supabase URL from context: `https://kkuolrxmytynsxemxixm.supabase.co`
Anon key provided in context (use the full key in adapter).

## Why Patching is Needed

Head script load order currently injects adapter before the inline app script. The adapter wraps `localStorage` via prototype override. This works but:
- Adapter loads in head before DOM ready, before Supabase CDN may be fully parsed
- Hard-coded placeholder anon key in `sync-adapter-v3-prod.js` line 8
- No guarantee `window.supabase` is ready when adapter init fires

Safer pattern: keep Supabase CDN in head, move adapter just before `</body>` after inline app script, ensuring `createClient` is available and app init has run once.

## Step-by-Step Patch

### 1. Prepare sync-adapter file

Use `sync-adapter-v3-prod.js` as production template.

Patch config:
```bash
# open file
```
Set lines 7-8:
```js
const SUPABASE_URL = 'https://kkuolrxmytynsxemxixm.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_FULL_ANON_KEY_HERE';
```

Verify KEYS match app usage:
- `lm_gym_plan`
- `lm_gym_history`
- `lm_health_diet_log`
- `lm_health_wellness_log`
- `lm_career_history`
- `lm_career_history_by_date`

These are the six keys the adapter wraps.

### 2. Verify current script tags

Read head lines 15-17:
```html
<script src="https://cdn.jsdelivr.net/npm/js-yaml@4/dist/js-yaml.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="sync-adapter-v3-prod.js"></script>
```

Keep Supabase CDN in head. Remove or comment adapter from head.

Patch head:
```html
<script src="https://cdn.jsdelivr.net/npm/js-yaml@4/dist/js-yaml.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
```

Leave no adapter in head.

### 3. Locate insertion point in HTML

File ends:
```html
</script>
</body>
</html>
```
Lines 3339-3341.

Find last `</script>` before `</body>`. That is line 3339. Insert adapter script immediately before `</body>`.

### 4. Apply patch

Old block:
```html
</script>
</body>
</html>
```

New block:
```html
</script>
<script src="sync-adapter-v3-prod.js"></script>
</body>
</html>
```

Using `patch` tool with context:

Patch path: `C:\Users\relyn/life-maxxing-protocol/lifemaxxing-v1.html`
Old string must include trailing newline and closing tags exactly.

### 5. Verify placement order

Final script order:
1. `<head>`:
   - js-yaml CDN
   - @supabase/supabase-js CDN
2. Inline app script `<script>...</script>` body ~1449-3339
3. `sync-adapter-v3-prod.js` just before `</body>`

Adapter initialization:
- `document.readyState` check ensures init runs after DOM load
- `waitSupabase` polls for `window.supabase`
- Wrapper installed after app script has already defined its functions, but `localStorage.setItem` calls from app will still go through wrapper because prototype is replaced at runtime.

No changes to app logic required.

### 6. Non-breaking safeguards

- Adapter only wraps keys listed in `KEYS`. All other localStorage untouched.
- `origSet`/`origGet` preserve original behavior.
- Debounce 800ms prevents write storms.
- Timestamp `_ts` per key prevents write loops.
- `visibilitychange`, `online`, `focus` pull handles offline-first.
- Realtime channel per device_id auto-merges.

### 7. Test checklist

1. Open HTML locally, open DevTools Console.
2. Expect `[sync] adapter ready { deviceId: '...' }`
3. Change a value in app UI, e.g., add gym set.
4. Network tab: POST to Supabase `local_sync` upsert after ~800ms debounce.
5. Open in incognito / different device, change value, verify Realtime push updates localStorage and UI via `lm_sync_update` event.
6. Offline test: go offline, make changes, go online → queue processes.

### 8. Deployment notes

- Deploy both `lifemaxxing-v1.html` and `sync-adapter-v3-prod.js` to same Netlify public folder.
- Relative path `sync-adapter-v3-prod.js` resolves correctly.
- Keep Supabase Realtime enabled on `local_sync` table.

### 9. Rollback

Comment out adapter script tag:
```html
<!-- <script src="sync-adapter-v3-prod.js"></script> -->
```
App reverts to localStorage only.

## Files Modified

- `C:\Users\relyn/life-maxxing-protocol/lifemaxxing-v1.html` → head script removal + body insertion
- `C:\Users\relyn/life-maxxing-protocol/sync-adapter-v3-prod.js` → config keys filled

No app logic changed.
