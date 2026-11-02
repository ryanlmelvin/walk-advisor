import { fetchForecast, searchLocations } from './forecast.js';
import { analyzeForecast, isWithinWalkingHours, isWithinCutoffs } from './ranking.js';
import { initPwa } from './pwa.js';

const $ = (id) => document.getElementById(id);
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const storageKey = `walk-advisor:${new URL('.', location.href).pathname}:forecast-v1`;
const hoursStorageKey = `walk-advisor:${new URL('.', location.href).pathname}:walking-hours-v1`;
const cutoffsStorageKey = `walk-advisor:${new URL('.', location.href).pathname}:cutoffs-v1`;
const cutoffFields = { minTemperature: 'minimum-temperature', maxTemperature: 'maximum-temperature', maxPrecipitationProbability: 'maximum-precipitation', maxAqi: 'maximum-aqi', maxUv: 'maximum-uv' };
let cutoffs = { minTemperature: 32, maxTemperature: 80, maxPrecipitationProbability: 33, maxAqi: 50, maxUv: 5 };
let walkingHours = { earliest: '08:00', latest: '21:00' };
try {
  const saved = JSON.parse(localStorage.getItem(hoursStorageKey) || 'null');
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(saved?.earliest) && /^([01]\d|2[0-3]):[0-5]\d$/.test(saved?.latest) && saved.earliest <= saved.latest) walkingHours = saved;
} catch { /* Default walking hours remain available without storage. */ }
$('earliest-time').value = walkingHours.earliest;
$('latest-time').value = walkingHours.latest;
try {
  const saved = JSON.parse(localStorage.getItem(cutoffsStorageKey) || 'null');
  if (saved && Object.keys(cutoffFields).every((key) => saved[key] === null || (typeof saved[key] === 'number' && Number.isFinite(saved[key])))
    && (saved.minTemperature === null || saved.maxTemperature === null || saved.minTemperature <= saved.maxTemperature)
    && (saved.maxPrecipitationProbability === null || (saved.maxPrecipitationProbability >= 0 && saved.maxPrecipitationProbability <= 100))
    && (saved.maxAqi === null || saved.maxAqi >= 0) && (saved.maxUv === null || saved.maxUv >= 0)) cutoffs = saved;
} catch { /* Defaults remain available without storage. */ }
for (const [key, id] of Object.entries(cutoffFields)) $(id).value = cutoffs[key] ?? '';
let forecast = null;
let view = 'day';
let selectedDate = null;
let request = null;
let searchRequest = null;
let loading = false;
let lastRefreshAttempt = 0;
let refreshFailed = false;
let installAvailable = false;
let locationGeneration = 0;

const icons = {
  daylight: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg>',
  afterDark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14A8.5 8.5 0 0 1 10 4a8.5 8.5 0 1 0 10 10Z"/></svg>',
};

function setStatus(message = '', error = false) {
  $('status').textContent = message;
  $('status').hidden = !message;
  $('status').classList.toggle('error', error);
}

function locationStatus(message = '') {
  $('location-status').textContent = message;
  $('location-status').hidden = !message;
}

function dialogStatus(message) {
  $('dialog-status').textContent = message;
  $('dialog-status').hidden = !message;
}

function format(time, options) {
  return new Intl.DateTimeFormat('en-US', { timeZone: forecast?.location.timezone || 'UTC', ...options }).format(time);
}

const timeLabel = (time) => format(time, { hour: 'numeric', minute: '2-digit' }).replace(':00', '');
const dateLabel = (time) => format(time, { weekday: 'short', month: 'short', day: 'numeric' });
const fullDate = (time) => format(time, { weekday: 'long', month: 'long', day: 'numeric' });
const numeric = (value) => typeof value === 'number' && Number.isFinite(value);
const valueLabel = (value, suffix = '', digits = 0) => numeric(value) ? `${Number(value.toFixed(digits))}${suffix}` : '—';

function dayTime(day) {
  return day.sunrise ?? forecast.hours.find((hour) => hour.date === day.date)?.time ?? Date.now();
}

function metrics(hour) {
  return `<dl class="metrics"><div><dt>Precipitation</dt><dd>${valueLabel(hour.precipitationProbability, '%')}<small>${valueLabel(hour.precipitation, ' mm', 2)}</small></dd></div><div><dt>US AQI</dt><dd>${valueLabel(hour.aqi)}${hour.aqi === null ? '<small>Unavailable</small>' : ''}</dd></div><div><dt>UV index</dt><dd>${valueLabel(hour.uv, '', 1)}</dd></div><div><dt>Temperature</dt><dd>${valueLabel(hour.temperature, '°F', 1)}</dd></div></dl>`;
}

function recommendation(period, key, showDate) {
  const name = key === 'daylight' ? 'Before sunset' : 'After sunset';
  const hour = period.best;
  return `<article class="recommendation" aria-label="${name}"><h3 class="card-heading">${icons[key]}${name}</h3>${hour
    ? `<p class="walk-time">${timeLabel(hour.time)}</p>${showDate ? `<p class="walk-date">${dateLabel(hour.time)}</p>` : ''}${metrics(hour)}${period.complete ? '' : '<p class="card-note">Weather-only · AQI unavailable</p>'}`
    : `<p class="no-pick">${escape(period.reason || 'No matching hours.')}</p>`}</article>`;
}

function timeRanges(hours, includeDate) {
  const groups = [];
  for (const hour of hours) {
    const last = groups.at(-1);
    if (last && last.end.date === hour.date && hour.time - last.end.time === 3600000) last.end = hour;
    else groups.push({ start: hour, end: hour });
  }
  return groups.map(({ start, end }) => `${includeDate ? format(start.time, { weekday: 'short' }) + ' · ' : ''}${timeLabel(start.time)}${end.time !== start.time ? '–' + timeLabel(end.time) : ''}`);
}

function minimumBlock(title, minimum, suffix, digits = 0, secondary = '') {
  const labels = minimum ? timeRanges(minimum.times, view === 'week') : [];
  return `<div class="minimum"><h3>${title}</h3><p class="minimum-value">${minimum ? valueLabel(minimum.value, suffix, digits) : '—'}</p><div class="minimum-times">${labels.length ? labels.slice(0, 2).map((label) => `<p>${label}</p>`).join('') : 'Unavailable'}${labels.length > 2 ? `<details><summary>All tied hours</summary>${labels.slice(2).map((label) => `<p>${label}</p>`).join('')}</details>` : ''}${secondary}</div></div>`;
}

function renderMinima(minima) {
  const amount = minima.precipitation;
  const amountDetail = amount ? `<details><summary>Lowest amount: ${valueLabel(amount.value, ' mm', 2)}</summary>${timeRanges(amount.times, view === 'week').map((label) => `<p>${label}</p>`).join('')}</details>` : '';
  $('minima').innerHTML = minimumBlock('Precipitation chance', minima.precipitationProbability, '%', 0, amountDetail)
    + minimumBlock('US AQI', minima.aqi, '') + minimumBlock('UV index', minima.uv, '', 1)
    + minimumBlock('Temperature', minima.temperature, '°F', 1);
}

function eligibleHours(now, date = null) {
  const days = new Map(forecast.days.map((day) => [day.date, day]));
  return forecast.hours.filter((hour) => {
    const day = days.get(hour.date);
    return hour.time >= now && (!date || hour.date === date) && numeric(day?.sunrise)
      && numeric(day?.sunset) && day.sunset > day.sunrise && hour.time >= day.sunrise
      && isWithinWalkingHours(hour, forecast.location.timezone, walkingHours)
      && isWithinCutoffs(hour, cutoffs, { allowMissingAqi: true });
  });
}

function renderHourly(hours, minima) {
  const metricCell = (hour, metric, suffix = '', digits = 0) => `<td${numeric(hour[metric]) && hour[metric] === minima[metric]?.value ? ' class="lowest" title="Lowest value in this range"' : ''}>${valueLabel(hour[metric], suffix, digits)}</td>`;
  $('hourly-table').innerHTML = hours.length ? `<table><thead><tr><th scope="col">Hour</th><th scope="col">Rain / snow</th><th scope="col">Amount</th><th scope="col">US AQI</th><th scope="col">UV</th><th scope="col">Temp</th></tr></thead><tbody>${hours.map((hour) => `<tr><th scope="row">${view === 'week' ? format(hour.time, { weekday: 'short' }) + ' ' : ''}${timeLabel(hour.time)}</th>${metricCell(hour, 'precipitationProbability', '%')}${metricCell(hour, 'precipitation', ' mm', 2)}${metricCell(hour, 'aqi')}${metricCell(hour, 'uv', '', 1)}${metricCell(hour, 'temperature', '°F', 1)}</tr>`).join('')}</tbody></table>` : '<p class="small muted" style="padding:14px">No matching hours.</p>';
}

function renderWeek(analysis) {
  const cell = (day, key, weekBest) => {
    const period = day[key];
    return `<td>${period.best ? `<button data-date="${day.date}" aria-label="View ${escape(dateLabel(dayTime(day)))} ${key === 'daylight' ? 'daylight' : 'evening'} forecast"${period.best.time === weekBest?.time ? ' class="week-best" title="Best combined choice this week"' : ''}>${timeLabel(period.best.time)}</button>${!period.complete ? '<span class="weather-only">Weather-only</span>' : ''}` : '<span class="empty-period">—</span>'}</td>`;
  };
  $('week-table').innerHTML = `<table><thead><tr><th scope="col">Day</th><th scope="col">Before sunset</th><th scope="col">After sunset</th></tr></thead><tbody>${analysis.days.map((day) => `<tr><th scope="row"><button data-date="${day.date}">${dateLabel(dayTime(day))}</button></th>${cell(day, 'daylight', analysis.bestDaylight)}${cell(day, 'afterDark', analysis.bestAfterDark)}</tr>`).join('')}</tbody></table>`;
}

function render() {
  if (!forecast) return;
  const now = Date.now();
  const analysis = analyzeForecast(forecast, now, walkingHours, cutoffs);
  if (!analysis.days.some((day) => day.date === selectedDate)) selectedDate = analysis.days[0]?.date;
  const day = analysis.days.find((item) => item.date === selectedDate);
  if (!day) return;
  $('forecast').hidden = false;
  $('location-name').textContent = forecast.location.name || forecast.location.label || 'Selected location';
  $('location-name').parentElement.title = `Change location: ${forecast.location.label || ''}`;
  $('day-view').setAttribute('aria-pressed', String(view === 'day'));
  $('week-view').setAttribute('aria-pressed', String(view === 'week'));
  $('day-picker').hidden = view !== 'day';
  $('week-table').hidden = view !== 'week';
  $('day-picker').innerHTML = analysis.days.map((item) => `<button data-date="${item.date}" aria-pressed="${item.date === selectedDate}" aria-label="${fullDate(dayTime(item))}"><span>${format(dayTime(item), { weekday: 'short' })}</span><span>${format(dayTime(item), { day: 'numeric' })}</span></button>`).join('');
  $('forecast-heading').textContent = view === 'day' ? fullDate(dayTime(day)) : 'Best this week';
  $('sunset-time').textContent = view === 'day' && day.sunset ? `Sunset ${timeLabel(day.sunset)}` : '';
  if (view === 'day') {
    $('recommendations').innerHTML = recommendation(day.daylight, 'daylight', false) + recommendation(day.afterDark, 'afterDark', false);
  } else {
    $('recommendations').innerHTML = recommendation({ best: analysis.bestDaylight, complete: true }, 'daylight', true)
      + recommendation({ best: analysis.bestAfterDark, complete: true }, 'afterDark', true);
    renderWeek(analysis);
  }
  const shownHours = eligibleHours(now, view === 'day' ? selectedDate : null);
  $('minima-section').hidden = shownHours.length === 0;
  $('hourly-details').hidden = shownHours.length === 0;
  const minima = view === 'week' ? analysis.minima : analyzeForecast({ ...forecast, hours: forecast.hours.filter((hour) => hour.date === selectedDate) }, now, walkingHours, cutoffs).minima;
  renderMinima(minima);
  renderHourly(shownHours, minima);
  const unavailable = shownHours.some((hour) => !numeric(hour.aqi));
  $('coverage-note').textContent = unavailable ? 'Weather-only picks lack AQI.' : '';
  $('coverage-note').hidden = !unavailable;
  const ageHours = (now - forecast.fetchedAt) / 3600000;
  const saved = refreshFailed || !navigator.onLine || ageHours >= 1;
  $('updated-at').textContent = `${saved ? 'Saved' : 'Updated'} ${ageHours > 20 ? dateLabel(forecast.fetchedAt) + ', ' : ''}${timeLabel(forecast.fetchedAt)} · ${format(now, { timeZoneName: 'short' }).split(' ').at(-1)}`;
  $('updated-at').title = `Retrieved ${format(forecast.fetchedAt, { dateStyle: 'full', timeStyle: 'short' })}. Times in ${forecast.location.timezone}.`;
  $('location-detail').textContent = `${forecast.location.label || forecast.location.name} · ${forecast.location.latitude.toFixed(4)}, ${forecast.location.longitude.toFixed(4)} · ${forecast.location.timezone}`;
  if (!navigator.onLine) setStatus('You’re offline. Showing the last saved forecast; conditions may have changed.');
  else if (ageHours >= 1 && !loading && !refreshFailed) setStatus('This saved forecast is over an hour old. Refresh for current predictions.');
}

function saveForecast() {
  if (!forecast) return true;
  try { localStorage.setItem(storageKey, JSON.stringify({ version: 1, forecast })); return true; }
  catch { return false; }
}

function saveWalkingHours() {
  try { localStorage.setItem(hoursStorageKey, JSON.stringify(walkingHours)); return true; }
  catch { return false; }
}

function saveCutoffs() {
  try { localStorage.setItem(cutoffsStorageKey, JSON.stringify(cutoffs)); return true; }
  catch { return false; }
}

async function loadForecast(location) {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  loading = true;
  lastRefreshAttempt = Date.now();
  $('refresh-button').disabled = true;
  setStatus('Getting weather and air quality…');
  try {
    const data = await fetchForecast(location, { signal: controller.signal });
    if (controller.signal.aborted) return;
    forecast = data;
    refreshFailed = false;
    $('location-picker').hidden = true;
    locationStatus();
    const saved = saveForecast();
    setStatus(saved ? '' : 'Forecast loaded, but this browser could not save it for offline use.');
    render();
  } catch (error) {
    if (controller.signal.aborted) return;
    refreshFailed = true;
    setStatus(`${error.message}${forecast ? ' Showing the last forecast for ' + (forecast.location.name || forecast.location.label) + '.' : ''}`, true);
    render();
  } finally {
    if (request === controller) {
      loading = false;
      $('refresh-button').disabled = false;
    }
  }
}

function showLocation() {
  $('location-picker').hidden = false;
  $('cancel-location').hidden = !forecast;
  $('location-input').focus();
}

function selectLocation(location) {
  locationGeneration++;
  searchRequest?.abort();
  $('location-results').replaceChildren();
  loadForecast(location);
}

$('location-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = $('location-input').value.trim();
  const coordinates = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (coordinates) {
    const latitude = Number(coordinates[1]), longitude = Number(coordinates[2]);
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return locationStatus('Latitude must be −90 to 90 and longitude −180 to 180.');
    return selectLocation({ name: 'Selected coordinates', label: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`, latitude, longitude });
  }
  if (query.length < 2) return locationStatus('Enter at least two characters to search.');
  searchRequest?.abort();
  const controller = new AbortController();
  searchRequest = controller;
  $('search-button').disabled = true;
  $('location-results').replaceChildren();
  locationStatus('Finding locations…');
  try {
    const results = await searchLocations(query, { signal: controller.signal });
    if (controller.signal.aborted) return;
    locationStatus(results.length ? '' : 'No matches. Try a nearby city or latitude, longitude.');
    for (const result of results) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = result.label;
      button.addEventListener('click', () => selectLocation(result));
      item.append(button);
      $('location-results').append(item);
    }
  } catch (error) {
    if (!controller.signal.aborted) locationStatus(error.message);
  } finally {
    if (searchRequest === controller) $('search-button').disabled = false;
  }
});

$('locate-button').addEventListener('click', () => {
  if (!navigator.geolocation) return locationStatus('Location access is unavailable. Search for a city or enter coordinates.');
  const generation = ++locationGeneration;
  $('locate-button').disabled = true;
  locationStatus('Finding your location…');
  navigator.geolocation.getCurrentPosition((position) => {
    $('locate-button').disabled = false;
    if (generation !== locationGeneration) return;
    const latitude = Number(position.coords.latitude.toFixed(5)), longitude = Number(position.coords.longitude.toFixed(5));
    locationStatus();
    selectLocation({ name: 'Your location', label: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`, latitude, longitude });
  }, (error) => {
    $('locate-button').disabled = false;
    if (generation !== locationGeneration) return;
    locationStatus(error.code === 1 ? 'Location access was declined. Search for a city or enter coordinates.' : 'Could not find your location. Try again or search for a city.');
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 300000 });
});

$('change-location').addEventListener('click', showLocation);
$('cancel-location').addEventListener('click', () => {
  locationGeneration++;
  searchRequest?.abort();
  request?.abort();
  $('location-picker').hidden = true;
  setStatus();
});
$('refresh-button').addEventListener('click', () => forecast && loadForecast(forecast.location));
$('day-view').addEventListener('click', () => { view = 'day'; render(); });
$('week-view').addEventListener('click', () => { view = 'week'; render(); });
for (const id of ['day-picker', 'week-table']) $(id).addEventListener('click', (event) => {
  const button = event.target.closest('button[data-date]');
  if (button) { selectedDate = button.dataset.date; view = 'day'; render(); }
});

$('menu-button').addEventListener('click', () => $('app-dialog').showModal());
$('walking-hours-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const earliest = $('earliest-time').value, latest = $('latest-time').value;
  if (!earliest || !latest || latest < earliest) {
    dialogStatus('Latest must be at or after earliest on the same day.');
    $('latest-time').focus();
    return;
  }
  const nextCutoffs = Object.fromEntries(Object.entries(cutoffFields).map(([key, id]) => [key, $(id).value.trim() === '' ? null : Number($(id).value)]));
  if (nextCutoffs.minTemperature !== null && nextCutoffs.maxTemperature !== null && nextCutoffs.minTemperature > nextCutoffs.maxTemperature) {
    dialogStatus('Maximum temperature must be at or above the minimum.');
    $('maximum-temperature').focus();
    return;
  }
  walkingHours = { earliest, latest };
  cutoffs = nextCutoffs;
  const hoursSaved = saveWalkingHours(), cutoffsSaved = saveCutoffs();
  if (hoursSaved && cutoffsSaved) {
    dialogStatus('Preferences saved.');
  } else {
    dialogStatus('Applied for this visit. Couldn’t save on this device.');
  }
  render();
});
$('close-dialog').addEventListener('click', () => $('app-dialog').close());
$('method-button').addEventListener('click', () => { $('method-details').open = true; $('app-dialog').showModal(); });
$('app-dialog').addEventListener('click', (event) => { if (event.target === $('app-dialog') && (event.clientX < $('app-dialog').getBoundingClientRect().left || event.clientX > $('app-dialog').getBoundingClientRect().right || event.clientY < $('app-dialog').getBoundingClientRect().top || event.clientY > $('app-dialog').getBoundingClientRect().bottom)) $('app-dialog').close(); });

const pwa = initPwa({
  onUpdate: (available) => { $('update-button').hidden = !available; $('dialog-update').hidden = !available; },
  onStatus: (message) => { dialogStatus(message); if (!$('app-dialog').open && message) setStatus(message); },
  onInstallAvailable: (available) => { installAvailable = available; },
  beforeUpdate: async () => {
    if (saveForecast() && saveWalkingHours() && saveCutoffs()) return true;
    dialogStatus('Could not save your current preferences and forecast. Try updating again when browser storage is available.');
    return false;
  },
});
for (const id of ['update-button', 'dialog-update']) $(id).addEventListener('click', () => pwa.applyUpdate());
$('install-button').addEventListener('click', async () => {
  if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) dialogStatus('You’re already using the installed app.');
  else if (installAvailable) await pwa.install();
  else { $('install-help').open = true; $('install-help').scrollIntoView({ block: 'nearest' }); }
});

try {
  const cached = JSON.parse(localStorage.getItem(storageKey) || 'null');
  if (cached?.version === 1 && cached.forecast && Array.isArray(cached.forecast.hours) && Array.isArray(cached.forecast.days)
    && numeric(cached.forecast.fetchedAt) && numeric(cached.forecast.location?.latitude) && numeric(cached.forecast.location?.longitude)) {
    // Validate the saved time zone before rendering browser-formatted times.
    new Intl.DateTimeFormat('en-US', { timeZone: cached.forecast.location.timezone }).format();
    forecast = cached.forecast;
    $('location-picker').hidden = true;
    render();
    if (navigator.onLine) loadForecast(forecast.location);
  }
} catch { forecast = null; $('location-picker').hidden = false; }

window.addEventListener('offline', () => { if (forecast) render(); });
window.addEventListener('online', () => { if (forecast && !loading) loadForecast(forecast.location); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !forecast) return;
  render();
  if (navigator.onLine && !loading && Date.now() - lastRefreshAttempt > 1800000) loadForecast(forecast.location);
});
setInterval(() => {
  if (document.visibilityState === 'visible' && forecast && !$('app-dialog').open) {
    render();
    if (navigator.onLine && !loading && Date.now() - lastRefreshAttempt > 1800000) loadForecast(forecast.location);
  }
}, 60000);
