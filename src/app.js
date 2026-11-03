import { fetchForecast, searchLocations } from './forecast.js';
import { analyzeForecast, completeForecastRange, isWithinWalkingHours, isWithinCutoffs } from './ranking.js';
import { initPwa } from './pwa.js';
import { icons } from './weather-icons.js';

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
let hourlyRange = null;
let selectedDate = null;
let request = null;
let searchRequest = null;
let loading = false;
let lastRefreshAttempt = 0;
let refreshFailed = false;
let installAvailable = false;
let locationGeneration = 0;

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
  return `<dl class="metrics"><div><dt>Precipitation</dt><dd>${valueLabel(hour.precipitationProbability, '%')}</dd></div><div><dt>US AQI</dt><dd>${valueLabel(hour.aqi)}</dd></div><div><dt>UV index</dt><dd>${valueLabel(hour.uv, '', 1)}</dd></div><div><dt>Temp</dt><dd>${valueLabel(hour.temperature, '°F', 1)}</dd></div></dl>`;
}

function recommendation(period, key, showDate) {
  const name = key === 'daylight' ? 'Before sunset' : 'After sunset';
  const hour = period.best;
  return `<article class="recommendation" data-period="${key}" aria-label="${name}"><h3 class="card-heading">${icons[key]}${name}</h3>${hour
    ? `<p class="walk-time">${timeLabel(hour.time)}</p>${showDate ? `<p class="walk-date">${dateLabel(hour.time)}</p>` : ''}${metrics(hour)}`
    : `<p class="no-pick">${escape(period.reason || 'No matching hours.')}</p>`}</article>`;
}

function upcomingHours(source, now, date = null) {
  const days = new Map(source.days.map((day) => [day.date, day]));
  return source.hours.filter((hour) => {
    const day = days.get(hour.date);
    return hour.time >= now && (!date || hour.date === date) && numeric(day?.sunrise)
      && numeric(day?.sunset) && day.sunset > day.sunrise && hour.time >= day.sunrise
      && isWithinWalkingHours(hour, source.location.timezone, walkingHours);
  }).sort((left, right) => left.time - right.time);
}

function renderHourly(hours) {
  const container = $('hourly-table');
  const range = `${forecast.location.latitude},${forecast.location.longitude}:${forecast.location.timezone}:${view}:${view === 'day' ? selectedDate : ''}`;
  const scrollLeft = range === hourlyRange ? container.scrollLeft : 0;
  hourlyRange = range;
  $('hourly-section').hidden = hours.length === 0;
  if (!hours.length) { container.replaceChildren(); return; }
  const columns = hours.map((hour) => ({ hour, matching: isWithinCutoffs(hour, cutoffs) }));
  const criteria = [
    ['precipitationProbability', 'Precipitation', '%', 0],
    ['aqi', 'US AQI', '', 0],
    ['uv', 'UV index', '', 1],
    ['temperature', 'Temperature', '°F', 1],
  ];
  container.innerHTML = `<table class="hourly-grid"><thead><tr><td class="hourly-corner"></td>${columns.map(({ hour, matching }) => `<th scope="col"${matching ? ' class="matching-hour"' : ''}>${view === 'week' ? `<span class="hour-date">${dateLabel(hour.time)}</span>` : ''}${timeLabel(hour.time)}${matching ? ' <span aria-hidden="true">✓</span><span class="sr-only"> · Matches cutoffs</span>' : '<span class="sr-only"> · Outside cutoffs</span>'}</th>`).join('')}</tr></thead><tbody>${criteria.map(([metric, label, suffix, digits]) => `<tr><th scope="row">${label}</th>${columns.map(({ hour, matching }) => `<td${matching ? ' class="matching-hour"' : ''}>${valueLabel(hour[metric], suffix, digits)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  container.scrollLeft = scrollLeft;
}

function renderWeek(analysis) {
  if (!analysis.days.length) { $('week-table').replaceChildren(); return; }
  const cell = (day, key, weekBest) => {
    const period = day[key];
    return `<td>${period.best ? `<button data-date="${day.date}" aria-label="View ${escape(dateLabel(dayTime(day)))} ${key === 'daylight' ? 'daylight' : 'evening'} forecast"${period.best.time === weekBest?.time ? ' class="week-best" title="Best combined choice this week"' : ''}>${timeLabel(period.best.time)}</button>` : '<span class="empty-period">—</span>'}</td>`;
  };
  $('week-table').innerHTML = `<table><thead><tr><th scope="col">Day</th><th scope="col">Before sunset</th><th scope="col">After sunset</th></tr></thead><tbody>${analysis.days.map((day) => `<tr><th scope="row"><button data-date="${day.date}">${dateLabel(dayTime(day))}</button></th>${cell(day, 'daylight', analysis.bestDaylight)}${cell(day, 'afterDark', analysis.bestAfterDark)}</tr>`).join('')}</tbody></table><p class="small muted range-note">Data for later dates not available yet.</p>`;
}

function render() {
  if (!forecast) return;
  const now = Date.now();
  const available = completeForecastRange(forecast, now, walkingHours);
  const analysis = analyzeForecast(available, now, walkingHours, cutoffs);
  if (!analysis.days.some((day) => day.date === selectedDate)) selectedDate = analysis.days[0]?.date;
  const day = analysis.days.find((item) => item.date === selectedDate);
  $('forecast').hidden = false;
  $('location-name').textContent = forecast.location.name || forecast.location.label || 'Selected location';
  $('location-name').parentElement.title = `Change location: ${forecast.location.label || ''}`;
  $('day-view').setAttribute('aria-pressed', String(view === 'day'));
  $('week-view').setAttribute('aria-pressed', String(view === 'week'));
  $('day-picker').hidden = view !== 'day' || !day;
  $('week-table').hidden = view !== 'week';
  $('day-picker').innerHTML = analysis.days.map((item) => `<button data-date="${item.date}" aria-pressed="${item.date === selectedDate}" aria-label="${fullDate(dayTime(item))}"><span>${format(dayTime(item), { weekday: 'short' })}</span><span>${format(dayTime(item), { day: 'numeric' })}</span></button>`).join('');
  $('forecast-heading').innerHTML = day ? (view === 'day' ? `For <em>${escape(fullDate(dayTime(day)))},</em> the best times to walk are` : 'Best this week') : '';
  $('sunset-time').textContent = view === 'day' && day?.sunset ? `Sunset ${timeLabel(day.sunset)}` : '';
  if (!day) {
    $('recommendations').innerHTML = '<p class="no-pick">Complete forecast unavailable.</p>';
    $('week-table').replaceChildren();
  } else if (view === 'day') {
    $('recommendations').innerHTML = recommendation(day.daylight, 'daylight', false) + recommendation(day.afterDark, 'afterDark', false);
  } else {
    $('recommendations').innerHTML = recommendation({ best: analysis.bestDaylight, complete: true }, 'daylight', true)
      + recommendation({ best: analysis.bestAfterDark, complete: true }, 'afterDark', true);
    renderWeek(analysis);
  }
  renderHourly(upcomingHours(available, now, view === 'day' ? selectedDate : null));
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
