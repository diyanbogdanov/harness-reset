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

function firstMinutesByDay(samples) {
  const firstByDay = new Map();

  for (const sample of samples) {
    const key = localDayKey(sample);
    const minutes = localMinutes(sample);
    const current = firstByDay.get(key);

    if (current === undefined || minutes < current) {
      firstByDay.set(key, minutes);
    }
  }

  return firstByDay;
}

function addMinutes(minutes, offset) {
  return wrapDayMinutes(minutes + offset);
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
  const limitHitByDay = firstMinutesByDay(limitHitSamples);
  const limitHitDays = limitHitByDay.size;
  const requiredDays = minLimitHitDays ?? 1;

  if (limitHitDays < requiredDays) {
    return {
      kind: 'insufficient-limit-history',
      limitHitDays,
      requiredDays,
    };
  }

  const limitHitMinutes = circularMedianMinutes([...limitHitByDay.values()]);
  const targetResetMinutes = addMinutes(limitHitMinutes, resetPaddingMinutes);
  const warmupMinutes = addMinutes(targetResetMinutes, -windowMinutes);
  const warmupTime = formatTime(warmupMinutes);

  return {
    kind: 'suggested',
    strategy: 'limit-hit',
    limitHitDays,
    limitHit: formatTime(limitHitMinutes),
    targetReset: formatTime(targetResetMinutes),
    warmupTime,
    schedule: `daily at ${warmupTime}`,
  };
}
