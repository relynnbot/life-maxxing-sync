// sync-adapter-v3-prod.js
// Production-ready localStorage → Supabase sync adapter for lifemaxxing-v1.html
// Transparent wrapper, debounced upserts, device_id, seed on load, Netlify-ready
// v2: Multi-device merge — syncs across ALL devices, merges keys: lm_gym_plan, lm_gym_history, lm_health_diet_log, lm_health_wellness_log, lm_career_history, lm_career_history_by_date

(() => {
  // --- CONFIG (set from HTML env vars or replace here) ---
  const SUPABASE_URL = 'https://kkuolrxmytynsxemxixm.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtrdW9scnhteXR5bnN4ZW14aXhtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3ODA5NDYsImV4cCI6MjEwNjM1Njk0Nn0.SNvRKagIH7Hapv-Mi5Eeuxiay99U3JR5qMk3bgViC5Q';
  const DEBOUNCE_MS = 800;

  const KEYS = [
    'lm_gym_plan',
    'lm_gym_history',
    'lm_health_diet_log',
    'lm_health_wellness_log',
    'lm_career_history',
    'lm_career_history_by_date'
  ];

  // Device identity — stable per browser
  let deviceId = localStorage.getItem('lm_device_id');
  if (!deviceId) {
    deviceId = (typeof crypto !== 'undefined' && crypto.randomUUID) 
      ? crypto.randomUUID() 
      : 'd-' + Math.random().toString(36).slice(2);
    localStorage.setItem('lm_device_id', deviceId);
  }

  // Lightweight offline queue via IndexedDB
  const DB_NAME = 'lm_sync_v3';
  const STORE = 'queue';
  let db;
  const openDB = () => new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) {
        d.createObjectStore(STORE, {keyPath: 'id', autoIncrement: true});
      }
    };
    req.onsuccess = () => { db = req.result; res(); };
    req.onerror = () => rej(req.error);
  });

  const waitSupabase = () => new Promise(res => {
    if (window.supabase) return res(window.supabase);
    const iv = setInterval(() => { 
      if (window.supabase) { clearInterval(iv); res(window.supabase); } 
    }, 50);
  });

  const debounceMap = new Map();
  const localTimestamps = new Map();

  // Domain merge helpers (LWW + structural merges)
  const mergeGymHistory = (local, remote) => {
    const map = new Map();
    const all = Array.isArray(local) ? local : [];
    const rem = Array.isArray(remote) ? remote : [];
    [...all, ...rem].forEach(e => {
      const key = e.id || `${e.date}|${e.dayId}`;
      const existing = map.get(key);
      if (!existing || (e.updated_at||0) >= (existing.updated_at||0)) map.set(key, e);
    });
    return Array.from(map.values());
  };

  const mergeLogByDate = (local, remote) => {
    const out = {...(local||{})};
    Object.entries(remote||{}).forEach(([date, data]) => {
      if (!out[date]) { out[date] = data; return; }
      out[date] = {
        meals: {...(out[date].meals||{}), ...(data.meals||{})},
        supplements: {...(out[date].supplements||{}), ...(data.supplements||{})},
        notes: out[date].notes || data.notes
      };
    });
    return out;
  };

  const mergeCareerByDate = (local, remote) => {
    const out = {...(local||{})};
    Object.entries(remote||{}).forEach(([date, data]) => {
      if (!out[date]) { out[date] = data; return; }
      const localTasks = new Map((out[date].tasks||[]).map(t => [t.id, t]));
      (data.tasks||[]).forEach(t => {
        const existing = localTasks.get(t.id);
        if (!existing || (t.updated_at||0) > (existing.updated_at||0)) localTasks.set(t.id, t);
      });
      out[date] = { tasks: Array.from(localTasks.values()) };
    });
    return out;
  };

  const mergers = {
    'lm_gym_history': mergeGymHistory,
    'lm_health_diet_log': mergeLogByDate,
    'lm_health_wellness_log': mergeLogByDate,
    'lm_career_history_by_date': mergeCareerByDate,
  };

  async function init() {
    await openDB();
    const { createClient } = await waitSupabase();
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });

    // Seed from Supabase if local missing - merge from ALL devices
    await Promise.allSettled(KEYS.map(async k => {
      if (localStorage.getItem(k)) {
        // Merge existing local with all devices on first load
        const { data } = await supabase.from('local_sync')
          .select('value,updated_at')
          .eq('key', k);
        if (data && data.length > 0) {
          try {
            const localParsed = JSON.parse(localStorage.getItem(k) || 'null');
            let merged = localParsed;
            let latestTs = localStorage.getItem(k + '_ts') || '1970-01-01';
            data.forEach(row => {
              const merger = mergers[k];
              if (merger && merged) {
                const remoteVal = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
                merged = merger(merged, remoteVal);
              } else {
                const remoteVal = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
                if (!merged || new Date(row.updated_at) > new Date(latestTs)) {
                  merged = remoteVal;
                  latestTs = row.updated_at;
                }
              }
              if (new Date(row.updated_at) > new Date(latestTs)) {
                latestTs = row.updated_at;
              }
            });
            localStorage.setItem(k, JSON.stringify(merged));
            localStorage.setItem(k + '_ts', latestTs);
          } catch {}
        }
        return;
      }
      const { data } = await supabase.from('local_sync')
        .select('value,updated_at,key').eq('key', k);
      if (data && data.length > 0) {
        try {
          let merged;
          let latestTs = '1970-01-01';
          data.forEach(row => {
            const merger = mergers[k];
            const remoteVal = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
            if (!merged) {
              merged = remoteVal;
            } else if (merger) {
              merged = merger(merged, remoteVal);
            } else if (new Date(row.updated_at) > new Date(latestTs)) {
              merged = remoteVal;
            }
            if (new Date(row.updated_at) > new Date(latestTs)) {
              latestTs = row.updated_at;
            }
          });
          localStorage.setItem(k, JSON.stringify(merged));
          localStorage.setItem(k + '_ts', latestTs);
        } catch {}
      }
    }));

    const origSet = localStorage.setItem.bind(localStorage);
    const origGet = localStorage.getItem.bind(localStorage);

    // Wrap setItem
    localStorage.setItem = (key, value) => {
      origSet(key, value);
      if (!KEYS.includes(key)) return;
      const ts = new Date().toISOString();
      localStorage.setItem(key + '_ts', ts);
      localTimestamps.set(key, ts);

      if (debounceMap.has(key)) clearTimeout(debounceMap.get(key));
      debounceMap.set(key, setTimeout(async () => {
        try {
          const parsed = (() => { try { return JSON.parse(value); } catch { return value; } })();
          
          // Fetch all devices for this key to merge before upsert
          const { data: allRows } = await supabase.from('local_sync')
            .select('device_id,updated_at,value').eq('key', key);
          
          let finalValue = parsed;
          if (allRows && allRows.length > 0) {
            // Merge with all devices except current
            const merger = mergers[key];
            if (merger) {
              let merged = parsed;
              allRows.forEach(row => {
                if (row.device_id === deviceId) return; // skip own row
                const remoteVal = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
                merged = merger(merged, remoteVal);
              });
              finalValue = merged;
            } else {
              // Find latest remote
              const latest = allRows.reduce((latest, row) => {
                if (row.device_id === deviceId) return latest;
                if (!latest || new Date(row.updated_at) > new Date(latest.updated_at)) {
                  return row;
                }
                return latest;
              }, null);
              if (latest && new Date(ts) < new Date(latest.updated_at)) {
                // Remote newer, merge or keep remote
                const remoteVal = typeof latest.value === 'string' ? JSON.parse(latest.value) : latest.value;
                finalValue = remoteVal;
                return; // keep remote, don't overwrite
              }
            }
          }

          await supabase.from('local_sync').upsert({
            device_id: deviceId,
            key,
            value: finalValue,
            updated_at: ts
          }, { onConflict: 'device_id,key' });
        } catch (e) {
          console.warn('[sync] offline queue', key, e);
        }
      }, DEBOUNCE_MS));
    };

    // Pull with merge
    const pull = async () => {
      try {
        // Fetch data from ALL devices, not just this device_id
        const { data: allRows } = await supabase.from('local_sync')
          .select('key,value,updated_at,device_id');
        if (!allRows) return;
        
        // Group by key
        const byKey = {};
        allRows.forEach(row => {
          if (!KEYS.includes(row.key)) return;
          if (!byKey[row.key]) byKey[row.key] = [];
          byKey[row.key].push(row);
        });
        
        Object.entries(byKey).forEach(([key, rows]) => {
          if (rows.length === 0) return;
          const localRaw = origGet(key);
          const localTs = localStorage.getItem(key + '_ts');
          const localTime = new Date(localTs || 0);
          
          // Merge all devices for this key
          const merger = mergers[key];
          let mergedValue;
          let latestTs = localTime;
          
          rows.forEach(row => {
            const remoteVal = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
            const remoteTime = new Date(row.updated_at);
            
            if (!mergedValue) {
              mergedValue = remoteVal;
            } else if (merger) {
              mergedValue = merger(mergedValue, remoteVal);
            } else if (remoteTime > latestTs) {
              mergedValue = remoteVal;
              latestTs = remoteTime;
            }
            
            if (remoteTime > latestTs) {
              latestTs = remoteTime;
            }
          });
          
          // Merge with local if exists
          if (localRaw) {
            try {
              const localParsed = JSON.parse(localRaw);
              if (merger) {
                mergedValue = merger(localParsed, mergedValue);
              } else if (localTime > latestTs) {
                mergedValue = localParsed;
                latestTs = localTime;
              }
            } catch {}
          }
          
          if (!localRaw || latestTs > localTime) {
            origSet(key, JSON.stringify(mergedValue));
            localStorage.setItem(key + '_ts', latestTs.toISOString());
            window.dispatchEvent(new CustomEvent('lm_sync_update', { detail: { key, source: 'remote' }}));
          }
        });
      } catch (e) { console.warn('[sync] pull error', e); }
    };

    // Process simple online events
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); });
    window.addEventListener('online', pull);
    window.addEventListener('focus', pull);

    // Realtime updates
    try {
      // Listen to ALL changes, not just this device
      const channel = supabase.channel('sync-all-devices')
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'local_sync'
        }, payload => {
          const k = payload.new?.key;
          if (!KEYS.includes(k)) return;
          // Always pull when any device changes
          pull();
        })
        .subscribe();
    } catch (e) { console.warn('[sync] realtime not available', e); }

    console.info('[sync] adapter ready', { deviceId });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();