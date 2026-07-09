// Popup: gate the auto-cart toggle behind an explicit risk acceptance.
// State lives in chrome.storage.local: { accepted: bool, enabled: bool }.

const acceptEl = document.getElementById('accept');
const enabledEl = document.getElementById('enabled');
const stateEl = document.getElementById('state');

function render(accepted, enabled) {
  acceptEl.checked = accepted;
  enabledEl.disabled = !accepted;
  enabledEl.checked = enabled && accepted;
  stateEl.textContent = enabled && accepted ? 'On — will auto-add to cart' : 'Off';
}

chrome.storage.local.get({ accepted: false, enabled: false }, ({ accepted, enabled }) => {
  render(accepted, enabled);
});

acceptEl.addEventListener('change', () => {
  const accepted = acceptEl.checked;
  // Revoking acceptance also force-disables the feature.
  const patch = accepted ? { accepted } : { accepted: false, enabled: false };
  chrome.storage.local.set(patch, () => {
    chrome.storage.local.get({ accepted: false, enabled: false }, ({ accepted, enabled }) =>
      render(accepted, enabled)
    );
  });
});

enabledEl.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: enabledEl.checked }, () => {
    chrome.storage.local.get({ accepted: false, enabled: false }, ({ accepted, enabled }) =>
      render(accepted, enabled)
    );
  });
});
