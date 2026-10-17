// src/usage/periodKeys.js
//
// Calendar keys and reset timestamps for quota windows. Every window is
// evaluated in America/Los_Angeles, matching dayKeyLA() in db.js, so a user in
// Tokyo still gets the same reset moment the client displays.

export const QUOTA_TIMEZONE = "America/Los_Angeles";

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: QUOTA_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Local calendar parts for a date, in the quota timezone. */
export function localParts(date) {
  return Object.fromEntries(
    dateTimeFormatter
      .formatToParts(date)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)])
  );
}

/** Offset between the quota timezone and UTC at `date`, in milliseconds. */
export function timeZoneOffsetMs(date) {
  const parts = localParts(date);
  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  return representedAsUtc - Math.trunc(date.getTime() / 1_000) * 1_000;
}

/** YYYY-MM in the quota timezone. */
export function monthKeyLA(date = new Date()) {
  const parts = localParts(date);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}`;
}

/** The first instant of the next month in the quota timezone, as ISO. */
export function getNextMonthResetAt(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }

  const current = localParts(now);
  // Passing the 1-based month as the zero-based index lands on next month.
  const nextMonthFirst = Date.UTC(current.year, current.month, 1);
  let resetMs = nextMonthFirst;

  // Two passes handle an offset change between `now` and the reset.
  for (let index = 0; index < 2; index += 1) {
    resetMs = nextMonthFirst - timeZoneOffsetMs(new Date(resetMs));
  }

  return new Date(resetMs).toISOString();
}
