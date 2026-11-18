/* =========================================================
   ui-enhancements.js
   Additive UX layer for the AWS Snapshot Portal.
   Does not modify app.js. It reacts to the DOM that app.js
   renders, so tables re-rendered by polling keep working.

   Features:
   - Dark / light theme toggle (remembered)
   - Collapsible sidebar and mobile navigation drawer
   - Command palette (Ctrl/Cmd+K)
   - Keyboard shortcuts: "/" focus search, "[" toggle sidebar, "?" help
   - Sortable table columns (click headers, keyboard accessible)
   - Click-to-copy for resource IDs
   - Export visible table rows to CSV (respects active search filter)
   - Dashboard quick-action shortcuts
========================================================= */

(function () {
    "use strict";

    /* ---------------- helpers ---------------- */

    const KEYS = {
        theme: "awsPortalTheme",
        collapsed: "awsPortalSidebarCollapsed"
    };

    const MOBILE_MAX = 900;

    function $(selector, root = document) {
        return root.querySelector(selector);
    }

    function $$(selector, root = document) {
        return Array.from(root.querySelectorAll(selector));
    }

    function getStored(key) {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    function setStored(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (e) {
            /* storage unavailable (private mode, etc.): feature still works */
        }
    }

    function isMobile() {
        return window.innerWidth <= MOBILE_MAX;
    }

    function isTyping(target) {
        if (!target) return false;
        const tag = target.tagName;
        return (
            tag === "INPUT" ||
            tag === "TEXTAREA" ||
            tag === "SELECT" ||
            target.isContentEditable
        );
    }

    function activePage() {
        return $(".page.active");
    }

    function notify(message, type = "info") {
        const el = $("#toast");
        if (!el) return;

        el.textContent = message;
        el.className = `toast show ${type}`;

        clearTimeout(notify.timer);
        notify.timer = setTimeout(() => {
            el.classList.remove("show");
        }, 2600);
    }

    /* ---------------- theme ---------------- */

    function setTheme(mode) {
        document.documentElement.setAttribute("data-theme", mode);
        setStored(KEYS.theme, mode);

        const btn = $("#theme-toggle");
        if (btn) {
            const isDark = mode === "dark";
            btn.textContent = isDark ? "☀" : "☾";
            btn.setAttribute(
                "aria-label",
                isDark ? "Switch to light mode" : "Switch to dark mode"
            );
        }
    }

    function initTheme() {
        const saved = getStored(KEYS.theme);
        const prefersDark =
            window.matchMedia &&
            window.matchMedia("(prefers-color-scheme: dark)").matches;

        setTheme(saved || (prefersDark ? "dark" : "light"));

        const btn = $("#theme-toggle");
        if (btn) {
            btn.addEventListener("click", () => {
                const current =
                    document.documentElement.getAttribute("data-theme");
                setTheme(current === "dark" ? "light" : "dark");
            });
        }
    }

    /* ---------------- sidebar ---------------- */

    function setCollapsed(on) {
        document.body.classList.toggle("sidebar-collapsed", on);
        setStored(KEYS.collapsed, on ? "1" : "0");

        const btn = $("#sidebar-toggle");
        if (btn) {
            btn.setAttribute("aria-expanded", String(!on));
            btn.setAttribute(
                "aria-label",
                on ? "Expand sidebar" : "Collapse sidebar"
            );
        }
    }

    function setNavOpen(on) {
        document.body.classList.toggle("nav-open", on);

        const btn = $("#menu-toggle");
        if (btn) {
            btn.setAttribute("aria-expanded", String(on));
        }
    }

    function toggleSidebar() {
        if (isMobile()) {
            setNavOpen(!document.body.classList.contains("nav-open"));
        } else {
            setCollapsed(!document.body.classList.contains("sidebar-collapsed"));
        }
    }

    function initSidebar() {
        if (!isMobile()) {
            setCollapsed(getStored(KEYS.collapsed) === "1");
        }

        const menu = $("#menu-toggle");
        if (menu) {
            menu.addEventListener("click", () => setNavOpen(true));
        }

        const sidebarBtn = $("#sidebar-toggle");
        if (sidebarBtn) {
            sidebarBtn.addEventListener("click", () => {
                if (isMobile()) {
                    setNavOpen(false);
                } else {
                    setCollapsed(
                        !document.body.classList.contains("sidebar-collapsed")
                    );
                }
            });
        }

        const backdrop = $("#nav-backdrop");
        if (backdrop) {
            backdrop.addEventListener("click", () => setNavOpen(false));
        }

        // Close the mobile drawer after picking a page.
        document.addEventListener("click", (event) => {
            if (event.target.closest(".nav-item")) {
                setNavOpen(false);
            }
        });
    }

    /* ---------------- command palette ---------------- */

    let palette = null;
    let paletteInput = null;
    let paletteList = null;
    let paletteItems = [];
    let paletteIndex = 0;

    function commands() {
        const list = [];

        $$(".nav-item[data-page]").forEach((btn) => {
            list.push({
                group: "Go to",
                label: btn.textContent.replace(/[^\p{L}\p{N}\s]/gu, "").trim(),
                hint: btn.dataset.page,
                run: () => btn.click()
            });
        });

        list.push({
            group: "Actions",
            label: "Manage AWS accounts",
            run: () => $("#open-credentials")?.click()
        });

        list.push({
            group: "Actions",
            label: "Toggle dark mode",
            run: () => $("#theme-toggle")?.click()
        });

        list.push({
            group: "Actions",
            label: "Toggle sidebar",
            run: () => toggleSidebar()
        });

        list.push({
            group: "Actions",
            label: "Keyboard shortcuts",
            run: () => openHelp()
        });

        const page = activePage();
        if (page) {
            const refresh = $$(".btn", page).find((b) =>
                /refresh/i.test(b.textContent)
            );

            if (refresh) {
                list.push({
                    group: "This page",
                    label: `Refresh ${page.querySelector("h2, h1")?.textContent.trim() || "data"}`,
                    run: () => refresh.click()
                });
            }

            if (EXPORT_PAGES.includes(page.id)) {
                list.push({
                    group: "This page",
                    label: "Export table as CSV",
                    run: () => exportPage(page.id)
                });
            }

            const search = $('input[type="search"]', page);
            if (search) {
                list.push({
                    group: "This page",
                    label: "Focus search",
                    run: () => search.focus()
                });
            }
        }

        return list;
    }

    function buildPalette() {
        palette = document.createElement("div");
        palette.className = "cmdk-overlay";
        palette.innerHTML = `
            <div class="cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
                <input class="cmdk-input" type="text"
                       placeholder="Type a page or command..."
                       aria-controls="cmdk-list" aria-autocomplete="list"
                       autocomplete="off">
                <div id="cmdk-list" class="cmdk-list" role="listbox"></div>
                <div class="cmdk-footer">
                    <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
                    <span><kbd>Enter</kbd> run</span>
                    <span><kbd>Esc</kbd> close</span>
                </div>
            </div>`;

        document.body.appendChild(palette);

        paletteInput = palette.querySelector(".cmdk-input");
        paletteList = palette.querySelector(".cmdk-list");

        palette.addEventListener("mousedown", (event) => {
            if (event.target === palette) closePalette();
        });

        paletteInput.addEventListener("input", renderPalette);
        paletteInput.addEventListener("keydown", onPaletteKey);
    }

    function paletteOpen() {
        return palette && palette.classList.contains("show");
    }

    function openPalette() {
        if (!palette) return;
        palette.classList.add("show");
        paletteInput.value = "";
        renderPalette();
        paletteInput.focus();
    }

    function closePalette() {
        if (!palette) return;
        palette.classList.remove("show");
    }

    function renderPalette() {
        const terms = paletteInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);

        paletteItems = commands().filter((item) => {
            const haystack = `${item.group} ${item.label} ${item.hint || ""}`.toLowerCase();
            return terms.every((term) => haystack.includes(term));
        });

        paletteIndex = 0;
        paletteList.innerHTML = "";

        if (paletteItems.length === 0) {
            const empty = document.createElement("div");
            empty.className = "cmdk-empty";
            empty.textContent = "No matching commands";
            paletteList.appendChild(empty);
            return;
        }

        paletteItems.forEach((item, index) => {
            const row = document.createElement("div");
            row.className = "cmdk-item";
            row.id = `cmdk-opt-${index}`;
            row.setAttribute("role", "option");
            row.setAttribute("aria-selected", String(index === 0));

            const label = document.createElement("span");
            label.textContent = item.label;

            const group = document.createElement("small");
            group.textContent = item.group;

            row.append(label, group);
            row.addEventListener("click", () => runPaletteItem(index));
            paletteList.appendChild(row);
        });
    }

    function highlightPalette(index) {
        const rows = $$(".cmdk-item", paletteList);
        if (rows.length === 0) return;

        paletteIndex = (index + rows.length) % rows.length;

        rows.forEach((row, i) => {
            row.setAttribute("aria-selected", String(i === paletteIndex));
        });

        rows[paletteIndex].scrollIntoView({ block: "nearest" });
        paletteInput.setAttribute("aria-activedescendant", rows[paletteIndex].id);
    }

    function runPaletteItem(index) {
        const item = paletteItems[index];
        closePalette();
        if (item) item.run();
    }

    function onPaletteKey(event) {
        if (event.key === "ArrowDown") {
            event.preventDefault();
            highlightPalette(paletteIndex + 1);
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            highlightPalette(paletteIndex - 1);
        } else if (event.key === "Enter") {
            event.preventDefault();
            runPaletteItem(paletteIndex);
        } else if (event.key === "Escape") {
            event.preventDefault();
            closePalette();
        }
    }

    /* ---------------- keyboard shortcut help ---------------- */

    let help = null;

    const SHORTCUTS = [
        ["Command palette", ["Ctrl", "K"]],
        ["Focus search on this page", ["/"]],
        ["Toggle sidebar", ["["]],
        ["Show shortcuts", ["?"]],
        ["Close dialogs", ["Esc"]]
    ];

    function buildHelp() {
        help = document.createElement("div");
        help.className = "cmdk-overlay";
        help.id = "help-overlay";

        const rows = SHORTCUTS.map(([label, keys]) => {
            const keyHtml = keys.map((k) => `<kbd>${k}</kbd>`).join(" + ");
            return `<div class="help-row"><span>${label}</span><span class="help-keys">${keyHtml}</span></div>`;
        }).join("");

        help.innerHTML = `
            <div class="cmdk" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
                <div class="cmdk-head">
                    <span>Keyboard shortcuts</span>
                    <button class="icon-btn" type="button" aria-label="Close">×</button>
                </div>
                ${rows}
            </div>`;

        document.body.appendChild(help);

        help.querySelector(".icon-btn").addEventListener("click", closeHelp);
        help.addEventListener("mousedown", (event) => {
            if (event.target === help) closeHelp();
        });
    }

    function helpOpen() {
        return help && help.classList.contains("show");
    }

    function openHelp() {
        if (!help) return;
        closePalette();
        help.classList.add("show");
        help.querySelector(".icon-btn").focus();
    }

    function closeHelp() {
        if (help) help.classList.remove("show");
    }

    /* ---------------- sortable tables ---------------- */

    function cellText(row, index) {
        const cell = row.cells[index];
        return cell ? cell.textContent.trim() : "";
    }

    function numericValue(text) {
        const cleaned = text.replace(/,/g, "").trim();
        if (!/^-?\d+(\.\d+)?\s*(GB|GiB|TB|MB|%|ms)?$/i.test(cleaned)) return null;
        return parseFloat(cleaned);
    }

    function dateValue(text) {
        if (!/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}/.test(text)) return null;
        const time = Date.parse(text);
        return Number.isNaN(time) ? null : time;
    }

    function sortTable(table, index, direction) {
        const body = table.tBodies[0];
        if (!body) return;

        const columnCount = table.tHead?.rows[0]?.cells.length || 0;
        const rows = Array.from(body.rows);

        // Rows that do not fill the table (empty messages, spans) stay at the bottom.
        const dataRows = rows.filter((r) => r.cells.length >= columnCount);
        const extraRows = rows.filter((r) => r.cells.length < columnCount);

        dataRows.sort((a, b) => {
            const at = cellText(a, index);
            const bt = cellText(b, index);

            const an = numericValue(at);
            const bn = numericValue(bt);
            const ad = dateValue(at);
            const bd = dateValue(bt);

            let result;
            if (an !== null && bn !== null) {
                result = an - bn;
            } else if (ad !== null && bd !== null) {
                result = ad - bd;
            } else {
                result = at.localeCompare(bt, undefined, { numeric: true, sensitivity: "base" });
            }

            return direction === "asc" ? result : -result;
        });

        [...dataRows, ...extraRows].forEach((row) => body.appendChild(row));
    }

    function enhanceTables() {
        $$("main table").forEach((table) => {
            if (table.dataset.sortable === "1") return;
            table.dataset.sortable = "1";

            const headers = table.tHead ? Array.from(table.tHead.rows[0].cells) : [];

            headers.forEach((th, index) => {
                // Do not make action columns sortable.
                if (th.querySelector("button, input, select, a")) return;
                if (!th.textContent.trim()) return;

                th.classList.add("sortable");
                th.tabIndex = 0;

                const activate = () => {
                    const next =
                        th.getAttribute("aria-sort") === "ascending" ? "desc" : "asc";

                    headers.forEach((h) => h.removeAttribute("aria-sort"));
                    th.setAttribute(
                        "aria-sort",
                        next === "asc" ? "ascending" : "descending"
                    );

                    sortTable(table, index, next);
                };

                th.addEventListener("click", activate);
                th.addEventListener("keydown", (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        activate();
                    }
                });
            });
        });
    }

    /* ---------------- click to copy IDs ---------------- */

    const RESOURCE_ID = /^(i|vol|snap|ami|subnet|vpc|sg|eni|rtb)-[0-9a-f]{6,}$/i;

    function markCopyable(root) {
        $$("td", root).forEach((cell) => {
            if (cell.dataset.cp === "1") return;
            cell.dataset.cp = "1";

            const text = cell.textContent.trim();
            if (RESOURCE_ID.test(text)) {
                cell.classList.add("copyable");
                cell.title = "Click to copy";
            }
        });
    }

    async function copyCell(cell) {
        const text = cell.textContent.trim();

        try {
            await navigator.clipboard.writeText(text);
            notify(`Copied ${text}`, "success");
        } catch (error) {
            notify("Could not copy. Clipboard access may be blocked.", "error");
        }
    }

    /* ---------------- CSV export ---------------- */

    const EXPORT_PAGES = ["instances", "volumes", "snapshots", "snapshot-dashboard"];

    function addExportButtons() {
        EXPORT_PAGES.forEach((id) => {
            const page = document.getElementById(id);
            const bar = page && page.querySelector(".page-toolbar");
            if (!bar || bar.querySelector("[data-export]")) return;

            let actions = bar.querySelector(".toolbar-actions");
            if (!actions) {
                actions = document.createElement("div");
                actions.className = "toolbar-actions";

                const existing = bar.querySelector("button");
                if (existing) actions.appendChild(existing);

                bar.appendChild(actions);
            }

            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "btn secondary";
            btn.dataset.export = id;
            btn.textContent = "Export CSV";
            actions.appendChild(btn);
        });
    }

    function exportPage(id) {
        const table = document.querySelector(`#${id} table`);
        if (!table) {
            notify("Nothing to export yet. Load data first.", "error");
            return;
        }

        const sample = table.tBodies[0]?.rows[0];
        const keep = sample
            ? Array.from(sample.cells)
                .map((cell, i) => (cell.querySelector("button, a, input, select") ? -1 : i))
                .filter((i) => i >= 0)
            : null;

        const escapeCsv = (text) => `"${text.replace(/\s+/g, " ").replace(/"/g, '""')}"`;

        const pick = (row) => {
            const cells = Array.from(row.cells);
            return (keep || cells.map((_, i) => i))
                .map((i) => (cells[i] ? escapeCsv(cells[i].textContent.trim()) : '""'))
                .join(",");
        };

        const lines = [];

        if (table.tHead) {
            const headerCells = Array.from(table.tHead.rows[0].cells);
            lines.push(
                (keep || headerCells.map((_, i) => i))
                    .map((i) => escapeCsv(headerCells[i]?.textContent.trim() || ""))
                    .join(",")
            );
        }

        // Only rows currently visible, so an active search filter is respected.
        const visibleRows = Array.from(table.tBodies[0]?.rows || []).filter(
            (row) => getComputedStyle(row).display !== "none"
        );

        visibleRows.forEach((row) => lines.push(pick(row)));

        const blob = new Blob(["\uFEFF" + lines.join("\r\n")], {
            type: "text/csv;charset=utf-8"
        });

        const url = URL.createObjectURL(blob);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        const link = document.createElement("a");

        link.href = url;
        link.download = `${id}-${stamp}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();

        setTimeout(() => URL.revokeObjectURL(url), 1000);
        notify(`Exported ${visibleRows.length} rows`, "success");
    }

    /* ---------------- dashboard quick actions ---------------- */

    function addQuickActions() {
        const dashboard = document.getElementById("dashboard");
        if (!dashboard || dashboard.querySelector(".quick-actions")) return;

        const anchor = dashboard.querySelector(".stats-grid");
        if (!anchor) return;

        const actions = [
            ["Browse instances", "instances", "▣"],
            ["Create snapshot", "create-snapshot", "＋"],
            ["Snapshot jobs", "snapshot-dashboard", "◉"],
            ["Revert a volume", "revert-snapshot", "↶"]
        ];

        const wrap = document.createElement("div");
        wrap.className = "quick-actions";

        actions.forEach(([label, page, icon]) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "quick-action";

            const iconEl = document.createElement("span");
            iconEl.className = "qa-icon";
            iconEl.textContent = icon;

            const labelEl = document.createElement("span");
            labelEl.textContent = label;

            btn.append(iconEl, labelEl);
            btn.addEventListener("click", () => {
                $(`.nav-item[data-page="${page}"]`)?.click();
            });

            wrap.appendChild(btn);
        });

        anchor.before(wrap);
    }

    /* ---------------- global keyboard handling ---------------- */

    function onGlobalKeydown(event) {
        const mod = event.ctrlKey || event.metaKey;

        if (mod && event.key.toLowerCase() === "k") {
            event.preventDefault();
            paletteOpen() ? closePalette() : openPalette();
            return;
        }

        if (event.key === "Escape") {
            if (paletteOpen()) {
                closePalette();
            } else if (helpOpen()) {
                closeHelp();
            } else if (document.body.classList.contains("nav-open")) {
                setNavOpen(false);
            }
            return;
        }

        if (mod || event.altKey || isTyping(event.target) || paletteOpen() || helpOpen()) {
            return;
        }

        if (event.key === "/") {
            const search = activePage() && $('input[type="search"]', activePage());
            if (search) {
                event.preventDefault();
                search.focus();
            }
        } else if (event.key === "?") {
            event.preventDefault();
            openHelp();
        } else if (event.key === "[") {
            toggleSidebar();
        }
    }

    /* ---------------- DOM observation ---------------- */

    let scheduled = false;

    function enhanceAll() {
        scheduled = false;
        enhanceTables();
        markCopyable(document);
        addExportButtons();
        addQuickActions();
    }

    function observeChanges() {
        const target = $("main") || document.body;

        const observer = new MutationObserver(() => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(enhanceAll);
        });

        observer.observe(target, { childList: true, subtree: true });
    }

    /* ---------------- init ---------------- */

    function init() {
        initTheme();
        initSidebar();

        buildPalette();
        buildHelp();

        $("#palette-open")?.addEventListener("click", openPalette);

        document.addEventListener("click", (event) => {
            const cell = event.target.closest("td.copyable");
            if (cell) copyCell(cell);
        });

        document.addEventListener("keydown", onGlobalKeydown);

        enhanceAll();
        observeChanges();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();

