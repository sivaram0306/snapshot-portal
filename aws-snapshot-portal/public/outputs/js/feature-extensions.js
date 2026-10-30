/* =========================================================
   feature-extensions.js
   Additive features for the AWS Snapshot Portal.

   Existing functions (app.js) are not edited. Where a feature
   needs to observe app behaviour it wraps a global function
   (toast, renderSnapshots) and calls the original.

   Features:
   1. Activity log page (records toast notifications in this browser)
   2. Estimated monthly storage cost card on the dashboard
   3. "Older than N days" filter on the Snapshots page
========================================================= */

(function () {
    "use strict";

    /* ---------------- shared helpers ---------------- */

    function $(id) {
        return document.getElementById(id);
    }

    function esc(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function readJson(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function writeJson(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            /* storage unavailable; feature degrades gracefully */
        }
    }

    function currentAccountName() {
        if (typeof state === "undefined" || !Array.isArray(state.accounts)) return "";
        const account = state.accounts.find((a) => a && a.id === state.activeAccountId);
        return account ? account.name : "";
    }

    function currentPageId() {
        return typeof state !== "undefined" ? state.currentPage : "";
    }

    /* =====================================================
       1. ACTIVITY LOG
    ===================================================== */

    const ACTIVITY_KEY = "awsPortalActivityLog";
    const ACTIVITY_MAX = 200;

    function readActivity() {
        return readJson(ACTIVITY_KEY, []);
    }

    function recordActivity(message, type) {
        const entries = readActivity();

        entries.push({
            at: new Date().toISOString(),
            message: String(message ?? ""),
            type: ["success", "error", "warning"].includes(type) ? type : "info",
            account: currentAccountName()
        });

        writeJson(ACTIVITY_KEY, entries.slice(-ACTIVITY_MAX));

        if (currentPageId() === "activity") {
            renderActivity();
        }
    }

    // Wrap the global toast so every notification is logged, then call the original.
    function installToastLogger() {
        const original = window.toast;
        if (typeof original !== "function" || original.__featureWrapped) return;

        const wrapped = function (message, type = "info") {
            try {
                recordActivity(message, type);
            } catch (e) {
                /* logging must never block the notification */
            }
            return original.call(this, message, type);
        };

        wrapped.__featureWrapped = true;
        window.toast = wrapped;
    }

    function buildActivityPage() {
        if ($("activity")) return;

        const navAnchor = document.querySelector('.navigation [data-page="revert-snapshot"]');
        if (navAnchor) {
            const navBtn = document.createElement("button");
            navBtn.className = "nav-item";
            navBtn.type = "button";
            navBtn.dataset.page = "activity";
            navBtn.innerHTML = "<span>≡</span>Activity";
            navBtn.addEventListener("click", () => {
                showPage("activity");
                if ($("page-title")) $("page-title").textContent = "Activity";
                renderActivity();
            });
            navAnchor.after(navBtn);
        }

        const section = document.createElement("section");
        section.id = "activity";
        section.className = "page";
        section.innerHTML = `
            <div class="page-toolbar">
                <div>
                    <h2>Activity</h2>
                    <p>Notifications from this browser, newest first. Stored locally, not shared.</p>
                </div>
                <div class="toolbar-actions">
                    <select id="activity-filter" class="age-filter" aria-label="Filter activity">
                        <option value="all">All</option>
                        <option value="success">Success</option>
                        <option value="error">Errors</option>
                        <option value="warning">Warnings</option>
                        <option value="info">Info</option>
                    </select>
                    <button id="activity-export" class="btn secondary" type="button">Export CSV</button>
                    <button id="activity-clear" class="btn secondary" type="button">Clear log</button>
                </div>
            </div>
            <div id="activity-list" class="table-container"></div>`;

        const revertPage = $("revert-snapshot");
        if (revertPage) {
            revertPage.after(section);
        } else {
            document.querySelector("main")?.appendChild(section);
        }

        $("activity-filter").addEventListener("change", renderActivity);
        $("activity-export").addEventListener("click", exportActivity);
        $("activity-clear").addEventListener("click", clearActivity);
    }

    function renderActivity() {
        const list = $("activity-list");
        if (!list) return;

        const filter = $("activity-filter")?.value || "all";

        const entries = readActivity()
            .filter((e) => filter === "all" || e.type === filter)
            .reverse();

        if (entries.length === 0) {
            list.innerHTML = `<div class="empty-state small">No activity recorded yet.</div>`;
            return;
        }

        list.innerHTML = `
            <ul class="activity-feed">
                ${entries.map((e) => `
                    <li class="activity-item ${esc(e.type)}">
                        <span class="activity-dot" aria-hidden="true"></span>
                        <div class="activity-body">
                            <div class="activity-msg">${esc(e.message)}</div>
                            <div class="activity-meta">
                                ${esc(new Date(e.at).toLocaleString())}${e.account ? " · " + esc(e.account) : ""}
                            </div>
                        </div>
                        <span class="activity-type">${esc(e.type)}</span>
                    </li>`).join("")}
            </ul>`;
    }

    function exportActivity() {
        const entries = readActivity();

        if (entries.length === 0) {
            if (typeof toast === "function") toast("Activity log is empty.", "error");
            return;
        }

        const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const lines = [["time", "type", "account", "message"].join(",")].concat(
            entries.map((e) => [e.at, e.type, e.account, e.message].map(csvCell).join(","))
        );

        const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");

        link.href = url;
        link.download = `activity-log-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function clearActivity() {
        if (!window.confirm("Clear the activity log stored in this browser?")) return;
        writeJson(ACTIVITY_KEY, []);
        renderActivity();
    }

    /* =====================================================
       2. ESTIMATED STORAGE COST CARD
    ===================================================== */

    // USD per GB-month, US East (N. Virginia) on-demand list prices.
    // Regional prices differ. Check the AWS pricing page and edit here.
    const EBS_RATES_USD_PER_GB_MONTH = {
        gp2: 0.10,
        gp3: 0.08,
        io1: 0.125,
        io2: 0.125,
        st1: 0.045,
        sc1: 0.015,
        standard: 0.05
    };

    const SNAPSHOT_RATE_USD_PER_GB_MONTH = 0.05;

    const usd = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2
    });

    function computeCosts() {
        const volumes = typeof state !== "undefined" && Array.isArray(state.volumes) ? state.volumes : [];
        const snapshots = typeof state !== "undefined" && Array.isArray(state.snapshots) ? state.snapshots : [];

        const byType = {};
        let volumeTotal = 0;

        volumes.forEach((volume) => {
            const type = volume?.type || "unknown";
            const size = Number(volume?.size) || 0;
            const rate = EBS_RATES_USD_PER_GB_MONTH[type];
            const cost = rate ? size * rate : 0;

            if (!byType[type]) {
                byType[type] = { gb: 0, cost: 0, rate: rate || null };
            }

            byType[type].gb += size;
            byType[type].cost += cost;
            volumeTotal += cost;
        });

        const snapshotGb = snapshots.reduce((sum, s) => sum + (Number(s?.size) || 0), 0);
        const snapshotCost = snapshotGb * SNAPSHOT_RATE_USD_PER_GB_MONTH;

        return {
            byType,
            volumeTotal,
            snapshotGb,
            snapshotCost,
            total: volumeTotal + snapshotCost
        };
    }

    function buildCostCard() {
        if ($("cost-card")) return;

        const grid = document.querySelector("#dashboard .dashboard-grid");
        if (!grid) return;

        const card = document.createElement("div");
        card.id = "cost-card";
        card.className = "content-card cost-card";
        grid.appendChild(card);
    }

    function renderCostCard() {
        const card = $("cost-card");
        if (!card) return;

        const costs = computeCosts();

        const typeRows = Object.keys(costs.byType)
            .sort((a, b) => costs.byType[b].cost - costs.byType[a].cost)
            .map((type) => {
                const row = costs.byType[type];
                const rate = row.rate ? usd.format(row.rate) + "/GB" : "no rate";
                return `
                    <tr>
                        <td>${esc(type)}</td>
                        <td>${row.gb.toLocaleString()} GB</td>
                        <td>${esc(rate)}</td>
                        <td>${usd.format(row.cost)}</td>
                    </tr>`;
            })
            .join("");

        card.innerHTML = `
            <div class="card-header">
                <div>
                    <h3>Estimated Monthly Storage Cost</h3>
                    <p>Based on provisioned volume size and loaded snapshots</p>
                </div>
            </div>

            <div class="cost-total">
                <strong>${usd.format(costs.total)}</strong>
                <span>per month (estimate)</span>
            </div>

            ${typeRows
                ? `<table class="cost-table">
                        <thead>
                            <tr><th>Volume type</th><th>Size</th><th>Rate</th><th>Monthly</th></tr>
                        </thead>
                        <tbody>${typeRows}</tbody>
                   </table>`
                : `<div class="empty-state small">Load volumes to see an estimate.</div>`}

            <div class="cost-snapshots">
                Snapshots: ${costs.snapshotGb.toLocaleString()} GB × ${usd.format(SNAPSHOT_RATE_USD_PER_GB_MONTH)}/GB
                = <strong>${usd.format(costs.snapshotCost)}</strong>
            </div>

            <small class="cost-note">
                US East list prices in USD; other regions differ. Volume types without a listed rate are excluded.
                Snapshot charges are based on stored, incremental data, so actual cost is usually lower than this upper-bound estimate.
            </small>`;
    }

    /* =====================================================
       3. SNAPSHOT AGE FILTER
    ===================================================== */

    const AGE_OPTIONS = [
        ["0", "Any age"],
        ["7", "Older than 7 days"],
        ["30", "Older than 30 days"],
        ["90", "Older than 90 days"],
        ["365", "Older than 1 year"]
    ];

    function selectedAgeDays() {
        return Number($("snapshot-age-filter")?.value || 0);
    }

    function applyAgeFilter(snapshots) {
        const days = selectedAgeDays();
        if (!days) return snapshots;

        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

        return snapshots.filter((snapshot) => {
            const started = Date.parse(snapshot?.startTime);
            return !Number.isNaN(started) && started <= cutoff;
        });
    }

    function buildAgeFilter() {
        const bar = document.querySelector("#snapshots .filter-bar");
        if (!bar || $("snapshot-age-filter")) return;

        const select = document.createElement("select");
        select.id = "snapshot-age-filter";
        select.className = "age-filter";
        select.setAttribute("aria-label", "Filter snapshots by age");
        select.innerHTML = AGE_OPTIONS
            .map(([value, label]) => `<option value="${value}">${label}</option>`)
            .join("");

        const count = $("snapshot-result-count");
        if (count && count.parentElement === bar) {
            bar.insertBefore(select, count);
        } else {
            bar.appendChild(select);
        }

        select.addEventListener("change", () => {
            if (typeof searchSnapshots === "function") searchSnapshots();
        });
    }

    // Wrap renderSnapshots so every render path (search, polling, reload) respects the age filter.
    function installSnapshotAgeWrapper() {
        const original = window.renderSnapshots;
        if (typeof original !== "function" || original.__featureWrapped) return;

        const wrapped = function (snapshots) {
            const list = Array.isArray(snapshots) ? snapshots : [];
            const filtered = applyAgeFilter(list);
            const result = original.call(this, filtered);

            if (selectedAgeDays() > 0 && $("snapshot-result-count")) {
                const n = filtered.length;
                $("snapshot-result-count").textContent = `${n} result${n === 1 ? "" : "s"}`;
            }

            return result;
        };

        wrapped.__featureWrapped = true;
        window.renderSnapshots = wrapped;
    }

    /* =====================================================
       DATA WATCHERS
       The cost card follows whatever app.js last loaded,
       without needing to edit the loaders.
    ===================================================== */

    let costRenderQueued = false;

    function queueCostRender() {
        if (costRenderQueued) return;
        costRenderQueued = true;

        requestAnimationFrame(() => {
            costRenderQueued = false;
            renderCostCard();
        });
    }

    function watchDataSources() {
        const ids = ["volume-count", "snapshot-count", "volumes-table", "snapshots-table"];

        const observer = new MutationObserver(queueCostRender);

        ids.forEach((id) => {
            const el = $(id);
            if (el) {
                observer.observe(el, { childList: true, subtree: true, characterData: true });
            }
        });
    }

    /* =====================================================
       INIT
    ===================================================== */

    function init() {
        installToastLogger();
        installSnapshotAgeWrapper();

        buildActivityPage();
        buildAgeFilter();
        buildCostCard();

        renderActivity();
        renderCostCard();
        watchDataSources();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();

