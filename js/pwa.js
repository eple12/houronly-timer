// Install button: Chrome/Edge on Android (and desktop) fire beforeinstallprompt
// when the PWA criteria are met. We stash that event and replay it on click,
// since the browser only lets it fire once and only responds within a user gesture.
let deferredInstallPrompt = null;

const alreadyInstalled = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (!alreadyInstalled()) installBtn.hidden = false;
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  installBtn.hidden = true;
});

on('installBtn', 'click', async () => {
  if (!deferredInstallPrompt) return;
  installBtn.hidden = true;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
});

if (alreadyInstalled()) installBtn.hidden = true;
