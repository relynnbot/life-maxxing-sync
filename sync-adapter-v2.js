// sync-adapter-v2.js — offline-first with IndexedDB queue + conflict resolution
// Drop before app script. Wraps localStorage for 6 keys, syncs to Supabase with LWW + domain merges.

(() => {
  const SUPABASE_URL = 'https://<PROJECT>.supabase.co';
  const SUPABASE_ANON_KEY = '<ANON_KEY>';
  const DEBOUNCE_MS = 600;
  
  const KEYS = [
    'lm_gym_plan',
    'lm_gym_history',
    'lm_health_diet_log',
    'lm_health_wellness_log',
    'lm_career_history',
    'lm_career_history_by_date'
  ];
  
  const DOMAIN = {
    'lm_gym_plan': 'gym',
    'lm_gym_history': 'gym',
    'lm_health_diet_log': 'health',
    'lm_health_wellness_log': 'health',
    'lm_career_history': 'career',
    'lm_career_history_by_date': 'career'
  };
  
  let deviceId = localStorage.getItem('lm_device_id');
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem('lm_device_id', deviceId);
  }
  
  // IndexedDB for offline queue
  const DB_NAME = 'lm_sync_v1';
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
    req.onerror = rej;
  });
  
  const enqueue = (op) => {
    if (!db) return;
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add({
      ...op,
      deviceId,
      queuedAt: Date.now(),
      retry: 0
    });
  };
  
  const waitSupabase = () => new Promise(res => {
    if (window.supabase) return res(window.supabase);
    const iv = setInterval(() => { if (window.supabase) { clearInterval(iv); res(window.supabase); } }, 50);
  });
  
  const debounceMap = new Map();
  const localTimestamps = new Map();
  
  // Domain-specific merge functions
  const mergeGymHistory = (local, remote) => {
    const map = new Map();
    [...(local||[]), ...(remote||[])].forEach(e => {
      const key = e.id || e.date + '|' + e.dayId;
      const existing = map.get(key);
      if (!existing || (e.updated_at||0) > (existing.updated_at||0)) map.set(key, e);
    });
    return Array.from(map.values());
  };
  
  const mergeHealthLog = (local, remote) => {
    const out = {...(local||{})};
    Object.entries(remote||{}).forEach(([date, data]) => {
      if (!out[date]) { out[date] = data; return; }
      // deep merge meals/supplements
      out[date] = {
        meals: {...(out[date].meals||{}), ...(data.meals||{})},
        supplements: {...(out[date].supplements||{}), ...(data.supplements||{})}
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
        if (!existing || (t.updated_at||0) > (existing.updated_at||0)) {
          localTasks.set(t.id, t);
        }
      });
      out[date] = { tasks: Array.from(localTasks.values()) };
    });
    return out;
  };
  
  const mergers = {
    'lm_gym_history': mergeGymHistory,
    'lm_health_diet_log': mergeHealthLog,
    'lm_health_wellness_log': mergeHealthLog,
    'lm_career_history_by_date': mergeCareerByDate,
  };
  
  async function init() {
    await openDB();
    const { createClient } = await waitSupabase();
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false }});
    
    // Seed from remote if local empty
    await Promise.all(KEYS.map(async k => {
      if (localStorage.getItem(k)) return;
      const { data } = await supabase.from('local_sync')
        .select('value,updated_at').eq('device_id', deviceId).eq('key', k).maybeSingle();
      if (data?.value) {
        localStorage.setItem(k, JSON.stringify(data.value));
        localTimestamps.set(k, data.updated_at);
      }
    }));
    
    const origSet = localStorage.setItem.bind(localStorage);
    const origGet = localStorage.getItem.bind(localStorage);
    
    // Wrap setItem
    localStorage.setItem = (key, value) => {
      origSet(key, value);
      if (!KEYS.includes(key)) return;
      
      const ts = Date.now().toISOString();
      localTimestamps.set(key, ts);
      localStorage.setItem(key + '_ts', ts);
      
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
              // remote newer, skip push
              return;
            }
          }
          
          await supabase.from('local_sync').upsert({
            device_id: deviceId,
            key,
            value: finalValue,
            updated_at: ts,
            version: (existing?.updated_at ? 1 : 0) + 1
          }, { onConflict: 'device_id,key' });
          
          // clear queue on success
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).delete(key);
        } catch (e) {
          // offline: enqueue
          enqueue({key, value: JSON.stringify(parsed), op: 'set', ts});
          console.warn('[sync] queued', key, e);
        }
      }, DEBOUNCE_MS));
    };
    
    // Pull with merge
    const pull = async () => {
      const { data } = await supabase.from('local_sync')
        .select('key,value,updated_at').eq('device_id', deviceId);
      if (!data) return;
      
      data.forEach(row => {
        if (!KEYS.includes(row.key)) return;
        const localRaw = origGet(row.key);
        const localTs = localStorage.getItem(row.key + '_ts');
        
        let shouldUpdate = false;
        let finalValue = row.value;
        
        if (!localRaw) {
          shouldUpdate = true;
        } else {
          const localTime = new Date(localTs || 0);
          const remoteTime = new Date(row.updated_at);
          if (remoteTime > localTime) {
            const merger = mergers[row.key];
            if (merger) {
              try {
                const localParsed = JSON.parse(localRaw);
                finalValue = merger(localParsed, row.value);
                shouldUpdate = true;
              } catch {}
            } else {
              shouldUpdate = true;
            }
          }
        }
        
        if (shouldUpdate) {
          origSet(row.key, JSON.stringify(finalValue));
          localStorage.setItem(row.key + '_ts', row.updated_at);
          window.dispatchEvent(new CustomEvent('lm_sync_update', { detail: { key: row.key, source: 'remote' }}));
        }
      });
    };
    
    // Process offline queue
    const processQueue = async () => {
      if (!navigator.onLine) return;
      const tx = db.transaction(STORE, 'readonly');
      const all = await new Promise(res => {
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => res(req.result);
      });
      for (const item of all) {
        try {
          await supabase.from('local_sync').upsert({
            device_id: deviceId,
            key: item.key,
            value: JSON.parse(item.value),
            updated_at: item.ts
          }, { onConflict: 'device_id,key' });
          // delete on success
          db.transaction(STORE, 'readwrite').objectStore(STORE).delete(item.id);
        } catch {}
      }
    };
    
    // Events
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { pull(); processQueue(); }});
    window.addEventListener('online', () => { pull(); processQueue(); });
    window.addEventListener('focus', pull);
    
    // Realtime
    try {
      supabase.channel('sync-'+deviceId)
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'local_sync',
          filter: `device_id=eq.${deviceId}`
        }, payload => {
          const k = payload.new?.key;
          if (!KEYS.includes(k)) return;
          // avoid echo
          if (navigator.onLine) {
            pull();
          }
        })
        .subscribe();
    } catch {}
    
    // Sync status indicator
    const status = () => {
      if (!navigator.onLine) {
        console.info('[sync] offline');
        return;
      }
      console.info('[sync] online');
    };
    window.addEventListener('online', status);
    window.addEventListener('offline', status);
    status();
  }
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
