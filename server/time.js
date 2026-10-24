// All scheduling uses the configured IANA zone, independent of the Worker host clock.
const formatters = new Map();
export function localParts(timeZone, date = new Date()) {
  if (!formatters.has(timeZone))
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }),
    );
  return Object.fromEntries(
    formatters
      .get(timeZone)
      .formatToParts(date)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
}
const dateKey = (p) => `${p.year}-${p.month}-${p.day}`;
export function startOfToday(timeZone, date = new Date()) {
  const today = dateKey(localParts(timeZone, date));
  // Search for the first instant with this local date. This also handles days
  // where a daylight-saving change skips midnight or repeats the preceding hour.
  let lo = date.getTime() - 36 * 3600000,
    hi = date.getTime();
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (dateKey(localParts(timeZone, new Date(mid))) < today) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
}
export function nextHour(timeZone, date = new Date()) {
  const minute = Math.floor(date.getTime() / 60000) * 60000;
  // Minute boundaries allow half/quarter-hour UTC offsets and DST transitions.
  for (let t = minute + 60000; t <= minute + 180 * 60000; t += 60000) {
    if (localParts(timeZone, new Date(t)).minute === '00') return new Date(t);
  }
  throw new Error('Could not determine the next local hour');
}
