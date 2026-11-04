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

    revert: {
        instance: null,
        volumes: [],
        snapshots: [],
        selectedSnapshots: {},
        restoring: false,
        queue: []
    },

    currentPage: "dashboard",

    snapshotDashboardTimer: null,
    snapshotPollingTimer: null,

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

let toastTimer = null;
let credentialPopupOpening = false;
let revertSelectionRequestId = 0;


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
        console[type === "error" ? "error" : "log"](
            "Toast:",
            message
        );
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

function setLoading(visible, message = "Loading...") {
    const loading = $("loading");
    const text = $("loading-text");

    if (!loading) {
        return;
    }

    if (text) {
        text.textContent = message;
    }

    loading.classList.toggle("show", Boolean(visible));
}


/* =========================================================
   STORAGE
========================================================= */

function saveAccounts() {
    try {
        sessionStorage.setItem(
            "awsSnapshotAccounts",
            JSON.stringify(state.accounts)
        );

        sessionStorage.setItem(
            "awsSnapshotActiveAccount",
            state.activeAccountId || ""
        );
    } catch (error) {
        console.error(
            "Unable to save account information:",
            error
        );

        toast(
            "Unable to save account information in this browser.",
            "error"
        );
    }
}

function loadAccounts() {
    try {
        const raw =
            sessionStorage.getItem(
                "awsSnapshotAccounts"
            );

        const parsed =
            raw
                ? JSON.parse(raw)
                : [];

        state.accounts =
            Array.isArray(parsed)
                ? parsed
                : [];

        state.activeAccountId =
            sessionStorage.getItem(
                "awsSnapshotActiveAccount"
            ) || null;

        if (
            state.activeAccountId &&
            !state.accounts.some(
                account =>
                    account &&
                    account.id ===
                    state.activeAccountId
            )
        ) {
            state.activeAccountId =
                state.accounts[0]?.id || null;
        }

    } catch (error) {
        console.error(
            "Unable to load saved accounts:",
            error
        );

        state.accounts = [];
        state.activeAccountId = null;
    }
}


/* =========================================================
   ACCOUNT
========================================================= */

function getActiveAccount() {
    return state.accounts.find(
        account =>
            account &&
            account.id ===
            state.activeAccountId
    );
}

function updateAccountSelector() {
    const select = $("account-select");

    if (!select) {
        return;
    }

    select.innerHTML = "";

    if (!state.accounts.length) {
        select.innerHTML =
            `<option value="">No account connected</option>`;

        return;
    }

    state.accounts.forEach(account => {
        if (!account) {
            return;
        }

        const option =
            document.createElement("option");

        option.value =
            account.id;

        option.textContent =
            account.name || "Unnamed account";

        option.selected =
            account.id ===
            state.activeAccountId;

        select.appendChild(option);
    });
}

function updateRegionFromAccount() {
    const account = getActiveAccount();

    const region = $("region");
    const accountRegion = $("account-region");

    if (!account) {
        if (region) {
            region.value = "us-west-1";
        }

        if (accountRegion) {
            accountRegion.value = "us-west-1";
        }

        return;
    }

    const selectedRegion =
        account.region ||
        "us-west-1";

    if (region) {
        region.value = selectedRegion;
    }

    if (accountRegion) {
        accountRegion.value = selectedRegion;
    }
}

function updateSelectedAccountUI() {
    const account = getActiveAccount();

    const status = $("connection-status");

    const dashboardAccount =
        $("dashboard-selected-account");

    const dashboardRegion =
        $("dashboard-selected-region");

    const summaryAccount =
        $("summary-account-name");

    const summaryRegion =
        $("summary-region");

    const summaryStatus =
        $("summary-account-status");

    if (!account) {
        if (dashboardAccount) {
            dashboardAccount.textContent =
                "No account selected";
        }

        if (dashboardRegion) {
            dashboardRegion.textContent = "-";
        }

        if (summaryAccount) {
            summaryAccount.textContent = "-";
        }

        if (summaryRegion) {
            summaryRegion.textContent = "-";
        }

        if (summaryStatus) {
            summaryStatus.textContent =
                "Not connected";
        }

        if (status) {
            status.textContent =
                "Not connected";

            status.className =
                "connection-status";
        }

        return;
    }

    const region =
        account.region ||
        "us-west-1";

    if (dashboardAccount) {
        dashboardAccount.textContent =
            account.name || "Unnamed account";
    }

    if (dashboardRegion) {
        dashboardRegion.textContent =
            region;
    }

    if (summaryAccount) {
        summaryAccount.textContent =
            account.name || "Unnamed account";
    }

    if (summaryRegion) {
        summaryRegion.textContent =
            region;
    }

    if (summaryStatus) {
        summaryStatus.textContent =
            "Connected";
    }

    if (status) {
        status.textContent =
            `Connected: ${account.name || "AWS account"}`;

        status.className =
            "connection-status connected";
    }
}

function regionChanged() {
    const account = getActiveAccount();
    const region = $("region");

    if (!account || !region) {
        return;
    }

    account.region =
        region.value || "us-west-1";

    saveAccounts();

    updateAccountSelector();
    updateRegionFromAccount();
    updateSelectedAccountUI();

    clearAwsData();
    resetRevertState();

    if (state.currentPage === "dashboard") {
        loadDashboard();
    }

    if (state.currentPage === "instances") {
        loadInstancesWithVolumeValidation();
    }

    if (state.currentPage === "volumes") {
        loadVolumes();
    }

    if (state.currentPage === "snapshots") {
        loadSnapshots();
    }

    if (state.currentPage === "create-snapshot") {
        loadInstancesWithVolumeValidation();
    }

    if (state.currentPage === "revert-snapshot") {
        loadInstancesForRevert();
    }

    toast(
        `Region changed to ${account.region}.`,
        "success"
    );
}


/* =========================================================
   REQUEST
========================================================= */

function getRequestBody() {
    const account = getActiveAccount();

    if (!account) {
        throw new Error(
            "Please add and select an AWS account first."
        );
    }

    const region =
        account.region ||
        $("region")?.value ||
        "us-west-1";

    return {
        accessKeyId:
            account.accessKeyId,

        secretAccessKey:
            account.secretAccessKey,

        sessionToken:
            account.sessionToken || "",

        region,

        accountName:
            account.name
    };
}


/* =========================================================
   AWS AUTH & SESSION EXPIRY HANDLING
========================================================= */

function isAwsAuthenticationError(data) {
    if (!data) {
        return false;
    }

    const code = data.code || data.errorCode || data.awsCode || data.awsError?.code || data.error?.code || "";
    const message = typeof data.error === "string" ? data.error : (data.message || data.error?.message || String(data || ""));

    if (AWS_AUTH_ERROR_CODES.includes(code)) {
        return true;
    }

    return /ExpiredToken|InvalidClientTokenId|UnrecognizedClient|InvalidAccessKeyId|SignatureDoesNotMatch|Request has expired/i.test(message);
}

function openCredentialsForAwsError() {
    if (credentialPopupOpening) {
        return;
    }

    credentialPopupOpening = true;

    const expiryModal = document.getElementById("session-expired-modal");
    if (expiryModal) {
        expiryModal.classList.add("show");
    } else {
        renderAccountList();
        $("credential-modal")?.classList.add("show");
    }

    setTimeout(() => {
        credentialPopupOpening = false;
    }, 500);

    toast(
        "AWS session expired or invalid. Please update your account credentials.",
        "error"
    );
}


/* =========================================================
   API
========================================================= */

async function api(url, options = {}) {
    const config = {
        ...options,
        headers: {
            ...(options.body
                ? { "Content-Type": "application/json" }
                : {}),
            ...(options.headers || {})
        }
    };

    let response;

    try {
        response = await fetch(url, config);
    } catch (error) {
        console.error("API network error:", error);
        throw new Error("Unable to connect to the server.");
    }

    const contentType = response.headers.get("content-type") || "";
    let data;

    try {
        if (contentType.toLowerCase().includes("application/json")) {
            data = await response.json();
        } else {
            const text = await response.text();
            console.error(`Unexpected non-JSON response from ${url}:`, text);

            if (isAwsAuthenticationError({ message: text }) || text.includes("Request has expired")) {
                openCredentialsForAwsError();
            }

            throw new Error(text || `Server returned HTTP ${response.status}`);
        }
    } catch (error) {
        console.error("API response parsing error:", error);

        if (error instanceof Error && error.message) {
            if (isAwsAuthenticationError(error) || error.message.includes("Request has expired")) {
                openCredentialsForAwsError();
            }
            throw error;
        }

        throw new Error(`Server returned HTTP ${response.status}`);
    }

    if (!data || typeof data !== "object") {
        throw new Error(`Invalid server response from ${url}`);
    }

    if (isAwsAuthenticationError(data) || (data.error && String(data.error).includes("Request has expired"))) {
        openCredentialsForAwsError();
        throw new Error("AWS credentials expired or session is invalid.");
    }

    if (!response.ok || data.success === false) {
        const errorMsg = data.error || data.message || `HTTP ${response.status}`;
        if (isAwsAuthenticationError({ message: errorMsg, code: data.code }) || String(errorMsg).includes("Request has expired")) {
            openCredentialsForAwsError();
        }
        throw new Error(errorMsg);
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
    if (button) {
        button.textContent = "Add Account";
    }

    renderAccountList();
    $("credential-modal")?.classList.add("show");
}

function closeCredentials() {
    $("credential-modal")?.classList.remove("show");
    state.editingAccountId = null;
    clearAccountForm();

    const button = $("account-add");
    if (button) {
        button.textContent = "Add Account";
    }
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
    if (!account) return;

    state.editingAccountId = account.id;

    if ($("account-name")) $("account-name").value = account.name || "";
    if ($("access-key")) $("access-key").value = account.accessKeyId || "";
    if ($("secret-key")) $("secret-key").value = account.secretAccessKey || "";
    if ($("session-token")) $("session-token").value = account.sessionToken || "";
    if ($("account-region")) $("account-region").value = account.region || "us-west-1";

    const button = $("account-add");
    if (button) {
        button.textContent = "Update Account";
    }

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
        if (!account) return;

        account.name = name;
        account.accessKeyId = accessKeyId;
        account.secretAccessKey = secretAccessKey;
        account.sessionToken = sessionToken;
        account.region = region;
        state.activeAccountId = account.id;

        toast("AWS account updated successfully.", "success");
    } else {
        const account = {
            id: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
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

function resetRevertState() {
    resetRevertFormSteps();
    const instanceSelect = document.getElementById('restore-instance-select');
    if (instanceSelect) {
        instanceSelect.value = '';
        instanceSelect.disabled = true;
        instanceSelect.innerHTML = `<option value="">Select an instance...</option>`;
    }
}

function loadInstancesForRevert() {
    if (typeof loadRevertPageData === "function") {
        loadRevertPageData();
    }
}

function renderAccountList() {
    const container = $("account-list");
    if (!container) return;

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
    if (!account) return;

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
    if (!select?.value) return;
    selectAccount(select.value);
}

function removeAccount(accountId) {
    const account = state.accounts.find(item => item && item.id === accountId);
    if (!account) return;

    if (!confirm(`Remove AWS account "${account.name}"?`)) return;

    state.accounts = state.accounts.filter(item => item && item.id !== accountId);
    if (state.activeAccountId === accountId) {
        state.activeAccountId = state.accounts[0]?.id || null;
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
   INSTANCE STORAGE & 2TB VALIDATION LOGIC
========================================================= */

function getInstanceStorageGB(instance) {
    if (!instance) return 0;

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
    if (!instanceId) return 0;

    return state.volumes
        .filter(volume => String(volume?.attachedInstance || volume?.instanceId || "").trim() === instanceId)
        .reduce((total, volume) => total + (Number(volume?.size) || 0), 0);
}

function isInstanceOverStorageLimit(instance) {
    return getInstanceStorageGB(instance) > MAX_INSTANCE_STORAGE_GB;
}

function validateInstanceStorageLimits() {
    const oversizedInstances = [];
    const validInstances = [];

    state.instances.forEach(instance => {
        const totalStorage = getInstanceStorageGB(instance);
        if (totalStorage > MAX_INSTANCE_STORAGE_GB) {
            oversizedInstances.push({ instance, storageGB: totalStorage });
        } else {
            validInstances.push({ instance, storageGB: totalStorage });
        }
    });

    return { validInstances, oversizedInstances };
}


/* =========================================================
   INSTANCE DEDUPLICATION
========================================================= */

function deduplicateInstances(instances = []) {
    const seenIds = new Set();
    const seenNames = new Set();
    const unique = [];

    if (!Array.isArray(instances)) return unique;

    for (const instance of instances) {
        if (!instance) continue;

        const instanceId = String(instance.instanceId || instance.instance_id || "").trim().toLowerCase();
        const instanceName = String(instance.name || instance.instanceName || "").trim().toLowerCase();

        if (instanceId && seenIds.has(instanceId)) continue;
        if (instanceName && seenNames.has(instanceName)) continue;

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
   CENTRALIZED MULTI-ACCOUNT DASHBOARD
========================================================= */

async function loadCentralizedDashboard() {
    if (!state.accounts || !state.accounts.length) {
        toast("No AWS accounts configured.", "error");
        if ($("centralized-accounts-table")) {
            $("centralized-accounts-table").innerHTML = `<div class="empty-state small">No AWS accounts configured. Please add an account first.</div>`;
        }
        return;
    }

    try {
        setLoading(true, "Aggregating telemetry across all AWS accounts...");

        const data = await api("/api/aws/centralized-dashboard", {
            method: "POST",
            body: JSON.stringify({ accounts: state.accounts })
        });

        const summary = data.summary || {};

        if ($("cd-total-instances")) $("cd-total-instances").textContent = summary.instances || 0;
        if ($("cd-total-volumes")) $("cd-total-volumes").textContent = summary.volumes || 0;
        if ($("cd-total-snapshots")) $("cd-total-snapshots").textContent = summary.snapshots || 0;
        if ($("cd-total-storage")) $("cd-total-storage").textContent = formatStorageSize(summary.storageGB || 0);

        const container = $("centralized-accounts-table");
        if (container) {
            const accountsList = data.accountsData || [];

            if (!accountsList.length) {
                container.innerHTML = `<div class="empty-state small">No account telemetry available.</div>`;
            } else {
                container.innerHTML = `
                    <div class="table-wrapper">
                        <table>
                            <thead>
                                <tr>
                                    <th>Account Name</th>
                                    <th>Region</th>
                                    <th>Status</th>
                                    <th>Instances</th>
                                    <th>Volumes</th>
                                    <th>Snapshots</th>
                                    <th>Total Storage</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${accountsList.map(acc => `
                                    <tr>
                                        <td><strong>${escapeHtml(acc.name || "Unnamed")}</strong></td>
                                        <td><code>${escapeHtml(acc.region || "-")}</code></td>
                                        <td>
                                            <span class="status ${acc.status === 'connected' ? 'completed' : 'error'}">
                                                ${escapeHtml(acc.status)}
                                            </span>
                                        </td>
                                        <td>${Number(acc.instances || 0)}</td>
                                        <td>${Number(acc.volumes || 0)}</td>
                                        <td>${Number(acc.snapshots || 0)}</td>
                                        <td>${escapeHtml(formatStorageSize(acc.storageGB || 0))}</td>
                                    </tr>
                                `).join("")}
                            </tbody>
                        </table>
                    </div>
                `;
            }
        }

        toast("Global multi-account telemetry updated.", "success");

    } catch (error) {
        console.error("Centralized dashboard loading failed:", error);
        toast(error?.message || "Unable to load centralized dashboard.", "error");
    } finally {
        setLoading(false);
    }
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

async function loadInstancesWithVolumeValidation() {
    if (!getActiveAccount()) {
        toast("Connect an AWS account first.", "error");
        return;
    }

    try {
        setLoading(true, "Loading EC2 instances and volume info...");

        const [instancesData, volumesData] = await Promise.all([
            api("/api/aws/instances", { method: "POST", body: JSON.stringify(getRequestBody()) }),
            api("/api/aws/volumes", { method: "POST", body: JSON.stringify(getRequestBody()) })
        ]);

        state.instances = deduplicateInstances(instancesData.instances || []);
        state.volumes = Array.isArray(volumesData.volumes) ? volumesData.volumes : [];

        if ($("instance-count")) $("instance-count").textContent = state.instances.length;

        updateVolumeTotals();

        const { oversizedInstances } = validateInstanceStorageLimits();
        if (oversizedInstances.length > 0) {
            toast(`Warning: ${oversizedInstances.length} instance(s) exceed 2TB storage limit.`, "error");
        }

        searchInstances();
        toast(`${state.instances.length} unique instances loaded with volume data.`, "success");

    } catch (error) {
        console.error("Instance & volume loading failed:", error);
        toast(error?.message || "Unable to load EC2 instances.", "error");
    } finally {
        setLoading(false);
    }
}

async function loadInstances() {
    return loadInstancesWithVolumeValidation();
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
        ].join(" ").toLowerCase();

        return text.includes(search);
    });

    if ($("instance-result-count")) {
        $("instance-result-count").textContent = `${filtered.length} result${filtered.length === 1 ? "" : "s"}`;
    }

    renderInstances(filtered);
}

function renderInstances(instances) {
    const container = $("instances-table");
    if (!container) return;

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
                    ${instances.map(instance => {
                        const storageGB = getInstanceStorageGB(instance);
                        const overLimit = storageGB > MAX_INSTANCE_STORAGE_GB;

                        return `
                            <tr>
                                <td>${escapeHtml(instance.name || "-")}</td>
                                <td><code>${escapeHtml(instance.instanceId || instance.instance_id || "-")}</code></td>
                                <td>
                                    <span class="status ${escapeHtml(instance.state || "")}">
                                        ${escapeHtml(instance.state || "-")}
                                    </span>
                                </td>
                                <td>${escapeHtml(instance.instanceType || "-")}</td>
                                <td>${escapeHtml(instance.privateIp || "-")}</td>
                                <td>${escapeHtml(instance.publicIp || "-")}</td>
                                <td>${escapeHtml(instance.availabilityZone || "-")}</td>
                                <td>${Number(instance.volumeCount || 0)}</td>
                                <td>
                                    <span class="${overLimit ? "status error" : ""}">
                                        ${escapeHtml(formatStorageSize(storageGB))}
                                    </span>
                                </td>
                            </tr>
                        `;
                    }).join("")}
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
    if (!container) return;

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
                    ${volumes.map(volume => `
                        <tr>
                            <td>${escapeHtml(volume.name || "-")}</td>
                            <td><code>${escapeHtml(volume.volumeId || "-")}</code></td>
                            <td><strong>${Number(volume.size || 0)} GB</strong></td>
                            <td>${escapeHtml(volume.type || "gp3")}</td>
                            <td>
                                <span class="status ${escapeHtml(volume.state || "")}">
                                    ${escapeHtml(volume.state || "-")}
                                </span>
                            </td>
                            <td><code>${escapeHtml(volume.attachedInstance || "-")}</code></td>
                            <td>${volume.encrypted ? "Yes" : "No"}</td>
                        </tr>
                    `).join("")}
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

    try {
        if (!silent) {
            setLoading(true, "Loading AWS snapshots...");
        }

        const data = await api("/api/aws/snapshots", {
            method: "POST",
            body: JSON.stringify(getRequestBody())
        });

        state.snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];

        if ($("snapshot-count")) {
            $("snapshot-count").textContent = state.snapshots.length;
        }

        searchSnapshots();

        if (!silent) {
            toast(`${state.snapshots.length} snapshots loaded.`, "success");
        }

    } catch (error) {
        if (!silent) {
            toast(error?.message || "Unable to load snapshots.", "error");
        } else {
            console.error("Snapshot polling failed:", error);
        }
    } finally {
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
        ].join(" ").toLowerCase();

        return text.includes(search);
    });

    if ($("snapshot-result-count")) {
        $("snapshot-result-count").textContent = `${filtered.length} result${filtered.length === 1 ? "" : "s"}`;
    }

    renderSnapshots(filtered);
}

function renderSnapshots(snapshots) {
    const container = $("snapshots-table");
    if (!container) return;

    if (!snapshots.length) {
        container.innerHTML = `<div class="empty-state small">No snapshots found.</div>`;
        return;
    }

    container.innerHTML = `
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
                    ${snapshots.map(snapshot => `
                        <tr>
                            <td><code>${escapeHtml(snapshot.snapshotId || "-")}</code></td>
                            <td>
                                ${escapeHtml(snapshot.instanceName || "-")}
                                <br>
                                <small>${escapeHtml(snapshot.instanceId || "-")}</small>
                            </td>
                            <td><code>${escapeHtml(snapshot.volumeId || "-")}</code></td>
                            <td>
                                <span class="status ${escapeHtml(snapshot.state || "")}">
                                    ${escapeHtml(snapshot.state || "-")}
                                </span>
                            </td>
                            <td>${escapeHtml(snapshot.progress || "-")}</td>
                            <td>${escapeHtml(snapshot.createdBy || "-")}</td>
                            <td>${escapeHtml(snapshot.team || "-")}</td>
                            <td>${formatDate(snapshot.startTime)}</td>
                        </tr>
                    `).join("")}
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
    loadSnapshots({ silent: true });

    state.snapshotPollingTimer = setInterval(() => {
        if (state.currentPage !== "snapshots") return;
        if (!getActiveAccount()) return;
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
   CREATE SNAPSHOT
========================================================= */

async function loadInstancesForSnapshot() {
    if (!getActiveAccount()) return;

    if (state.instances.length) {
        state.instances = deduplicateInstances(state.instances);
        updateInstanceHint();
        return;
    }

    try {
        setLoading(true, "Loading instances...");
        const data = await api("/api/aws/instances", {
            method: "POST",
            body: JSON.stringify(getRequestBody())
        });

        state.instances = deduplicateInstances(data.instances || []);
        updateInstanceHint();
    } catch (error) {
        console.error("Unable to load snapshot instances:", error);
        toast(error?.message || "Unable to load instances.", "error");
    } finally {
        setLoading(false);
    }
}

function updateInstanceHint() {
    const hint = $("snapshot-instance-hint");
    if (!hint) return;

    hint.textContent = `${state.instances.length} unique instance(s) available in ${getActiveAccount()?.region || "-"}. Instances with more than 2 TB of attached EBS storage cannot be snapshotted.`;
}

function getSnapshotInstanceLines() {
    const lines = $("snapshot-instances")?.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean) || [];
    const seen = new Set();

    return lines.filter(value => {
        const key = value.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function previewSnapshotInstances() {
    const lines = getSnapshotInstanceLines();
    const preview = $("snapshot-instance-preview");
    if (!preview) return;

    state.instances = deduplicateInstances(state.instances);

    if (!lines.length) {
        preview.innerHTML = `<div class="muted">Enter one instance name or ID per line.</div>`;
        return;
    }

    const results = lines.map(input => {
        const lower = input.toLowerCase();
        const match = state.instances.find(
            instance =>
                String(instance.instanceId || instance.instance_id || "").toLowerCase() === lower ||
                String(instance.name || instance.instanceName || "").toLowerCase() === lower
        );
        return { input, match };
    });

    const found = results.filter(item => item.match);
    const missing = results.filter(item => !item.match);
    const oversized = found.filter(item => isInstanceOverStorageLimit(item.match));
    const allowed = found.filter(item => !isInstanceOverStorageLimit(item.match));

    let html = "";

    if (allowed.length) {
        html += `
            <div class="success-box">
                <strong>${allowed.length} unique instance(s) eligible for snapshot</strong>
                <ul>
                    ${allowed.map(item => `
                        <li>
                            ${escapeHtml(item.match.name || item.match.instanceId || item.match.instance_id)}
                            — ${escapeHtml(formatStorageSize(getInstanceStorageGB(item.match)))}
                        </li>
                    `).join("")}
                </ul>
            </div>
        `;
    }

    if (oversized.length) {
        html += `
            <div class="error-box">
                <strong>${oversized.length} instance(s) exceed 2 TB (2048 GB) limit</strong>
                <ul>
                    ${oversized.map(item => `
                        <li>
                            ${escapeHtml(item.match.name || item.match.instanceId || item.match.instance_id)}
                            — ${escapeHtml(formatStorageSize(getInstanceStorageGB(item.match)))}
                        </li>
                    `).join("")}
                </ul>
            </div>
        `;
    }

    if (missing.length) {
        html += `
            <div class="error-box">
                <strong>${missing.length} instance(s) not found</strong>
                <ul>
                    ${missing.map(item => `<li>${escapeHtml(item.input)}</li>`).join("")}
                </ul>
            </div>
        `;
    }

    preview.innerHTML = html;
}

async function createSnapshotsFromInstances() {
    const account = getActiveAccount();
    if (!account) {
        toast("Connect an AWS account first.", "error");
        openCredentials();
        return;
    }

    state.instances = deduplicateInstances(state.instances);
    const instances = getSnapshotInstanceLines();

    if (!instances.length) {
        toast("Enter at least one instance name or ID.", "error");
        return;
    }

    const matchedInstances = instances.map(input => {
        const lower = input.toLowerCase();
        return state.instances.find(
            instance =>
                String(instance.instanceId || instance.instance_id || "").toLowerCase() === lower ||
                String(instance.name || instance.instanceName || "").toLowerCase() === lower
        );
    }).filter(Boolean);

    const uniqueMatchedInstances = deduplicateInstances(matchedInstances);
    const oversized = uniqueMatchedInstances.filter(instance => isInstanceOverStorageLimit(instance));

    if (oversized.length) {
        alert("Snapshot creation blocked.\n\nOne or more instances exceed the 2 TB limit.");
        return;
    }

    if (uniqueMatchedInstances.length !== instances.length) {
        const matchedKeys = new Set(
            uniqueMatchedInstances.flatMap(instance => [
                String(instance.instanceId || instance.instance_id || "").toLowerCase(),
                String(instance.name || instance.instanceName || "").toLowerCase()
            ])
        );

        const missing = instances.filter(input => !matchedKeys.has(input.toLowerCase()));
        if (missing.length) {
            alert("The following instance(s) were not found:\n\n" + missing.join("\n"));
            return;
        }
    }

    const description = $("snapshot-description")?.value.trim() || "";

    if (!confirm(`Create snapshots for ${uniqueMatchedInstances.length} unique instance(s)?`)) {
        return;
    }

    const snapshotInstances = uniqueMatchedInstances.map(
        instance => instance.instanceId || instance.instance_id || instance.name
    );

    try {
        setLoading(true, "Creating snapshots...");

        const data = await api("/api/aws/create-instance-snapshots", {
            method: "POST",
            body: JSON.stringify({
                ...getRequestBody(),
                instances: snapshotInstances,
                description
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
    if (!container) return;

    container.innerHTML = `
        <div class="success-box">
            <h3>Snapshot job started</h3>
            <p>Job ID: <strong>${escapeHtml(data.jobId || "-")}</strong></p>
            <p>Instances: <strong>${Number(data.instanceCount || 0)}</strong></p>
            <p>Volumes: <strong>${Number(data.volumeCount || 0)}</strong></p>
            <p>Snapshots: <strong>${Number(data.snapshotCount || 0)}</strong></p>
        </div>
    `;
}


/* =========================================================
   PAGE NAVIGATION
========================================================= */

function showPage(page) {
    if (!page) page = "dashboard";

    if (page !== "snapshots") stopSnapshotPolling();
    if (page !== "snapshot-dashboard") stopSnapshotDashboardPolling();
    if (page === "revert-snapshot") {
        resetRevertState();
        loadInstancesWithVolumeValidation().then(() => {
            loadInstancesForRevert();
        });
    }   
    if (page === "centralized-dashboard") {
        loadCentralizedDashboard();
    }

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
        "revert-dashboard": "Revert Jobs",
        "centralized-dashboard": "Global Dashboard"
    };

    if ($("page-title")) {
        $("page-title").textContent = titles[page] || "AWS Snapshot Portal";
    }

    state.currentPage = page;

    if (page === "dashboard") loadDashboard();
    if (page === "instances") loadInstancesWithVolumeValidation();
    if (page === "volumes") loadVolumes();
    if (page === "snapshots") {
        loadSnapshots();
        startSnapshotPolling();
    }
    if (page === "create-snapshot") {
        loadInstancesForSnapshot();
        loadInstancesWithVolumeValidation();
    }
    if (page === "snapshot-dashboard") {
        loadSnapshotDashboard();
        startSnapshotDashboardPolling();
    }
    if (page === "revert-snapshot") {
        resetRevertState();
        loadInstancesForRevert();
    }
    if (page === "revert-dashboard") {
        loadRevertDashboard();
    }
}


/* =========================================================
   SNAPSHOT DASHBOARD (GLOBAL AUTO-REFRESH & SESSION SYNC)
========================================================= */

async function loadSnapshotDashboard() {
    try {
        const data = await api("/api/snapshot-dashboard");
        renderSnapshotDashboard(data);

        await syncRunningJobsGlobally(
            Array.isArray(data.jobs) ? data.jobs : []
        );
    } catch (error) {
        console.error("Snapshot dashboard loading failed:", error);
        if (isAwsAuthenticationError(error)) {
            openCredentialsForAwsError();
        }
        toast(error?.message || "Unable to load snapshot jobs.", "error");
    }
}

async function syncRunningJobsGlobally(jobs) {
    const activeJobs = jobs.filter(job => job?.status === "running");
    if (!activeJobs.length) return;

    for (const job of activeJobs) {
        let targetAccount = getActiveAccount();

        if (!targetAccount && state.accounts.length > 0) {
            targetAccount = state.accounts.find(acc => acc.region === job.region) || state.accounts[0];
        }

        if (!targetAccount) continue;

        const requestBody = {
            accessKeyId: targetAccount.accessKeyId,
            secretAccessKey: targetAccount.secretAccessKey,
            sessionToken: targetAccount.sessionToken || "",
            region: job.region || targetAccount.region || "us-west-1",
            accountName: targetAccount.name
        };

        try {
            await api(`/api/snapshot-jobs/${encodeURIComponent(job.job_id)}/sync`, {
                method: "POST",
                body: JSON.stringify(requestBody)
            });
        } catch (error) {
            console.error(`Unable to sync job ${job.job_id}`, error);
            if (isAwsAuthenticationError(error)) {
                openCredentialsForAwsError();
            }
        }
    }
}

let snapshotDashboardCountdownTimer = null;
let secondsRemaining = 15;

function startSnapshotDashboardPolling() {
    stopSnapshotDashboardPolling();
    loadSnapshotDashboard();
    secondsRemaining = 15;

    state.snapshotDashboardTimer = setInterval(() => {
        const toggle = document.getElementById("auto-refresh-toggle");
        if (toggle && !toggle.checked) return;

        if (state.currentPage === "snapshot-dashboard") {
            loadSnapshotDashboard();
            secondsRemaining = 15;
        }
    }, SNAPSHOT_DASHBOARD_POLL_INTERVAL);

    snapshotDashboardCountdownTimer = setInterval(() => {
        const toggle = document.getElementById("auto-refresh-toggle");
        const badge = document.getElementById("refresh-countdown-badge");
        if (!badge) return;

        if (toggle && !toggle.checked) {
            badge.textContent = "Paused";
            return;
        }

        secondsRemaining--;
        if (secondsRemaining < 0) {
            secondsRemaining = 15;
        }
        badge.textContent = `${secondsRemaining}s`;
    }, 1000);
}

function stopSnapshotDashboardPolling() {
    if (state.snapshotDashboardTimer) {
        clearInterval(state.snapshotDashboardTimer);
        state.snapshotDashboardTimer = null;
    }
    if (snapshotDashboardCountdownTimer) {
        clearInterval(snapshotDashboardCountdownTimer);
        snapshotDashboardCountdownTimer = null;
    }
}

function renderSnapshotDashboard(data) {
    const summary = data.summary || {};

    if ($("sd-total-jobs")) $("sd-total-jobs").textContent = Number(summary.total_jobs || 0);
    if ($("sd-running-jobs")) $("sd-running-jobs").textContent = Number(summary.running_jobs || 0);
    if ($("sd-total-snapshots")) $("sd-total-snapshots").textContent = Number(summary.total_snapshots || 0);
    if ($("sd-completed-snapshots")) $("sd-completed-snapshots").textContent = Number(summary.completed_snapshots || 0);
    if ($("sd-failed-snapshots")) $("sd-failed-snapshots").textContent = Number(summary.failed_snapshots || 0);

    renderSnapshotJobs(Array.isArray(data.jobs) ? data.jobs : []);
}

function renderSnapshotJobs(jobs) {
    const container = $("snapshot-jobs-table");
    if (!container) return;

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
                    </tr>
                </thead>
                <tbody>
                    ${jobs.map(job => `
                        <tr>
                            <td>
                                <button type="button" class="link-button job-details" data-job-id="${escapeHtml(job.job_id || "")}">
                                    ${escapeHtml(job.job_id || "-")}
                                </button>
                            </td>
                            <td>${escapeHtml(job.account_name || "-")}</td>
                            <td><strong>${escapeHtml(job.region || "-")}</strong></td>
                            <td>
                                <span class="status ${escapeHtml(job.status || "")}">
                                    ${escapeHtml(job.status || "-")}
                                </span>
                            </td>
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
                        </tr>
                    `).join("")}
                </tbody>
            </table>
        </div>
    `;
}


/* =========================================================
   JOB DETAILS
========================================================= */

async function showJobDetails(jobId) {
    if (!jobId) return;

    try {
        const data = await api(`/api/snapshot-jobs/${encodeURIComponent(jobId)}`);
        const job = data.job || {};
        const items = Array.isArray(data.items) ? data.items : [];

        const modal = $("job-details-modal");
        const content = $("job-details-content");

        if (!modal || !content) return;

        content.innerHTML = `
            <div class="job-summary">
                <h2>${escapeHtml(job.job_id || jobId)}</h2>
                <p>Status: <strong>${escapeHtml(job.status || "-")}</strong></p>
                <p>Progress: <strong>${Number(job.progress || 0).toFixed(1)}%</strong></p>
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
                        ${items.map(item => `
                            <tr>
                                <td>${escapeHtml(item.instance_name || "-")}</td>
                                <td><code>${escapeHtml(item.instance_id || "-")}</code></td>
                                <td><code>${escapeHtml(item.volume_id || "-")}</code></td>
                                <td><code>${escapeHtml(item.snapshot_id || "-")}</code></td>
                                <td>${escapeHtml(item.status || "-")}</td>
                                <td>${Number(item.progress || 0)}%</td>
                                <td>${escapeHtml(item.error_message || "")}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>
        `;

        modal.classList.add("show");

    } catch (error) {
        console.error("Unable to load job details:", error);
        if (isAwsAuthenticationError(error)) {
            openCredentialsForAwsError();
        }
        toast(error?.message || "Unable to load job details.", "error");
    }
}

function closeJobDetails() {
    $("job-details-modal")?.classList.remove("show");
}


/* =========================================================
   EVENT LISTENERS
========================================================= */

function setupEventListeners() {
    $("refresh-centralized-dashboard")?.addEventListener("click", loadCentralizedDashboard);
    $("refresh-revert-dashboard")?.addEventListener("click", loadRevertDashboard);
    $("refresh-revert-data")?.addEventListener("click", loadRevertPageData);

    document.querySelectorAll("[data-page]").forEach(button => {
        button.addEventListener("click", () => {
            showPage(button.dataset.page);
        });
    });

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

    $("instance-search")?.addEventListener("input", searchInstances);
    $("snapshot-search")?.addEventListener("input", searchSnapshots);

    $("fetch-instances")?.addEventListener("click", loadInstancesWithVolumeValidation);
    $("fetch-volumes")?.addEventListener("click", loadVolumes);
    $("fetch-snapshots")?.addEventListener("click", loadSnapshots);
    $("refresh-dashboard")?.addEventListener("click", loadDashboard);
    $("refresh-snapshot-dashboard")?.addEventListener("click", loadSnapshotDashboard);

    $("snapshot-instances")?.addEventListener("input", previewSnapshotInstances);
    $("preview-instances")?.addEventListener("click", previewSnapshotInstances);
    $("create-snapshots")?.addEventListener("click", createSnapshotsFromInstances);

    $("snapshot-jobs-table")?.addEventListener("click", event => {
        const button = event.target.closest(".job-details");
        if (button) {
            showJobDetails(button.dataset.jobId);
        }
    });

    $("close-job-details")?.addEventListener("click", closeJobDetails);

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

    const refreshBtn = document.getElementById("refresh-snapshot-dashboard");
    const refreshIcon = document.getElementById("refresh-icon");

    if (refreshBtn) {
        refreshBtn.addEventListener("click", async () => {
            if (refreshIcon) refreshIcon.classList.add("fa-spin");
            secondsRemaining = 15;
            await loadSnapshotDashboard();
            setTimeout(() => {
                if (refreshIcon) refreshIcon.classList.remove("fa-spin");
                toast("Snapshot jobs dashboard refreshed.", "success");
            }, 400);
        });
    }

    const autoToggle = document.getElementById("auto-refresh-toggle");
    if (autoToggle) {
        autoToggle.addEventListener("change", (e) => {
            if (e.target.checked) {
                toast("Auto-refresh enabled (15s interval).", "success");
                secondsRemaining = 15;
            } else {
                toast("Auto-refresh paused.", "info");
                const badge = document.getElementById("refresh-countdown-badge");
                if (badge) badge.textContent = "Paused";
            }
        });
    }

    const reauthBtn = document.getElementById("session-expired-reauth-btn");
    if (reauthBtn) {
        reauthBtn.addEventListener("click", () => {
            document.getElementById("session-expired-modal")?.classList.remove("show");
            if (typeof openCredentials === "function") {
                openCredentials();
            }
        });
    }
}

/* =========================================================
   SNAPSHOT REVERT WORKFLOW HELPERS
========================================================= */

function loadInstancesForRevert() {
    const select = $("revert-instance");
    if (!select) return;

    if (!state.instances.length) {
        select.innerHTML = '<option value="">No instances available. Load instances first.</option>';
        return;
    }

    select.innerHTML = '<option value="">-- Select an Instance --</option>' + 
        state.instances.map(inst => {
            const id = inst.instanceId || inst.instance_id;
            const name = inst.name || id;
            return `<option value="${escapeHtml(id)}">${escapeHtml(name)} (${escapeHtml(id)})</option>`;
        }).join("");
}

function selectRevertInstance(instanceId) {
    const instance = state.instances.find(inst => (inst.instanceId || inst.instance_id) === instanceId);
    state.revert.instance = instance || null;
    state.revert.volumes = [];
    state.revert.snapshots = [];
    state.revert.selectedSnapshots = {};

    const volumesContainer = $("revert-volumes");
    if (!volumesContainer) return;

    if (!instance) {
        volumesContainer.innerHTML = '<div class="muted">Select an instance to view attached volumes.</div>';
        return;
    }

    // Filter volumes attached to this instance
    const attachedVolumes = state.volumes.filter(vol => 
        String(vol.attachedInstance || vol.instanceId || "").trim() === instanceId
    );

    state.revert.volumes = attachedVolumes;

    if (!attachedVolumes.length) {
        volumesContainer.innerHTML = '<div class="muted">No volumes attached to this instance.</div>';
        return;
    }

    volumesContainer.innerHTML = `
        <div class="table-wrapper">
            <table>
                <thead>
                    <tr>
                        <th>Select</th>
                        <th>Volume ID</th>
                        <th>Size</th>
                        <th>Device</th>
                        <th>Target Snapshot</th>
                    </tr>
                </thead>
                <tbody>
                    ${attachedVolumes.map(vol => {
                        const volId = vol.volumeId;
                        // Find matching snapshots for this volume
                        const volSnapshots = state.snapshots.filter(s => s.volumeId === volId);
                        
                        return `
                            <tr>
                                <td>
                                    <input type="checkbox" class="revert-volume-checkbox" data-volume-id="${escapeHtml(volId)}" checked />
                                </td>
                                <td><code>${escapeHtml(volId)}</code></td>
                                <td>${escapeHtml(vol.size || 0)} GB</td>
                                <td>${escapeHtml(vol.device || "-")}</td>
                                <td>
                                    <select class="revert-snapshot-select" data-volume-id="${escapeHtml(volId)}">
                                        <option value="">-- Select Snapshot --</option>
                                        ${volSnapshots.map(snap => `
                                            <option value="${escapeHtml(snap.snapshotId)}">
                                                ${escapeHtml(snap.snapshotId)} (${formatDate(snap.startTime)})
                                            </option>
                                        `).join("")}
                                    </select>
                                </td>
                            </tr>
                        `;
                    }).join("")}
                </tbody>
            </table>
        </div>
    `;

    // Auto-select checkboxes for all loaded volumes by default
    attachedVolumes.forEach(vol => {
        state.revert.selectedSnapshots[vol.volumeId] = {
            selected: true,
            snapshotId: ""
        };
    });
}

function updateRevertCheckbox(volumeId, checked) {
    if (state.revert.selectedSnapshots[volumeId]) {
        state.revert.selectedSnapshots[volumeId].selected = checked;
    } else {
        state.revert.selectedSnapshots[volumeId] = { selected: checked, snapshotId: "" };
    }
}

function updateRevertSelection(volumeId, snapshotId) {
    if (!state.revert.selectedSnapshots[volumeId]) {
        state.revert.selectedSnapshots[volumeId] = { selected: true, snapshotId: "" };
    }
    state.revert.selectedSnapshots[volumeId].snapshotId = snapshotId;
}

async function revertFromSnapshot() {
    const instance = state.revert.instance;
    if (!instance) {
        toast("Please select an instance to revert.", "error");
        return;
    }

    const instanceId = instance.instanceId || instance.instance_id;
    const tasks = [];

    for (const [volumeId, data] of Object.entries(state.revert.selectedSnapshots)) {
        if (data.selected && data.snapshotId) {
            tasks.push({
                instanceId,
                volumeId,
                snapshotId: data.snapshotId
            });
        }
    }

    if (!tasks.length) {
        toast("Please select at least one volume and map it to a snapshot.", "error");
        return;
    }

    if (!confirm(`Are you sure you want to revert ${tasks.length} volume(s) for instance ${instanceId}? This will restart the instance.`)) {
        return;
    }

    try {
        setLoading(true, "Initiating snapshot reversion pipeline...");

        const requestPayload = {
            ...getRequestBody(),
            tasks
        };

        const response = await api("/api/aws/revert-snapshots", {
            method: "POST",
            body: JSON.stringify(requestPayload)
        });

        toast("Snapshot reversion job initiated successfully.", "success");
        console.log("Revert response:", response);

        // Optionally navigate to dashboard or reset state
        showPage("snapshot-dashboard");

    } catch (error) {
        console.error("Revert snapshot failed:", error);
        toast(error?.message || "Failed to execute snapshot reversion.", "error");
    } finally {
        setLoading(false);
    }
}
/* =========================================================
   GLOBAL ERROR HANDLING
========================================================= */

window.addEventListener("error", event => {
    console.error("Global JavaScript error:", event.error || event.message);
});

window.addEventListener("unhandledrejection", event => {
    console.error("Unhandled promise rejection:", event.reason);
    if (isAwsAuthenticationError(event.reason)) {
        openCredentialsForAwsError();
    }
});

/* =========================================================
   RESTORATION QUEUE MANAGEMENT
========================================================= */

if (!state.revert.queue) {
    state.revert.queue = [];
}

document.addEventListener("DOMContentLoaded", () => {
    const addToQueueBtn = document.getElementById("add-to-queue-btn");
    if (addToQueueBtn) {
        addToQueueBtn.addEventListener("click", addRevertTaskToQueue);
    }

    const executeBtn = document.getElementById("restore-snapshot-button");
    if (executeBtn) {
        executeBtn.addEventListener("click", executeRevertQueue);
    }
});

function addRevertTaskToQueue() {
    const instanceSelect = document.getElementById("restore-instance-select");
    const volumeSelect = document.getElementById("restore-volume-select");
    const snapshotSelect = document.getElementById("restore-snapshot-select");

    const instanceId = instanceSelect?.value;
    const instanceName = instanceSelect?.options[instanceSelect.selectedIndex]?.text || instanceId;

    const selectedVolumeOptions = Array.from(volumeSelect?.selectedOptions || []);
    const snapshotId = snapshotSelect?.value;
    const snapshotText = snapshotSelect?.options[snapshotSelect.selectedIndex]?.text || snapshotId;

    if (!instanceId) {
        toast("Please select an EC2 instance first.", "error");
        return;
    }

    if (!selectedVolumeOptions.length) {
        toast("Please select at least one volume to replace.", "error");
        return;
    }

    if (!snapshotId) {
        toast("Please select a target snapshot to map.", "error");
        return;
    }

    selectedVolumeOptions.forEach(volOpt => {
        const volumeId = volOpt.value;
        const volumeLabel = volOpt.text;

        const exists = state.revert.queue.some(
            task => task.instanceId === instanceId && task.volumeId === volumeId
        );

        if (!exists) {
            state.revert.queue.push({
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                instanceId,
                instanceName,
                volumeId,
                volumeLabel,
                snapshotId,
                snapshotText
            });
        }
    });

    renderRevertQueue();
    toast("Volume mapping added to restoration queue.", "success");
}

function removeTaskFromQueue(taskId) {
    state.revert.queue = state.revert.queue.filter(task => task.id !== taskId);
    renderRevertQueue();
    toast("Task removed from queue.", "info");
}

function renderRevertQueue() {
    const container = document.getElementById("restore-queue-list");
    const emptyText = document.getElementById("queue-empty-text");
    const counterBadge = document.getElementById("queue-counter-badge");
    const executeBtn = document.getElementById("restore-snapshot-button");

    if (!container) return;

    if (counterBadge) {
        counterBadge.textContent = `${state.revert.queue.length} task${state.revert.queue.length === 1 ? "" : "s"} queued`;
    }

    if (!state.revert.queue.length) {
        if (emptyText) emptyText.style.display = "block";
        container.innerHTML = `<p id="queue-empty-text" style="color: var(--text-muted, #888); font-size: 12px; text-align: center; margin: 8px 0;">No restore tasks added to queue yet.</p>`;
        if (executeBtn) executeBtn.disabled = true;
        return;
    }

    if (emptyText) emptyText.style.display = "none";

    container.innerHTML = state.revert.queue.map(task => `
        <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(15, 23, 42, 0.6); border: 1px solid var(--border-color, #334155); padding: 8px 12px; border-radius: 6px; margin-bottom: 6px; font-size: 12px;">
            <div>
                <strong style="color: #f8fafc;">Instance:</strong> ${escapeHtml(task.instanceId)}<br>
                <strong style="color: #f8fafc;">Volume:</strong> <code>${escapeHtml(task.volumeId)}</code><br>
                <strong style="color: #f8fafc;">Snapshot:</strong> <code>${escapeHtml(task.snapshotId)}</code>
            </div>
            <button type="button" onclick="removeTaskFromQueue('${task.id}')" style="background: rgba(248, 113, 113, 0.1); color: #f87171; border: 1px solid #f87171; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 11px;">
                Remove
            </button>
        </div>
    `).join("");

    if (executeBtn) {
        executeBtn.disabled = false;
    }
}

async function executeRevertQueue() {
    if (!state.revert.queue.length) {
        toast("No tasks in the execution queue.", "error");
        return;
    }

    if (!confirm(`Execute parallel restoration for ${state.revert.queue.length} queued task(s)? This will stop the target instances.`)) {
        return;
    }

    try {
        setLoading(true, "Dispatching parallel volume restoration tasks...");

        const requestBody = {
            ...getRequestBody(),
            tasks: state.revert.queue
        };

        const data = await api("/api/aws/revert-snapshots", {
            method: "POST",
            body: JSON.stringify(requestBody)
        });

        toast("Restoration jobs successfully dispatched!", "success");
        state.revert.queue = [];
        renderRevertQueue();

        if (typeof showPage === "function") {
            showPage("revert-dashboard");
        }

    } catch (error) {
        console.error("Revert execution failed:", error);
        toast(error?.message || "Failed to execute volume restoration pipeline.", "error");
    } finally {
        setLoading(false);
    }
}

/* =========================================================
   FILTERED REVERT WORKFLOW (INSTANCE-BOUND)
========================================================= */

document.addEventListener("DOMContentLoaded", () => {
    const instanceSelect = document.getElementById("restore-instance-select");
    if (instanceSelect) {
        instanceSelect.addEventListener("change", (e) => {
            const instanceId = e.target.value;
            if (!instanceId) {
                resetRevertFormSteps();
                return;
            }
            loadInstanceVolumesLocally(instanceId);
        });
    }

    const volumeSelect = document.getElementById("restore-volume-select");
    if (volumeSelect) {
        volumeSelect.addEventListener("change", () => {
            const selectedVolumeIds = Array.from(volumeSelect.selectedOptions).map(opt => opt.value);
            if (selectedVolumeIds.length > 0) {
                loadSnapshotsForVolumesLocally(selectedVolumeIds);
            }
        });
    }
});

function loadInstanceVolumesLocally(instanceId) {
    const volumeSelect = document.getElementById("restore-volume-select");
    const snapshotSelect = document.getElementById("restore-snapshot-select");

    if (!volumeSelect) return;

    const instanceVolumes = state.volumes.filter(vol => {
        const attachedTo = String(vol.attachedInstance || vol.instanceId || vol.instance_id || "").trim();
        return attachedTo === String(instanceId).trim();
    });

    if (!instanceVolumes.length) {
        volumeSelect.innerHTML = `<option value="">No EBS volumes attached to this instance</option>`;
        volumeSelect.disabled = true;
        toast("No volumes found for this specific instance.", "error");
        return;
    }

    volumeSelect.innerHTML = instanceVolumes.map(vol => `
        <option value="${escapeHtml(vol.volumeId || vol.volume_id)}">
            ${escapeHtml(vol.name || vol.volumeId || vol.volume_id)} (${escapeHtml(vol.size || 0)} GB) - [${escapeHtml(vol.state || "in-use")}]
        </option>
    `).join("");

    volumeSelect.disabled = false;

    if (snapshotSelect) {
        snapshotSelect.innerHTML = `<option value="">Select volume(s) first</option>`;
        snapshotSelect.disabled = true;
    }

    toast(`${instanceVolumes.length} attached volume(s) loaded for instance.`, "success");
}

function loadSnapshotsForVolumesLocally(volumeIds) {
    const snapshotSelect = document.getElementById("restore-snapshot-select");
    const addToQueueBtn = document.getElementById("add-to-queue-btn");

    if (!snapshotSelect) return;

    const matchingSnapshots = state.snapshots.filter(snap => {
        const snapVolId = String(snap.volumeId || snap.volume_id || "").trim();
        return volumeIds.includes(snapVolId);
    });

    if (!matchingSnapshots.length) {
        snapshotSelect.innerHTML = `<option value="">No snapshots found for selected volume(s)</option>`;
        snapshotSelect.disabled = true;
        if (addToQueueBtn) addToQueueBtn.disabled = true;
        toast("No matching snapshots found for these volumes.", "error");
        return;
    }

    snapshotSelect.innerHTML = matchingSnapshots.map(snap => `
        <option value="${escapeHtml(snap.snapshotId || snap.snapshot_id)}">
            [${escapeHtml(snap.volumeId || snap.volume_id)}] ${escapeHtml(snap.snapshotId || snap.snapshot_id)} — ${formatDate(snap.startTime || snap.start_time)} (${escapeHtml(snap.progress || "100%")})
        </option>
    `).join("");

    snapshotSelect.disabled = false;
    if (addToQueueBtn) addToQueueBtn.disabled = false;

    toast(`${matchingSnapshots.length} snapshot(s) loaded for selected volumes.`, "success");
}

function resetRevertFormSteps() {
    const volumeSelect = document.getElementById("restore-volume-select");
    const snapshotSelect = document.getElementById("restore-snapshot-select");
    const addToQueueBtn = document.getElementById("add-to-queue-btn");

    if (volumeSelect) {
        volumeSelect.innerHTML = `<option value="">Select an instance first</option>`;
        volumeSelect.disabled = true;
    }
    if (snapshotSelect) {
        snapshotSelect.innerHTML = `<option value="">Select volume(s) first</option>`;
        snapshotSelect.disabled = true;
    }
    if (addToQueueBtn) {
        addToQueueBtn.disabled = true;
    }
}

/* =========================================================
   CLEANUP
========================================================= */

window.addEventListener("beforeunload", () => {
    stopSnapshotPolling();
    stopSnapshotDashboardPolling();
});

window.removeTaskFromQueue = removeTaskFromQueue;

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
        if (dashboard) {
            dashboard.classList.add("active");
        }

        const dashboardMessage = $("dashboard-message");
        if (dashboardMessage) {
            dashboardMessage.textContent = `Application error: ${message}`;
        }
    }
});
