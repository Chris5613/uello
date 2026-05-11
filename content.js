(function () {
  "use strict";

  const DEBUG = true;
  const LOG = "[TelloDash]";
  const STORAGE_KEY = "tello_saved_accounts";
  const SCAN_STATE_KEY = "tello_scan_state";

  function log(...args) {
    if (DEBUG) console.log(LOG, ...args);
  }

  function warn(...args) {
    console.warn(LOG, ...args);
  }

  function error(...args) {
    console.error(LOG, ...args);
  }

  log("content.js loaded", {
    href: location.href,
    readyState: document.readyState
  });

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function findPhoneDropdown() {
    log("Searching for phone dropdown...");

    const byName = document.querySelector('select[name="selected_subscription_id"]');
    const byOriginalNumber = document.querySelector("select.original-number");
    const byChangeSubmit = document.querySelector("select.js_onchange_submit");

    log("Dropdown selector results", {
      byName,
      byOriginalNumber,
      byChangeSubmit,
      allSelects: [...document.querySelectorAll("select")].map((select) => ({
        name: select.name,
        className: select.className,
        value: select.value,
        options: [...select.options].map((option) => ({
          value: option.value,
          text: cleanText(option.textContent)
        }))
      }))
    });

    return byName || byOriginalNumber || byChangeSubmit;
  }

  function getSelectedPhone(dropdown) {
    const selected = dropdown?.selectedOptions?.[0];
    const phone = cleanText(selected?.textContent || "Unknown line");
    log("Selected phone detected:", phone);
    return phone;
  }

  function getDropdownOptions(dropdown) {
    const options = [...dropdown.options]
      .filter((option) => option.value)
      .map((option, index) => ({
        index,
        value: option.value,
        label: cleanText(option.textContent)
      }));

    log("Dropdown options found:", options);
    return options;
  }

  function getPageText() {
    const text = cleanText(document.body.innerText || document.body.textContent || "");
    log("Page text length:", text.length);
    log("Page text preview:", text.slice(0, 700));
    return text;
  }

  function extractLineData() {
    log("Extracting line data...");

    const text = getPageText();

    const remainingMatch =
      text.match(/([\d.]+)\s*(MB|GB)\s+remaining\s*\/\s*([\d.]+)\s*(MB|GB)/i) ||
      text.match(/([\d.]+)\s*(MB|GB).*?remaining.*?\/\s*([\d.]+)\s*(MB|GB)/i);

    const renewalMatch =
      text.match(/Renewal date:\s*([0-9/]+)/i) ||
      text.match(/automatically charged.*?([0-9/]+)/i);

    const priceMatch = text.match(/\$\s*\d+(?:\.\d{2})?/);

    let dataRemaining = "Unknown";
    let dataTotal = "Unknown";

    if (remainingMatch) {
      log("Matched remaining data:", remainingMatch);

      dataRemaining = `${remainingMatch[1]} ${remainingMatch[2]}`;
      dataTotal = `${remainingMatch[3]} ${remainingMatch[4]}`;
    } else {
      warn("No full remaining data match found.");

      const simpleDataMatch = text.match(/Remaining balance\s+([\d.]+)\s*(MB|GB)/i);
      const totalMatch = text.match(/\/\s*([\d.]+)\s*(MB|GB)/i);

      log("Fallback data matches", {
        simpleDataMatch,
        totalMatch
      });

      if (simpleDataMatch) {
        dataRemaining = `${simpleDataMatch[1]} ${simpleDataMatch[2]}`;
      }

      if (totalMatch) {
        dataTotal = `${totalMatch[1]} ${totalMatch[2]}`;
      }
    }

    const planMatch =
      text.match(/My Plan\s+([\d.]+\s*GB).*?(Unlimited text|Unlimited texts)/i) ||
      text.match(/([\d.]+\s*GB).*?(Unlimited text|Unlimited texts)/i);

    const result = {
      dataRemaining,
      dataTotal,
      texts: /Unlimited texts?/i.test(text) ? "Unlimited texts" : "Unknown",
      renewalDate: renewalMatch ? renewalMatch[1] : "Unknown",
      plan: planMatch ? `${cleanText(planMatch[1])} Data + ${cleanText(planMatch[2])}` : "Unknown",
      price: priceMatch ? priceMatch[0] : "Unknown",
      lastScanned: new Date().toISOString()
    };

    log("Extracted line data result:", result);
    return result;
  }

  async function chromeGet(key, fallback) {
    log("chromeGet:", key);

    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => {
        log("chromeGet result:", key, result);
        resolve(result[key] ?? fallback);
      });
    });
  }

  async function chromeSet(data) {
    log("chromeSet:", data);

    return new Promise((resolve) => {
      chrome.storage.local.set(data, () => {
        if (chrome.runtime.lastError) {
          error("chromeSet error:", chrome.runtime.lastError);
        } else {
          log("chromeSet complete");
        }

        resolve();
      });
    });
  }

  async function saveLineToAccount(accountLabel, phone, lineData) {
    log("Saving line to account", {
      accountLabel,
      phone,
      lineData
    });

    const accounts = await chromeGet(STORAGE_KEY, []);
    const accountId = accountLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_");

    let account = accounts.find((item) => item.accountId === accountId);

    if (!account) {
      log("Creating new account object:", accountId);

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
      log("Updating existing line:", phone);
      account.lines[existingIndex] = savedLine;
    } else {
      log("Adding new line:", phone);
      account.lines.push(savedLine);
    }

    account.lineCount = account.lines.length;
    account.lastScanned = new Date().toISOString();

    await chromeSet({ [STORAGE_KEY]: accounts });

    log("Saved account data:", account);
  }

  async function startScan() {
    log("Scan button clicked.");

    try {
      const dropdown = findPhoneDropdown();

      if (!dropdown) {
        warn("Could not find dropdown.");
        alert("Could not find the Tello number dropdown.");
        return;
      }

      log("Found dropdown:", dropdown);

      const accountLabel =
        prompt("Name this Tello account:", "Tello Account") || "Tello Account";

      log("Account label:", accountLabel);

      const options = getDropdownOptions(dropdown);

      if (!options.length) {
        warn("No dropdown options found.");
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

      log("Scan state saved. Starting continueScan...");

      await continueScan();
    } catch (err) {
      error("startScan failed:", err);
      alert("Scan failed. Check console logs.");
    }
  }

  async function continueScan() {
    log("continueScan called.");

    try {
      const state = await chromeGet(SCAN_STATE_KEY, null);

      log("Loaded scan state:", state);

      if (!state || !state.active) {
        log("No active scan. Stopping continueScan.");
        return;
      }

      const dropdown = findPhoneDropdown();

      if (!dropdown) {
        warn("continueScan could not find dropdown.");
        return;
      }

      log("Waiting before scrape...");
      await sleep(1800);

      const selectedValue = dropdown.value;
      const selectedPhone = getSelectedPhone(dropdown);
      const lineData = extractLineData();

      log("Current dropdown value:", selectedValue);
      log("Saving current line...");

      await saveLineToAccount(state.accountLabel, selectedPhone, lineData);

      const currentOptionIndex = state.options.findIndex(
        (option) => option.value === selectedValue
      );

      const nextIndex =
        currentOptionIndex >= 0 ? currentOptionIndex + 1 : state.currentIndex + 1;

      log("Index info:", {
        currentOptionIndex,
        storedCurrentIndex: state.currentIndex,
        nextIndex,
        totalOptions: state.options.length
      });

      if (nextIndex >= state.options.length) {
        log("Scan finished.");

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

      log("Next option:", nextOption);

      await chromeSet({
        [SCAN_STATE_KEY]: {
          ...state,
          currentIndex: nextIndex
        }
      });

      log("Changing dropdown value to:", nextOption.value);

      dropdown.value = nextOption.value;

      dropdown.dispatchEvent(new Event("input", { bubbles: true }));
      dropdown.dispatchEvent(new Event("change", { bubbles: true }));

      const form = dropdown.closest("form");

      log("Closest form:", form);

      if (form) {
        log("Submitting form to switch number...");
        form.submit();
      } else {
        warn("No form found. Dropdown change event fired but page may not reload.");
      }
    } catch (err) {
      error("continueScan failed:", err);
      alert("continueScan failed. Check console logs.");
    }
  }

  async function clearSavedData() {
    log("Clear button clicked.");

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
    log("createShell called.");

    if (document.getElementById("tello-line-dashboard")) {
      log("Shell already exists.");
      return;
    }

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
    log("Shell appended.");

    const scanBtn = document.getElementById("tello-scan-account-btn");
    const clearBtn = document.getElementById("tello-clear-data-btn");
    const minimizeBtn = document.getElementById("tello-minimize-btn");

    log("Buttons found:", {
      scanBtn,
      clearBtn,
      minimizeBtn
    });

    scanBtn?.addEventListener("click", startScan);
    clearBtn?.addEventListener("click", clearSavedData);
    minimizeBtn?.addEventListener("click", () => {
      log("Minimize clicked.");
      shell.classList.toggle("tello-minimized");
    });
  }

  async function renderDashboard() {
    log("renderDashboard called.");

    createShell();

    const body = document.getElementById("tello-dashboard-body");
    const accounts = await chromeGet(STORAGE_KEY, []);

    log("Accounts to render:", accounts);

    if (!body) {
      warn("Dashboard body not found.");
      return;
    }

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
    log("init called.");

    try {
      createShell();
      await renderDashboard();

      log("Scheduling continueScan after page load.");

      setTimeout(() => {
        log("Auto continueScan timeout fired.");
        continueScan();
      }, 1200);
    } catch (err) {
      error("init failed:", err);
    }
  }

  if (document.readyState === "loading") {
    log("Document loading. Waiting DOMContentLoaded.");
    document.addEventListener("DOMContentLoaded", init);
  } else {
    log("Document already ready. Running init now.");
    init();
  }
})();