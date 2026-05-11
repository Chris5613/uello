(function () {
  "use strict";

  const STORAGE_KEY = "tello_saved_accounts";
  const ACTIVE_ACCOUNT_KEY = "tello_active_account_label";

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getPageText() {
    return cleanText(document.body.innerText || document.body.textContent || "");
  }

  function findPhoneDropdown() {
    const selects = [...document.querySelectorAll("select")];

    return selects.find((select) => {
      const optionText = [...select.options]
        .map((option) => option.textContent)
        .join(" ");

      return /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(optionText);
    });
  }

  function extractPhoneFromOption(option) {
    const text = cleanText(option?.textContent);
    const match = text.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
    return match ? match[0] : text || "Unknown line";
  }

  function extractLineData() {
    const text = getPageText();

    const dataMatch =
      text.match(/([\d.]+)\s*(MB|GB)\s*(?:remaining|left)/i) ||
      text.match(/remaining\s*balance\s*([\d.]+)\s*(MB|GB)/i) ||
      text.match(/([\d.]+)\s*(MB|GB)/i);

    const totalMatch =
      text.match(/\/\s*([\d.]+)\s*(MB|GB)/i) ||
      text.match(/of\s*([\d.]+)\s*(MB|GB)/i);

    const renewalMatch =
      text.match(/renewal\s*date[:\s]*([A-Za-z0-9,/\-\s]+)/i) ||
      text.match(/renews?\s*(?:on)?\s*([A-Za-z0-9,/\-\s]+)/i);

    const planMatch =
      text.match(/(\d+(?:\.\d+)?\s*GB[^\\n]*?(?:Data|text|texts)[^\\n]*)/i) ||
      text.match(/(Unlimited[^\\n]*?(?:text|texts|data)[^\\n]*)/i);

    const priceMatch =
      text.match(/\$\s*\d+(?:\.\d{2})?/);

    return {
      dataRemaining: dataMatch ? `${dataMatch[1]} ${dataMatch[2]}` : "Unknown",
      dataTotal: totalMatch ? `${totalMatch[1]} ${totalMatch[2]}` : "Unknown",
      renewalDate: renewalMatch ? cleanText(renewalMatch[1]).slice(0, 40) : "Unknown",
      plan: planMatch ? cleanText(planMatch[1]).slice(0, 80) : "Unknown",
      price: priceMatch ? priceMatch[0] : "Unknown",
      texts: /unlimited\s*texts?/i.test(text) ? "Unlimited texts" : "Unknown"
    };
  }

  function getAccountLabel() {
    return (
      localStorage.getItem(ACTIVE_ACCOUNT_KEY) ||
      document.querySelector("#tello-account-label-input")?.value ||
      "Tello Account"
    );
  }

  function setAccountLabel(label) {
    localStorage.setItem(ACTIVE_ACCOUNT_KEY, label || "Tello Account");
  }

  async function getSavedAccounts() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (result) => {
        resolve(result[STORAGE_KEY] || []);
      });
    });
  }

  async function saveAccounts(accounts) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: accounts }, resolve);
    });
  }

  async function saveScannedAccount(account) {
    const accounts = await getSavedAccounts();
    const existingIndex = accounts.findIndex((item) => item.accountId === account.accountId);

    if (existingIndex >= 0) {
      accounts[existingIndex] = account;
    } else {
      accounts.push(account);
    }

    await saveAccounts(accounts);
  }

  function makeAccountId(label) {
    return cleanText(label).toLowerCase().replace(/[^a-z0-9]+/g, "_") || "tello_account";
  }

  async function scanCurrentAccount() {
    const dropdown = findPhoneDropdown();

    if (!dropdown) {
      alert("Could not find the phone number dropdown on this page.");
      return;
    }

    const accountLabel =
      prompt("Name this Tello account:", getAccountLabel()) || getAccountLabel();

    setAccountLabel(accountLabel);

    const options = [...dropdown.options].filter((option) => option.value !== "");
    const lines = [];

    for (const option of options) {
      dropdown.value = option.value;

      dropdown.dispatchEvent(new Event("input", { bubbles: true }));
      dropdown.dispatchEvent(new Event("change", { bubbles: true }));

      await sleep(2500);

      const phone = extractPhoneFromOption(option);
      const lineData = extractLineData();

      lines.push({
        phone,
        ...lineData,
        lastScanned: new Date().toISOString()
      });
    }

    const account = {
      accountId: makeAccountId(accountLabel),
      label: accountLabel,
      lineCount: lines.length,
      lines,
      lastScanned: new Date().toISOString()
    };

    await saveScannedAccount(account);
    renderDashboard();

    alert(`Scanned ${lines.length} line(s) for ${accountLabel}.`);
  }

  async function clearSavedData() {
    const confirmed = confirm("Clear all saved Tello account data?");
    if (!confirmed) return;

    await saveAccounts([]);
    renderDashboard();
  }

  function getDataPercent(line) {
    const remaining = parseFloat(line.dataRemaining);
    const total = parseFloat(line.dataTotal);

    if (!Number.isFinite(remaining) || !Number.isFinite(total) || total <= 0) {
      return 0;
    }

    const remainingUnit = String(line.dataRemaining).toUpperCase().includes("GB") ? "GB" : "MB";
    const totalUnit = String(line.dataTotal).toUpperCase().includes("GB") ? "GB" : "MB";

    const remainingMb = remainingUnit === "GB" ? remaining * 1024 : remaining;
    const totalMb = totalUnit === "GB" ? total * 1024 : total;

    return Math.max(0, Math.min(100, (remainingMb / totalMb) * 100));
  }

  function createShell() {
    if (document.getElementById("tello-line-dashboard")) return;

    const shell = document.createElement("div");
    shell.id = "tello-line-dashboard";

    shell.innerHTML = `
      <div class="tello-dash-header">
        <div>
          <div class="tello-dash-title">Tello Line Dashboard</div>
          <div class="tello-dash-subtitle">Saved accounts + phone lines</div>
        </div>

        <div class="tello-dash-actions">
          <button id="tello-scan-account-btn">Scan this account</button>
          <button id="tello-clear-data-btn">Clear</button>
          <button id="tello-minimize-btn">−</button>
        </div>
      </div>

      <div id="tello-dashboard-body"></div>
    `;

    document.body.appendChild(shell);

    document
      .getElementById("tello-scan-account-btn")
      .addEventListener("click", scanCurrentAccount);

    document
      .getElementById("tello-clear-data-btn")
      .addEventListener("click", clearSavedData);

    document
      .getElementById("tello-minimize-btn")
      .addEventListener("click", () => {
        shell.classList.toggle("tello-minimized");
      });
  }

  async function renderDashboard() {
    createShell();

    const body = document.getElementById("tello-dashboard-body");
    const accounts = await getSavedAccounts();

    if (!accounts.length) {
      body.innerHTML = `
        <div class="tello-empty">
          No saved lines yet. Log into a Tello account, then click <b>Scan this account</b>.
        </div>
      `;
      return;
    }

    body.innerHTML = accounts
      .map((account) => {
        const linesHtml = account.lines
          .map((line) => {
            const percent = getDataPercent(line);

            return `
              <div class="tello-line-card">
                <div class="tello-line-top">
                  <div>
                    <div class="tello-phone">${line.phone}</div>
                    <div class="tello-plan">${line.plan}</div>
                  </div>
                  <div class="tello-price">${line.price}</div>
                </div>

                <div class="tello-data-row">
                  <div>
                    <div class="tello-data-main">${line.dataRemaining}</div>
                    <div class="tello-data-sub">remaining / ${line.dataTotal}</div>
                  </div>
                  <div class="tello-texts">${line.texts}</div>
                </div>

                <div class="tello-progress">
                  <span style="width: ${percent}%;"></span>
                </div>

                <div class="tello-meta">
                  <span>Renewal: ${line.renewalDate}</span>
                  <span>Updated: ${new Date(line.lastScanned).toLocaleString()}</span>
                </div>
              </div>
            `;
          })
          .join("");

        return `
          <section class="tello-account-section">
            <div class="tello-account-title">
              <span>${account.label}</span>
              <small>${account.lineCount} line(s)</small>
            </div>
            ${linesHtml}
          </section>
        `;
      })
      .join("");
  }

  function init() {
    createShell();
    renderDashboard();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();