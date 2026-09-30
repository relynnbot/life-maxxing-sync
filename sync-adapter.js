// sync-adapter.js — minimal localStorage <-> Supabase bridge
// Drop this before the app's inline script. It transparently mirrors
// the 6 localStorage keys used by Life-Maxxing-Protocol to Supabase.
// No changes to lifemaxxing-v1.html logic required.

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

  // simple device identity
  let deviceId = localStorage.getItem('lm_device_id');
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem('lm_device_id', deviceId);
  }

  // Load Supabase client from CDN if not present
  const waitSupabase = () => new Promise(res => {
    if (window.supabase) return res(window.supabase);
    const iv = setInterval(() => { if (window.supabase) { clearInterval(iv); res(window.supabase); } }, 50);
  });

  const debounceMap = new Map();

  async function init() {
    const { createClient } = await waitSupabase();
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false }
    });

    // 1. Seed localStorage from Supabase on first load
    await Promise.all(KEYS.map(async k => {
      const local = localStorage.getItem(k);
      if (local) return; // prefer existing
      // try to fetch latest per key
      // For simplicity we store whole blob in a generic table `local_sync`
      const { data } = await supabase.from('local_sync')
        .select('value').eq('device_id', deviceId).eq('key', k).maybeSingle();
      if (data?.value) {
        try { localStorage.setItem(k, JSON.stringify(data.value)); } catch {}
      }
    }));

    // 2. Wrap localStorage.setItem
    const origSet = localStorage.setItem.bind(localStorage);
    localStorage.setItem = (key, value) => {
      origSet(key, value);
      if (!KEYS.includes(key)) return;
      // debounce writes
      if (debounceMap.has(key)) clearTimeout(debounceMap.get(key));
      debounceMap.set(key, setTimeout(async () => {
        try {
          const parsed = (() => { try { return JSON.parse(value); } catch { return value; } })();
          await supabase.from('local_sync').upsert({
            device_id: deviceId,
            key,
            value: parsed,
            updated_at: new Date().toISOString()
          }, { onConflict: 'device_id,key' });
        } catch (e) { console.warn('[sync] write error', key, e); }
      }, DEBOUNCE_MS));
    };

    // 3. Pull on visibility change / online
    const pull = async () => {
      const { data } = await supabase.from('local_sync')
        .select('key,value,updated_at').eq('device_id', deviceId);
      if (!data) return;
      data.forEach(row => {
        if (!KEYS.includes(row.key)) return;
        const localRaw = localStorage.getItem(row.key);
        const localTime = localStorage.getItem(row.key + '_ts');
        // naive merge: if remote newer, overwrite
        if (!localRaw) {
          origSet(row.key, JSON.stringify(row.value));
        }
      });
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); });
    window.addEventListener('online', pull);

    // 4. Realtime subscription
    try {
      const channel = supabase.channel('sync-' + deviceId)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'local_sync', filter: `device_id=eq.${deviceId}` },
          payload => {
            const k = payload.new?.key;
            if (!KEYS.includes(k)) return;
            const newVal = JSON.stringify(payload.new.value);
            if (localStorage.getItem(k) !== newVal) {
              origSet(k, newVal);
              window.dispatchEvent(new CustomEvent('lm_sync_update', { detail: { key: k }}));
            }
          })
        .subscribe();
    } catch {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
