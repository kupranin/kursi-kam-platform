import { rpc, supabase } from './supabase';
import type { StaffPerson } from './types';

/** A message sent to the signed-in person. */
export interface IncomingChat {
  id: number;
  sender_id: string;
  body: string;
  created_at: string;
}

type ReadMap = Record<string, number>;

const OPEN_EVENT = 'kursi-chat-open';
const READ_EVENT = 'kursi-chat-read';

let openPartner: string | null = null;

function storageKey(me: string): string {
  return 'kursi-chat-read:' + me;
}

export function readChatMarks(me: string): ReadMap {
  try {
    const raw = localStorage.getItem(storageKey(me));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ReadMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** The thread the person is looking at. Null when chat is closed or another view is open. */
export function openChatPartner(): string | null {
  return openPartner;
}

export function setOpenChatPartner(id: string | null): void {
  openPartner = id;
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function onChatOpen(listener: () => void): () => void {
  window.addEventListener(OPEN_EVENT, listener);
  return () => window.removeEventListener(OPEN_EVENT, listener);
}

export function onChatRead(listener: () => void): () => void {
  window.addEventListener(READ_EVENT, listener);
  return () => window.removeEventListener(READ_EVENT, listener);
}

/** Remember the latest message seen from this person. */
export function markChatRead(me: string, senderId: string, messageId: number): void {
  const marks = readChatMarks(me);
  if ((marks[senderId] ?? 0) >= messageId) return;
  marks[senderId] = messageId;
  localStorage.setItem(storageKey(me), JSON.stringify(marks));
  window.dispatchEvent(new Event(READ_EVENT));
}

export async function loadIncomingChats(me: string): Promise<IncomingChat[]> {
  const { data, error } = await supabase
    .from('staff_messages')
    .select('id, sender_id, body, created_at')
    .eq('recipient_id', me)
    .order('id', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as IncomingChat[];
}

export async function loadChatNames(): Promise<Map<string, string>> {
  const directory = await rpc<StaffPerson[]>('staff_directory');
  return new Map((directory ?? []).map((person) => [person.id, person.full_name]));
}
