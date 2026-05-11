(function () {
  "use strict";

  const STORAGE_KEY = "tello_saved_accounts";
  const LOG = "[TelloSiteBridge]";

  function sendTelloData() {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      const accounts = result[STORAGE_KEY] || [];

      console.log(LOG, "sending accounts to site", accounts);

      window.postMessage(
        {
          type: "NAM_TELLO_DATA_SYNC",
          accounts,
        },
        "*"
      );
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== "NAM_TELLO_REQUEST_SYNC") return;

    console.log(LOG, "site requested sync");
    sendTelloData();
  });

  sendTelloData();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!changes[STORAGE_KEY]) return;

    console.log(LOG, "storage changed, syncing again");
    sendTelloData();
  });
})();