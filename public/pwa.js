/** Browser lifecycle controller. Other windows choose their own reload. */
export function initPwa({ onUpdate = () => {}, onStatus = () => {}, onInstallAvailable = () => {}, beforeUpdate = async () => true } = {}) {
  let registration;
  let registrationPromise;
  let installingPrompt;
  let checking;
  let lastChecked = 0;
  let accepting = false;
  let changedElsewhere = false;
  let reloading = false;
  let activationTimer;
  let controlled = Boolean(navigator.serviceWorker?.controller);

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installingPrompt = event;
    onInstallAvailable(true);
  });
  window.addEventListener('appinstalled', () => {
    installingPrompt = undefined;
    onInstallAvailable(false);
  });

  function showWaiting() {
    // On the first visit, an installed worker can briefly be "waiting" before
    // its automatic activation. There is no older app to offer an update for.
    onUpdate(Boolean((controlled && registration?.waiting) || changedElsewhere));
  }

  function watchWorker(worker) {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') showWaiting();
      if (worker.state === 'redundant' && accepting) {
        accepting = false;
        clearTimeout(activationTimer);
        onStatus('The update could not activate. Try again, or use Update recovery.');
        showWaiting();
      }
    });
  }

  async function checkForUpdate({ force = false } = {}) {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return false;
    if (checking) return checking;
    if (!force && Date.now() - lastChecked < 60_000) return Boolean(registration?.waiting);
    lastChecked = Date.now();
    checking = (async () => {
      try {
        await registrationPromise;
        if (!registration) return false;
        await registration.update();
        showWaiting();
        if (force && !registration.waiting && !registration.installing && !changedElsewhere) onStatus('You have the latest installed version.');
        return Boolean(registration.waiting || changedElsewhere);
      } catch {
        if (force) onStatus('Could not check for updates. Reconnect and try again.');
        return false;
      } finally {
        checking = undefined;
      }
    })();
    return checking;
  }

  async function applyUpdate() {
    if (accepting) return false;
    try {
      if (!(await beforeUpdate())) {
        onStatus('Your settings could not be saved. Retry before updating.');
        return false;
      }
    } catch {
      onStatus('Your settings could not be saved. Retry before updating.');
      return false;
    }
    if (changedElsewhere && !registration?.waiting) {
      window.location.reload();
      return true;
    }
    if (!registration?.waiting) {
      await checkForUpdate({ force: true });
      if (!registration?.waiting) return false;
    }
    accepting = true;
    onStatus('Applying update…');
    activationTimer = setTimeout(() => {
      accepting = false;
      onStatus('The update is taking too long. Try again, or use Update recovery.');
      showWaiting();
    }, 12_000);
    try {
      registration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
      return true;
    } catch {
      accepting = false;
      clearTimeout(activationTimer);
      onStatus('The update could not activate. Try again, or use Update recovery.');
      showWaiting();
      return false;
    }
  }

  async function install() {
    if (!installingPrompt) return { outcome: 'unavailable' };
    const prompt = installingPrompt;
    installingPrompt = undefined;
    onInstallAvailable(false);
    await prompt.prompt();
    return prompt.userChoice;
  }

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!controlled) {
        controlled = true;
        showWaiting();
        return;
      }
      if (accepting && !reloading) {
        reloading = true;
        clearTimeout(activationTimer);
        window.location.reload();
      } else if (registration?.active) {
        changedElsewhere = true;
        showWaiting();
      }
    });
    registrationPromise = navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' })
      .then(value => {
        registration = value;
        showWaiting();
        watchWorker(value.installing);
        value.addEventListener('updatefound', () => watchWorker(value.installing));
        return value;
      }).catch(() => onStatus('Offline installation could not finish. Reconnect and reload to retry.'));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkForUpdate();
    });
    window.addEventListener('online', () => checkForUpdate());
    setInterval(() => {
      if (document.visibilityState === 'visible') checkForUpdate();
    }, 60_000);
  }
  return { checkForUpdate, applyUpdate, install };
}
