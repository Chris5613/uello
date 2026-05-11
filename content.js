(function () {
  "use strict";

  const STORAGE_KEY = "tello_saved_accounts";
  const SCAN_STATE_KEY = "tello_scan_state";

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function findPhoneDropdown() {
    return (
      document.querySelector('select[name="selected_subscription_id"]') ||
      document.querySelector("select.original-number") ||
      document.querySelector("select.js_onchange_submit")
    );
  }

  function getSelectedPhone(dropdown) {
    const selected = dropdown?.selectedOptions?.[0];
    return cleanText(selected?.textContent || "Unknown line");
  }

  function getDropdownOptions(dropdown) {
    return [...dropdown.options]
      .filter((option) => option.value)
      .map((option, index) => ({
        index,
        value: option.value,
        label: cleanText(option.textContent)
      }));
  }

  function getPageText() {
    return cleanText(document.body.innerText || document.body.textContent || "");
  }

  function extractLineData() {
    const text = getPageText();

    const remainingMatch =
      text.match(/([\d.]+)\s*(MB|GB)\s+remaining\s*\/\s*([\d.]+)\s*(MB|GB)/i) ||
      text.match(/([\d.]+)\s*(MB|GB).*?remaining.*?\/\s*([\d.]+)\s*(MB|GB)/i);

    const renewalMatch =
      text.match(/Renewal date:\s*([0-9/]+)/i) ||
      text.match(/automatically charged.*?([0-9/]+)/i);

    const priceMatch =
      text.match(/\$\s*\d+(?:\.\d{2})?/);

    let dataRemaining = "Unknown";
    let dataTotal = "Unknown";

    if (remainingMatch) {
      dataRemaining = `${remainingMatch[1]} ${remainingMatch[2]}`;
      dataTotal = `${remainingMatch[3]} ${remainingMatch[4]}`;
    } else {
      const simpleDataMatch = text.match(/Remaining balance\s+([\d.]+)\s*(MB|GB)/i);
      if (simpleDataMatch) {
        dataRemaining = `${simpleDataMatch[1]} ${simpleDataMatch[2]}`;
      }

      const totalMatch = text.match(/\/\s*([\d.]+)\s*(MB|GB)/i);
      if (totalMatch) {
        dataTotal = `${totalMatch[1]} ${totalMatch[2]}`;
      }
    }

    const planMatch =
      text.match(/My Plan\s+([\d.]+\s*GB).*?(Unlimited text|Unlimited texts)/i) ||
      text.match(/([\d.]+\s*GB).*?(Unlimited text|Unlimited texts)/i);

    return {
      dataRemaining,
      dataTotal,
      texts: /Unlimited texts?/i.test(text) ? "Unlimited texts" : "Unknown",
      renewalDate: renewalMatch ? renewalMatch[1] : "Unknown",
      plan: planMatch ? `${cleanText(planMatch[1])} Data + ${cleanText(planMatch[2])}` : "Unknown",
      price: priceMatch ? priceMatch[0] : "Unknown",
      lastScanned: new Date().toISOString()
    };
  }

  async function chromeGet(key, fallback) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => {
        resolve(result[key] ?? fallback);
      });
    });
  }

  async function chromeSet(data) {
    return new Promise((resolve) => {
      chrome.storage.local.set(data, resolve);
    });
  }

  async function saveLineToAccount(accountLabel, phone, lineData) {
    const accounts = await chromeGet(STORAGE_KEY, []);
    const accountId = accountLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_");

    let account = accounts.find((item) => item.accountId === accountId);

    if (!account) {
      account = {
        accountId,
        label: accountLabel,
        lines: [],
        lineCount: 0,
        lastScanned: new Date().toISOString()
      };
      accounts.push(account);
    }

    const existingIndex = account.lines.findIndex((line) => line.phone === phone);

    const savedLine = {
      phone,
      ...lineData
    };

    if (existingIndex >= 0) {
      account.lines[existingIndex] = savedLine;
    } else {
      account.lines.push(savedLine);
    }

    account.lineCount = account.lines.length;
    account.lastScanned = new Date().toISOString();

    await chromeSet({ [STORAGE_KEY]: accounts });
  }

  async function startScan() {
    const dropdown = findPhoneDropdown();

    if (!dropdown) {
      alert("Could not find the Tello number dropdown.");
      return;
    }

    const accountLabel =
      prompt("Name this Tello account:", "Tello Account") || "Tello Account";

    const options = getDropdownOptions(dropdown);

    if (!options.length) {
      alert("No phone numbers found in the dropdown.");
      return;
    }

    await chromeSet({
      [SCAN_STATE_KEY]: {
        active: true,
        accountLabel,
        options,
        currentIndex: 0
      }
    });

    alert("Scan started. The page may reload as it switches numbers.");

    await continueScan();
  }

  async function continueScan() {
    const state = await chromeGet(SCAN_STATE_KEY, null);
    if (!state || !state.active) return;

    const dropdown = findPhoneDropdown();
    if (!dropdown) return;

    await sleep(1600);

    const selectedValue = dropdown.value;
    const selectedPhone = getSelectedPhone(dropdown);
    const lineData = extractLineData();

    await saveLineToAccount(state.accountLabel, selectedPhone, lineData);

    const currentOptionIndex = state.options.findIndex(
      (option) => option.value === selectedValue
    );

    const nextIndex =
      currentOptionIndex >= 0 ? currentOptionIndex + 1 : state.currentIndex + 1;

    if (nextIndex >= state.options.length) {
      await chromeSet({
        [SCAN_STATE_KEY]: {
          active: false,
          accountLabel: state.accountLabel,
          options: state.options,
          currentIndex: nextIndex
        }
      });

      renderDashboard();
      alert(`Finished scanning ${state.accountLabel}.`);
      return;
    }

    const nextOption = state.options[nextIndex];

    await chromeSet({
      [SCAN_STATE_KEY]: {
        ...state,
        currentIndex: nextIndex
      }
    });

    dropdown.value = nextOption.value;

    dropdown.dispatchEvent(new Event("change", { bubbles: true }));

    const form = dropdown.closest("form");
    if (form) {
      form.submit();
    }
  }

  async function clearSavedData() {
    const confirmed = confirm("Clear all saved Tello account data?");
    if (!confirmed) return;

    await chromeSet({
      [STORAGE_KEY]: [],
      [SCAN_STATE_KEY]: null
    });

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
          <button id="tello-scan-account-btn" type="button">Scan this account</button>
          <button id="tello-clear-data-btn" type="button">Clear</button>
          <button id="tello-minimize-btn" type="button">−</button>
        </div>
      </div>

      <div id="tello-dashboard-body"></div>
    `;

    document.documentElement.appendChild(shell);

    document
      .getElementById("tello-scan-account-btn")
      .addEventListener("click", startScan);

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
    const accounts = await chromeGet(STORAGE_KEY, []);

    if (!accounts.length) {
      body.innerHTML = `
        <div class="tello-empty">
          No saved lines yet. Click <b>Scan this account</b>.
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

  async function init() {
    createShell();
    await renderDashboard();

    setTimeout(() => {
      continueScan();
    }, 1200);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();