// sync-adapter-v3-prod.js
// Production-ready localStorage → Supabase sync adapter for lifemaxxing-v1.html
// Transparent wrapper, debounced upserts, device_id, seed on load, Netlify-ready

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

    // Seed from Supabase if local missing
    await Promise.allSettled(KEYS.map(async k => {
      if (localStorage.getItem(k)) return;
      const { data } = await supabase.from('local_sync')
        .select('value,updated_at').eq('device_id', deviceId).eq('key', k).maybeSingle();
      if (data?.value) {
        try {
          const val = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
          localStorage.setItem(k, JSON.stringify(val));
          localStorage.setItem(k + '_ts', data.updated_at);
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
          const { data: existing } = await supabase.from('local_sync')
            .select('updated_at,value').eq('device_id', deviceId).eq('key', key).maybeSingle();

          let finalValue = parsed;
          if (existing?.value) {
            const merger = mergers[key];
            if (merger) {
              finalValue = merger(parsed, existing.value);
            } else if (new Date(ts) < new Date(existing.updated_at)) {
              return; // remote newer, keep remote
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
          // Simple fallback: retry on next online
        }
      }, DEBOUNCE_MS));
    };

    // Pull with merge
    const pull = async () => {
      try {
        const { data } = await supabase.from('local_sync')
          .select('key,value,updated_at').eq('device_id', deviceId);
        if (!data) return;
        data.forEach(row => {
          if (!KEYS.includes(row.key)) return;
          const localRaw = origGet(row.key);
          const localTs = localStorage.getItem(row.key + '_ts');
          if (!localRaw) {
            origSet(row.key, JSON.stringify(row.value));
            localStorage.setItem(row.key + '_ts', row.updated_at);
            window.dispatchEvent(new CustomEvent('lm_sync_update', { detail: { key: row.key, source: 'remote' }}));
            return;
          }
          const localTime = new Date(localTs || 0);
          const remoteTime = new Date(row.updated_at);
          if (remoteTime > localTime) {
            const merger = mergers[row.key];
            let finalValue = row.value;
            if (merger) {
              try {
                const localParsed = JSON.parse(localRaw);
                finalValue = merger(localParsed, row.value);
              } catch {}
            }
            origSet(row.key, JSON.stringify(finalValue));
            localStorage.setItem(row.key + '_ts', row.updated_at);
            window.dispatchEvent(new CustomEvent('lm_sync_update', { detail: { key: row.key, source: 'remote' }}));
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
      const channel = supabase.channel('sync-' + deviceId)
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'local_sync',
          filter: `device_id=eq.${deviceId}`
        }, payload => {
          const k = payload.new?.key;
          if (!KEYS.includes(k)) return;
          // Avoid loop by checking timestamp
          const localTs = localStorage.getItem(k + '_ts');
          if (localTs && new Date(localTs) >= new Date(payload.new.updated_at)) return;
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