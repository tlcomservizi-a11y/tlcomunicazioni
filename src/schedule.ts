// Orari di apertura, slot liberi e appuntamenti. Tutte le ore sono locali (Europe/Rome),
// salvate come 'YYYY-MM-DDTHH:MM'.
import { all, one, run, type Business } from "./db.js";

export const TZ = "Europe/Rome";
export const DAYS = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"] as const;
const DAY_NAMES = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];

/** Data/ora attuale a Roma come 'YYYY-MM-DDTHH:MM'. */
export function nowLocal(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

export function describeNow(): string {
  const n = nowLocal();
  return `${DAY_NAMES[dayIndex(n.slice(0, 10))]} ${n.slice(0, 10)}, ore ${n.slice(11)} (ora italiana)`;
}

function dayIndex(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export function dayName(date: string): string {
  return DAY_NAMES[dayIndex(date)];
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const toHHMM = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

export type Hours = Partial<Record<(typeof DAYS)[number], string>>;

export function parseHours(b: Business): Hours {
  try {
    return JSON.parse(b.hours || "{}");
  } catch {
    return {};
  }
}

/** "09:00-13:00, 15:00-19:00" -> [[540,780],[900,1140]] */
function ranges(spec: string | undefined): [number, number][] {
  if (!spec) return [];
  return spec
    .split(",")
    .map((r) => r.trim().match(/^(\d{1,2}[:.]\d{2})\s*-\s*(\d{1,2}[:.]\d{2})$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => [toMin(m[1].replace(".", ":")), toMin(m[2].replace(".", ":"))] as [number, number])
    .filter(([a, b]) => b > a);
}

export function hoursText(b: Business): string {
  const h = parseHours(b);
  const order = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"] as const;
  const lines = order.map((d) => `${d}: ${h[d]?.trim() || "chiuso"}`);
  return lines.join("\n");
}

function busyIntervals(businessId: number, date: string): [number, number][] {
  return all<{ starts_at: string; duration_minutes: number }>(
    `SELECT starts_at, duration_minutes FROM appointments
     WHERE business_id = ? AND status = 'confermato' AND substr(starts_at, 1, 10) = ?`,
    businessId,
    date,
  ).map((a) => {
    const s = toMin(a.starts_at.slice(11, 16));
    return [s, s + a.duration_minutes];
  });
}

/** Slot liberi a partire da una data per N giorni. */
export function freeSlots(b: Business, fromDate: string | undefined, days = 5, max = 24) {
  const now = nowLocal();
  const start = fromDate && fromDate >= now.slice(0, 10) ? fromDate : now.slice(0, 10);
  const hours = parseHours(b);
  const out: { date: string; day: string; times: string[] }[] = [];
  let count = 0;
  for (let i = 0; i < Math.min(days, 21) && count < max; i++) {
    const date = addDays(start, i);
    const spec = hours[DAYS[dayIndex(date)]];
    const busy = busyIntervals(b.id, date);
    const times: string[] = [];
    for (const [open, close] of ranges(spec)) {
      for (let t = open; t + b.slot_minutes <= close; t += b.slot_minutes) {
        const slot = `${date}T${toHHMM(t)}`;
        if (slot <= now) continue;
        if (busy.some(([s, e]) => t < e && t + b.slot_minutes > s)) continue;
        times.push(toHHMM(t));
      }
    }
    if (times.length) {
      const take = times.slice(0, max - count);
      out.push({ date, day: dayName(date), times: take });
      count += take.length;
    }
  }
  return out;
}

/** Verifica che lo slot sia dentro l'orario, nel futuro e libero. Ritorna un errore leggibile o null. */
export function checkSlot(b: Business, startsAt: string, duration = b.slot_minutes): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(startsAt)) return "Formato data non valido: usa YYYY-MM-DDTHH:MM";
  if (startsAt <= nowLocal()) return "L'orario richiesto è già passato";
  const date = startsAt.slice(0, 10);
  const t = toMin(startsAt.slice(11));
  const open = ranges(parseHours(b)[DAYS[dayIndex(date)]]);
  if (!open.some(([a, c]) => t >= a && t + duration <= c)) return `L'attività è chiusa in quell'orario (${dayName(date)})`;
  if (busyIntervals(b.id, date).some(([s, e]) => t < e && t + duration > s)) return "Quell'orario è già occupato";
  return null;
}

export function bookAppointment(
  b: Business,
  opts: { contactId: number | null; startsAt: string; service: string; notes?: string; createdBy: string; force?: boolean },
): { ok: true; id: number } | { ok: false; error: string } {
  if (!opts.force) {
    const err = checkSlot(b, opts.startsAt);
    if (err) return { ok: false, error: err };
  }
  const r = run(
    `INSERT INTO appointments (business_id, contact_id, starts_at, duration_minutes, service, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    b.id,
    opts.contactId,
    opts.startsAt,
    b.slot_minutes,
    opts.service,
    opts.notes ?? "",
    opts.createdBy,
  );
  return { ok: true, id: Number(r.lastInsertRowid) };
}

export function upcomingForContact(businessId: number, contactId: number) {
  return all(
    `SELECT id, starts_at, service, status FROM appointments
     WHERE business_id = ? AND contact_id = ? AND status = 'confermato' AND starts_at >= ? ORDER BY starts_at`,
    businessId,
    contactId,
    nowLocal(),
  );
}

export function cancelAppointment(businessId: number, id: number, contactId?: number): boolean {
  const appt = one("SELECT * FROM appointments WHERE id = ? AND business_id = ?", id, businessId);
  if (!appt || (contactId !== undefined && appt.contact_id !== contactId)) return false;
  run("UPDATE appointments SET status = 'annullato' WHERE id = ?", id);
  return true;
}
