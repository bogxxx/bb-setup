// Snooze times: the presets, the free-form parser, and how a moment reads.
// Every function takes the current moment `ref` in epoch milliseconds and
// works in the local time zone of the device it runs on.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The local day `days` after the day of `ms`, at hour:min. */
function at(ms: number, days: number, hour: number, min = 0): number {
  const d = new Date(ms);
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + days,
    hour,
    min,
  ).getTime();
}
const sameDay = (a: number, b: number) => at(a, 0, 0) === at(b, 0, 0);
const minuteOf = (ms: number) => Math.floor(ms / MINUTE) * MINUTE;
/** Days from the day of `ref` to the next `dow`, never 0. */
const daysUntil = (dow: number, ref: number) =>
  (dow - new Date(ref).getDay() + 7) % 7 || 7;

// ---------- Formatting ----------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${d.getHours() < 12 ? "AM" : "PM"}`;
}

function fmtDate(ms: number, ref: number): string {
  const d = new Date(ms);
  const year =
    d.getFullYear() === new Date(ref).getFullYear()
      ? ""
      : `, ${d.getFullYear()}`;
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}${year}`;
}

/** A row's time: "Today, 5:30 PM" or "Sun, Sep 27, 9:00 AM". */
export function fmtWhen(ms: number, ref: number): string {
  return sameDay(ms, ref)
    ? `Today, ${fmtTime(ms)}`
    : `${fmtDate(ms, ref)}, ${fmtTime(ms)}`;
}

/** After "Snoozed until": "today at 5:30 PM", "tomorrow at 9:00 AM", "Mon, Sep 28 at 9:00 AM". */
/** Snooze Old Threads' wake time: no time wakes it, only the thread itself. */
const NEEDED = Date.UTC(2100, 0, 1);

export function fmtUntil(ms: number, ref: number): string {
  if (ms >= NEEDED) return "it needs you";
  const day = sameDay(ms, ref)
    ? "today"
    : sameDay(ms, at(ref, 1, 0))
      ? "tomorrow"
      : fmtDate(ms, ref);
  return `${day} at ${fmtTime(ms)}`;
}

// ---------- Presets ----------

export type PresetId = "later" | "tomorrow" | "nextweek";

export interface Preset {
  id: PresetId;
  title: string;
  until: number;
}

// Later today lands on fixed times of day, like This Afternoon and This
// Evening in Apple Reminders, so threads snoozed around the same time come
// back together: the first of 9:00, 15:00 and 18:00 at least an hour away,
// none after 17:00. When two presets land on the same moment, the first stays.
const MORNING = 9;
const SLOTS = [MORNING, 15, 18];

export function presets(ref: number): Preset[] {
  const list: Preset[] = [];
  const later = SLOTS.map((h) => at(ref, 0, h)).find(
    (ms) => ms - minuteOf(ref) >= HOUR,
  );
  if (later) list.push({ id: "later", title: "Later today", until: later });
  list.push({ id: "tomorrow", title: "Tomorrow", until: at(ref, 1, MORNING) });
  list.push({
    id: "nextweek",
    title: "Next week",
    until: at(ref, daysUntil(1, ref), MORNING),
  });
  const seen = new Set<number>();
  return list.filter((p) => !seen.has(p.until) && seen.add(p.until));
}

// ---------- Parser ----------

const WEEKDAY =
  "(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)";
const MONTH =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const UNIT =
  "(months?|mos?|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w)";
const COUNT: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};
const NAMED: [string, number][] = [
  ["noon|midday", 12],
  ["midnight", 0],
  ["morning", MORNING],
  ["afternoon", 15],
  ["evening", 18],
  ["night", 20],
  ["eod|end of day", 17],
];
const FILLERS = new Set([
  "at",
  "on",
  "in",
  "until",
  "till",
  "til",
  "by",
  "the",
  "of",
  "this",
  "for",
  "and",
]);
const dayIndex = (w: string) =>
  ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(w.slice(0, 3));
const monthIndex = (w: string) =>
  [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ].indexOf(w.slice(0, 3));
/** A number without am/pm: 1–6 is afternoon, 7–11 morning, 12 noon, 0 and 13–23 as on a 24-hour clock. */
const bareHour = (h: number) => (h >= 1 && h <= 6 ? h + 12 : h);

interface ParsedDay {
  y: number;
  mo: number;
  d: number;
  /** Moves a past moment forward by a day, a week or a year. */
  roll: "day" | "week" | "year" | null;
  time: { h: number; mi: number } | null;
}

/** Free-form text ("8 am", "3 days", "fri 3pm", "aug 7") to a moment after `ref`, or null. */
export function parse(text: string, ref: number): number | null {
  let s = ` ${text.toLowerCase().replace(/,/g, " ").trim().replace(/\.$/, "").replace(/\s+/g, " ")} `;
  if (!s.trim()) return null;
  const take = (body: string) => {
    const m = new RegExp(` ${body}(?= )`).exec(s);
    if (m) s = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`;
    return m;
  };
  const today = new Date(ref);
  // Set from the closures below; `as` keeps TypeScript from narrowing them to null.
  let day = null as ParsedDay | null;
  let time = null as { h: number; mi: number } | null;
  let minutes = 0;
  let days = 0;
  let months = 0;
  let todayOnly = false;
  let bad = false;
  const setDay = (
    y: number,
    mo: number,
    d: number,
    roll: ParsedDay["roll"] = null,
    dayTime: ParsedDay["time"] = null,
  ) => {
    if (day || new Date(y, mo, d).getDate() !== d) bad = true;
    else day = { y, mo, d, roll, time: dayTime };
  };
  const setDayAt = (
    ms: number,
    roll: ParsedDay["roll"] = null,
    dayTime: ParsedDay["time"] = null,
  ) => {
    const d = new Date(ms);
    setDay(d.getFullYear(), d.getMonth(), d.getDate(), roll, dayTime);
  };
  const setTime = (h: number, mi: number) => {
    if (time || h > 23 || mi > 59) bad = true;
    else time = { h, mi };
  };
  const addDuration = (n: number, unit: string) => {
    if (/^(h|m(?!o))/.test(unit)) minutes += unit[0] === "h" ? n * 60 : n;
    else if (!Number.isInteger(n)) bad = true;
    else if (unit.startsWith("mo")) months += n;
    else days += unit[0] === "w" ? n * 7 : n;
  };
  let m: RegExpExecArray | null;

  // Dates
  if ((m = take("(\\d{4})-(\\d{1,2})-(\\d{1,2})"))) {
    if (+m[2] < 1 || +m[2] > 12) bad = true;
    else setDay(+m[1], +m[2] - 1, +m[3]);
  }
  if ((m = take(`${MONTH} (\\d{1,2})(?:st|nd|rd|th)?(?: (\\d{4}))?`))) {
    setDay(
      m[3] ? +m[3] : today.getFullYear(),
      monthIndex(m[1]),
      +m[2],
      m[3] ? null : "year",
    );
  } else if (
    (m = take(`(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${MONTH}(?: (\\d{4}))?`))
  ) {
    setDay(
      m[3] ? +m[3] : today.getFullYear(),
      monthIndex(m[2]),
      +m[1],
      m[3] ? null : "year",
    );
  }
  // Times
  if (
    (m =
      take("(\\d{1,2})(?::(\\d{2}))? ?([ap])\\.?m\\.?") ||
      take("(\\d{1,2})(?::(\\d{2}))?([ap])"))
  ) {
    if (+m[1] < 1 || +m[1] > 12) bad = true;
    else setTime((+m[1] % 12) + (m[3] === "p" ? 12 : 0), +(m[2] || 0));
  }
  if ((m = take("(\\d{1,2}):(\\d{2})"))) setTime(bareHour(+m[1]), +m[2]);
  // Durations
  if (take("half (?:an )?hour")) addDuration(30, "m");
  while ((m = take(`(\\d+(?:\\.\\d+)?) ?${UNIT}`))) addDuration(+m[1], m[2]);
  while (
    (m = take(
      "(an?|one|two|three|four|five|six|seven|eight|nine|ten) (months?|minutes?|mins?|hours?|hrs?|days?|weeks?)",
    ))
  )
    addDuration(COUNT[m[1]], m[2]);
  // Day words
  if (take("next week")) setDayAt(at(ref, daysUntil(1, ref), 0));
  else if (take("next month"))
    setDay(today.getFullYear(), today.getMonth() + 1, 1);
  else if (take("(?:(?:next|this) )?weekend"))
    setDayAt(at(ref, daysUntil(6, ref), 0));
  if ((m = take(`next ${WEEKDAY}`)))
    setDayAt(
      at(ref, daysUntil(1, ref) + ((dayIndex(m[1]) + 6) % 7), 0),
      "week",
    );
  else if ((m = take(WEEKDAY)))
    setDayAt(at(ref, daysUntil(dayIndex(m[1]), ref), 0), "week");
  if (take("today")) {
    setDayAt(ref, "day");
    todayOnly = true;
  }
  if (take("tonight")) setDayAt(ref, "day", { h: 20, mi: 0 });
  if (take("(?:tomorrow|tmrw|tmr|tomo|tom)")) setDayAt(at(ref, 1, 0));
  // Named times, then a bare hour
  for (const [words, h] of NAMED) if (take(`(?:${words})`)) setTime(h, 0);
  if (!time && (m = take("(\\d{1,2})"))) setTime(bareHour(+m[1]), 0);

  s = s.replace(/ from now(?= )/g, " ");
  if (bad || s.split(" ").some((w) => w && !FILLERS.has(w))) return null;

  if (minutes) {
    if (day || time || days || months) return null;
    return minuteOf(ref + minutes * MINUTE);
  }
  if (days || months) {
    if (day) return null;
    const t = time || { h: MORNING, mi: 0 };
    const ms = new Date(
      today.getFullYear(),
      today.getMonth() + months,
      today.getDate() + days,
      t.h,
      t.mi,
    ).getTime();
    return ms > ref ? ms : null;
  }
  if (!day) {
    if (!time) return null;
    const ms = at(ref, 0, time.h, time.mi);
    return ms > ref ? ms : at(ref, 1, time.h, time.mi);
  }
  if (todayOnly && !time)
    return presets(ref).find((p) => p.id === "later")?.until ?? null;
  const { y, mo, d, roll } = day;
  const t = time || day.time || { h: MORNING, mi: 0 };
  const moment = (years: number, plusDays: number) =>
    new Date(y + years, mo, d + plusDays, t.h, t.mi).getTime();
  const ms = moment(0, 0);
  if (ms > ref) return ms;
  if (roll === "day") return moment(0, 1);
  if (roll === "week") return moment(0, 7);
  if (roll === "year") return moment(1, 0);
  return null;
}

// ---------- Last used ----------

/** What the user picked last: a preset, or the text they typed. */
export type Choice =
  { kind: "preset"; id: PresetId } | { kind: "text"; text: string };

/**
 * The Last used time, recomputed from `ref`: "fri 3pm" means the coming Friday.
 * Null when the choice has no time now, like Later today after 17:00.
 */
export function lastUsed(choice: Choice | null, ref: number): number | null {
  if (choice === null) return null;
  if (choice.kind === "text") return parse(choice.text, ref);
  return presets(ref).find((p) => p.id === choice.id)?.until ?? null;
}
