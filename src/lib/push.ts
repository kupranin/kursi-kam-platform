import { supabase } from './supabase';
import type { Lang } from './lang';

export type PushUi =
  | { kind: 'hidden' }
  | { kind: 'ios' }
  | { kind: 'unconfigured' }
  | { kind: 'denied' }
  | { kind: 'on' }
  | { kind: 'off' };

function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
}

export function vapidPublicKey(): string {
  return (import.meta.env.VITE_VAPID_PUBLIC_KEY ?? '').trim();
}

function pushSupport(): 'hidden' | 'ios' | 'ready' {
  const ua = navigator.userAgent;
  const appleMobile = /iPhone|iPod|iPad/.test(ua);
  const standalone = isStandalone();
  if (appleMobile && !standalone) return 'ios';
  const hasPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!hasPush) {
    // iPadOS uses a desktop user agent. Push is missing until the site is on the Home Screen.
    const ipad = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    if (ipad && !standalone) return 'ios';
    return 'hidden';
  }
  return 'ready';
}

function vapidBytes(publicKey: string): Uint8Array {
  const padding = '='.repeat((4 - (publicKey.length % 4)) % 4);
  const base64 = (publicKey + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function ensurePushWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    return reg;
  } catch {
    return null;
  }
}

export function listenForPushOpen(): () => void {
  if (!('serviceWorker' in navigator)) return () => {};
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; path?: string } | null;
    if (!data || data.type !== 'kursi-push-open' || typeof data.path !== 'string') return;
    if (!data.path.startsWith('/') || data.path.startsWith('//')) return;
    if (window.location.pathname + window.location.search === data.path) return;
    window.location.assign(data.path);
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  return () => navigator.serviceWorker.removeEventListener('message', onMessage);
}

export async function readPushState(): Promise<PushUi> {
  const support = pushSupport();
  if (support === 'hidden') return { kind: 'hidden' };
  if (support === 'ios') return { kind: 'ios' };
  if (!vapidPublicKey()) return { kind: 'unconfigured' };
  if (Notification.permission === 'denied') return { kind: 'denied' };
  const reg = await ensurePushWorker();
  const sub = await reg?.pushManager.getSubscription();
  if (sub && Notification.permission === 'granted') return { kind: 'on' };
  return { kind: 'off' };
}

export async function enablePush(lang: Lang): Promise<'on' | 'denied'> {
  const key = vapidPublicKey();
  if (!key) throw new Error('unconfigured');
  // Ask in the same click that subscribes. iOS ignores a prompt that waits first.
  const permissionPromise = Notification.requestPermission();
  const regPromise = ensurePushWorker();
  const permission = await permissionPromise;
  if (permission !== 'granted') return 'denied';
  const reg = await regPromise;
  if (!reg) throw new Error('failed');
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidBytes(key) as BufferSource,
  });
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('failed');
  const { error } = await supabase.rpc('save_push_subscription', {
    p_endpoint: json.endpoint,
    p_p256dh: json.keys.p256dh,
    p_auth: json.keys.auth,
    p_user_agent: navigator.userAgent.slice(0, 400),
    p_lang: lang,
  });
  if (error) throw new Error(error.message);
  return 'on';
}

export async function disablePush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
  if (error) throw new Error(error.message);
  await sub.unsubscribe();
}

export async function syncPushLang(lang: Lang): Promise<void> {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    const reg = await ensurePushWorker();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub || Notification.permission !== 'granted') return;
    await supabase.from('push_subscriptions').update({
      lang,
      updated_at: new Date().toISOString(),
    }).eq('endpoint', sub.endpoint);
  } catch {
    /* the next language change tries again */
  }
}
