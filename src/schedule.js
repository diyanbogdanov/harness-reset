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

function clampDayMinutes(minutes) {
  return Math.min(23 * 60 + 59, Math.max(0, minutes));
}

export function inferWarmupTime(samples, { leadMinutes, minActiveDays }) {
  const firstByDay = new Map();

  for (const sample of samples) {
    const key = localDayKey(sample);
    const minutes = localMinutes(sample);
    const current = firstByDay.get(key);

    if (current === undefined || minutes < current) {
      firstByDay.set(key, minutes);
    }
  }

  const activeDays = firstByDay.size;

  if (activeDays < minActiveDays) {
    return {
      kind: 'insufficient-history',
      activeDays,
      requiredDays: minActiveDays,
    };
  }

  const firstActivityMinutes = medianMinutes([...firstByDay.values()]);
  const warmupMinutes = clampDayMinutes(firstActivityMinutes - leadMinutes);
  const warmupTime = formatTime(warmupMinutes);

  return {
    kind: 'suggested',
    activeDays,
    firstActivity: formatTime(firstActivityMinutes),
    warmupTime,
    schedule: `daily at ${warmupTime}`,
  };
}
