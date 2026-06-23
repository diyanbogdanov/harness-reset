function formatTime(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function localDayKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function localMinutes(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function medianMinutes(minutes) {
  const sorted = [...minutes].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

const DAY_MINUTES = 24 * 60;
const DUPLICATE_LIMIT_HIT_MINUTES = 60;
const FOLLOWING_WINDOW_GAP_MINUTES = 1;
const DEFAULT_ADDITIONAL_LIMIT_HIT_DAYS = 2;

function wrapDayMinutes(minutes) {
  return ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
}

function circularMedianMinutes(minutes) {
  const sorted = [...minutes].sort((a, b) => a - b);

  if (sorted.length <= 1) {
    return sorted[0];
  }

  let largestGap = -1;
  let startIndex = 0;

  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    const next = sorted[(index + 1) % sorted.length] + (index === sorted.length - 1 ? DAY_MINUTES : 0);
    const gap = next - current;

    if (gap > largestGap) {
      largestGap = gap;
      startIndex = (index + 1) % sorted.length;
    }
  }

  const unwrapped = [];

  for (let offset = 0; offset < sorted.length; offset += 1) {
    const index = (startIndex + offset) % sorted.length;
    let value = sorted[index];

    if (offset > 0 && value < unwrapped[offset - 1]) {
      value += DAY_MINUTES;
    }

    unwrapped.push(value);
  }

  return wrapDayMinutes(medianMinutes(unwrapped));
}

function dedupeDailyMinutes(minutes) {
  const deduped = [];

  for (const minutesOfDay of [...minutes].sort((a, b) => a - b)) {
    const previous = deduped.at(-1);

    if (previous === undefined || minutesOfDay - previous > DUPLICATE_LIMIT_HIT_MINUTES) {
      deduped.push(minutesOfDay);
    }
  }

  return deduped;
}

function minutesByDay(samples) {
  const byDay = new Map();

  for (const sample of samples) {
    const key = localDayKey(sample);
    const minutes = byDay.get(key) || [];
    minutes.push(localMinutes(sample));
    byDay.set(key, minutes);
  }

  for (const [key, minutes] of byDay) {
    byDay.set(key, dedupeDailyMinutes(minutes));
  }

  return byDay;
}

function addMinutes(minutes, offset) {
  return wrapDayMinutes(minutes + offset);
}

function ordinalMinutes(byDay, ordinal) {
  const minutes = [];

  for (const dayMinutes of byDay.values()) {
    if (dayMinutes[ordinal] !== undefined) {
      minutes.push(dayMinutes[ordinal]);
    }
  }

  return minutes;
}

function unwrapAfter(minutes, previousMinutes) {
  let unwrapped = minutes;

  while (unwrapped <= previousMinutes) {
    unwrapped += DAY_MINUTES;
  }

  return unwrapped;
}

function scheduleForTime(time) {
  return `daily at ${time}`;
}

function dailyRanges(startMinutes, endMinutes) {
  if (endMinutes - startMinutes >= DAY_MINUTES) {
    return [[0, DAY_MINUTES]];
  }

  const start = wrapDayMinutes(startMinutes);
  const end = wrapDayMinutes(endMinutes);

  if (start < end) {
    return [[start, end]];
  }

  if (start > end) {
    return [
      [start, DAY_MINUTES],
      [0, end],
    ];
  }

  return [[0, DAY_MINUTES]];
}

function rangesOverlap(left, right) {
  return Math.max(left[0], right[0]) < Math.min(left[1], right[1]);
}

function dailyWindowsOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  const leftRanges = dailyRanges(leftStart, leftEnd);
  const rightRanges = dailyRanges(rightStart, rightEnd);

  return leftRanges.some((left) => rightRanges.some((right) => rangesOverlap(left, right)));
}

function overlapsExistingDailyWindow(warmupUnwrapped, targetResetUnwrapped, windows) {
  return windows.some((window) =>
    dailyWindowsOverlap(
      warmupUnwrapped,
      targetResetUnwrapped,
      window.warmupUnwrapped,
      window.targetResetUnwrapped,
    ),
  );
}

function publicWindow(window) {
  return {
    evidenceDays: window.evidenceDays,
    limitHit: window.limitHit,
    targetReset: window.targetReset,
    warmupTime: window.warmupTime,
    schedule: window.schedule,
  };
}

export function inferWarmupTime(
  samples,
  {
    limitHitSamples = [],
    minLimitHitDays,
    resetPaddingMinutes,
    windowMinutes,
  },
) {
  const limitHitByDay = minutesByDay(limitHitSamples);
  const requiredDays = minLimitHitDays ?? 1;
  const limitHitDays = ordinalMinutes(limitHitByDay, 0).length;

  if (limitHitDays < requiredDays) {
    return {
      kind: 'insufficient-limit-history',
      limitHitDays,
      requiredDays,
    };
  }

  const windows = [];
  const additionalRequiredDays = Math.min(requiredDays, DEFAULT_ADDITIONAL_LIMIT_HIT_DAYS);

  for (let ordinal = 0; ; ordinal += 1) {
    const minutes = ordinalMinutes(limitHitByDay, ordinal);
    const requiredSlotDays = ordinal === 0 ? requiredDays : additionalRequiredDays;

    if (minutes.length < requiredSlotDays) {
      break;
    }

    const limitHitMinutes = circularMedianMinutes(minutes);
    const previousWindow = windows.at(-1);
    const limitHitUnwrapped = previousWindow
      ? unwrapAfter(limitHitMinutes, previousWindow.limitHitUnwrapped)
      : limitHitMinutes;
    const candidateTargetReset = limitHitUnwrapped + resetPaddingMinutes;
    const candidateWarmup = candidateTargetReset - windowMinutes;
    const warmupUnwrapped = previousWindow
      ? Math.max(candidateWarmup, previousWindow.targetResetUnwrapped + FOLLOWING_WINDOW_GAP_MINUTES)
      : candidateWarmup;
    const targetResetUnwrapped = warmupUnwrapped + windowMinutes;

    if (overlapsExistingDailyWindow(warmupUnwrapped, targetResetUnwrapped, windows)) {
      continue;
    }

    const warmupTime = formatTime(wrapDayMinutes(warmupUnwrapped));

    windows.push({
      evidenceDays: minutes.length,
      limitHit: formatTime(limitHitMinutes),
      limitHitUnwrapped,
      targetReset: formatTime(wrapDayMinutes(targetResetUnwrapped)),
      targetResetUnwrapped,
      warmupUnwrapped,
      warmupTime,
      schedule: scheduleForTime(warmupTime),
    });
  }

  const schedules = windows.map((window) => window.schedule);
  const firstWindow = windows[0];

  return {
    kind: 'suggested',
    strategy: 'limit-hit',
    limitHitDays: firstWindow.evidenceDays,
    limitHit: firstWindow.limitHit,
    targetReset: firstWindow.targetReset,
    warmupTime: firstWindow.warmupTime,
    schedule: schedules.join(', '),
    schedules,
    windows: windows.map(publicWindow),
  };
}
