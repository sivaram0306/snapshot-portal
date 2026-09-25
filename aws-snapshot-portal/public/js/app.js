"use strict";

/* =========================================================
   STATE
========================================================= */

const state = {
    accounts: [],
    activeAccountId: null,

    instances: [],
    volumes: [],
    snapshots: [],
    snapshotsLoading: false,
    snapshotPollFailureCount: 0,

    revert: {
        region: null,
        instance: null,
        volumes: [],          // volumes attached to the selected instance
        selectedVolumeIds: [], // volume IDs chosen in step 3
        snapshotsByVolume: {}, // volumeId -> [snapshots]
        queue: [],             // [{ volumeId, snapshotId }]
        restoring: false
    },

    currentPage: "dashboard",

    snapshotDashboardTimer: null,
    snapshotPollingTimer: null,
    revertDashboardTimer: null,
    snapshotJobs: [],
    cancellingJobIds: new Set(),

    editingAccountId: null
};

const MAX_INSTANCE_STORAGE_GB = 2048;

const AWS_AUTH_ERROR_CODES = [
    "ExpiredToken",
    "ExpiredTokenException",
    "InvalidClientTokenId",
    "UnrecognizedClientException",
    "InvalidAccessKeyId",
    "SignatureDoesNotMatch"
];

const SNAPSHOT_POLL_INTERVAL = 15000;
const SNAPSHOT_DASHBOARD_POLL_INTERVAL = 15000;
const REVERT_DASHBOARD_POLL_INTERVAL = 15000;
const REQUEST_TIMEOUT_MS = 20000;

// Snapshot polling specifically times out faster than the general request
// timeout: this call repeats every SNAPSHOT_POLL_INTERVAL, so letting any
// single attempt ride the full 20s default means a slow account could stay
// almost permanently "busy" polling instead of failing fast and clearly.
const SNAPSHOT_POLL_TIMEOUT_MS = 10000;

// Safety net for the in-flight guard itself: if loadSnapshots's own timeout
// path somehow doesn't run (e.g. an unexpected exception outside api()'s
// try/catch), this force-clears state.snapshotsLoading after a hard ceiling
// so the guard can never itself get permanently stuck and block all future
// polling forever.
const SNAPSHOT_LOADING_WATCHDOG_MS = SNAPSHOT_POLL_TIMEOUT_MS + 5000;

let toastTimer = null;
let credentialPopupOpening = false;


/* =========================================================
   DOM HELPERS
========================================================= */

function $(id) {
    return document.getElementById(id);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function formatDate(value) {
    if (!value) {
        return "-";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return String(value);
    }

    return date.toLocaleString();
}


/* =========================================================
   TOAST
========================================================= */

function toast(message, type = "info") {
    const element = $("toast");

    if (!element) {
        console[type === "error" ? "error" : "log"]("Toast:", message);
        return;
    }

    element.textContent = String(message ?? "");
    element.className = `toast ${type} show`;

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
        element.classList.remove("show");
    }, 3500);
}


/* =========================================================
   LOADING
========================================================= */

let loadingRefCount = 0;

function setLoading(visible, message = "Loading...") {
    const loading = $("loading");
    const text = $("loading-text");

    if (!loading) {
        return;
    }

    // Multiple operations can call setLoading(true) concurrently (e.g. a
    // slow snapshot fetch overlapping with another page's load). Using a
    // single boolean meant whichever call finished first could hide the
    // overlay while another was still running, or conversely leave it
    // stuck visible — blocking every click on the page — if calls got out
    // of order. A reference count only fully hides it once every caller
    // that showed it has also finished.
    if (visible) {
        loadingRefCount += 1;

        if (text) {
            text.textContent = message;
        }

        loading.classList.add("show");
    } else {
        loadingRefCount = Math.max(0, loadingRefCount - 1);

        if (loadingRefCount === 0) {
            loading.classList.remove("show");
        }
    }
}

function forceHideLoading() {
    loadingRefCount = 0;

    $("loading")?.classList.remove("show");
}


/* =========================================================
   STORAGE
========================================================= */

function saveAccounts() {
    try {
        sessionStorage.setItem("awsSnapshotAccounts", JSON.stringify(state.accounts));
        sessionStorage.setItem("awsSnapshotActiveAccount", state.activeAccountId || "");
    } catch (error) {
        console.error("Unable to save account information:", error);
        toast("Unable to save account information in this browser.", "error");
    }
}

function loadAccounts() {
    try {
        const raw = sessionStorage.getItem("awsSnapshotAccounts");
        const parsed = raw ? JSON.parse(raw) : [];

        state.accounts = Array.isArray(parsed) ? parsed : [];
        state.activeAccountId = sessionStorage.getItem("awsSnapshotActiveAccount") || null;

        if (
            state.activeAccountId &&
            !state.accounts.some(account => account && account.id === state.activeAccountId)
        ) {
            state.activeAccountId = state.accounts[0]?.id || null;
        }
    } catch (error) {
        console.error("Unable to load saved accounts:", error);
        state.accounts = [];
        state.activeAccountId = null;
    }
}


/* =========================================================
   ACCOUNT
========================================================= */

function getActiveAccount() {
    return state.accounts.find(account => account && account.id === state.activeAccountId);
}

function updateAccountSelector() {
    const select = $("account-select");

    if (!select) {
        return;
    }

    select.innerHTML = "";

    if (!state.accounts.length) {
        select.innerHTML = `<option value="">No account connected</option>`;
        return;
    }

    state.accounts.forEach(account => {
        if (!account) {
            return;
        }

        const option = document.createElement("option");
        option.value = account.id;
        option.textContent = account.name || "Unnamed account";
        option.selected = account.id === state.activeAccountId;
        select.appendChild(option);
    });
}

function updateRegionFromAccount() {
    const account = getActiveAccount();
    const region = $("region");
    const accountRegion = $("account-region");

    if (!account) {
        if (region) region.value = "us-west-1";
        if (accountRegion) accountRegion.value = "us-west-1";
        return;
    }

    const selectedRegion = account.region || "us-west-1";

    if (region) region.value = selectedRegion;
    if (accountRegion) accountRegion.value = selectedRegion;
}

function updateSelectedAccountUI() {
    const account = getActiveAccount();

    const status = $("connection-status");
    const dashboardAccount = $("dashboard-selected-account");
    const dashboardRegion = $("dashboard-selected-region");
    const summaryAccount = $("summary-account-name");
    const summaryRegion = $("summary-region");
    const summaryStatus = $("summary-account-status");

    if (!account) {
        if (dashboardAccount) dashboardAccount.textContent = "No account selected";
        if (dashboardRegion) dashboardRegion.textContent = "-";
        if (summaryAccount) summaryAccount.textContent = "-";
        if (summaryRegion) summaryRegion.textContent = "-";
        if (summaryStatus) summaryStatus.textContent = "Not connected";

        if (status) {
            status.textContent = "Not connected";
            status.className = "connection-status";
        }

        return;
    }

    const region = account.region || "us-west-1";

    if (dashboardAccount) dashboardAccount.textContent = account.name || "Unnamed account";
    if (dashboardRegion) dashboardRegion.textContent = region;
    if (summaryAccount) summaryAccount.textContent = account.name || "Unnamed account";
    if (summaryRegion) summaryRegion.textContent = region;
    if (summaryStatus) summaryStatus.textContent = "Connected";

    if (status) {
        status.textContent = `Connected: ${account.name || "AWS account"}`;
        status.className = "connection-status connected";
    }
}

function regionChanged() {
    const account = getActiveAccount();
    const region = $("region");

    if (!account || !region) {
        return;
    }

    account.region = region.value || "us-west-1";

    saveAccounts();

    updateAccountSelector();
    updateRegionFromAccount();
    updateSelectedAccountUI();

    clearAwsData();
    resetRevertState();

    if (state.currentPage === "dashboard") loadDashboard();
    if (state.currentPage === "instances") loadInstances();
    if (state.currentPage === "volumes") loadVolumes();
    if (state.currentPage === "snapshots") loadSnapshots();
    if (state.currentPage === "create-snapshot") loadInstancesForSnapshot();
    if (state.currentPage === "revert-snapshot") initRevertPage();

    toast(`Region changed to ${account.region}.`, "success");
}


/* =========================================================
   REQUEST
========================================================= */

function getRequestBody(overrides = {}) {
    const account = getActiveAccount();

    if (!account) {
        throw new Error("Please add and select an AWS account first.");
    }

    const region = overrides.region || account.region || $("region")?.value || "us-west-1";

    return {
        accessKeyId: account.accessKeyId,
        secretAccessKey: account.secretAccessKey,
        sessionToken: account.sessionToken || "",
        region,
        accountName: account.name
    };
}


/* =========================================================
   AWS AUTH
========================================================= */

function isAwsAuthenticationError(data) {
    if (!data) {
        return false;
    }

    const code =
        data.code ||
        data.errorCode ||
        data.awsCode ||
        data.awsError?.code ||
        data.error?.code ||
        "";

    const message =
        typeof data.error === "string"
            ? data.error
            : (data.message || data.error?.message || "");

    // Logged so that when this fires unexpectedly (e.g. during a long-running
    // create-snapshot call), the actual response causing it is visible in the
    // console instead of only a generic "session expired" toast. Check this
    // the next time it happens to confirm whether it's a real AWS auth
    // failure or a false positive from an unrelated error message.
    if (code || message) {
        console.log("Auth-error check — code:", code, "| message:", message);
    }

    if (AWS_AUTH_ERROR_CODES.includes(code)) {
        return true;
    }

    // Only fall back to matching against the free-text message if there is
    // no structured error code at all. Matching the regex against ANY
    // response's message text — even ones with a legitimate, unrelated
    // error code — risked false-triggering the "session expired" flow on
    // backend messages that merely mention these words in passing.
    if (code) {
        return false;
    }

    return /ExpiredToken|InvalidClientTokenId|UnrecognizedClient|InvalidAccessKeyId|SignatureDoesNotMatch/i.test(
        String(message)
    );
}

function openCredentialsForAwsError() {
    if (credentialPopupOpening) {
        return;
    }

    credentialPopupOpening = true;

    renderAccountList();

    $("credential-modal")?.classList.add("show");

    setTimeout(() => {
        credentialPopupOpening = false;
    }, 500);

    toast("AWS credentials expired or are invalid. Update the existing account credentials.", "error");
}


/* =========================================================
   API
========================================================= */

async function api(url, options = {}) {
    const controller = new AbortController();

    const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;

    const timeoutId = setTimeout(() => {
        controller.abort();
    }, timeoutMs);

    const config = {
        ...options,
        signal: controller.signal,
        headers: {
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(options.headers || {})
        }
    };

    // timeoutMs is consumed above, not a real fetch() option.
    delete config.timeoutMs;

    let response;

    try {
        response = await fetch(url, config);
    } catch (error) {
        // A hung backend (e.g. a slow/misconfigured account) previously left
        // requests pending forever with no visible error, making the tab
        // look permanently "stuck loading." An aborted request now surfaces
        // as a clear timeout message instead of hanging silently.
        if (error?.name === "AbortError") {
            console.error(`API request timed out after ${timeoutMs}ms:`, url);
            throw new Error("Request timed out. The AWS account or region may be unreachable.");
        }

        console.error("API network error:", error);
        throw new Error("Unable to connect to the server.");
    } finally {
        clearTimeout(timeoutId);
    }

    const contentType = response.headers.get("content-type") || "";
    let data;

    try {
        if (contentType.toLowerCase().includes("application/json")) {
            data = await response.json();
        } else {
            const text = await response.text();
            console.error(`Unexpected non-JSON response from ${url}:`, text);
            throw new Error(text || `Server returned HTTP ${response.status}`);
        }
    } catch (error) {
        console.error("API response parsing error:", error);

        if (error instanceof Error && error.message) {
            throw error;
        }

        throw new Error(`Server returned HTTP ${response.status}`);
    }

    if (!data || typeof data !== "object") {
        throw new Error(`Invalid server response from ${url}`);
    }

    if (isAwsAuthenticationError(data)) {
        openCredentialsForAwsError();
        throw new Error("AWS credentials expired or are invalid.");
    }

    if (!response.ok || data.success === false) {
        throw new Error(data.error || data.message || `HTTP ${response.status}`);
    }

    return data;
}


/* =========================================================
   ACCOUNT MODAL
========================================================= */

function openCredentials() {
    state.editingAccountId = null;

    clearAccountForm();

    const button = $("account-add");
    if (button) button.textContent = "Add Account";

    renderAccountList();

    $("credential-modal")?.classList.add("show");
}

function closeCredentials() {
    $("credential-modal")?.classList.remove("show");

    state.editingAccountId = null;

    clearAccountForm();

    const button = $("account-add");
    if (button) button.textContent = "Add Account";
}

function clearAccountForm() {
    if ($("account-name")) $("account-name").value = "";
    if ($("access-key")) $("access-key").value = "";
    if ($("secret-key")) $("secret-key").value = "";
    if ($("session-token")) $("session-token").value = "";
    if ($("account-region")) $("account-region").value = "us-west-1";
}

function editAccount(accountId) {
    const account = state.accounts.find(item => item && item.id === accountId);

    if (!account) {
        return;
    }

    state.editingAccountId = account.id;

    if ($("account-name")) $("account-name").value = account.name || "";
    if ($("access-key")) $("access-key").value = account.accessKeyId || "";
    if ($("secret-key")) $("secret-key").value = account.secretAccessKey || "";
    if ($("session-token")) $("session-token").value = account.sessionToken || "";
    if ($("account-region")) $("account-region").value = account.region || "us-west-1";

    const button = $("account-add");
    if (button) button.textContent = "Update Account";

    $("credential-modal")?.classList.add("show");
}

function saveAccount() {
    const name = $("account-name")?.value.trim() || "";
    const accessKeyId = $("access-key")?.value.trim() || "";
    const secretAccessKey = $("secret-key")?.value.trim() || "";
    const sessionToken = $("session-token")?.value.trim() || "";
    const region = $("account-region")?.value || "us-west-1";

    if (!name) {
        toast("Enter an account name.", "error");
        return;
    }

    if (!accessKeyId) {
        toast("Enter the AWS Access Key ID.", "error");
        return;
    }

    if (!secretAccessKey) {
        toast("Enter the AWS Secret Access Key.", "error");
        return;
    }

    if (state.editingAccountId) {
        const account = state.accounts.find(item => item && item.id === state.editingAccountId);

        if (!account) {
            return;
        }

        account.name = name;
        account.accessKeyId = accessKeyId;
        account.secretAccessKey = secretAccessKey;
        account.sessionToken = sessionToken;
        account.region = region;

        state.activeAccountId = account.id;

        // Credentials/region changed — any previously fetched instance list
        // and selections for this account are no longer trustworthy.
        if (state.createSnapshot?.accounts) {
            delete state.createSnapshot.accounts[account.id];
        }

        toast("AWS account updated successfully.", "success");
    } else {
        const account = {
            id:
                typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
                    ? crypto.randomUUID()
                    : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            name,
            accessKeyId,
            secretAccessKey,
            sessionToken,
            region
        };

        state.accounts.push(account);
        state.activeAccountId = account.id;

        toast("AWS account added successfully.", "success");
    }

    saveAccounts();

    updateAccountSelector();
    updateRegionFromAccount();
    updateSelectedAccountUI();

    renderAccountList();

    clearAwsData();
    resetRevertState();

    closeCredentials();

    showPage(state.currentPage);
}

function renderAccountList() {
    const container = $("account-list");

    if (!container) {
        return;
    }

    if (!state.accounts.length) {
        container.innerHTML = `<div class="muted">No accounts added.</div>`;
        return;
    }

    container.innerHTML = state.accounts
        .filter(Boolean)
        .map(account => {
            const active = account.id === state.activeAccountId;

            return `
                <div class="account-row ${active ? "selected" : ""}">
                    <div class="account-info">
                        <strong>${escapeHtml(account.name || "Unnamed account")}</strong>
                        <small>Region: ${escapeHtml(account.region || "us-west-1")}</small>
                    </div>
                    <div class="account-actions">
                        <button type="button" class="account-use" data-account-id="${escapeHtml(account.id)}">
                            ${active ? "Active" : "Use"}
                        </button>
                        <button type="button" class="account-edit" data-account-id="${escapeHtml(account.id)}">
                            Edit
                        </button>
                        <button type="button" class="account-remove" data-account-id="${escapeHtml(account.id)}">
                            Remove
                        </button>
                    </div>
                </div>
            `;
        })
        .join("");
}

function selectAccount(accountId) {
    const account = state.accounts.find(item => item && item.id === accountId);

    if (!account) {
        return;
    }

    state.activeAccountId = accountId;

    saveAccounts();

    updateAccountSelector();
    updateRegionFromAccount();
    updateSelectedAccountUI();

    renderAccountList();

    clearAwsData();
    resetRevertState();

    closeCredentials();

    showPage(state.currentPage);

    toast(`Using ${account.name}.`, "success");
}

function switchAccount() {
    const select = $("account-select");

    if (!select?.value) {
        return;
    }

    selectAccount(select.value);
}

function removeAccount(accountId) {
    const account = state.accounts.find(item => item && item.id === accountId);

    if (!account) {
        return;
    }

    if (!confirm(`Remove AWS account "${account.name}"?`)) {
        return;
    }

    state.accounts = state.accounts.filter(item => item && item.id !== accountId);

    if (state.activeAccountId === accountId) {
        state.activeAccountId = state.accounts[0]?.id || null;
    }

    if (state.createSnapshot?.accounts) {
        delete state.createSnapshot.accounts[accountId];
    }

    saveAccounts();

    updateAccountSelector();
    updateRegionFromAccount();
    updateSelectedAccountUI();

    renderAccountList();

    clearAwsData();
    resetRevertState();

    showPage(state.currentPage);
}


/* =========================================================
   STORAGE CALCULATIONS
========================================================= */

function getTotalVolumeStorageGB() {
    return state.volumes.reduce((total, volume) => total + (Number(volume?.size) || 0), 0);
}

function formatStorageSize(storageGB) {
    const gb = Number(storageGB) || 0;

    if (gb >= 1024) {
        return `${(gb / 1024).toFixed(2)} TB`;
    }

    return `${gb} GB`;
}

function updateVolumeTotals() {
    const total = getTotalVolumeStorageGB();
    const count = state.volumes.length;
    const encrypted = state.volumes.filter(volume => Boolean(volume?.encrypted)).length;

    if ($("volume-count")) $("volume-count").textContent = count;
    if ($("volume-total-storage")) $("volume-total-storage").textContent = formatStorageSize(total);
    if ($("dashboard-storage-number")) $("dashboard-storage-number").textContent = total.toLocaleString();
    if ($("dashboard-storage-readable")) $("dashboard-storage-readable").textContent = formatStorageSize(total);
    if ($("volumes-page-count")) $("volumes-page-count").textContent = count;
    if ($("volumes-page-total")) $("volumes-page-total").textContent = formatStorageSize(total);
    if ($("volumes-page-encrypted")) $("volumes-page-encrypted").textContent = encrypted;
}


/* =========================================================
   INSTANCE STORAGE
========================================================= */

function getInstanceStorageGB(instance) {
    if (!instance) {
        return 0;
    }

    if (instance.totalVolumeSize !== undefined && instance.totalVolumeSize !== null) {
        return Number(instance.totalVolumeSize) || 0;
    }

    if (instance.totalVolumeSizeGB !== undefined && instance.totalVolumeSizeGB !== null) {
        return Number(instance.totalVolumeSizeGB) || 0;
    }

    if (instance.totalStorageGB !== undefined && instance.totalStorageGB !== null) {
        return Number(instance.totalStorageGB) || 0;
    }

    const instanceId = String(instance.instanceId || instance.instance_id || "").trim();

    if (!instanceId) {
        return 0;
    }

    return state.volumes
        .filter(volume => String(volume?.attachedInstance || volume?.instanceId || "").trim() === instanceId)
        .reduce((total, volume) => total + (Number(volume?.size) || 0), 0);
}

function isInstanceOverStorageLimit(instance) {
    return getInstanceStorageGB(instance) > MAX_INSTANCE_STORAGE_GB;
}


/* =========================================================
   INSTANCE DEDUPLICATION
========================================================= */

function deduplicateInstances(instances = []) {
    const seenIds = new Set();
    const seenNames = new Set();
    const unique = [];

    if (!Array.isArray(instances)) {
        return unique;
    }

    for (const instance of instances) {
        if (!instance) {
            continue;
        }

        const instanceId = String(instance.instanceId || instance.instance_id || "").trim().toLowerCase();
        const instanceName = String(instance.name || instance.instanceName || "").trim().toLowerCase();

        if (instanceId && seenIds.has(instanceId)) {
            continue;
        }

        if (instanceName && seenNames.has(instanceName)) {
            continue;
        }

        if (instanceId) seenIds.add(instanceId);
        if (instanceName) seenNames.add(instanceName);

        unique.push(instance);
    }

    return unique;
}


/* =========================================================
   CLEAR AWS DATA
========================================================= */

function clearAwsData() {
    state.instances = [];
    state.volumes = [];
    state.snapshots = [];

    if ($("instance-count")) $("instance-count").textContent = "-";
    if ($("snapshot-count")) $("snapshot-count").textContent = "-";
    if ($("volume-count")) $("volume-count").textContent = "-";
    if ($("volume-total-storage")) $("volume-total-storage").textContent = "-";
    if ($("dashboard-storage-number")) $("dashboard-storage-number").textContent = "0";
    if ($("dashboard-storage-readable")) $("dashboard-storage-readable").textContent = "0 GB";
    if ($("volumes-page-count")) $("volumes-page-count").textContent = "0";
    if ($("volumes-page-total")) $("volumes-page-total").textContent = "0 GB";
    if ($("volumes-page-encrypted")) $("volumes-page-encrypted").textContent = "0";
    if ($("instances-table")) $("instances-table").innerHTML = "";
    if ($("volumes-table")) $("volumes-table").innerHTML = "";
    if ($("snapshots-table")) $("snapshots-table").innerHTML = "";
}


/* =========================================================
   DASHBOARD
========================================================= */

async function loadDashboard() {
    const account = getActiveAccount();

    updateSelectedAccountUI();

    if (!account) {
        if ($("dashboard-message")) {
            $("dashboard-message").textContent = "Add an AWS account to get started.";
        }

        return;
    }

    try {
        const requestBody = JSON.stringify(getRequestBody());

        const [instances, volumes, snapshots] = await Promise.all([
            api("/api/aws/instances", { method: "POST", body: requestBody }),
            api("/api/aws/volumes", { method: "POST", body: requestBody }),
            api("/api/aws/snapshots", { method: "POST", body: requestBody })
        ]);

        state.instances = deduplicateInstances(instances.instances || []);
        state.volumes = Array.isArray(volumes.volumes) ? volumes.volumes : [];
        state.snapshots = Array.isArray(snapshots.snapshots) ? snapshots.snapshots : [];

        if ($("instance-count")) $("instance-count").textContent = state.instances.length;
        if ($("snapshot-count")) $("snapshot-count").textContent = state.snapshots.length;

        updateVolumeTotals();

        if ($("dashboard-message")) {
            $("dashboard-message").textContent = `${account.name} — ${account.region}`;
        }
    } catch (error) {
        console.error("Dashboard loading failed:", error);
        toast(error?.message || "Unable to load dashboard data.", "error");
    }
}


/* =========================================================
   INSTANCES
========================================================= */

async function loadInstances() {
    if (!getActiveAccount()) {
        toast("Connect an AWS account first.", "error");
        return;
    }

    try {
        setLoading(true, "Loading EC2 instances...");

        const data = await api("/api/aws/instances", {
            method: "POST",
            body: JSON.stringify(getRequestBody())
        });

        state.instances = deduplicateInstances(data.instances || []);

        if ($("instance-count")) $("instance-count").textContent = state.instances.length;

        searchInstances();

        toast(`${state.instances.length} unique instances loaded.`, "success");
    } catch (error) {
        console.error("Instance loading failed:", error);
        toast(error?.message || "Unable to load EC2 instances.", "error");
    } finally {
        setLoading(false);
    }
}

function searchInstances() {
    const search = $("instance-search")?.value.trim().toLowerCase() || "";

    const filtered = state.instances.filter(instance => {
        const text = [
            instance?.name,
            instance?.instanceId,
            instance?.state,
            instance?.instanceType,
            instance?.privateIp,
            instance?.publicIp,
            instance?.availabilityZone
        ]
            .join(" ")
            .toLowerCase();

        return text.includes(search);
    });

    if ($("instance-result-count")) {
        $("instance-result-count").textContent = `${filtered.length} result${filtered.length === 1 ? "" : "s"}`;
    }

    renderInstances(filtered);
}

function renderInstances(instances) {
    const container = $("instances-table");

    if (!container) {
        return;
    }

    if (!instances.length) {
        container.innerHTML = `<div class="empty-state small">No instances found.</div>`;
        return;
    }

    container.innerHTML = `
        <div class="table-wrapper">
            <table>
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Instance ID</th>
                        <th>State</th>
                        <th>Type</th>
                        <th>Private IP</th>
                        <th>Public IP</th>
                        <th>AZ</th>
                        <th>Volumes</th>
                        <th>Total Storage</th>
                    </tr>
                </thead>
                <tbody>
                    ${instances
                        .map(instance => {
                            const storageGB = getInstanceStorageGB(instance);
                            const overLimit = storageGB > MAX_INSTANCE_STORAGE_GB;

                            return `
                                <tr>
                                    <td>${escapeHtml(instance.name || "-")}</td>
                                    <td><code>${escapeHtml(instance.instanceId || instance.instance_id || "-")}</code></td>
                                    <td><span class="status ${escapeHtml(instance.state || "")}">${escapeHtml(instance.state || "-")}</span></td>
                                    <td>${escapeHtml(instance.instanceType || "-")}</td>
                                    <td>${escapeHtml(instance.privateIp || "-")}</td>
                                    <td>${escapeHtml(instance.publicIp || "-")}</td>
                                    <td>${escapeHtml(instance.availabilityZone || "-")}</td>
                                    <td>${Number(instance.volumeCount || 0)}</td>
                                    <td><span class="${overLimit ? "status error" : ""}">${escapeHtml(formatStorageSize(storageGB))}</span></td>
                                </tr>
                            `;
                        })
                        .join("")}
                </tbody>
            </table>
        </div>
    `;
}


/* =========================================================
   VOLUMES
========================================================= */

async function loadVolumes() {
    if (!getActiveAccount()) {
        toast("Connect an AWS account first.", "error");
        return;
    }

    try {
        setLoading(true, "Loading EBS volumes...");

        const data = await api("/api/aws/volumes", {
            method: "POST",
            body: JSON.stringify(getRequestBody())
        });

        state.volumes = Array.isArray(data.volumes) ? data.volumes : [];

        updateVolumeTotals();
        renderVolumes(state.volumes);

        toast(`${state.volumes.length} volumes loaded.`, "success");
    } catch (error) {
        console.error("Volume loading failed:", error);
        toast(error?.message || "Unable to load EBS volumes.", "error");
    } finally {
        setLoading(false);
    }
}

function renderVolumes(volumes) {
    const container = $("volumes-table");

    if (!container) {
        return;
    }

    updateVolumeTotals();

    if (!volumes.length) {
        container.innerHTML = `<div class="empty-state small">No EBS volumes found.</div>`;
        return;
    }

    container.innerHTML = `
        <div class="table-wrapper">
            <table>
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Volume ID</th>
                        <th>Size</th>
                        <th>Type</th>
                        <th>State</th>
                        <th>Instance</th>
                        <th>Encrypted</th>
                    </tr>
                </thead>
                <tbody>
                    ${volumes
                        .map(
                            volume => `
                        <tr>
                            <td>${escapeHtml(volume.name || "-")}</td>
                            <td><code>${escapeHtml(volume.volumeId || "-")}</code></td>
                            <td><strong>${Number(volume.size || 0)} GB</strong></td>
                            <td>${escapeHtml(volume.type || "gp3")}</td>
                            <td><span class="status ${escapeHtml(volume.state || "")}">${escapeHtml(volume.state || "-")}</span></td>
                            <td><code>${escapeHtml(volume.attachedInstance || "-")}</code></td>
                            <td>${volume.encrypted ? "Yes" : "No"}</td>
                        </tr>
                    `
                        )
                        .join("")}
                </tbody>
            </table>
        </div>
    `;
}


/* =========================================================
   SNAPSHOTS
========================================================= */

async function loadSnapshots(options = {}) {
    const silent = Boolean(options.silent);

    if (!getActiveAccount()) {
        if (!silent) {
            toast("Connect an AWS account first.", "error");
        }

        return;
    }

    // Prevents overlapping requests: if a previous call (silent or not) is
    // still waiting on a slow account, a second call bailing out here stops
    // duplicate fetches and duplicate table re-renders from stacking up,
    // which is what could freeze the whole portal on a slow/misbehaving
    // account. The non-silent caller (a manual "Refresh" click, or the tab
    // being opened) still gets a toast so it's clear a load is already running.
    if (state.snapshotsLoading) {
        if (!silent) {
            toast("A snapshot refresh is already in progress. Please wait.", "info");
        }

        return;
    }

    state.snapshotsLoading = true;

    // Watchdog: force-clears the in-flight flag if loadSnapshots doesn't
    // reach its own finally block within a hard ceiling, so a single
    // unexpected failure mode can never permanently block all future
    // snapshot polling.
    const watchdogId = setTimeout(() => {
        if (state.snapshotsLoading) {
            console.error("Snapshot loading watchdog fired — forcing the in-flight flag clear.");
            state.snapshotsLoading = false;
        }
    }, SNAPSHOT_LOADING_WATCHDOG_MS);

    try {
        if (!silent) {
            setLoading(true, "Loading AWS snapshots...");
        }

        const data = await api("/api/aws/snapshots", {
            method: "POST",
            timeoutMs: SNAPSHOT_POLL_TIMEOUT_MS,
            body: JSON.stringify(getRequestBody())
        });

        state.snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];

        state.snapshotPollFailureCount = 0;

        if ($("snapshot-count")) $("snapshot-count").textContent = state.snapshots.length;

        searchSnapshots();

        if (!silent) {
            toast(`${state.snapshots.length} snapshots loaded.`, "success");
        }
    } catch (error) {
        if (!silent) {
            toast(error?.message || "Unable to load snapshots.", "error");
        } else {
            console.error("Snapshot polling failed:", error);

            state.snapshotPollFailureCount = (state.snapshotPollFailureCount || 0) + 1;

            // Silent polling failures are otherwise invisible — the tab just
            // quietly stops updating. After repeated consecutive failures,
            // surface a single toast so it's clear the account is timing out
            // rather than the UI silently going stale.
            if (state.snapshotPollFailureCount === 3) {
                toast(
                    `Snapshot updates for this account have timed out ${state.snapshotPollFailureCount} times in a row. The account or region may be slow or unreachable.`,
                    "error"
                );
            }
        }
    } finally {
        clearTimeout(watchdogId);
        state.snapshotsLoading = false;

        if (!silent) {
            setLoading(false);
        }
    }
}

function searchSnapshots() {
    const search = $("snapshot-search")?.value.trim().toLowerCase() || "";

    const filtered = state.snapshots.filter(snapshot => {
        const text = [
            snapshot?.snapshotId,
            snapshot?.volumeId,
            snapshot?.state,
            snapshot?.progress,
            snapshot?.description,
            snapshot?.instanceName,
            snapshot?.instanceId,
            snapshot?.createdBy,
            snapshot?.team
        ]
            .join(" ")
            .toLowerCase();

        return text.includes(search);
    });

    if ($("snapshot-result-count")) {
        $("snapshot-result-count").textContent = `${filtered.length} result${filtered.length === 1 ? "" : "s"}`;
    }

    renderSnapshots(filtered);
}

const MAX_RENDERED_SNAPSHOT_ROWS = 500;

function renderSnapshots(snapshots) {
    const container = $("snapshots-table");

    if (!container) {
        return;
    }

    if (!snapshots.length) {
        container.innerHTML = `<div class="empty-state small">No snapshots found.</div>`;
        return;
    }

    // Rebuilding a very large table's innerHTML on every 15s poll tick can
    // itself lock up the main thread for accounts with a large snapshot
    // history, compounding a slow-account freeze. Capping the render and
    // asking the user to narrow their search keeps each re-render cheap.
    const truncated = snapshots.length > MAX_RENDERED_SNAPSHOT_ROWS;
    const rowsToRender = truncated ? snapshots.slice(0, MAX_RENDERED_SNAPSHOT_ROWS) : snapshots;

    const truncationNotice = truncated
        ? `<div class="empty-state small">Showing the first ${MAX_RENDERED_SNAPSHOT_ROWS} of ${snapshots.length} results. Narrow your search to see more.</div>`
        : "";

    container.innerHTML = `
        ${truncationNotice}
        <div class="table-wrapper">
            <table>
                <thead>
                    <tr>
                        <th>Snapshot</th>
                        <th>Instance</th>
                        <th>Volume</th>
                        <th>State</th>
                        <th>Progress</th>
                        <th>Created By</th>
                        <th>Team</th>
                        <th>Start Time</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsToRender
                        .map(
                            snapshot => `
                        <tr>
                            <td><code>${escapeHtml(snapshot.snapshotId || "-")}</code></td>
                            <td>${escapeHtml(snapshot.instanceName || "-")}<br><small>${escapeHtml(snapshot.instanceId || "-")}</small></td>
                            <td><code>${escapeHtml(snapshot.volumeId || "-")}</code></td>
                            <td><span class="status ${escapeHtml(snapshot.state || "")}">${escapeHtml(snapshot.state || "-")}</span></td>
                            <td>${escapeHtml(snapshot.progress || "-")}</td>
                            <td>${escapeHtml(snapshot.createdBy || "-")}</td>
                            <td>${escapeHtml(snapshot.team || "-")}</td>
                            <td>${formatDate(snapshot.startTime)}</td>
                        </tr>
                    `
                        )
                        .join("")}
                </tbody>
            </table>
        </div>
    `;
}


/* =========================================================
   SNAPSHOT POLLING
========================================================= */

function startSnapshotPolling() {
    stopSnapshotPolling();

    state.snapshotPollFailureCount = 0;

    // First load is NOT silent: shows the spinner and, critically, surfaces
    // any error as a toast instead of only logging it to the console. This
    // was previously fired twice (once from showPage, once silently here),
    // which could mask a real failure on slower/misbehaving accounts (e.g.
    // UAT) behind a spinner that had already been dismissed by the other call.
    loadSnapshots();

    state.snapshotPollingTimer = setInterval(() => {
        if (state.currentPage !== "snapshots") return;
        if (!getActiveAccount()) return;

        // Guard against overlapping requests. setInterval fires on a fixed
        // clock regardless of whether the previous loadSnapshots() call has
        // resolved yet. For a slow/misbehaving account, each 15s tick could
        // stack another in-flight fetch on top of ones still pending, and
        // each eventual response triggers a full table re-render. A pile-up
        // of concurrent renders is what froze the entire portal, not just
        // the snapshots tab — this skip keeps at most one request in flight.
        if (state.snapshotsLoading) {
            console.warn("Skipping snapshot poll: previous request still in flight.");
            return;
        }

        loadSnapshots({ silent: true });
    }, SNAPSHOT_POLL_INTERVAL);
}

function stopSnapshotPolling() {
    if (state.snapshotPollingTimer) {
        clearInterval(state.snapshotPollingTimer);
        state.snapshotPollingTimer = null;
    }
}


/* =========================================================
   CREATE SNAPSHOT (multi-account)
========================================================= */

const SNAPSHOT_RETENTION_OPTIONS = [3, 5, 7];

// Per-account working state for the Create Snapshot page. Keyed by account
// id since instance IDs/names are only unique within a single AWS account.
state.createSnapshot = {
    accounts: {}, // accountId -> { loading, error, instances: [], selectedIds: Set }
    // Search here is click/Enter-triggered rather than live-as-you-type:
    // appliedSearch holds the term actually in effect, separate from
    // whatever is currently typed (but not yet searched) in the input.
    appliedSearch: ""
};

function applyCreateSnapshotSearch() {
    state.createSnapshot.appliedSearch = $("snapshot-instance-search")?.value || "";
    renderCreateSnapshotAccounts();
}

function clearCreateSnapshotSearch() {
    state.createSnapshot.appliedSearch = "";

    if ($("snapshot-instance-search")) {
        $("snapshot-instance-search").value = "";
    }

    renderCreateSnapshotAccounts();
}

function getCreateSnapshotAccountState(accountId) {
    if (!state.createSnapshot.accounts[accountId]) {
        state.createSnapshot.accounts[accountId] = {
            loading: false,
            error: null,
            instances: [],
            selectedIds: new Set()
        };
    }

    return state.createSnapshot.accounts[accountId];
}

async function loadInstancesForSnapshot() {
    if (!state.accounts.length) {
        renderCreateSnapshotAccounts();
        return;
    }

    renderCreateSnapshotAccounts();

    // Fetch every saved account's instances in parallel. Each account's
    // credentials/region are its own, so these are independent requests —
    // one account being slow or failing should not block the others from
    // loading and rendering their own instance lists.
    await Promise.all(state.accounts.filter(Boolean).map(account => loadInstancesForOneAccount(account)));
}

async function loadInstancesForOneAccount(account) {
    const accountState = getCreateSnapshotAccountState(account.id);

    accountState.loading = true;
    accountState.error = null;

    renderCreateSnapshotAccounts();

    try {
        const data = await api("/api/aws/instances", {
            method: "POST",
            timeoutMs: 20000,
            body: JSON.stringify({
                accessKeyId: account.accessKeyId,
                secretAccessKey: account.secretAccessKey,
                sessionToken: account.sessionToken || "",
                region: account.region || "us-west-1",
                accountName: account.name
            })
        });

        accountState.instances = deduplicateInstances(data.instances || []);

        // Drop selections for instances that no longer exist in a refreshed list.
        const stillPresent = new Set(
            accountState.instances.map(instance => instance.instanceId || instance.instance_id)
        );

        accountState.selectedIds = new Set(
            [...accountState.selectedIds].filter(id => stillPresent.has(id))
        );
    } catch (error) {
        console.error(`Unable to load instances for account "${account.name}":`, error);
        accountState.error = error?.message || "Unable to load instances.";
        accountState.instances = [];
    } finally {
        accountState.loading = false;
        renderCreateSnapshotAccounts();
    }
}

function toggleSnapshotInstanceSelection(accountId, instanceId, checked) {
    const accountState = getCreateSnapshotAccountState(accountId);

    if (checked) {
        accountState.selectedIds.add(instanceId);
    } else {
        accountState.selectedIds.delete(instanceId);
    }

    updateCreateSnapshotSummary();
}

function toggleAllSnapshotInstancesForAccount(accountId, checked) {
    const accountState = getCreateSnapshotAccountState(accountId);

    const eligibleIds = accountState.instances
        .filter(instance => !isInstanceOverStorageLimit(instance))
        .map(instance => instance.instanceId || instance.instance_id)
        .filter(Boolean);

    accountState.selectedIds = checked ? new Set(eligibleIds) : new Set();

    renderCreateSnapshotAccounts();
}

function renderCreateSnapshotAccounts() {
    const container = $("snapshot-accounts-container");

    if (!container) {
        return;
    }

    if (!state.accounts.length) {
        container.innerHTML = `<div class="empty-state">Add at least one AWS account to create snapshots.</div>`;
        updateCreateSnapshotSummary();
        return;
    }

    // Reads the last *applied* search term rather than the input's live
    // value, since search here is click/Enter-triggered, not live-as-you-type.
    const search = (state.createSnapshot.appliedSearch || "").trim().toLowerCase();

    let totalMatches = 0;

    container.innerHTML = state.accounts
        .filter(Boolean)
        .map(account => {
            const accountState = getCreateSnapshotAccountState(account.id);

            if (accountState.loading) {
                return `
                    <div class="content-card snapshot-account-card">
                        <div class="card-header">
                            <div>
                                <h3>${escapeHtml(account.name || "Unnamed account")}</h3>
                                <p>${escapeHtml(account.region || "us-west-1")}</p>
                            </div>
                        </div>
                        <div class="empty-state small">Loading instances...</div>
                    </div>
                `;
            }

            if (accountState.error) {
                return `
                    <div class="content-card snapshot-account-card">
                        <div class="card-header">
                            <div>
                                <h3>${escapeHtml(account.name || "Unnamed account")}</h3>
                                <p>${escapeHtml(account.region || "us-west-1")}</p>
                            </div>
                        </div>
                        <div class="error-box">
                            <strong>Unable to load instances</strong>
                            <p>${escapeHtml(accountState.error)}</p>
                            <button type="button" class="btn secondary retry-account-instances" data-account-id="${escapeHtml(account.id)}">Retry</button>
                        </div>
                    </div>
                `;
            }

            if (!accountState.instances.length) {
                return `
                    <div class="content-card snapshot-account-card">
                        <div class="card-header">
                            <div>
                                <h3>${escapeHtml(account.name || "Unnamed account")}</h3>
                                <p>${escapeHtml(account.region || "us-west-1")}</p>
                            </div>
                        </div>
                        <div class="empty-state small">No instances found in this account/region.</div>
                    </div>
                `;
            }

            // Search matches instance name, instance ID, or the account name
            // itself (so typing an account name surfaces all of its instances).
            const accountNameMatches = (account.name || "").toLowerCase().includes(search);

            const visibleInstances = search
                ? accountState.instances.filter(instance => {
                      if (accountNameMatches) {
                          return true;
                      }

                      const instanceId = String(instance.instanceId || instance.instance_id || "").toLowerCase();
                      const instanceName = String(instance.name || instance.instanceName || "").toLowerCase();

                      return instanceId.includes(search) || instanceName.includes(search);
                  })
                : accountState.instances;

            totalMatches += visibleInstances.length;

            if (search && !visibleInstances.length) {
                // Hide the whole card when a search is active and nothing in
                // this account matches, rather than showing an empty shell.
                return "";
            }

            const eligibleCount = visibleInstances.filter(instance => !isInstanceOverStorageLimit(instance)).length;

            const allEligibleSelected =
                eligibleCount > 0 &&
                visibleInstances
                    .filter(instance => !isInstanceOverStorageLimit(instance))
                    .every(instance => accountState.selectedIds.has(instance.instanceId || instance.instance_id));

            return `
                <div class="content-card snapshot-account-card">
                    <div class="card-header">
                        <div>
                            <h3>${escapeHtml(account.name || "Unnamed account")}</h3>
                            <p>${escapeHtml(account.region || "us-west-1")} &middot; ${visibleInstances.length}${
                search ? ` of ${accountState.instances.length}` : ""
            } instance(s), ${eligibleCount} eligible</p>
                            <p class="muted small-note">Snapshots will be tagged CreatedBy=${escapeHtml(getCreatedByForAccount(account))}</p>
                        </div>
                        <label class="select-all-label">
                            <input
                                type="checkbox"
                                class="select-all-instances"
                                data-account-id="${escapeHtml(account.id)}"
                                ${allEligibleSelected ? "checked" : ""}
                                ${eligibleCount === 0 ? "disabled" : ""}
                            >
                            Select all eligible
                        </label>
                    </div>

                    <div class="instance-checkbox-list">
                        ${visibleInstances
                            .map(instance => {
                                const instanceId = instance.instanceId || instance.instance_id || "";
                                const instanceName = instance.name || instance.instanceName || "Unnamed";
                                const oversized = isInstanceOverStorageLimit(instance);
                                const storage = formatStorageSize(getInstanceStorageGB(instance));
                                const checked = accountState.selectedIds.has(instanceId);

                                return `
                                    <label class="instance-checkbox-row ${oversized ? "disabled" : ""}">
                                        <input
                                            type="checkbox"
                                            class="snapshot-instance-checkbox"
                                            data-account-id="${escapeHtml(account.id)}"
                                            data-instance-id="${escapeHtml(instanceId)}"
                                            ${checked ? "checked" : ""}
                                            ${oversized ? "disabled" : ""}
                                        >
                                        <span class="instance-checkbox-label">
                                            <strong>${escapeHtml(instanceName)}</strong>
                                            <code>${escapeHtml(instanceId)}</code>
                                            <span class="${oversized ? "status error" : "muted"}">${escapeHtml(storage)}</span>
                                            ${oversized ? `<span class="status error">Exceeds 2 TB</span>` : ""}
                                        </span>
                                    </label>
                                `;
                            })
                            .join("")}
                    </div>
                </div>
            `;
        })
        .join("");

    if (search && totalMatches === 0) {
        container.innerHTML = `<div class="empty-state">No instances match "${escapeHtml(search)}".</div>`;
    }

    updateCreateSnapshotSummary();
}

function updateCreateSnapshotSummary() {
    const summary = $("snapshot-selection-summary");
    const createButton = $("create-snapshots");

    let totalSelected = 0;
    let accountsWithSelection = 0;

    Object.values(state.createSnapshot.accounts).forEach(accountState => {
        if (accountState.selectedIds.size > 0) {
            totalSelected += accountState.selectedIds.size;
            accountsWithSelection += 1;
        }
    });

    if (summary) {
        summary.textContent = totalSelected
            ? `${totalSelected} instance(s) selected across ${accountsWithSelection} account(s).`
            : "No instances selected yet.";
    }

    if (createButton) {
        createButton.disabled = totalSelected === 0;
    }
}

function buildSnapshotAccountsPayload() {
    const accounts = [];

    state.accounts.filter(Boolean).forEach(account => {
        const accountState = state.createSnapshot.accounts[account.id];

        if (!accountState || !accountState.selectedIds.size) {
            return;
        }

        accounts.push({
            accountName: account.name,
            accessKeyId: account.accessKeyId,
            secretAccessKey: account.secretAccessKey,
            sessionToken: account.sessionToken || "",
            region: account.region || "us-west-1",
            instances: [...accountState.selectedIds],
            // Sourced from the account's saved name — see getCreatedByForAccount.
            createdBy: getCreatedByForAccount(account)
        });
    });

    return accounts;
}

const DEFAULT_SNAPSHOT_TEAM = "SRE-Server-OPS-T2";

// "Created By" is derived from the AWS account's saved Account Name rather
// than typed in free text: an access key ID has no username embedded in it
// (it's an opaque credential, not a lookup key), so resolving it to a real
// IAM identity would require a signed AWS call (STS GetCallerIdentity) that
// only a backend can make. Until that endpoint exists, the account name the
// user already gave this credential when saving it is the closest available
// stand-in for "who/what this snapshot job ran as" — and it naturally varies
// per account in a multi-account job, which is more correct than one shared
// value applied to every account.
function getCreatedByForAccount(account) {
    return account?.name?.trim() || "Unknown account";
}

function getSnapshotTeamValue() {
    return $("snapshot-team")?.value.trim() || DEFAULT_SNAPSHOT_TEAM;
}

async function createSnapshotsFromInstances() {
    if (!state.accounts.length) {
        toast("Add at least one AWS account first.", "error");
        openCredentials();
        return;
    }

    const accountsPayload = buildSnapshotAccountsPayload();

    if (!accountsPayload.length) {
        toast("Select at least one instance to snapshot.", "error");
        return;
    }

    const retentionDays = Number($("snapshot-retention")?.value || SNAPSHOT_RETENTION_OPTIONS[0]);
    const description = $("snapshot-description")?.value.trim() || "";
    const team = getSnapshotTeamValue();

    const totalInstances = accountsPayload.reduce((sum, acc) => sum + acc.instances.length, 0);

    const createdBySummary = [...new Set(accountsPayload.map(acc => acc.createdBy))].join(", ");

    if (
        !confirm(
            `Create snapshots for ${totalInstances} instance(s) across ${accountsPayload.length} account(s)? ` +
                `Snapshots will be retained for ${retentionDays} day(s) (DeleteAfter: ${retentionDays}Days), tagged Team=${team}, CreatedBy=${createdBySummary}.`
        )
    ) {
        return;
    }

    try {
        setLoading(true, "Creating snapshots across accounts...");

        const data = await api("/api/aws/create-instance-snapshots", {
            method: "POST",
            // Longer timeout than the default: starting snapshots across
            // multiple accounts/volumes/instances can legitimately take
            // longer than the standard 20s window.
            timeoutMs: 90000,
            body: JSON.stringify({
                accounts: accountsPayload,
                retentionDays,
                description,
                // Matches the tag keys used by the underlying
                // `aws ec2 create-snapshot --tag-specifications` call:
                // InstanceName, InstanceId, VolumeId, CreatedBy, CreatedOn,
                // DeleteAfter, Team. The backend fills in per-volume tags
                // (InstanceName/InstanceId/VolumeId/CreatedOn) since those
                // vary per snapshot. CreatedBy now travels per-account inside
                // `accounts[].createdBy` (see buildSnapshotAccountsPayload)
                // rather than as one shared value, since it's sourced from
                // each account's own saved name. Team stays shared across
                // the whole job.
                team,
                deleteAfter: `${retentionDays}Days`
            })
        });

        renderCreateResults(data);

        toast(`Snapshot job ${data.jobId || "started"} started.`, "success");

        showPage("snapshot-dashboard");
    } catch (error) {
        console.error("Snapshot creation failed:", error);
        toast(error?.message || "Unable to create snapshots.", "error");
    } finally {
        setLoading(false);
    }
}

function renderCreateResults(data) {
    const container = $("snapshot-result");

    if (!container) {
        return;
    }

    const perAccount = Array.isArray(data.accounts) ? data.accounts : null;

    container.innerHTML = `
        <div class="success-box">
            <h3>Snapshot job started</h3>
            <p>Job ID: <strong>${escapeHtml(data.jobId || "-")}</strong></p>
            <p>Accounts: <strong>${Number(data.accountCount || (perAccount ? perAccount.length : 0))}</strong></p>
            <p>Instances: <strong>${Number(data.instanceCount || 0)}</strong></p>
            <p>Volumes: <strong>${Number(data.volumeCount || 0)}</strong></p>
            <p>Snapshots: <strong>${Number(data.snapshotCount || 0)}</strong></p>
            <p>Retention: <strong>${Number(data.retentionDays || 0)} day(s)</strong></p>
        </div>

        ${
            perAccount && perAccount.length
                ? `
            <div class="table-wrapper">
                <table>
                    <thead>
                        <tr>
                            <th>Account</th>
                            <th>Region</th>
                            <th>Instances</th>
                            <th>Snapshots</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${perAccount
                            .map(
                                acc => `
                            <tr>
                                <td>${escapeHtml(acc.accountName || "-")}</td>
                                <td>${escapeHtml(acc.region || "-")}</td>
                                <td>${Number(acc.instanceCount || 0)}</td>
                                <td>${Number(acc.snapshotCount || 0)}</td>
                                <td><span class="status ${escapeHtml(acc.status || "")}">${escapeHtml(acc.status || "-")}</span></td>
                            </tr>
                        `
                            )
                            .join("")}
                    </tbody>
                </table>
            </div>
        `
                : ""
        }
    `;
}


/* =========================================================
   PAGE NAVIGATION
========================================================= */

function showPage(page) {
    if (!page) {
        page = "dashboard";
    }

    if (page !== "snapshots") stopSnapshotPolling();
    if (page !== "snapshot-dashboard") stopSnapshotDashboardPolling();
    if (page !== "revert-dashboard") stopRevertDashboardPolling();

    const pages = document.querySelectorAll(".page");

    pages.forEach(element => {
        element.classList.toggle("active", element.id === page);
    });

    document.querySelectorAll("[data-page]").forEach(button => {
        button.classList.toggle("active", button.dataset.page === page);
    });

    const titles = {
        dashboard: "Dashboard",
        instances: "Instances",
        volumes: "Volumes",
        snapshots: "Snapshots",
        "create-snapshot": "Create Snapshot",
        "snapshot-dashboard": "Snapshot Jobs",
        "revert-snapshot": "Revert Snapshot",
        "revert-dashboard": "Revert History"
    };

    if ($("page-title")) {
        $("page-title").textContent = titles[page] || "AWS Snapshot Portal";
    }

    state.currentPage = page;

    if (page === "dashboard") loadDashboard();
    if (page === "instances") loadInstances();
    if (page === "volumes") loadVolumes();

    if (page === "snapshots") {
        startSnapshotPolling();
    }

    if (page === "create-snapshot") loadInstancesForSnapshot();

    if (page === "snapshot-dashboard") {
        loadSnapshotDashboard();
        startSnapshotDashboardPolling();
    }

    if (page === "revert-snapshot") {
        resetRevertState();
        initRevertPage();
    }

    if (page === "revert-dashboard") {
        loadRevertDashboard();
        startRevertDashboardPolling();
    }
}


/* =========================================================
   SNAPSHOT DASHBOARD
========================================================= */

async function loadSnapshotDashboard() {
    try {
        const data = await api("/api/snapshot-dashboard");

        renderSnapshotDashboard(data);

        await syncRunningJobs(Array.isArray(data.jobs) ? data.jobs : []);
    } catch (error) {
        console.error("Snapshot dashboard loading failed:", error);
        toast(error?.message || "Unable to load snapshot jobs.", "error");
    }
}

function renderSnapshotDashboard(data) {
    const summary = data.summary || {};

    if ($("sd-total-jobs")) $("sd-total-jobs").textContent = Number(summary.total_jobs || 0);
    if ($("sd-running-jobs")) $("sd-running-jobs").textContent = Number(summary.running_jobs || 0);
    if ($("sd-total-snapshots")) $("sd-total-snapshots").textContent = Number(summary.total_snapshots || 0);
    if ($("sd-completed-snapshots")) $("sd-completed-snapshots").textContent = Number(summary.completed_snapshots || 0);
    if ($("sd-failed-snapshots")) $("sd-failed-snapshots").textContent = Number(summary.failed_snapshots || 0);

    // Cached so cancelSnapshotJob can re-render the table immediately after
    // a cancel without waiting for the next poll or a full reload.
    state.snapshotJobs = Array.isArray(data.jobs) ? data.jobs : [];

    renderSnapshotJobs(state.snapshotJobs);
}

function renderSnapshotJobs(jobs) {
    const container = $("snapshot-jobs-table");

    if (!container) {
        return;
    }

    if (!jobs.length) {
        container.innerHTML = `<div class="empty-state">No snapshot jobs found.</div>`;
        return;
    }

    container.innerHTML = `
        <div class="table-wrapper">
            <table>
                <thead>
                    <tr>
                        <th>Job</th>
                        <th>Account</th>
                        <th>Region</th>
                        <th>Status</th>
                        <th>Instances</th>
                        <th>Volumes</th>
                        <th>Snapshots</th>
                        <th>Completed</th>
                        <th>Failed</th>
                        <th>Progress</th>
                        <th>Created By</th>
                        <th>Started</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${jobs
                        .map(job => {
                            const isRunning = job.status === "running";
                            const cancelling = state.cancellingJobIds?.has(job.job_id);

                            return `
                        <tr>
                            <td><button type="button" class="link-button job-details" data-job-id="${escapeHtml(job.job_id || "")}">${escapeHtml(job.job_id || "-")}</button></td>
                            <td>${escapeHtml(job.account_name || "-")}</td>
                            <td><strong>${escapeHtml(job.region || "-")}</strong></td>
                            <td><span class="status ${escapeHtml(job.status || "")}">${escapeHtml(job.status || "-")}</span></td>
                            <td>${Number(job.total_instances || 0)}</td>
                            <td>${Number(job.total_volumes || 0)}</td>
                            <td>${Number(job.total_snapshots || 0)}</td>
                            <td>${Number(job.completed_snapshots || 0)}</td>
                            <td>${Number(job.failed_snapshots || 0)}</td>
                            <td>
                                <div class="progress">
                                    <div class="progress-bar" style="width:${Math.max(0, Math.min(100, Number(job.progress || 0)))}%"></div>
                                </div>
                                <small>${Number(job.progress || 0).toFixed(1)}%</small>
                            </td>
                            <td>${escapeHtml(job.created_by || "-")}</td>
                            <td>${formatDate(job.started_at)}</td>
                            <td>
                                ${
                                    isRunning
                                        ? `<button type="button" class="btn secondary btn-cancel-job" data-job-id="${escapeHtml(job.job_id || "")}" ${cancelling ? "disabled" : ""}>${cancelling ? "Cancelling..." : "Cancel"}</button>`
                                        : `<span class="muted">-</span>`
                                }
                            </td>
                        </tr>
                    `;
                        })
                        .join("")}
                </tbody>
            </table>
        </div>
    `;
}


/* =========================================================
   JOB DETAILS
========================================================= */

async function showJobDetails(jobId) {
    if (!jobId) {
        return;
    }

    try {
        const data = await api(`/api/snapshot-jobs/${encodeURIComponent(jobId)}`);

        const job = data.job || {};
        const items = Array.isArray(data.items) ? data.items : [];

        const modal = $("job-details-modal");
        const content = $("job-details-content");

        if (!modal || !content) {
            return;
        }

        content.innerHTML = `
            <div class="job-summary">
                <h2>${escapeHtml(job.job_id || jobId)}</h2>
                <p>Status: <strong>${escapeHtml(job.status || "-")}</strong></p>
                <p>Progress: <strong>${Number(job.progress || 0).toFixed(1)}%</strong></p>
                ${
                    job.status === "running"
                        ? `<button type="button" class="btn secondary btn-cancel-job" data-job-id="${escapeHtml(job.job_id || jobId)}" ${state.cancellingJobIds?.has(job.job_id || jobId) ? "disabled" : ""}>${state.cancellingJobIds?.has(job.job_id || jobId) ? "Cancelling..." : "Cancel Job"}</button>`
                        : ""
                }
            </div>
            <div class="table-wrapper">
                <table>
                    <thead>
                        <tr>
                            <th>Instance</th>
                            <th>Instance ID</th>
                            <th>Volume</th>
                            <th>Snapshot</th>
                            <th>Status</th>
                            <th>Progress</th>
                            <th>Error</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${items
                            .map(
                                item => `
                            <tr>
                                <td>${escapeHtml(item.instance_name || "-")}</td>
                                <td><code>${escapeHtml(item.instance_id || "-")}</code></td>
                                <td><code>${escapeHtml(item.volume_id || "-")}</code></td>
                                <td><code>${escapeHtml(item.snapshot_id || "-")}</code></td>
                                <td>${escapeHtml(item.status || "-")}</td>
                                <td>${Number(item.progress || 0)}%</td>
                                <td>${escapeHtml(item.error_message || "")}</td>
                            </tr>
                        `
                            )
                            .join("")}
                    </tbody>
                </table>
            </div>
        `;

        modal.classList.add("show");
    } catch (error) {
        console.error("Unable to load job details:", error);
        toast(error?.message || "Unable to load job details.", "error");
    }
}

function closeJobDetails() {
    $("job-details-modal")?.classList.remove("show");
}


/* =========================================================
   JOB CANCELLATION
========================================================= */

async function cancelSnapshotJob(jobId) {
    if (!jobId) {
        return;
    }

    if (!getActiveAccount()) {
        toast("Select the AWS account this job belongs to before cancelling.", "error");
        return;
    }

    if (
        !confirm(
            `Cancel snapshot job ${jobId}?\n\n` +
                "This will mark the job cancelled and attempt to stop and delete any in-progress " +
                "AWS snapshots it created. Snapshots that have already completed will NOT be removed."
        )
    ) {
        return;
    }

    if (!state.cancellingJobIds) {
        state.cancellingJobIds = new Set();
    }

    state.cancellingJobIds.add(jobId);
    renderSnapshotJobs(state.snapshotJobs || []);

    try {
        await api(`/api/snapshot-jobs/${encodeURIComponent(jobId)}/cancel`, {
            method: "POST",
            timeoutMs: 30000,
            body: JSON.stringify(getRequestBody())
        });

        toast(`Snapshot job ${jobId} cancelled.`, "success");

        // Refresh immediately so the table reflects the new status without
        // waiting for the next 15s poll tick.
        await loadSnapshotDashboard();

        // If the job details modal is open for this job, refresh it too.
        if ($("job-details-modal")?.classList.contains("show")) {
            showJobDetails(jobId);
        }
    } catch (error) {
        console.error(`Unable to cancel job ${jobId}:`, error);
        toast(error?.message || `Unable to cancel job ${jobId}.`, "error");
    } finally {
        state.cancellingJobIds.delete(jobId);
        renderSnapshotJobs(state.snapshotJobs || []);
    }
}


/* =========================================================
   JOB SYNC / AUTO REFRESH
========================================================= */

async function syncRunningJobs(jobs) {
    const activeJobs = jobs.filter(job => job?.status === "running");

    if (!activeJobs.length) {
        return;
    }

    const account = getActiveAccount();

    if (!account) {
        return;
    }

    for (const job of activeJobs) {
        if (job.account_name !== account.name) {
            continue;
        }

        try {
            await api(`/api/snapshot-jobs/${encodeURIComponent(job.job_id)}/sync`, {
                method: "POST",
                body: JSON.stringify(getRequestBody())
            });
        } catch (error) {
            console.error(`Unable to sync ${job.job_id}`, error);
        }
    }
}

function startSnapshotDashboardPolling() {
    stopSnapshotDashboardPolling();

    state.snapshotDashboardTimer = setInterval(() => {
        if (state.currentPage === "snapshot-dashboard") {
            loadSnapshotDashboard();
        }
    }, SNAPSHOT_DASHBOARD_POLL_INTERVAL);
}

function stopSnapshotDashboardPolling() {
    if (state.snapshotDashboardTimer) {
        clearInterval(state.snapshotDashboardTimer);
        state.snapshotDashboardTimer = null;
    }
}


/* =========================================================
   REVERT SNAPSHOT DASHBOARD

   Expected API (not yet implemented server-side):

   GET /api/revert-dashboard
   {
       "summary": {
           "total_jobs": 10,
           "running_jobs": 1,
           "completed_jobs": 8,
           "failed_jobs": 1,
           "total_volumes": 14
       },
       "jobs": [
           {
               "job_id": "revert-123",
               "status": "completed" | "running" | "failed",
               "reverted_by": "john.doe",
               "account_name": "Production",
               "region": "us-east-1",
               "instance_name": "web-server-01",
               "instance_id": "i-0123456789",
               "total_volumes": 2,
               "total_snapshots": 2,
               "completed_volumes": 2,
               "failed_volumes": 0,
               "started_at": "2026-08-31T10:00:00Z",
               "completed_at": "2026-08-31T10:05:00Z"
           }
       ]
   }

   GET /api/revert-jobs/:jobId
   {
       "job": { ...same shape as above... },
       "items": [
           {
               "original_volume_id": "vol-old",
               "snapshot_id": "snap-123",
               "new_volume_id": "vol-new",
               "instance_name": "web-server-01",
               "size": 100,
               "status": "completed" | "running" | "failed",
               "error_message": "",
               "reverted_by": "john.doe",
               "reverted_at": "2026-08-31T10:04:00Z"
           }
       ]
   }
========================================================= */

function revertDashboardStatusClass(status) {
    const normalized = String(status || "").toLowerCase().replaceAll("_", "-");

    if (["completed", "success", "succeeded"].includes(normalized)) return "completed";
    if (["running", "in-progress", "pending"].includes(normalized)) return "running";
    if (["failed", "error"].includes(normalized)) return "failed";

    return normalized;
}

async function loadRevertDashboard() {
    const container = $("revert-jobs-table");

    if (!container) {
        return;
    }

    try {
        const data = await api("/api/revert-dashboard");

        renderRevertDashboard(data);
    } catch (error) {
        console.error("Revert dashboard loading failed:", error);

        toast(error?.message || "Unable to load revert history.", "error");

        container.innerHTML = `
            <div class="empty-state">
                <strong>Unable to load revert history</strong>
                <p>${escapeHtml(error?.message || "Unknown error")}</p>
                <button type="button" class="btn secondary" id="retry-revert-dashboard">Retry</button>
            </div>
        `;

        $("retry-revert-dashboard")?.addEventListener("click", loadRevertDashboard);
    }
}

function renderRevertDashboard(data) {
    const summary = data?.summary || {};
    const jobs = Array.isArray(data?.jobs) ? data.jobs : [];

    if ($("rd-total-jobs")) $("rd-total-jobs").textContent = Number(summary.total_jobs || 0);
    if ($("rd-running-jobs")) $("rd-running-jobs").textContent = Number(summary.running_jobs || 0);
    if ($("rd-completed-jobs")) $("rd-completed-jobs").textContent = Number(summary.completed_jobs || 0);
    if ($("rd-failed-jobs")) $("rd-failed-jobs").textContent = Number(summary.failed_jobs || 0);
    if ($("rd-total-volumes")) $("rd-total-volumes").textContent = Number(summary.total_volumes || 0);

    renderRevertDashboardJobs(jobs);
}

function renderRevertDashboardJobs(jobs) {
    const container = $("revert-jobs-table");

    if (!container) {
        return;
    }

    if (!jobs.length) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">↻</div>
                <h3>No revert activity</h3>
                <p>No snapshot revert operations have been recorded yet.</p>
            </div>
        `;

        return;
    }

    container.innerHTML = `
        <div class="table-wrapper">
            <table>
                <thead>
                    <tr>
                        <th>Job ID</th>
                        <th>Status</th>
                        <th>Reverted By</th>
                        <th>Account</th>
                        <th>Region</th>
                        <th>Instance</th>
                        <th>Instance ID</th>
                        <th>Volumes</th>
                        <th>Snapshots</th>
                        <th>Started</th>
                        <th>Completed</th>
                    </tr>
                </thead>
                <tbody>
                    ${jobs
                        .map(job => {
                            const statusClass = revertDashboardStatusClass(job.status);

                            return `
                                <tr>
                                    <td>
                                        <button type="button" class="link-button revert-job-details" data-job-id="${escapeHtml(job.job_id || "")}">
                                            ${escapeHtml(job.job_id || "-")}
                                        </button>
                                    </td>
                                    <td><span class="status ${escapeHtml(statusClass)}">${escapeHtml(job.status || "-")}</span></td>
                                    <td>${escapeHtml(job.reverted_by || job.created_by || job.username || "-")}</td>
                                    <td>${escapeHtml(job.account_name || "-")}</td>
                                    <td>${escapeHtml(job.region || "-")}</td>
                                    <td><strong>${escapeHtml(job.instance_name || "-")}</strong></td>
                                    <td><code>${escapeHtml(job.instance_id || "-")}</code></td>
                                    <td>${Number(job.total_volumes || 0)}</td>
                                    <td>${Number(job.total_snapshots || 0)}</td>
                                    <td>${formatDate(job.started_at || job.created_at)}</td>
                                    <td>${formatDate(job.completed_at)}</td>
                                </tr>
                            `;
                        })
                        .join("")}
                </tbody>
            </table>
        </div>
    `;
}

async function showRevertJobDetails(jobId) {
    if (!jobId) {
        return;
    }

    const modal = $("revert-job-details-modal");
    const content = $("revert-job-details-content");

    if (!modal || !content) {
        return;
    }

    modal.classList.add("show");

    content.innerHTML = `<div class="empty-state small">Loading revert details...</div>`;

    try {
        const data = await api(`/api/revert-jobs/${encodeURIComponent(jobId)}`);

        renderRevertJobDetails(data);
    } catch (error) {
        console.error("Revert job details error:", error);

        content.innerHTML = `
            <div class="empty-state small">
                <strong>Unable to load revert details</strong>
                <p>${escapeHtml(error?.message || "Unknown error")}</p>
            </div>
        `;
    }
}

function renderRevertJobDetails(data) {
    const job = data?.job || {};
    const items = Array.isArray(data?.items) ? data.items : [];

    const content = $("revert-job-details-content");

    if (!content) {
        return;
    }

    const revertedBy = job.reverted_by || job.created_by || job.username || "-";

    content.innerHTML = `
        <div class="job-summary">
            <h2>${escapeHtml(job.job_id || "-")}</h2>
            <p>Status: <span class="status ${escapeHtml(revertDashboardStatusClass(job.status))}">${escapeHtml(job.status || "-")}</span></p>
        </div>

        <div class="account-summary">
            <div class="summary-item"><span>Reverted By</span><strong>${escapeHtml(revertedBy)}</strong></div>
            <div class="summary-item"><span>Account</span><strong>${escapeHtml(job.account_name || "-")}</strong></div>
            <div class="summary-item"><span>Region</span><strong>${escapeHtml(job.region || "-")}</strong></div>
            <div class="summary-item"><span>Instance</span><strong>${escapeHtml(job.instance_name || "-")}</strong></div>
            <div class="summary-item"><span>Instance ID</span><strong><code>${escapeHtml(job.instance_id || "-")}</code></strong></div>
            <div class="summary-item"><span>Started</span><strong>${formatDate(job.started_at || job.created_at)}</strong></div>
            <div class="summary-item"><span>Completed</span><strong>${formatDate(job.completed_at)}</strong></div>
        </div>

        <div class="divider"></div>

        <h3>Volumes Restored (${items.length})</h3>

        ${
            items.length
                ? `
            <div class="table-wrapper">
                <table>
                    <thead>
                        <tr>
                            <th>Original Volume</th>
                            <th>Snapshot Used</th>
                            <th>New Volume</th>
                            <th>Instance</th>
                            <th>Size</th>
                            <th>Status</th>
                            <th>Reverted By</th>
                            <th>Reverted At</th>
                            <th>Error</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${items
                            .map(
                                item => `
                            <tr>
                                <td><code>${escapeHtml(item.original_volume_id || item.source_volume_id || "-")}</code></td>
                                <td><code>${escapeHtml(item.snapshot_id || "-")}</code></td>
                                <td><code>${escapeHtml(item.new_volume_id || item.restored_volume_id || "-")}</code></td>
                                <td>${escapeHtml(item.instance_name || job.instance_name || "-")}</td>
                                <td>${item.size ? `${Number(item.size)} GB` : "-"}</td>
                                <td><span class="status ${escapeHtml(revertDashboardStatusClass(item.status))}">${escapeHtml(item.status || "-")}</span></td>
                                <td>${escapeHtml(item.reverted_by || revertedBy)}</td>
                                <td>${formatDate(item.reverted_at || job.completed_at)}</td>
                                <td>${escapeHtml(item.error_message || item.error || "-")}</td>
                            </tr>
                        `
                            )
                            .join("")}
                    </tbody>
                </table>
            </div>
        `
                : `<div class="empty-state small">No volume details were recorded for this job.</div>`
        }
    `;
}

function closeRevertJobDetails() {
    $("revert-job-details-modal")?.classList.remove("show");
}

function startRevertDashboardPolling() {
    stopRevertDashboardPolling();

    loadRevertDashboard();

    state.revertDashboardTimer = setInterval(() => {
        if (state.currentPage === "revert-dashboard") {
            loadRevertDashboard();
        }
    }, REVERT_DASHBOARD_POLL_INTERVAL);
}

function stopRevertDashboardPolling() {
    if (state.revertDashboardTimer) {
        clearInterval(state.revertDashboardTimer);
        state.revertDashboardTimer = null;
    }
}


/* =========================================================
   REVERT SNAPSHOT — matches the actual index.html IDs:
   #restore-region-select -> #restore-instance-select
   -> #restore-volume-select (multi) -> #restore-snapshot-select
   -> #restore-snapshot-button
========================================================= */

function resetRevertState() {
    state.revert.region = null;
    state.revert.instance = null;
    state.revert.volumes = [];
    state.revert.selectedVolumeIds = [];
    state.revert.snapshotsByVolume = {};
    state.revert.queue = [];
    state.revert.restoring = false;

    const regionSelect = $("restore-region-select");
    const instanceSelect = $("restore-instance-select");
    const volumeSelect = $("restore-volume-select");
    const snapshotSelect = $("restore-snapshot-select");
    const startButton = $("restore-snapshot-button");
    const addToQueueButton = $("add-to-queue-btn");

    if (regionSelect) regionSelect.value = "";

    if (instanceSelect) {
        instanceSelect.innerHTML = `<option value="">Select an instance</option>`;
        instanceSelect.disabled = true;
    }

    if (volumeSelect) {
        volumeSelect.innerHTML = `<option value="">Select an instance first</option>`;
        volumeSelect.disabled = true;
    }

    if (snapshotSelect) {
        snapshotSelect.innerHTML = `<option value="">Select volume(s) first</option>`;
        snapshotSelect.disabled = true;
    }

    if (startButton) startButton.disabled = true;
    if (addToQueueButton) addToQueueButton.disabled = true;

    const panelStartButton = $("restore-snapshot-button-panel");
    if (panelStartButton) panelStartButton.disabled = true;

    document.querySelectorAll(".add-to-queue-btn-secondary").forEach(button => {
        button.disabled = true;
    });

    setRevertStepStatus("restore-instance-status", "waiting", "Waiting");
    setRevertStepStatus("restore-volume-status", "waiting", "Waiting");
    setRevertStepStatus("restore-snapshot-status", "waiting", "Waiting");

    renderRevertQueue();
    updateRevertSummaryPanel();
}

function setRevertStepStatus(elementId, className, label) {
    const element = $(elementId);

    if (!element) {
        return;
    }

    element.className = `step-status ${className}`;
    element.textContent = label;
}

function initRevertPage() {
    // Nothing to fetch until a region is picked; just make sure the
    // downstream selects reflect the current (empty) revert state.
    resetRevertState();
}

async function handleRevertRegionChange(region) {
    state.revert.region = region || null;

    state.revert.instance = null;
    state.revert.volumes = [];
    state.revert.selectedVolumeIds = [];
    state.revert.snapshotsByVolume = {};
    state.revert.queue = [];

    const instanceSelect = $("restore-instance-select");
    const volumeSelect = $("restore-volume-select");
    const snapshotSelect = $("restore-snapshot-select");
    const startButton = $("restore-snapshot-button");
    const addToQueueButton = $("add-to-queue-btn");

    if (volumeSelect) {
        volumeSelect.innerHTML = `<option value="">Select an instance first</option>`;
        volumeSelect.disabled = true;
    }

    if (snapshotSelect) {
        snapshotSelect.innerHTML = `<option value="">Select volume(s) first</option>`;
        snapshotSelect.disabled = true;
    }

    if (startButton) startButton.disabled = true;
    if (addToQueueButton) addToQueueButton.disabled = true;

    setRevertStepStatus("restore-volume-status", "waiting", "Waiting");
    setRevertStepStatus("restore-snapshot-status", "waiting", "Waiting");

    renderRevertQueue();
    updateRevertSummaryPanel();

    if (!region) {
        if (instanceSelect) {
            instanceSelect.innerHTML = `<option value="">Select a region first</option>`;
            instanceSelect.disabled = true;
        }

        setRevertStepStatus("restore-instance-status", "waiting", "Waiting");

        return;
    }

    if (!getActiveAccount()) {
        toast("Connect an AWS account first.", "error");

        if (instanceSelect) {
            instanceSelect.innerHTML = `<option value="">Connect an AWS account first</option>`;
            instanceSelect.disabled = true;
        }

        return;
    }

    try {
        setLoading(true, "Loading instances for the selected region...");

        const [instancesRes, volumesRes, snapshotsRes] = await Promise.all([
            api("/api/aws/instances", { method: "POST", body: JSON.stringify(getRequestBody({ region })) }),
            api("/api/aws/volumes", { method: "POST", body: JSON.stringify(getRequestBody({ region })) }),
            api("/api/aws/snapshots", { method: "POST", body: JSON.stringify(getRequestBody({ region })) })
        ]);

        state.instances = deduplicateInstances(instancesRes.instances || []);
        state.volumes = Array.isArray(volumesRes.volumes) ? volumesRes.volumes : [];
        state.snapshots = Array.isArray(snapshotsRes.snapshots) ? snapshotsRes.snapshots : [];

        if (instanceSelect) {
            instanceSelect.innerHTML = `<option value="">Select an instance</option>`;

            state.instances.forEach(instance => {
                const instanceId = instance.instanceId || instance.instance_id || "";
                const instanceName = instance.name || instance.instanceName || "Unnamed";

                const option = document.createElement("option");
                option.value = instanceId;
                option.textContent = `${instanceName} (${instanceId})`;
                instanceSelect.appendChild(option);
            });

            instanceSelect.disabled = state.instances.length === 0;
        }

        setRevertStepStatus(
            "restore-instance-status",
            state.instances.length ? "required" : "waiting",
            state.instances.length ? "Required" : "No instances found"
        );

        updateVolumeTotals();
    } catch (error) {
        console.error("Failed to load region data for revert:", error);
        toast(error?.message || "Unable to load region data.", "error");

        if (instanceSelect) {
            instanceSelect.innerHTML = `<option value="">Unable to load instances</option>`;
            instanceSelect.disabled = true;
        }
    } finally {
        setLoading(false);
    }
}

function handleRevertInstanceSelection(instanceId) {
    const volumeSelect = $("restore-volume-select");
    const snapshotSelect = $("restore-snapshot-select");
    const startButton = $("restore-snapshot-button");
    const addToQueueButton = $("add-to-queue-btn");
    const infoBox = $("restore-instance-info");

    state.revert.selectedVolumeIds = [];
    state.revert.snapshotsByVolume = {};
    state.revert.queue = [];

    if (snapshotSelect) {
        snapshotSelect.innerHTML = `<option value="">Select volume(s) first</option>`;
        snapshotSelect.disabled = true;
    }

    if (startButton) startButton.disabled = true;
    if (addToQueueButton) addToQueueButton.disabled = true;

    setRevertStepStatus("restore-snapshot-status", "waiting", "Waiting");

    renderRevertQueue();

    if (!instanceId) {
        state.revert.instance = null;
        state.revert.volumes = [];

        if (volumeSelect) {
            volumeSelect.innerHTML = `<option value="">Select an instance first</option>`;
            volumeSelect.disabled = true;
        }

        setRevertStepStatus("restore-volume-status", "waiting", "Waiting");

        if (infoBox) infoBox.innerHTML = "";

        updateRevertSummaryPanel();

        return;
    }

    const instance = state.instances.find(
        i => String(i.instanceId || i.instance_id || "").trim() === instanceId
    );

    if (!instance) {
        return;
    }

    state.revert.instance = instance;

    state.revert.volumes = state.volumes.filter(
        v => String(v?.attachedInstance || v?.instanceId || "").trim() === instanceId
    );

    if (infoBox) {
        infoBox.innerHTML = `
            <div class="restore-preview-item">
                <strong>${escapeHtml(instance.name || instance.instanceName || instanceId)}</strong>
                <span>State: ${escapeHtml(instance.state || "-")}</span>
                <span>${state.revert.volumes.length} attached volume(s)</span>
            </div>
        `;
    }

    if (volumeSelect) {
        volumeSelect.innerHTML = "";

        if (!state.revert.volumes.length) {
            volumeSelect.innerHTML = `<option value="">No volumes attached to this instance</option>`;
            volumeSelect.disabled = true;
        } else {
            state.revert.volumes.forEach(volume => {
                const volumeId = volume.volumeId || volume.volume_id || "";

                const option = document.createElement("option");
                option.value = volumeId;
                option.textContent = `${volumeId} (${Number(volume.size || 0)} GB)`;
                volumeSelect.appendChild(option);
            });

            volumeSelect.disabled = false;
        }
    }

    setRevertStepStatus(
        "restore-volume-status",
        state.revert.volumes.length ? "required" : "waiting",
        state.revert.volumes.length ? "Required" : "No volumes found"
    );

    updateRevertSummaryPanel();
}

function handleRevertVolumeSelection(selectedOptions) {
    const selectedVolumeIds = Array.from(selectedOptions)
        .map(option => option.value)
        .filter(Boolean);

    state.revert.selectedVolumeIds = selectedVolumeIds;

    const snapshotSelect = $("restore-snapshot-select");
    const addToQueueButton = $("add-to-queue-btn");
    const infoBox = $("restore-volume-info");

    if (infoBox) {
        infoBox.innerHTML = selectedVolumeIds.length
            ? `<div class="muted">${selectedVolumeIds.length} volume(s) selected.</div>`
            : "";
    }

    if (!selectedVolumeIds.length) {
        if (snapshotSelect) {
            snapshotSelect.innerHTML = `<option value="">Select volume(s) first</option>`;
            snapshotSelect.disabled = true;
        }

        if (addToQueueButton) addToQueueButton.disabled = true;

        setRevertStepStatus("restore-snapshot-status", "waiting", "Waiting");

        return;
    }

    // Build the snapshot list scoped to the selected volumes.
    state.revert.snapshotsByVolume = {};

    selectedVolumeIds.forEach(volumeId => {
        const matches = state.snapshots.filter(
            snapshot => String(snapshot.volumeId || snapshot.volume_id || "") === volumeId
        );

        matches.sort(
            (a, b) => new Date(b.startTime || b.start_time || 0) - new Date(a.startTime || a.start_time || 0)
        );

        state.revert.snapshotsByVolume[volumeId] = matches;
    });

    if (snapshotSelect) {
        snapshotSelect.innerHTML = "";

        let hasAnySnapshot = false;

        selectedVolumeIds.forEach(volumeId => {
            const snaps = state.revert.snapshotsByVolume[volumeId] || [];

            snaps.forEach(snap => {
                hasAnySnapshot = true;

                const snapshotId = snap.snapshotId || snap.snapshot_id || "";
                const label = snap.description || formatDate(snap.startTime || snap.start_time);

                const option = document.createElement("option");
                option.value = `${volumeId}::${snapshotId}`;
                option.textContent = `${volumeId} -> ${snapshotId} (${label})`;
                snapshotSelect.appendChild(option);
            });
        });

        if (!hasAnySnapshot) {
            snapshotSelect.innerHTML = `<option value="">No snapshots available for the selected volume(s)</option>`;
            snapshotSelect.disabled = true;
        } else {
            snapshotSelect.disabled = false;
        }
    }

    setRevertStepStatus(
        "restore-snapshot-status",
        Object.values(state.revert.snapshotsByVolume).some(list => list.length) ? "required" : "waiting",
        Object.values(state.revert.snapshotsByVolume).some(list => list.length)
            ? "Required"
            : "No snapshots found"
    );

    updateAddToQueueButtonState();
}

function updateAddToQueueButtonState() {
    const snapshotSelect = $("restore-snapshot-select");
    const disabled = !snapshotSelect || !snapshotSelect.value;

    const addToQueueButton = $("add-to-queue-btn");
    if (addToQueueButton) addToQueueButton.disabled = disabled;

    document.querySelectorAll(".add-to-queue-btn-secondary").forEach(button => {
        button.disabled = disabled;
    });
}

function addRevertSelectionToQueue() {
    const snapshotSelect = $("restore-snapshot-select");

    if (!snapshotSelect || !snapshotSelect.value) {
        toast("Select a volume/snapshot pairing first.", "error");
        return;
    }

    const [volumeId, snapshotId] = snapshotSelect.value.split("::");

    if (!volumeId || !snapshotId) {
        return;
    }

    const alreadyQueued = state.revert.queue.some(item => item.volumeId === volumeId);

    if (alreadyQueued) {
        state.revert.queue = state.revert.queue.map(item =>
            item.volumeId === volumeId ? { volumeId, snapshotId } : item
        );

        toast(`Updated queued snapshot for ${volumeId}.`, "success");
    } else {
        state.revert.queue.push({ volumeId, snapshotId });
        toast(`Added ${volumeId} to the restore queue.`, "success");
    }

    renderRevertQueue();
    updateRevertSummaryPanel();
    updateStartButtonState();
}

function removeRevertQueueItem(volumeId) {
    state.revert.queue = state.revert.queue.filter(item => item.volumeId !== volumeId);

    renderRevertQueue();
    updateRevertSummaryPanel();
    updateStartButtonState();
}

function renderRevertQueue() {
    const list = $("restore-queue-list");
    const badge = $("queue-counter-badge");
    const emptyText = $("queue-empty-text");

    if (badge) {
        badge.textContent = `${state.revert.queue.length} task${state.revert.queue.length === 1 ? "" : "s"} queued`;
    }

    if (!list) {
        return;
    }

    if (!state.revert.queue.length) {
        list.innerHTML = `<p id="queue-empty-text" class="muted" style="text-align:center;margin:10px 0;">No restore tasks added to the queue yet.</p>`;
        return;
    }

    list.innerHTML = state.revert.queue
        .map(
            item => `
        <div class="revert-queue-row" style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;">
            <span><code>${escapeHtml(item.volumeId)}</code> &rarr; <code>${escapeHtml(item.snapshotId)}</code></span>
            <button type="button" class="btn-remove-queue-item" data-volume-id="${escapeHtml(item.volumeId)}">Remove</button>
        </div>
    `
        )
        .join("");
}

function updateStartButtonState() {
    const disabled = state.revert.queue.length === 0 || state.revert.restoring;

    const startButton = $("restore-snapshot-button");
    if (startButton) startButton.disabled = disabled;

    const panelButton = $("restore-snapshot-button-panel");
    if (panelButton) panelButton.disabled = disabled;
}

function updateRevertSummaryPanel() {
    const instance = state.revert.instance;

    if ($("restore-summary-region")) {
        $("restore-summary-region").textContent = state.revert.region || "-";
    }

    if ($("restore-summary-instance")) {
        $("restore-summary-instance").textContent = instance
            ? instance.name || instance.instanceName || instance.instanceId || instance.instance_id
            : "-";
    }

    if ($("restore-summary-old-volume")) {
        $("restore-summary-old-volume").textContent = state.revert.queue.length
            ? state.revert.queue.map(item => item.volumeId).join(", ")
            : "-";
    }

    if ($("restore-summary-snapshot")) {
        $("restore-summary-snapshot").textContent = state.revert.queue.length
            ? state.revert.queue.map(item => item.snapshotId).join(", ")
            : "-";
    }
}

async function revertFromSnapshot() {
    const account = getActiveAccount();

    if (!account) {
        toast("Connect an AWS account first.", "error");
        return;
    }

    const instance = state.revert.instance;

    if (!instance) {
        toast("Select an instance to revert.", "error");
        return;
    }

    if (!state.revert.queue.length) {
        toast("Add at least one volume/snapshot pairing to the queue.", "error");
        return;
    }

    const instanceId = instance.instanceId || instance.instance_id;

    if (
        !confirm(
            `Revert ${state.revert.queue.length} volume(s) on instance ${instanceId}? ` +
                `This will stop the instance, detach the selected volume(s), and attach new volumes created from the chosen snapshots.`
        )
    ) {
        return;
    }

    const restores = {};
    state.revert.queue.forEach(item => {
        restores[item.volumeId] = item.snapshotId;
    });

    try {
        state.revert.restoring = true;
        updateStartButtonState();

        setLoading(true, "Initiating snapshot revert process...");

        const requestPayload = {
            ...getRequestBody({ region: state.revert.region }),
            instanceId,
            restores
        };

        const result = await api("/api/aws/snapshots/revert", {
            method: "POST",
            body: JSON.stringify(requestPayload)
        });

        toast(result.message || "Snapshot revert process completed successfully.", "success");

        resetRevertState();

        showPage("dashboard");
    } catch (error) {
        console.error("Snapshot revert failed:", error);
        toast(error?.message || "Failed to execute snapshot revert.", "error");
    } finally {
        state.revert.restoring = false;
        setLoading(false);
        updateStartButtonState();
    }
}


/* =========================================================
   EVENT LISTENERS
========================================================= */

function setupEventListeners() {

    /* LOADING OVERLAY ESCAPE HATCH
       If a request hangs indefinitely for a reason the app didn't
       anticipate, the loading overlay could otherwise block every click
       on the page with no way out. Holding it for 3 seconds force-clears
       it so the portal is never fully unusable. */
    let loadingHoldTimer = null;

    $("loading")?.addEventListener("mousedown", () => {
        loadingHoldTimer = setTimeout(() => {
            forceHideLoading();
            toast("Loading indicator cleared. If a request is still pending, its result may arrive shortly.", "info");
        }, 3000);
    });

    ["mouseup", "mouseleave"].forEach(evt => {
        $("loading")?.addEventListener(evt, () => {
            clearTimeout(loadingHoldTimer);
        });
    });


    /* PAGE NAVIGATION */
    document.querySelectorAll("[data-page]").forEach(button => {
        button.addEventListener("click", () => {
            showPage(button.dataset.page);
        });
    });

    /* ACCOUNT */
    $("account-select")?.addEventListener("change", switchAccount);
    $("region")?.addEventListener("change", regionChanged);
    $("open-credentials")?.addEventListener("click", openCredentials);
    $("close-credentials")?.addEventListener("click", closeCredentials);
    $("dashboard-add-account")?.addEventListener("click", openCredentials);
    $("account-add")?.addEventListener("click", saveAccount);
    $("account-cancel")?.addEventListener("click", closeCredentials);

    $("account-list")?.addEventListener("click", event => {
        const useButton = event.target.closest(".account-use");
        const editButton = event.target.closest(".account-edit");
        const removeButton = event.target.closest(".account-remove");

        if (useButton) {
            selectAccount(useButton.dataset.accountId);
            return;
        }

        if (editButton) {
            editAccount(editButton.dataset.accountId);
            return;
        }

        if (removeButton) {
            removeAccount(removeButton.dataset.accountId);
        }
    });

    /* SEARCH */
    $("instance-search")?.addEventListener("input", searchInstances);
    $("snapshot-search")?.addEventListener("input", searchSnapshots);

    /* DATA LOADING */
    $("fetch-instances")?.addEventListener("click", loadInstances);
    $("fetch-volumes")?.addEventListener("click", loadVolumes);
    $("fetch-snapshots")?.addEventListener("click", loadSnapshots);
    $("refresh-dashboard")?.addEventListener("click", loadDashboard);
    $("refresh-snapshot-dashboard")?.addEventListener("click", loadSnapshotDashboard);

    /* CREATE SNAPSHOT */
    $("snapshot-instance-search-btn")?.addEventListener("click", applyCreateSnapshotSearch);

    $("snapshot-instance-search")?.addEventListener("keydown", event => {
        if (event.key === "Enter") {
            event.preventDefault();
            applyCreateSnapshotSearch();
        }
    });

    $("snapshot-instance-search-clear")?.addEventListener("click", clearCreateSnapshotSearch);

    $("snapshot-accounts-container")?.addEventListener("change", event => {
        const instanceCheckbox = event.target.closest(".snapshot-instance-checkbox");

        if (instanceCheckbox) {
            toggleSnapshotInstanceSelection(
                instanceCheckbox.dataset.accountId,
                instanceCheckbox.dataset.instanceId,
                instanceCheckbox.checked
            );

            return;
        }

        const selectAllCheckbox = event.target.closest(".select-all-instances");

        if (selectAllCheckbox) {
            toggleAllSnapshotInstancesForAccount(selectAllCheckbox.dataset.accountId, selectAllCheckbox.checked);
        }
    });

    $("snapshot-accounts-container")?.addEventListener("click", event => {
        const retryButton = event.target.closest(".retry-account-instances");

        if (!retryButton) {
            return;
        }

        const account = state.accounts.find(item => item && item.id === retryButton.dataset.accountId);

        if (account) {
            loadInstancesForOneAccount(account);
        }
    });

    $("refresh-snapshot-accounts")?.addEventListener("click", loadInstancesForSnapshot);
    $("create-snapshots")?.addEventListener("click", createSnapshotsFromInstances);

    /* REVERT SNAPSHOT — wired to the real IDs in index.html */
    $("restore-region-select")?.addEventListener("change", event => {
        handleRevertRegionChange(event.target.value);
    });

    $("restore-instance-select")?.addEventListener("change", event => {
        handleRevertInstanceSelection(event.target.value);
    });

    $("restore-volume-select")?.addEventListener("change", event => {
        handleRevertVolumeSelection(event.target.selectedOptions);
    });

    $("restore-snapshot-select")?.addEventListener("change", updateAddToQueueButtonState);

    $("add-to-queue-btn")?.addEventListener("click", addRevertSelectionToQueue);

    // Queue panel's mirror button (class-based, since the id was de-duplicated
    // in index.html) triggers the same action as the canonical button above.
    document.querySelectorAll(".add-to-queue-btn-secondary").forEach(button => {
        button.addEventListener("click", addRevertSelectionToQueue);
    });

    // Queue panel's mirror "execute" button triggers the same restore as the
    // canonical #restore-snapshot-button (its id was de-duplicated in index.html).
    $("restore-snapshot-button-panel")?.addEventListener("click", revertFromSnapshot);

    $("restore-queue-list")?.addEventListener("click", event => {
        const removeButton = event.target.closest(".btn-remove-queue-item");

        if (removeButton) {
            removeRevertQueueItem(removeButton.dataset.volumeId);
        }
    });

    $("restore-snapshot-button")?.addEventListener("click", revertFromSnapshot);

    $("refresh-revert-data")?.addEventListener("click", () => {
        if (state.revert.region) {
            handleRevertRegionChange(state.revert.region);
        } else {
            toast("Select a region first.", "error");
        }
    });

    /* JOB DETAILS */
    $("snapshot-jobs-table")?.addEventListener("click", event => {
        const detailsButton = event.target.closest(".job-details");

        if (detailsButton) {
            showJobDetails(detailsButton.dataset.jobId);
            return;
        }

        const cancelButton = event.target.closest(".btn-cancel-job");

        if (cancelButton) {
            cancelSnapshotJob(cancelButton.dataset.jobId);
        }
    });

    $("close-job-details")?.addEventListener("click", closeJobDetails);

    $("job-details-content")?.addEventListener("click", event => {
        const cancelButton = event.target.closest(".btn-cancel-job");

        if (cancelButton) {
            cancelSnapshotJob(cancelButton.dataset.jobId);
        }
    });

    /* REVERT DASHBOARD */
    $("revert-jobs-table")?.addEventListener("click", event => {
        const button = event.target.closest(".revert-job-details");

        if (button) {
            showRevertJobDetails(button.dataset.jobId);
        }
    });

    $("refresh-revert-dashboard")?.addEventListener("click", loadRevertDashboard);
    $("close-revert-job-details")?.addEventListener("click", closeRevertJobDetails);

    $("revert-job-details-modal")?.addEventListener("click", event => {
        if (event.target === $("revert-job-details-modal")) {
            closeRevertJobDetails();
        }
    });

    /* MODALS */
    $("credential-modal")?.addEventListener("click", event => {
        if (event.target === $("credential-modal")) {
            closeCredentials();
        }
    });

    $("job-details-modal")?.addEventListener("click", event => {
        if (event.target === $("job-details-modal")) {
            closeJobDetails();
        }
    });
}


/* =========================================================
   GLOBAL ERROR HANDLING
========================================================= */

window.addEventListener("error", event => {
    console.error("Global JavaScript error:", event.error || event.message);
});

window.addEventListener("unhandledrejection", event => {
    console.error("Unhandled promise rejection:", event.reason);
});


/* =========================================================
   CLEANUP
========================================================= */

window.addEventListener("beforeunload", () => {
    stopSnapshotPolling();
    stopSnapshotDashboardPolling();
    stopRevertDashboardPolling();
});


/* =========================================================
   INITIALIZATION
========================================================= */

document.addEventListener("DOMContentLoaded", () => {
    console.log("AWS Snapshot Portal initializing...");

    try {
        loadAccounts();

        updateAccountSelector();
        updateRegionFromAccount();
        updateSelectedAccountUI();
        updateVolumeTotals();

        setupEventListeners();

        showPage("dashboard");

        console.log("AWS Snapshot Portal ready.");
    } catch (error) {
        console.error("FATAL APPLICATION INITIALIZATION ERROR:", error);

        const message = error?.message || "Unknown initialization error.";

        toast(`Application initialization failed: ${message}`, "error");

        document.querySelectorAll(".page").forEach(page => {
            page.classList.remove("active");
        });

        const dashboard = $("dashboard");
        if (dashboard) dashboard.classList.add("active");

        const dashboardMessage = $("dashboard-message");
        if (dashboardMessage) dashboardMessage.textContent = `Application error: ${message}`;
    }
});
