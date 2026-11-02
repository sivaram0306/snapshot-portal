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
        restoring: false
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
        loadInstances();
    }

    if (state.currentPage === "volumes") {
        loadVolumes();
    }

    if (state.currentPage === "snapshots") {
        loadSnapshots();
    }

    if (state.currentPage === "create-snapshot") {
        loadInstancesForSnapshot();
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
            account.name,

        awsAccountId:
            account.awsAccountId || account.id
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
            : (
                data.message ||
                data.error?.message ||
                ""
            );

    if (
        AWS_AUTH_ERROR_CODES.includes(code)
    ) {
        return true;
    }

    return /ExpiredToken|InvalidClientTokenId|UnrecognizedClient|InvalidAccessKeyId|SignatureDoesNotMatch/i
        .test(String(message));
}

function openCredentialsForAwsError() {
    if (credentialPopupOpening) {
        return;
    }

    credentialPopupOpening = true;

    renderAccountList();

    $("credential-modal")
        ?.classList.add("show");

    setTimeout(() => {
        credentialPopupOpening = false;
    }, 500);

    toast(
        "AWS credentials expired or are invalid. Update the existing account credentials.",
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
                ? {
                    "Content-Type":
                        "application/json"
                }
                : {}),
            ...(portalSessionToken ? { "Authorization": `Bearer ${portalSessionToken}` } : {}),
            ...(options.headers || {})
        }
    };

    let response;

    try {
        response =
            await fetch(url, config);

    } catch (error) {
        console.error(
            "API network error:",
            error
        );

        throw new Error(
            "Unable to connect to the server."
        );
    }

    const contentType =
        response.headers.get("content-type") ||
        "";

    let data;

    try {
        if (
            contentType
                .toLowerCase()
                .includes("application/json")
        ) {
            data = await response.json();
        } else {
            const text = await response.text();

            console.error(
                `Unexpected non-JSON response from ${url}:`,
                text
            );

            throw new Error(
                text ||
                `Server returned HTTP ${response.status}`
            );
        }

    } catch (error) {
        console.error(
            "API response parsing error:",
            error
        );

        if (
            error instanceof Error &&
            error.message
        ) {
            throw error;
        }

        throw new Error(
            `Server returned HTTP ${response.status}`
        );
    }

    if (
        !data ||
        typeof data !== "object"
    ) {
        throw new Error(
            `Invalid server response from ${url}`
        );
    }

    if (data.code === "PORTAL_SESSION_EXPIRED" || data.code === "PORTAL_SESSION_REQUIRED") {
        portalLogout(data.error || "Your portal session expired. Sign in again.");
        throw new Error(data.error || "Portal session expired.");
    }

    if (
        isAwsAuthenticationError(data)
    ) {
        openCredentialsForAwsError();

        throw new Error(
            "AWS credentials expired or are invalid."
        );
    }

    if (
        !response.ok ||
        data.success === false
    ) {
        throw new Error(
            data.error ||
            data.message ||
            `HTTP ${response.status}`
        );
    }

    return data;
}


/* =========================================================
   ACCOUNT MODAL
========================================================= */

function openCredentials() {
    state.editingAccountId = null;

    clearAccountForm();

    const button =
        $("account-add");

    if (button) {
        button.textContent =
            "Add Account";
    }

    renderAccountList();

    $("credential-modal")
        ?.classList.add("show");
}

function closeCredentials() {
    $("credential-modal")
        ?.classList.remove("show");

    state.editingAccountId = null;

    clearAccountForm();

    const button =
        $("account-add");

    if (button) {
        button.textContent =
            "Add Account";
    }
}

function clearAccountForm() {
    if ($("account-name")) {
        $("account-name").value = "";
    }

    if ($("access-key")) {
        $("access-key").value = "";
    }

    if ($("secret-key")) {
        $("secret-key").value = "";
    }

    if ($("session-token")) {
        $("session-token").value = "";
    }

    if ($("account-region")) {
        $("account-region").value =
            "us-west-1";
    }
}

function editAccount(accountId) {
    const account =
        state.accounts.find(
            item =>
                item &&
                item.id === accountId
        );

    if (!account) {
        return;
    }

    state.editingAccountId =
        account.id;

    if ($("account-name")) {
        $("account-name").value =
            account.name || "";
    }

    if ($("access-key")) {
        $("access-key").value =
            account.accessKeyId || "";
    }

    if ($("secret-key")) {
        $("secret-key").value =
            account.secretAccessKey || "";
    }

    if ($("session-token")) {
        $("session-token").value =
            account.sessionToken || "";
    }

    if ($("account-region")) {
        $("account-region").value =
            account.region ||
            "us-west-1";
    }

    const button =
        $("account-add");

    if (button) {
        button.textContent =
            "Update Account";
    }

    $("credential-modal")
        ?.classList.add("show");
}

function saveAccount() {
    const name =
        $("account-name")
            ?.value
            .trim() || "";

    const accessKeyId =
        $("access-key")
            ?.value
            .trim() || "";

    const secretAccessKey =
        $("secret-key")
            ?.value
            .trim() || "";

    const sessionToken =
        $("session-token")
            ?.value
            .trim() || "";

    const region =
        $("account-region")
            ?.value ||
        "us-west-1";

    if (!name) {
        toast(
            "Enter an account name.",
            "error"
        );

        return;
    }

    if (!accessKeyId) {
        toast(
            "Enter the AWS Access Key ID.",
            "error"
        );

        return;
    }

    if (!secretAccessKey) {
        toast(
            "Enter the AWS Secret Access Key.",
            "error"
        );

        return;
    }

    if (state.editingAccountId) {
        const account =
            state.accounts.find(
                item =>
                    item &&
                    item.id ===
                    state.editingAccountId
            );

        if (!account) {
            return;
        }

        account.name =
            name;

        account.accessKeyId =
            accessKeyId;

        account.secretAccessKey =
            secretAccessKey;

        account.sessionToken =
            sessionToken;

        account.region =
            region;

        state.activeAccountId =
            account.id;

        toast(
            "AWS account updated successfully.",
            "success"
        );

    } else {
        const account = {
            id:
                typeof crypto !== "undefined" &&
                typeof crypto.randomUUID === "function"
                    ? crypto.randomUUID()
                    : `${Date.now()}-${Math.random()
                        .toString(36)
                        .slice(2)}`,

            name,
            accessKeyId,
            secretAccessKey,
            sessionToken,
            region
        };

        state.accounts.push(account);

        state.activeAccountId =
            account.id;

        toast(
            "AWS account added successfully.",
            "success"
        );
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
/* =========================================================
   GLOBAL SNAPSHOT REVERT FUNCTIONS (Required by app.js router)
========================================================= */

function resetRevertState() {
    const regionSelect = document.getElementById('restore-region-select');
    if (regionSelect) {
        regionSelect.value = '';
        regionSelect.dispatchEvent(new Event('change'));
    }
}

function loadInstancesForRevert() {
    const regionSelect = document.getElementById('restore-region-select');
    if (regionSelect && regionSelect.value) {
        regionSelect.dispatchEvent(new Event('change'));
    }
}
function renderAccountList() {
    const container =
        $("account-list");

    if (!container) {
        return;
    }

    if (!state.accounts.length) {
        container.innerHTML =
            `<div class="muted">No accounts added.</div>`;

        return;
    }

    container.innerHTML =
        state.accounts
            .filter(Boolean)
            .map(account => {
                const active =
                    account.id ===
                    state.activeAccountId;

                return `
                    <div class="account-row ${active ? "selected" : ""}">

                        <div class="account-info">

                            <strong>
                                ${escapeHtml(
                                    account.name ||
                                    "Unnamed account"
                                )}
                            </strong>

                            <small>
                                Region:
                                ${escapeHtml(
                                    account.region ||
                                    "us-west-1"
                                )}
                            </small>

                        </div>

                        <div class="account-actions">

                            <button
                                type="button"
                                class="account-use"
                                data-account-id="${escapeHtml(
                                    account.id
                                )}"
                            >
                                ${active ? "Active" : "Use"}
                            </button>

                            <button
                                type="button"
                                class="account-edit"
                                data-account-id="${escapeHtml(
                                    account.id
                                )}"
                            >
                                Edit
                            </button>

                            <button
                                type="button"
                                class="account-remove"
                                data-account-id="${escapeHtml(
                                    account.id
                                )}"
                            >
                                Remove
                            </button>

                        </div>

                    </div>
                `;
            })
            .join("");
}

function selectAccount(accountId) {
    const account =
        state.accounts.find(
            item =>
                item &&
                item.id === accountId
        );

    if (!account) {
        return;
    }

    state.activeAccountId =
        accountId;

    saveAccounts();

    updateAccountSelector();
    updateRegionFromAccount();
    updateSelectedAccountUI();

    renderAccountList();

    clearAwsData();
    resetRevertState();

    closeCredentials();

    showPage(state.currentPage);

    toast(
        `Using ${account.name}.`,
        "success"
    );
}

function switchAccount() {
    const select =
        $("account-select");

    if (!select?.value) {
        return;
    }

    selectAccount(
        select.value
    );
}

function removeAccount(accountId) {
    const account =
        state.accounts.find(
            item =>
                item &&
                item.id === accountId
        );

    if (!account) {
        return;
    }

    if (
        !confirm(
            `Remove AWS account "${account.name}"?`
        )
    ) {
        return;
    }

    state.accounts =
        state.accounts.filter(
            item =>
                item &&
                item.id !== accountId
        );

    if (
        state.activeAccountId ===
        accountId
    ) {
        state.activeAccountId =
            state.accounts[0]?.id ||
            null;
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
    return state.volumes.reduce(
        (total, volume) => {
            return (
                total +
                (Number(volume?.size) || 0)
            );
        },
        0
    );
}

function formatStorageSize(storageGB) {
    const gb =
        Number(storageGB) || 0;

    if (gb >= 1024) {
        return `${(
            gb / 1024
        ).toFixed(2)} TB`;
    }

    return `${gb} GB`;
}

function updateVolumeTotals() {
    const total =
        getTotalVolumeStorageGB();

    const count =
        state.volumes.length;

    const encrypted =
        state.volumes.filter(
            volume =>
                Boolean(volume?.encrypted)
        ).length;

    if ($("volume-count")) {
        $("volume-count").textContent =
            count;
    }

    if ($("volume-total-storage")) {
        $("volume-total-storage").textContent =
            formatStorageSize(total);
    }

    if ($("dashboard-storage-number")) {
        $("dashboard-storage-number").textContent =
            total.toLocaleString();
    }

    if ($("dashboard-storage-readable")) {
        $("dashboard-storage-readable").textContent =
            formatStorageSize(total);
    }

    if ($("volumes-page-count")) {
        $("volumes-page-count").textContent =
            count;
    }

    if ($("volumes-page-total")) {
        $("volumes-page-total").textContent =
            formatStorageSize(total);
    }

    if ($("volumes-page-encrypted")) {
        $("volumes-page-encrypted").textContent =
            encrypted;
    }
}


/* =========================================================
   INSTANCE STORAGE
========================================================= */

function getInstanceStorageGB(instance) {
    if (!instance) {
        return 0;
    }

    if (
        instance.totalVolumeSize !==
        undefined &&
        instance.totalVolumeSize !== null
    ) {
        return Number(
            instance.totalVolumeSize
        ) || 0;
    }

    if (
        instance.totalVolumeSizeGB !==
        undefined &&
        instance.totalVolumeSizeGB !== null
    ) {
        return Number(
            instance.totalVolumeSizeGB
        ) || 0;
    }

    if (
        instance.totalStorageGB !==
        undefined &&
        instance.totalStorageGB !== null
    ) {
        return Number(
            instance.totalStorageGB
        ) || 0;
    }

    const instanceId =
        String(
            instance.instanceId ||
            instance.instance_id ||
            ""
        ).trim();

    if (!instanceId) {
        return 0;
    }

    return state.volumes
        .filter(
            volume =>
                String(
                    volume?.attachedInstance ||
                    volume?.instanceId ||
                    ""
                ).trim() === instanceId
        )
        .reduce(
            (total, volume) =>
                total +
                (Number(volume?.size) || 0),
            0
        );
}

function isInstanceOverStorageLimit(instance) {
    return (
        getInstanceStorageGB(instance) >
        MAX_INSTANCE_STORAGE_GB
    );
}


/* =========================================================
   INSTANCE DEDUPLICATION
========================================================= */

function deduplicateInstances(instances = []) {
    const seenIds =
        new Set();

    const seenNames =
        new Set();

    const unique = [];

    if (!Array.isArray(instances)) {
        return unique;
    }

    for (const instance of instances) {
        if (!instance) {
            continue;
        }

        const instanceId =
            String(
                instance.instanceId ||
                instance.instance_id ||
                ""
            )
                .trim()
                .toLowerCase();

        const instanceName =
            String(
                instance.name ||
                instance.instanceName ||
                ""
            )
                .trim()
                .toLowerCase();

        if (
            instanceId &&
            seenIds.has(instanceId)
        ) {
            continue;
        }

        if (
            instanceName &&
            seenNames.has(instanceName)
        ) {
            continue;
        }

        if (instanceId) {
            seenIds.add(instanceId);
        }

        if (instanceName) {
            seenNames.add(instanceName);
        }

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

    if ($("instance-count")) {
        $("instance-count").textContent =
            "-";
    }

    if ($("snapshot-count")) {
        $("snapshot-count").textContent =
            "-";
    }

    if ($("volume-count")) {
        $("volume-count").textContent =
            "-";
    }

    if ($("volume-total-storage")) {
        $("volume-total-storage").textContent =
            "-";
    }

    if ($("dashboard-storage-number")) {
        $("dashboard-storage-number").textContent =
            "0";
    }

    if ($("dashboard-storage-readable")) {
        $("dashboard-storage-readable").textContent =
            "0 GB";
    }

    if ($("volumes-page-count")) {
        $("volumes-page-count").textContent =
            "0";
    }

    if ($("volumes-page-total")) {
        $("volumes-page-total").textContent =
            "0 GB";
    }

    if ($("volumes-page-encrypted")) {
        $("volumes-page-encrypted").textContent =
            "0";
    }

    if ($("instances-table")) {
        $("instances-table").innerHTML =
            "";
    }

    if ($("volumes-table")) {
        $("volumes-table").innerHTML =
            "";
    }

    if ($("snapshots-table")) {
        $("snapshots-table").innerHTML =
            "";
    }
}


/* =========================================================
   DASHBOARD
========================================================= */

async function loadDashboard() {
    const account =
        getActiveAccount();

    updateSelectedAccountUI();

    if (!account) {
        if ($("dashboard-message")) {
            $("dashboard-message").textContent =
                "Add an AWS account to get started.";
        }

        return;
    }

    try {
        const requestBody =
            JSON.stringify(
                getRequestBody()
            );

        const [
            instances,
            volumes,
            snapshots
        ] = await Promise.all([

            api(
                "/api/aws/instances",
                {
                    method: "POST",
                    body: requestBody
                }
            ),

            api(
                "/api/aws/volumes",
                {
                    method: "POST",
                    body: requestBody
                }
            ),

            api(
                "/api/aws/snapshots",
                {
                    method: "POST",
                    body: requestBody
                }
            )

        ]);

        state.instances =
            deduplicateInstances(
                instances.instances || []
            );

        state.volumes =
            Array.isArray(volumes.volumes)
                ? volumes.volumes
                : [];

        state.snapshots =
            Array.isArray(snapshots.snapshots)
                ? snapshots.snapshots
                : [];

        if ($("instance-count")) {
            $("instance-count").textContent =
                state.instances.length;
        }

        if ($("snapshot-count")) {
            $("snapshot-count").textContent =
                state.snapshots.length;
        }

        updateVolumeTotals();

        if ($("dashboard-message")) {
            $("dashboard-message").textContent =
                `${account.name} — ${account.region}`;
        }

    } catch (error) {
        console.error(
            "Dashboard loading failed:",
            error
        );

        toast(
            error?.message ||
            "Unable to load dashboard data.",
            "error"
        );
    }
}


/* =========================================================
   INSTANCES
========================================================= */

async function loadInstances() {
    if (!getActiveAccount()) {
        toast(
            "Connect an AWS account first.",
            "error"
        );

        return;
    }

    try {
        setLoading(
            true,
            "Loading EC2 instances..."
        );

        const data =
            await api(
                "/api/aws/instances",
                {
                    method: "POST",
                    body:
                        JSON.stringify(
                            getRequestBody()
                        )
                }
            );

        state.instances =
            deduplicateInstances(
                data.instances || []
            );

        if ($("instance-count")) {
            $("instance-count").textContent =
                state.instances.length;
        }

        searchInstances();

        toast(
            `${state.instances.length} unique instances loaded.`,
            "success"
        );

    } catch (error) {
        console.error(
            "Instance loading failed:",
            error
        );

        toast(
            error?.message ||
            "Unable to load EC2 instances.",
            "error"
        );

    } finally {
        setLoading(false);
    }
}

function searchInstances() {
    const search =
        $("instance-search")
            ?.value
            .trim()
            .toLowerCase() ||
        "";

    const filtered =
        state.instances.filter(instance => {
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
        $("instance-result-count").textContent =
            `${filtered.length} result${
                filtered.length === 1
                    ? ""
                    : "s"
            }`;
    }

    renderInstances(filtered);
}

function renderInstances(instances) {
    const container =
        $("instances-table");

    if (!container) {
        return;
    }

    if (!instances.length) {
        container.innerHTML =
            `<div class="empty-state small">
                No instances found.
            </div>`;

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
                        const storageGB =
                            getInstanceStorageGB(
                                instance
                            );

                        const overLimit =
                            storageGB >
                            MAX_INSTANCE_STORAGE_GB;

                        return `
                            <tr>

                                <td>
                                    ${escapeHtml(
                                        instance.name ||
                                        "-"
                                    )}
                                </td>

                                <td>
                                    <code>
                                        ${escapeHtml(
                                            instance.instanceId ||
                                            instance.instance_id ||
                                            "-"
                                        )}
                                    </code>
                                </td>

                                <td>
                                    <span class="status ${escapeHtml(
                                        instance.state ||
                                        ""
                                    )}">
                                        ${escapeHtml(
                                            instance.state ||
                                            "-"
                                        )}
                                    </span>
                                </td>

                                <td>
                                    ${escapeHtml(
                                        instance.instanceType ||
                                        "-"
                                    )}
                                </td>

                                <td>
                                    ${escapeHtml(
                                        instance.privateIp ||
                                        "-"
                                    )}
                                </td>

                                <td>
                                    ${escapeHtml(
                                        instance.publicIp ||
                                        "-"
                                    )}
                                </td>

                                <td>
                                    ${escapeHtml(
                                        instance.availabilityZone ||
                                        "-"
                                    )}
                                </td>

                                <td>
                                    ${Number(
                                        instance.volumeCount ||
                                        0
                                    )}
                                </td>

                                <td>
                                    <span class="${
                                        overLimit
                                            ? "status error"
                                            : ""
                                    }">
                                        ${escapeHtml(
                                            formatStorageSize(
                                                storageGB
                                            )
                                        )}
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
        toast(
            "Connect an AWS account first.",
            "error"
        );

        return;
    }

    try {
        setLoading(
            true,
            "Loading EBS volumes..."
        );

        const data =
            await api(
                "/api/aws/volumes",
                {
                    method: "POST",
                    body:
                        JSON.stringify(
                            getRequestBody()
                        )
                }
            );

        state.volumes =
            Array.isArray(data.volumes)
                ? data.volumes
                : [];

        updateVolumeTotals();

        renderVolumes(
            state.volumes
        );

        toast(
            `${state.volumes.length} volumes loaded.`,
            "success"
        );

    } catch (error) {
        console.error(
            "Volume loading failed:",
            error
        );

        toast(
            error?.message ||
            "Unable to load EBS volumes.",
            "error"
        );

    } finally {
        setLoading(false);
    }
}

function renderVolumes(volumes) {
    const container =
        $("volumes-table");

    if (!container) {
        return;
    }

    updateVolumeTotals();

    if (!volumes.length) {
        container.innerHTML =
            `<div class="empty-state small">
                No EBS volumes found.
            </div>`;

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

                            <td>
                                ${escapeHtml(
                                    volume.name ||
                                    "-"
                                )}
                            </td>

                            <td>
                                <code>
                                    ${escapeHtml(
                                        volume.volumeId ||
                                        "-"
                                    )}
                                </code>
                            </td>

                            <td>
                                <strong>
                                    ${Number(
                                        volume.size ||
                                        0
                                    )}
                                    GB
                                </strong>
                            </td>

                            <td>
                                ${escapeHtml(
                                    volume.type ||
                                    "gp3"
                                )}
                            </td>

                            <td>
                                <span class="status ${escapeHtml(
                                    volume.state ||
                                    ""
                                )}">
                                    ${escapeHtml(
                                        volume.state ||
                                        "-"
                                    )}
                                </span>
                            </td>

                            <td>
                                <code>
                                    ${escapeHtml(
                                        volume.attachedInstance ||
                                        "-"
                                    )}
                                </code>
                            </td>

                            <td>
                                ${
                                    volume.encrypted
                                        ? "Yes"
                                        : "No"
                                }
                            </td>

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
    const silent =
        Boolean(options.silent);

    if (!getActiveAccount()) {
        if (!silent) {
            toast(
                "Connect an AWS account first.",
                "error"
            );
        }

        return;
    }

    try {
        if (!silent) {
            setLoading(
                true,
                "Loading AWS snapshots..."
            );
        }

        const data =
            await api(
                "/api/aws/snapshots",
                {
                    method: "POST",
                    body:
                        JSON.stringify(
                            getRequestBody()
                        )
                }
            );

        state.snapshots =
            Array.isArray(data.snapshots)
                ? data.snapshots
                : [];

        if ($("snapshot-count")) {
            $("snapshot-count").textContent =
                state.snapshots.length;
        }

        searchSnapshots();

        if (!silent) {
            toast(
                `${state.snapshots.length} snapshots loaded.`,
                "success"
            );
        }

    } catch (error) {
        if (!silent) {
            toast(
                error?.message ||
                "Unable to load snapshots.",
                "error"
            );
        } else {
            console.error(
                "Snapshot polling failed:",
                error
            );
        }

    } finally {
        if (!silent) {
            setLoading(false);
        }
    }
}

function searchSnapshots() {
    const search =
        $("snapshot-search")
            ?.value
            .trim()
            .toLowerCase() ||
        "";

    const filtered =
        state.snapshots.filter(snapshot => {
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
        $("snapshot-result-count").textContent =
            `${filtered.length} result${
                filtered.length === 1
                    ? ""
                    : "s"
            }`;
    }

    renderSnapshots(filtered);
}

function renderSnapshots(snapshots) {
    const container =
        $("snapshots-table");

    if (!container) {
        return;
    }

    if (!snapshots.length) {
        container.innerHTML =
            `<div class="empty-state small">
                No snapshots found.
            </div>`;

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

                            <td>
                                <code>
                                    ${escapeHtml(
                                        snapshot.snapshotId ||
                                        "-"
                                    )}
                                </code>
                            </td>

                            <td>
                                ${escapeHtml(
                                    snapshot.instanceName ||
                                    "-"
                                )}
                                <br>
                                <small>
                                    ${escapeHtml(
                                        snapshot.instanceId ||
                                        "-"
                                    )}
                                </small>
                            </td>

                            <td>
                                <code>
                                    ${escapeHtml(
                                        snapshot.volumeId ||
                                        "-"
                                    )}
                                </code>
                            </td>

                            <td>
                                <span class="status ${escapeHtml(
                                    snapshot.state ||
                                    ""
                                )}">
                                    ${escapeHtml(
                                        snapshot.state ||
                                        "-"
                                    )}
                                </span>
                            </td>

                            <td>
                                ${escapeHtml(
                                    snapshot.progress ||
                                    "-"
                                )}
                            </td>

                            <td>
                                ${escapeHtml(
                                    snapshot.createdBy ||
                                    "-"
                                )}
                            </td>

                            <td>
                                ${escapeHtml(
                                    snapshot.team ||
                                    "-"
                                )}
                            </td>

                            <td>
                                ${formatDate(
                                    snapshot.startTime
                                )}
                            </td>

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

    loadSnapshots({
        silent: true
    });

    state.snapshotPollingTimer =
        setInterval(() => {
            if (
                state.currentPage !==
                "snapshots"
            ) {
                return;
            }

            if (!getActiveAccount()) {
                return;
            }

            loadSnapshots({
                silent: true
            });

        }, SNAPSHOT_POLL_INTERVAL);
}

function stopSnapshotPolling() {
    if (
        state.snapshotPollingTimer
    ) {
        clearInterval(
            state.snapshotPollingTimer
        );

        state.snapshotPollingTimer =
            null;
    }
}


/* =========================================================
   CREATE SNAPSHOT
========================================================= */

async function loadInstancesForSnapshot() {
    if (!getActiveAccount()) {
        return;
    }

    if (state.instances.length) {
        state.instances =
            deduplicateInstances(
                state.instances
            );

        updateInstanceHint();

        return;
    }

    try {
        setLoading(
            true,
            "Loading instances..."
        );

        const data =
            await api(
                "/api/aws/instances",
                {
                    method: "POST",
                    body:
                        JSON.stringify(
                            getRequestBody()
                        )
                }
            );

        state.instances =
            deduplicateInstances(
                data.instances || []
            );

        updateInstanceHint();

    } catch (error) {
        console.error(
            "Unable to load snapshot instances:",
            error
        );

        toast(
            error?.message ||
            "Unable to load instances.",
            "error"
        );

    } finally {
        setLoading(false);
    }
}

function updateInstanceHint() {
    const hint =
        $("snapshot-instance-hint");

    if (!hint) {
        return;
    }

    hint.textContent =
        `${state.instances.length} unique instance(s) available in ${
            getActiveAccount()?.region || "-"
        }. Instances with more than 2 TB of attached EBS storage cannot be snapshotted.`;
}

function getSnapshotInstanceLines() {
    const lines =
        $("snapshot-instances")
            ?.value
            .split(/\r?\n/)
            .map(value => value.trim())
            .filter(Boolean) ||
        [];

    const seen =
        new Set();

    return lines.filter(value => {
        const key =
            value.toLowerCase();

        if (seen.has(key)) {
            return false;
        }

        seen.add(key);

        return true;
    });
}

function previewSnapshotInstances() {
    const lines =
        getSnapshotInstanceLines();

    const preview =
        $("snapshot-instance-preview");

    if (!preview) {
        return;
    }

    state.instances =
        deduplicateInstances(
            state.instances
        );

    if (!lines.length) {
        preview.innerHTML =
            `<div class="muted">
                Enter one instance name or ID per line.
            </div>`;

        return;
    }

    const results =
        lines.map(input => {
            const lower =
                input.toLowerCase();

            const match =
                state.instances.find(
                    instance =>
                        String(
                            instance.instanceId ||
                            instance.instance_id ||
                            ""
                        )
                            .toLowerCase() ===
                            lower ||
                        String(
                            instance.name ||
                            instance.instanceName ||
                            ""
                        )
                            .toLowerCase() ===
                            lower
                );

            return {
                input,
                match
            };
        });

    const found =
        results.filter(
            item => item.match
        );

    const missing =
        results.filter(
            item => !item.match
        );

    const oversized =
        found.filter(
            item =>
                isInstanceOverStorageLimit(
                    item.match
                )
        );

    const allowed =
        found.filter(
            item =>
                !isInstanceOverStorageLimit(
                    item.match
                )
        );

    let html = "";

    if (allowed.length) {
        html += `
            <div class="success-box">

                <strong>
                    ${allowed.length}
                    unique instance(s) eligible for snapshot
                </strong>

                <ul>

                    ${allowed.map(item => `
                        <li>
                            ${escapeHtml(
                                item.match.name ||
                                item.match.instanceId ||
                                item.match.instance_id
                            )}

                            —

                            ${escapeHtml(
                                formatStorageSize(
                                    getInstanceStorageGB(
                                        item.match
                                    )
                                )
                            )}
                        </li>
                    `).join("")}

                </ul>

            </div>
        `;
    }

    if (oversized.length) {
        html += `
            <div class="error-box">

                <strong>
                    ${oversized.length}
                    instance(s) exceed 2 TB
                </strong>

                <ul>

                    ${oversized.map(item => `
                        <li>
                            ${escapeHtml(
                                item.match.name ||
                                item.match.instanceId ||
                                item.match.instance_id
                            )}

                            —

                            ${escapeHtml(
                                formatStorageSize(
                                    getInstanceStorageGB(
                                        item.match
                                    )
                                )
                            )}
                        </li>
                    `).join("")}

                </ul>

            </div>
        `;
    }

    if (missing.length) {
        html += `
            <div class="error-box">

                <strong>
                    ${missing.length}
                    instance(s) not found
                </strong>

                <ul>

                    ${missing.map(item => `
                        <li>
                            ${escapeHtml(
                                item.input
                            )}
                        </li>
                    `).join("")}

                </ul>

            </div>
        `;
    }

    preview.innerHTML =
        html;
}

async function createSnapshotsFromInstances() {
    const account =
        getActiveAccount();

    if (!account) {
        toast(
            "Connect an AWS account first.",
            "error"
        );

        openCredentials();

        return;
    }

    state.instances =
        deduplicateInstances(
            state.instances
        );

    const instances =
        getSnapshotInstanceLines();

    if (!instances.length) {
        toast(
            "Enter at least one instance name or ID.",
            "error"
        );

        return;
    }

    const matchedInstances =
        instances
            .map(input => {
                const lower =
                    input.toLowerCase();

                return state.instances.find(
                    instance =>
                        String(
                            instance.instanceId ||
                            instance.instance_id ||
                            ""
                        )
                            .toLowerCase() ===
                            lower ||
                        String(
                            instance.name ||
                            instance.instanceName ||
                            ""
                        )
                            .toLowerCase() ===
                            lower
                );
            })
            .filter(Boolean);

    const uniqueMatchedInstances =
        deduplicateInstances(
            matchedInstances
        );

    const oversized =
        uniqueMatchedInstances.filter(
            instance =>
                isInstanceOverStorageLimit(
                    instance
                )
        );

    if (oversized.length) {
        alert(
            "Snapshot creation blocked.\n\n" +
            "One or more instances exceed the 2 TB limit."
        );

        return;
    }

    if (
        uniqueMatchedInstances.length !==
        instances.length
    ) {
        const matchedKeys =
            new Set(
                uniqueMatchedInstances.flatMap(
                    instance => [
                        String(
                            instance.instanceId ||
                            instance.instance_id ||
                            ""
                        ).toLowerCase(),

                        String(
                            instance.name ||
                            instance.instanceName ||
                            ""
                        ).toLowerCase()
                    ]
                )
            );

        const missing =
            instances.filter(
                input =>
                    !matchedKeys.has(
                        input.toLowerCase()
                    )
            );

        if (missing.length) {
            alert(
                "The following instance(s) were not found:\n\n" +
                missing.join("\n")
            );

            return;
        }
    }

    const description =
        $("snapshot-description")
            ?.value
            .trim() ||
        "";

    if (
        !confirm(
            `Create snapshots for ${uniqueMatchedInstances.length} unique instance(s)?`
        )
    ) {
        return;
    }

    const snapshotInstances =
        uniqueMatchedInstances.map(
            instance =>
                instance.instanceId ||
                instance.instance_id ||
                instance.name
        );

    try {
        setLoading(
            true,
            "Creating snapshots..."
        );

        const data =
            await api(
                "/api/aws/create-instance-snapshots",
                {
                    method: "POST",
                    body:
                        JSON.stringify({
                            ...getRequestBody(),

                            instances:
                                snapshotInstances,

                            description
                        })
                }
            );

        renderCreateResults(data);

        toast(
            `Snapshot job ${data.jobId || "started"} started.`,
            "success"
        );

        showPage(
            "snapshot-dashboard"
        );

    } catch (error) {
        console.error(
            "Snapshot creation failed:",
            error
        );

        toast(
            error?.message ||
            "Unable to create snapshots.",
            "error"
        );

    } finally {
        setLoading(false);
    }
}

function renderCreateResults(data) {
    const container =
        $("snapshot-result");

    if (!container) {
        return;
    }

    container.innerHTML = `
        <div class="success-box">

            <h3>
                Snapshot job started
            </h3>

            <p>
                Job ID:
                <strong>
                    ${escapeHtml(
                        data.jobId ||
                        "-"
                    )}
                </strong>
            </p>

            <p>
                Instances:
                <strong>
                    ${Number(
                        data.instanceCount ||
                        0
                    )}
                </strong>
            </p>

            <p>
                Volumes:
                <strong>
                    ${Number(
                        data.volumeCount ||
                        0
                    )}
                </strong>
            </p>

            <p>
                Snapshots:
                <strong>
                    ${Number(
                        data.snapshotCount ||
                        0
                    )}
                </strong>
            </p>

        </div>
    `;
}
/* =========================================================
   PAGE NAVIGATION
========================================================= */

function showPage(page) {
    if (!page) {
        page = "dashboard";
    }

    if (typeof portalAuthenticated !== "undefined" && !portalAuthenticated) {
        return;
    }

    if (page !== "snapshots") {
        stopSnapshotPolling();
    }

    if (page !== "snapshot-dashboard") {
        stopSnapshotDashboardPolling();
    }
    if (page !== "revert-dashboard") {
        stopRevertDashboardPolling();
    }

    const pages =
        document.querySelectorAll(".page");

    pages.forEach(element => {
        element.classList.toggle(
            "active",
            element.id === page
        );
    });

    document
        .querySelectorAll("[data-page]")
        .forEach(button => {
            button.classList.toggle(
                "active",
                button.dataset.page === page
            );
        });

    const titles = {
        dashboard:
            "Dashboard",

        instances:
            "Instances",

        volumes:
            "Volumes",

        snapshots:
            "Snapshots",

        "create-snapshot":
            "Create Snapshot",

        "snapshot-dashboard":
            "Snapshot Command Centre",

        "revert-dashboard":
            "Recovery Command Centre",

        "revert-snapshot":
            "Revert Snapshot"
    };

    if ($("page-title")) {
        $("page-title").textContent =
            titles[page] ||
            "AWS Snapshot Portal";
    }

    state.currentPage =
        page;

    if (page === "dashboard") {
        loadDashboard();
    }

    if (page === "instances") {
        loadInstances();
    }

    if (page === "volumes") {
        loadVolumes();
    }

    if (page === "snapshots") {
        loadSnapshots();
        startSnapshotPolling();
    }

    if (page === "create-snapshot") {
        loadInstancesForSnapshot();
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
        startRevertDashboardPolling();
    }
}


/* =========================================================
   SNAPSHOT DASHBOARD
========================================================= */

async function loadSnapshotDashboard() {
    try {
        const data =
            await api(
                "/api/snapshot-dashboard"
            );

        renderSnapshotDashboard(
            data
        );

        await syncRunningJobs(
            Array.isArray(data.jobs)
                ? data.jobs
                : []
        );

    } catch (error) {
        console.error(
            "Snapshot dashboard loading failed:",
            error
        );

        toast(
            error?.message ||
            "Unable to load snapshot jobs.",
            "error"
        );
    }
}

function renderSnapshotDashboard(data) {
    const summary =
        data.summary || {};

    if ($("sd-total-jobs")) {
        $("sd-total-jobs").textContent =
            Number(
                summary.total_jobs ||
                0
            );
    }

    if ($("sd-running-jobs")) {
        $("sd-running-jobs").textContent =
            Number(
                summary.running_jobs ||
                0
            );
    }

    if ($("sd-total-snapshots")) {
        $("sd-total-snapshots").textContent =
            Number(
                summary.total_snapshots ||
                0
            );
    }

    if ($("sd-completed-snapshots")) {
        $("sd-completed-snapshots").textContent =
            Number(
                summary.completed_snapshots ||
                0
            );
    }

    if ($("sd-failed-snapshots")) {
        $("sd-failed-snapshots").textContent =
            Number(
                summary.failed_snapshots ||
                0
            );
    }

    renderSnapshotJobs(
        Array.isArray(data.jobs)
            ? data.jobs
            : []
    );
}

function renderSnapshotJobs(jobs) {
    const container =
        $("snapshot-jobs-table");

    if (!container) {
        return;
    }

    if (!jobs.length) {
        container.innerHTML =
            `<div class="empty-state">
                No snapshot jobs found.
            </div>`;

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
                        <th>Retention</th>
                        <th>Snapshot end date</th>
                    </tr>

                </thead>

                <tbody>

                    ${jobs.map(job => `
                        <tr>

                            <td>

                                <button
                                    type="button"
                                    class="link-button job-details"
                                    data-job-id="${escapeHtml(
                                        job.job_id ||
                                        ""
                                    )}"
                                >
                                    ${escapeHtml(
                                        job.job_id ||
                                        "-"
                                    )}
                                </button>

                            </td>

                            <td>
                                ${escapeHtml(
                                    job.account_name ||
                                    "-"
                                )}
                            </td>

                            <td>
                                <strong>
                                    ${escapeHtml(
                                        job.region ||
                                        "-"
                                    )}
                                </strong>
                            </td>

                            <td>
                                <span class="status ${escapeHtml(
                                    job.status ||
                                    ""
                                )}">
                                    ${escapeHtml(
                                        job.status ||
                                        "-"
                                    )}
                                </span>
                            </td>

                            <td>
                                ${Number(
                                    job.total_instances ||
                                    0
                                )}
                            </td>

                            <td>
                                ${Number(
                                    job.total_volumes ||
                                    0
                                )}
                            </td>

                            <td>
                                ${Number(
                                    job.total_snapshots ||
                                    0
                                )}
                            </td>

                            <td>
                                ${Number(
                                    job.completed_snapshots ||
                                    0
                                )}
                            </td>

                            <td>
                                ${Number(
                                    job.failed_snapshots ||
                                    0
                                )}
                            </td>

                            <td>

                                <div class="progress">

                                    <div
                                        class="progress-bar"
                                        style="width:${Math.max(
                                            0,
                                            Math.min(
                                                100,
                                                Number(
                                                    job.progress ||
                                                    0
                                                )
                                            )
                                        )}%"
                                    ></div>

                                </div>

                                <small>
                                    ${Number(
                                        job.progress ||
                                        0
                                    ).toFixed(1)}%
                                </small>

                            </td>

                            <td>
                                ${escapeHtml(
                                    job.created_by ||
                                    "-"
                                )}
                            </td>

                            <td>
                                ${formatDate(job.started_at)}
                            </td>
                            <td>
                                ${escapeHtml(job.retention_days ? `${job.retention_days} days` : (job.retention_period || "-"))}
                            </td>
                            <td>
                                ${formatDate(job.expires_at || job.end_date || job.retention_end_date || (job.retention_days && job.started_at ? new Date(new Date(job.started_at).getTime() + Number(job.retention_days) * 86400000).toISOString() : null))}
                            </td>

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
    if (!jobId) {
        return;
    }

    try {
        const data =
            await api(
                `/api/snapshot-jobs/${encodeURIComponent(
                    jobId
                )}`
            );

        const job =
            data.job || {};

        const items =
            Array.isArray(data.items)
                ? data.items
                : [];

        const modal =
            $("job-details-modal");

        const content =
            $("job-details-content");

        if (!modal || !content) {
            return;
        }

        content.innerHTML = `
            <div class="job-summary">

                <h2>
                    ${escapeHtml(
                        job.job_id ||
                        jobId
                    )}
                </h2>

                <p>
                    Status:
                    <strong>
                        ${escapeHtml(
                            job.status ||
                            "-"
                        )}
                    </strong>
                </p>

                <p>
                    Progress:
                    <strong>
                        ${Number(
                            job.progress ||
                            0
                        ).toFixed(1)}%
                    </strong>
                </p>

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

                                <td>
                                    ${escapeHtml(
                                        item.instance_name ||
                                        "-"
                                    )}
                                </td>

                                <td>
                                    <code>
                                        ${escapeHtml(
                                            item.instance_id ||
                                            "-"
                                        )}
                                    </code>
                                </td>

                                <td>
                                    <code>
                                        ${escapeHtml(
                                            item.volume_id ||
                                            "-"
                                        )}
                                    </code>
                                </td>

                                <td>
                                    <code>
                                        ${escapeHtml(
                                            item.snapshot_id ||
                                            "-"
                                        )}
                                    </code>
                                </td>

                                <td>
                                    ${escapeHtml(
                                        item.status ||
                                        "-"
                                    )}
                                </td>

                                <td>
                                    ${Number(
                                        item.progress ||
                                        0
                                    )}%
                                </td>

                                <td>
                                    ${escapeHtml(
                                        item.error_message ||
                                        ""
                                    )}
                                </td>

                            </tr>
                        `).join("")}

                    </tbody>

                </table>

            </div>
        `;

        modal.classList.add("show");

    } catch (error) {
        console.error(
            "Unable to load job details:",
            error
        );

        toast(
            error?.message ||
            "Unable to load job details.",
            "error"
        );
    }
}

function closeJobDetails() {
    $("job-details-modal")
        ?.classList.remove("show");
}


/* =========================================================
   JOB SYNC / AUTO REFRESH
========================================================= */

async function syncRunningJobs(jobs) {
    const activeJobs =
        jobs.filter(
            job =>
                job?.status ===
                "running"
        );

    if (!activeJobs.length) {
        return;
    }

    const account =
        getActiveAccount();

    if (!account) {
        return;
    }

    for (const job of activeJobs) {
        if (
            job.account_name !==
            account.name
        ) {
            continue;
        }

        try {
            await api(
                `/api/snapshot-jobs/${encodeURIComponent(
                    job.job_id
                )}/sync`,
                {
                    method: "POST",
                    body:
                        JSON.stringify(
                            getRequestBody()
                        )
                }
            );

        } catch (error) {
            console.error(
                `Unable to sync ${job.job_id}`,
                error
            );
        }
    }
}

function startSnapshotDashboardPolling() {
    stopSnapshotDashboardPolling();

    state.snapshotDashboardTimer =
        setInterval(() => {
            if (
                state.currentPage ===
                "snapshot-dashboard"
            ) {
                loadSnapshotDashboard();
            }

        }, SNAPSHOT_DASHBOARD_POLL_INTERVAL);
}

function stopSnapshotDashboardPolling() {
    if (
        state.snapshotDashboardTimer
    ) {
        clearInterval(
            state.snapshotDashboardTimer
        );

        state.snapshotDashboardTimer =
            null;
    }
}


/* =========================================================
   EVENT LISTENERS
========================================================= */

function setupEventListeners() {

    /* -----------------------------------------------------
       PAGE NAVIGATION
    ----------------------------------------------------- */

    document
        .querySelectorAll("[data-page]")
        .forEach(button => {
            button.addEventListener(
                "click",
                () => {
                    showPage(
                        button.dataset.page
                    );
                }
            );
        });


    /* -----------------------------------------------------
       ACCOUNT
    ----------------------------------------------------- */

    $("account-select")
        ?.addEventListener(
            "change",
            switchAccount
        );

    $("region")
        ?.addEventListener(
            "change",
            regionChanged
        );

    $("open-credentials")
        ?.addEventListener(
            "click",
            openCredentials
        );

    $("close-credentials")
        ?.addEventListener(
            "click",
            closeCredentials
        );

    $("dashboard-add-account")
        ?.addEventListener(
            "click",
            openCredentials
        );

    $("account-add")
        ?.addEventListener(
            "click",
            saveAccount
        );

    $("account-cancel")
        ?.addEventListener(
            "click",
            closeCredentials
        );

    $("account-list")
        ?.addEventListener(
            "click",
            event => {
                const useButton =
                    event.target.closest(
                        ".account-use"
                    );

                const editButton =
                    event.target.closest(
                        ".account-edit"
                    );

                const removeButton =
                    event.target.closest(
                        ".account-remove"
                    );

                if (useButton) {
                    selectAccount(
                        useButton.dataset.accountId
                    );

                    return;
                }

                if (editButton) {
                    editAccount(
                        editButton.dataset.accountId
                    );

                    return;
                }

                if (removeButton) {
                    removeAccount(
                        removeButton.dataset.accountId
                    );
                }
            }
        );


    /* -----------------------------------------------------
       SEARCH
    ----------------------------------------------------- */

    $("instance-search")
        ?.addEventListener(
            "input",
            searchInstances
        );

    $("snapshot-search")
        ?.addEventListener(
            "input",
            searchSnapshots
        );


    /* -----------------------------------------------------
       DATA LOADING
    ----------------------------------------------------- */

    $("fetch-instances")
        ?.addEventListener(
            "click",
            loadInstances
        );

    $("fetch-volumes")
        ?.addEventListener(
            "click",
            loadVolumes
        );

    $("fetch-snapshots")
        ?.addEventListener(
            "click",
            loadSnapshots
        );

    $("refresh-dashboard")
        ?.addEventListener(
            "click",
            loadDashboard
        );

    $("refresh-snapshot-dashboard")
        ?.addEventListener(
            "click",
            loadSnapshotDashboard
        );


    /* -----------------------------------------------------
       CREATE SNAPSHOT
    ----------------------------------------------------- */

    $("snapshot-instances")
        ?.addEventListener(
            "input",
            previewSnapshotInstances
        );

    $("preview-instances")
        ?.addEventListener(
            "click",
            previewSnapshotInstances
        );

    $("create-snapshots")
        ?.addEventListener(
            "click",
            createSnapshotsFromInstances
        );


    /* -----------------------------------------------------
       SNAPSHOT REVERT
    ----------------------------------------------------- */

    $("revert-instance")
        ?.addEventListener(
            "change",
            event => {
                selectRevertInstance(
                    event.target.value
                );
            }
        );

    $("revert-volumes")
        ?.addEventListener(
            "change",
            event => {

                const snapshotSelect =
                    event.target.closest(
                        ".revert-snapshot-select"
                    );

                if (snapshotSelect) {
                    updateRevertSelection(
                        snapshotSelect.dataset.volumeId,
                        snapshotSelect.value
                    );

                    return;
                }

                const checkbox =
                    event.target.closest(
                        ".revert-volume-checkbox"
                    );

                if (checkbox) {
                    updateRevertCheckbox(
                        checkbox.dataset.volumeId,
                        checkbox.checked
                    );
                }
            }
        );

    /*
        IMPORTANT:
        The button now has its own unique ID:
        #revert-snapshot-button

        The page itself remains:
        #revert-snapshot
    */
    $("revert-snapshot-button")
        ?.addEventListener(
            "click",
            revertFromSnapshot
        );


    /* -----------------------------------------------------
       JOB DETAILS
    ----------------------------------------------------- */

    $("snapshot-jobs-table")
        ?.addEventListener(
            "click",
            event => {

                const button =
                    event.target.closest(
                        ".job-details"
                    );

                if (button) {
                    showJobDetails(
                        button.dataset.jobId
                    );
                }
            }
        );

    $("close-job-details")
        ?.addEventListener(
            "click",
            closeJobDetails
        );


    /* -----------------------------------------------------
       MODALS
    ----------------------------------------------------- */

    $("credential-modal")
        ?.addEventListener(
            "click",
            event => {
                if (
                    event.target ===
                    $("credential-modal")
                ) {
                    closeCredentials();
                }
            }
        );

    $("job-details-modal")
        ?.addEventListener(
            "click",
            event => {
                if (
                    event.target ===
                    $("job-details-modal")
                ) {
                    closeJobDetails();
                }
            }
        );
}


/* =========================================================
   GLOBAL ERROR HANDLING
========================================================= */

window.addEventListener(
    "error",
    event => {
        console.error(
            "Global JavaScript error:",
            event.error || event.message
        );
    }
);

window.addEventListener(
    "unhandledrejection",
    event => {
        console.error(
            "Unhandled promise rejection:",
            event.reason
        );
    }
);


/* =========================================================
   CLEANUP
========================================================= */

window.addEventListener(
    "beforeunload",
    () => {
        stopSnapshotPolling();
        stopSnapshotDashboardPolling();
    }
);


/* =========================================================
   INITIALIZATION
========================================================= */

document.addEventListener(
    "DOMContentLoaded",
    () => {
        console.log(
            "AWS Snapshot Portal initializing..."
        );

        try {
            loadAccounts();

            updateAccountSelector();

            updateRegionFromAccount();

            updateSelectedAccountUI();

            updateVolumeTotals();

            setupEventListeners();

            showPage(
                "dashboard"
            );

            console.log(
                "AWS Snapshot Portal ready."
            );

        } catch (error) {
            console.error(
                "FATAL APPLICATION INITIALIZATION ERROR:",
                error
            );

            const message =
                error?.message ||
                "Unknown initialization error.";

            toast(
                `Application initialization failed: ${message}`,
                "error"
            );

            /*
                Ensure the user does not get a completely
                blank application if initialization fails.
            */
            document
                .querySelectorAll(".page")
                .forEach(page => {
                    page.classList.remove(
                        "active"
                    );
                });

            const dashboard =
                $("dashboard");

            if (dashboard) {
                dashboard.classList.add(
                    "active"
                );
            }

            const dashboardMessage =
                $("dashboard-message");

            if (dashboardMessage) {
                dashboardMessage.textContent =
                    `Application error: ${message}`;
            }
        }
    }
);
/* =========================================================
   SNAPSHOT REVERT DASHBOARD
   =========================================================

   Expected API:

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
               "status": "completed",
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
       "job": {
           "job_id": "revert-123",
           "status": "completed",
           "reverted_by": "john.doe",
           "account_name": "Production",
           "region": "us-east-1",
           "instance_name": "web-server-01",
           "instance_id": "i-0123456789",
           "started_at": "...",
           "completed_at": "..."
       },

       "items": [
           {
               "original_volume_id": "vol-old",
               "snapshot_id": "snap-123",
               "new_volume_id": "vol-new",
               "instance_name": "web-server-01",
               "size": 100,
               "status": "completed",
               "error_message": "",
               "reverted_by": "john.doe",
               "reverted_at": "2026-08-31T10:04:00Z"
           }
       ]
   }
*/


/* =========================================================
   CONFIGURATION
========================================================= */

const REVERT_DASHBOARD_POLL_INTERVAL = 15000;

let revertDashboardTimer = null;


/* =========================================================
   HTML ESCAPING
========================================================= */

function revertDashboardEscapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}


/* =========================================================
   DATE FORMAT
========================================================= */

function revertDashboardFormatDate(value) {

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
   STATUS CLASS
========================================================= */

function revertDashboardStatusClass(status) {

    const normalized =
        String(status || "")
            .toLowerCase()
            .replaceAll("_", "-");

    if (
        normalized === "completed" ||
        normalized === "success" ||
        normalized === "succeeded"
    ) {
        return "completed";
    }

    if (
        normalized === "running" ||
        normalized === "in-progress" ||
        normalized === "pending"
    ) {
        return "running";
    }

    if (
        normalized === "failed" ||
        normalized === "error"
    ) {
        return "failed";
    }

    return normalized;
}


/* =========================================================
   LOAD DASHBOARD
========================================================= */

async function loadRevertDashboard() {

    const container =
        document.getElementById(
            "revert-jobs-table"
        );

    if (!container) {
        return;
    }

    try {

        container.innerHTML = `
            <div class="revert-dashboard-loading">
                Loading revert history...
            </div>
        `;

        const response =
            await fetch(
                "/api/revert-dashboard",
                {
                    method: "GET",
                    headers: {
                        "Accept": "application/json",
                        ...(portalSessionToken ? { "Authorization": `Bearer ${portalSessionToken}` } : {})
                    }
                }
            );

        if (!response.ok) {
            if (response.status === 401) portalLogout("Your portal session expired. Sign in again.");
            throw new Error(
                `HTTP ${response.status}`
            );
        }

        const data =
            await response.json();

        renderRevertDashboard(
            data
        );

    } catch (error) {

        console.error(
            "Revert dashboard error:",
            error
        );

        container.innerHTML = `
            <div class="revert-dashboard-error">

                <strong>
                    Unable to load revert history
                </strong>

                <p>
                    ${revertDashboardEscapeHtml(
                        error.message ||
                        "Unknown error"
                    )}
                </p>

                <button
                    type="button"
                    class="revert-dashboard-btn"
                    onclick="loadRevertDashboard()"
                >
                    Retry
                </button>

            </div>
        `;
    }
}


/* =========================================================
   RENDER DASHBOARD
========================================================= */

function renderRevertDashboard(data) {

    const summary =
        data?.summary || {};

    const jobs =
        Array.isArray(data?.jobs)
            ? data.jobs
            : [];


    updateRevertDashboardSummary(
        summary
    );

    renderRevertDashboardJobs(
        jobs
    );
}


/* =========================================================
   SUMMARY
========================================================= */

function updateRevertDashboardSummary(summary) {

    const total =
        document.getElementById(
            "rd-total-jobs"
        );

    const running =
        document.getElementById(
            "rd-running-jobs"
        );

    const completed =
        document.getElementById(
            "rd-completed-jobs"
        );

    const failed =
        document.getElementById(
            "rd-failed-jobs"
        );

    const volumes =
        document.getElementById(
            "rd-total-volumes"
        );


    if (total) {
        total.textContent =
            Number(
                summary.total_jobs || 0
            );
    }

    if (running) {
        running.textContent =
            Number(
                summary.running_jobs || 0
            );
    }

    if (completed) {
        completed.textContent =
            Number(
                summary.completed_jobs || 0
            );
    }

    if (failed) {
        failed.textContent =
            Number(
                summary.failed_jobs || 0
            );
    }

    if (volumes) {
        volumes.textContent =
            Number(
                summary.total_volumes || 0
            );
    }
}


/* =========================================================
   RENDER JOB TABLE
========================================================= */

function renderRevertDashboardJobs(jobs) {

    const container =
        document.getElementById(
            "revert-jobs-table"
        );

    if (!container) {
        return;
    }


    if (!jobs.length) {

        container.innerHTML = `
            <div class="revert-dashboard-empty">

                <div class="revert-dashboard-empty-icon">
                    ↻
                </div>

                <h3>
                    No revert activity
                </h3>

                <p>
                    No snapshot revert operations have been recorded yet.
                </p>

            </div>
        `;

        return;
    }


    container.innerHTML = `

        <div class="revert-table-wrapper">

            <table class="revert-dashboard-table">

                <thead>

                    <tr>

                        <th>
                            Job ID
                        </th>

                        <th>
                            Status
                        </th>

                        <th>
                            Reverted By
                        </th>

                        <th>
                            Account
                        </th>

                        <th>
                            Region
                        </th>

                        <th>
                            Instance
                        </th>

                        <th>
                            Instance ID
                        </th>

                        <th>
                            Volumes
                        </th>

                        <th>
                            Snapshots
                        </th>

                        <th>
                            Started
                        </th>

                        <th>
                            Completed
                        </th>

                    </tr>

                </thead>


                <tbody>

                    ${jobs.map(job => {

                        const statusClass =
                            revertDashboardStatusClass(
                                job.status
                            );

                        return `

                            <tr>

                                <td>

                                    <button
                                        type="button"
                                        class="revert-job-link"
                                        data-job-id="${revertDashboardEscapeHtml(
                                            job.job_id || ""
                                        )}"
                                    >
                                        ${revertDashboardEscapeHtml(
                                            job.job_id || "-"
                                        )}
                                    </button>

                                </td>


                                <td>

                                    <span
                                        class="revert-status ${revertDashboardEscapeHtml(
                                            statusClass
                                        )}"
                                    >

                                        <span class="revert-status-dot"></span>

                                        ${revertDashboardEscapeHtml(
                                            job.status || "-"
                                        )}

                                    </span>

                                </td>


                                <td>

                                    <div class="reverted-by">

                                        <span class="user-icon">
                                            👤
                                        </span>

                                        <strong>
                                            ${revertDashboardEscapeHtml(
                                                job.reverted_by ||
                                                job.created_by ||
                                                job.username ||
                                                "-"
                                            )}
                                        </strong>

                                    </div>

                                </td>


                                <td>
                                    ${revertDashboardEscapeHtml(
                                        job.account_name || "-"
                                    )}
                                </td>


                                <td>
                                    ${revertDashboardEscapeHtml(
                                        job.region || "-"
                                    )}
                                </td>


                                <td>
                                    <strong>
                                        ${revertDashboardEscapeHtml(
                                            job.instance_name || "-"
                                        )}
                                    </strong>
                                </td>


                                <td>

                                    <code>
                                        ${revertDashboardEscapeHtml(
                                            job.instance_id || "-"
                                        )}
                                    </code>

                                </td>


                                <td>
                                    ${Number(
                                        job.total_volumes || 0
                                    )}
                                </td>


                                <td>
                                    ${Number(
                                        job.total_snapshots || 0
                                    )}
                                </td>


                                <td>
                                    ${revertDashboardFormatDate(
                                        job.started_at ||
                                        job.created_at
                                    )}
                                </td>


                                <td>
                                    ${revertDashboardFormatDate(
                                        job.completed_at
                                    )}
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
   JOB DETAILS
========================================================= */

async function showRevertJobDetails(jobId) {

    if (!jobId) {
        return;
    }

    const modal =
        document.getElementById(
            "revert-job-details-modal"
        );

    const content =
        document.getElementById(
            "revert-job-details-content"
        );

    if (!modal || !content) {
        return;
    }


    modal.classList.add("show");

    content.innerHTML = `
        <div class="revert-dashboard-loading">
            Loading revert details...
        </div>
    `;


    try {

        const response =
            await fetch(
                `/api/revert-jobs/${encodeURIComponent(
                    jobId
                )}`,
                {
                    method: "GET",
                    headers: {
                        "Accept": "application/json",
                        ...(portalSessionToken ? { "Authorization": `Bearer ${portalSessionToken}` } : {})
                    }
                }
            );


        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}`
            );
        }


        const data =
            await response.json();


        renderRevertJobDetails(
            data
        );


    } catch (error) {

        console.error(
            "Revert job details error:",
            error
        );

        content.innerHTML = `
            <div class="revert-dashboard-error">

                <strong>
                    Unable to load revert details
                </strong>

                <p>
                    ${revertDashboardEscapeHtml(
                        error.message ||
                        "Unknown error"
                    )}
                </p>

            </div>
        `;
    }
}


/* =========================================================
   RENDER JOB DETAILS
========================================================= */

function renderRevertJobDetails(data) {

    const job =
        data?.job || {};

    const items =
        Array.isArray(data?.items)
            ? data.items
            : [];

    const content =
        document.getElementById(
            "revert-job-details-content"
        );

    if (!content) {
        return;
    }


    const revertedBy =
        job.reverted_by ||
        job.created_by ||
        job.username ||
        "-";


    content.innerHTML = `

        <div class="revert-detail-header">

            <div>

                <span class="revert-detail-label">
                    Revert Job
                </span>

                <h2>
                    ${revertDashboardEscapeHtml(
                        job.job_id || "-"
                    )}
                </h2>

            </div>


            <span class="revert-status ${revertDashboardEscapeHtml(
                revertDashboardStatusClass(
                    job.status
                )
            )}">

                <span class="revert-status-dot"></span>

                ${revertDashboardEscapeHtml(
                    job.status || "-"
                )}

            </span>

        </div>


        <div class="revert-audit-grid">

            <div class="revert-audit-item">

                <span>
                    Reverted By
                </span>

                <strong>
                    👤
                    ${revertDashboardEscapeHtml(
                        revertedBy
                    )}
                </strong>

            </div>


            <div class="revert-audit-item">

                <span>
                    Account
                </span>

                <strong>
                    ${revertDashboardEscapeHtml(
                        job.account_name || "-"
                    )}
                </strong>

            </div>


            <div class="revert-audit-item">

                <span>
                    Region
                </span>

                <strong>
                    ${revertDashboardEscapeHtml(
                        job.region || "-"
                    )}
                </strong>

            </div>


            <div class="revert-audit-item">

                <span>
                    Instance
                </span>

                <strong>
                    ${revertDashboardEscapeHtml(
                        job.instance_name || "-"
                    )}
                </strong>

            </div>


            <div class="revert-audit-item">

                <span>
                    Instance ID
                </span>

                <code>
                    ${revertDashboardEscapeHtml(
                        job.instance_id || "-"
                    )}
                </code>

            </div>


            <div class="revert-audit-item">

                <span>
                    Started
                </span>

                <strong>
                    ${revertDashboardFormatDate(
                        job.started_at ||
                        job.created_at
                    )}
                </strong>

            </div>


            <div class="revert-audit-item">

                <span>
                    Completed
                </span>

                <strong>
                    ${revertDashboardFormatDate(
                        job.completed_at
                    )}
                </strong>

            </div>

        </div>


        <div class="revert-resources">

            <div class="revert-resources-header">

                <div>

                    <span class="revert-detail-label">
                        What Was Reverted
                    </span>

                    <h3>
                        Snapshot Restore Operations
                    </h3>

                </div>

                <span>
                    ${items.length}
                    volume(s)
                </span>

            </div>


            ${
                items.length
                    ? `
                        <div class="revert-table-wrapper">

                            <table class="revert-dashboard-table">

                                <thead>

                                    <tr>

                                        <th>
                                            Original Volume
                                        </th>

                                        <th>
                                            Snapshot Used
                                        </th>

                                        <th>
                                            New Volume
                                        </th>

                                        <th>
                                            Instance
                                        </th>

                                        <th>
                                            Size
                                        </th>

                                        <th>
                                            Status
                                        </th>

                                        <th>
                                            Reverted By
                                        </th>

                                        <th>
                                            Reverted At
                                        </th>

                                        <th>
                                            Error
                                        </th>

                                    </tr>

                                </thead>


                                <tbody>

                                    ${items.map(item => {

                                        const statusClass =
                                            revertDashboardStatusClass(
                                                item.status
                                            );

                                        return `

                                            <tr>

                                                <td>

                                                    <code>
                                                        ${revertDashboardEscapeHtml(
                                                            item.original_volume_id ||
                                                            item.source_volume_id ||
                                                            "-"
                                                        )}
                                                    </code>

                                                </td>


                                                <td>

                                                    <code>
                                                        ${revertDashboardEscapeHtml(
                                                            item.snapshot_id ||
                                                            "-"
                                                        )}
                                                    </code>

                                                </td>


                                                <td>

                                                    <code>
                                                        ${revertDashboardEscapeHtml(
                                                            item.new_volume_id ||
                                                            item.restored_volume_id ||
                                                            "-"
                                                        )}
                                                    </code>

                                                </td>


                                                <td>

                                                    ${revertDashboardEscapeHtml(
                                                        item.instance_name ||
                                                        job.instance_name ||
                                                        "-"
                                                    )}

                                                </td>


                                                <td>

                                                    ${
                                                        item.size
                                                            ? `${Number(
                                                                item.size
                                                            )} GB`
                                                            : "-"
                                                    }

                                                </td>


                                                <td>

                                                    <span
                                                        class="revert-status ${revertDashboardEscapeHtml(
                                                            statusClass
                                                        )}"
                                                    >

                                                        <span class="revert-status-dot"></span>

                                                        ${revertDashboardEscapeHtml(
                                                            item.status ||
                                                            "-"
                                                        )}

                                                    </span>

                                                </td>


                                                <td>

                                                    ${revertDashboardEscapeHtml(
                                                        item.reverted_by ||
                                                        revertedBy
                                                    )}

                                                </td>


                                                <td>

                                                    ${revertDashboardFormatDate(
                                                        item.reverted_at ||
                                                        job.completed_at
                                                    )}

                                                </td>


                                                <td>

                                                    <span class="revert-error-text">

                                                        ${revertDashboardEscapeHtml(
                                                            item.error_message ||
                                                            item.error ||
                                                            "-"
                                                        )}

                                                    </span>

                                                </td>

                                            </tr>

                                        `;

                                    }).join("")}

                                </tbody>

                            </table>

                        </div>
                    `
                    : `
                        <div class="revert-dashboard-empty small">
                            No volume details were recorded for this job.
                        </div>
                    `
            }

        </div>

    `;
}


/* =========================================================
   CLOSE DETAILS
========================================================= */

function closeRevertJobDetails() {

    const modal =
        document.getElementById(
            "revert-job-details-modal"
        );

    if (modal) {
        modal.classList.remove("show");
    }
}


/* =========================================================
   EVENT LISTENERS
========================================================= */

function setupRevertDashboardListeners() {

    const table =
        document.getElementById(
            "revert-jobs-table"
        );


    if (table) {

        table.addEventListener(
            "click",
            event => {

                const button =
                    event.target.closest(
                        ".revert-job-link"
                    );

                if (!button) {
                    return;
                }

                showRevertJobDetails(
                    button.dataset.jobId
                );
            }
        );

    }


    const refreshButton =
        document.getElementById(
            "refresh-revert-dashboard"
        );


    if (refreshButton) {

        refreshButton.addEventListener(
            "click",
            () => {
                loadRevertDashboard();
            }
        );

    }


    const closeButton =
        document.getElementById(
            "close-revert-job-details"
        );


    if (closeButton) {

        closeButton.addEventListener(
            "click",
            closeRevertJobDetails
        );

    }


    const modal =
        document.getElementById(
            "revert-job-details-modal"
        );


    if (modal) {

        modal.addEventListener(
            "click",
            event => {

                if (
                    event.target === modal
                ) {
                    closeRevertJobDetails();
                }

            }
        );

    }

}


/* =========================================================
   POLLING
========================================================= */

function startRevertDashboardPolling() {

    stopRevertDashboardPolling();

    loadRevertDashboard();


    revertDashboardTimer =
        setInterval(
            () => {

                loadRevertDashboard();

            },
            REVERT_DASHBOARD_POLL_INTERVAL
        );
}


function stopRevertDashboardPolling() {

    if (revertDashboardTimer) {

        clearInterval(
            revertDashboardTimer
        );

        revertDashboardTimer = null;
    }
}


/* =========================================================
   INITIALIZE
========================================================= */

document.addEventListener(
    "DOMContentLoaded",
    () => {

        setupRevertDashboardListeners();

        /*
         * Do not automatically start polling unless
         * the dashboard exists on the current page.
         *
         * If you have a SPA router, call:
         *
         * startRevertDashboardPolling()
         *
         * when the revert-dashboard page is opened.
         */

        const dashboard =
            document.getElementById(
                "revert-dashboard"
            );

        if (
            dashboard &&
            dashboard.classList.contains("active")
        ) {
            startRevertDashboardPolling();
        }

    }
);
/* =========================================================
   SNAPSHOT REVERT DASHBOARD
========================================================= */

async function loadInstancesForSnapshot() {
    const account = getActiveAccount();
    const select = $("snapshot-instance-select") || $("create-snapshot-instance-select");

    if (!select) return;

    if (!account) {
        select.innerHTML = '<option value="">Connect an AWS account first</option>';
        return;
    }

    try {
        setLoading(true, "Loading instances for snapshot creation...");
        const data = await api("/api/aws/instances", {
            method: "POST",
            body: JSON.stringify(getRequestBody())
        });

        state.instances = deduplicateInstances(data.instances || []);

        select.innerHTML = '<option value="">-- Select Instance --</option>';
        state.instances.forEach(instance => {
            const instanceId = instance.instanceId || instance.instance_id || "";
            const instanceName = instance.name || instance.instanceName || "Unnamed";
            const option = document.createElement("option");
            option.value = instanceId;
            option.textContent = `${instanceName} (${instanceId})`;
            select.appendChild(option);
        });
    } catch (error) {
        console.error("Failed to load instances for snapshot:", error);
        toast(error?.message || "Unable to load instances.", "error");
    } finally {
        setLoading(false);
    }
}

async function loadInstancesForRevert() {
    const account = getActiveAccount();
    const select = $("restore-instance-select") || $("revert-instance-select");

    if (!select) return;

    if (!account) {
        select.innerHTML = '<option value="">Connect an AWS account first</option>';
        return;
    }

    try {
        setLoading(true, "Loading instances for revert dashboard...");
        const [instancesRes, volumesRes, snapshotsRes] = await Promise.all([
            api("/api/aws/instances", { method: "POST", body: JSON.stringify(getRequestBody()) }),
            api("/api/aws/volumes", { method: "POST", body: JSON.stringify(getRequestBody()) }),
            api("/api/aws/snapshots", { method: "POST", body: JSON.stringify(getRequestBody()) })
        ]);

        state.instances = deduplicateInstances(instancesRes.instances || []);
        state.volumes = Array.isArray(volumesRes.volumes) ? volumesRes.volumes : [];
        state.snapshots = Array.isArray(snapshotsRes.snapshots) ? snapshotsRes.snapshots : [];

        select.innerHTML = '<option value="">-- Select Instance to Revert --</option>';
        state.instances.forEach(instance => {
            const instanceId = instance.instanceId || instance.instance_id || "";
            const instanceName = instance.name || instance.instanceName || "Unnamed";
            const option = document.createElement("option");
            option.value = instanceId;
            option.textContent = `${instanceName} (${instanceId})`;
            select.appendChild(option);
        });

        updateVolumeTotals();
    } catch (error) {
        console.error("Failed to load revert dashboard data:", error);
        toast(error?.message || "Unable to load revert dashboard.", "error");
    } finally {
        setLoading(false);
    }
}

async function handleRevertInstanceSelection(instanceId) {
    if (!instanceId) {
        state.revert.instance = null;
        state.revert.volumes = [];
        state.revert.snapshots = [];
        state.revert.selectedSnapshots = {};
        renderRevertDashboardDetails();
        return;
    }

    const instance = state.instances.find(
        i => String(i.instanceId || i.instance_id || "").trim() === instanceId
    );

    if (!instance) return;

    state.revert.instance = instance;
    state.revert.volumes = state.volumes.filter(
        v => String(v?.attachedInstance || v?.instanceId || "").trim() === instanceId
    );

    // Map snapshots matching instance volumes
    const volumeIds = new Set(state.revert.volumes.map(v => v.volumeId || v.volume_id));
    state.revert.snapshots = state.snapshots.filter(s => volumeIds.has(s.volumeId || s.volume_id));

    // Auto-select the latest snapshot per volume
    state.revert.selectedSnapshots = {};
    state.revert.volumes.forEach(vol => {
        const volId = vol.volumeId || vol.volume_id;
        const volSnaps = state.revert.snapshots.filter(s => (s.volumeId || s.volume_id) === volId);

        if (volSnaps.length > 0) {
            // Sort by start/creation time descending
            volSnaps.sort((a, b) => new Date(b.startTime || b.start_time || 0) - new Date(a.startTime || a.start_time || 0));
            state.revert.selectedSnapshots[volId] = volSnaps[0].snapshotId || volSnaps[0].snapshot_id;
        }
    });

    renderRevertDashboardDetails();
}

function renderRevertDashboardDetails() {
    const container = $("revert-dashboard-container") || $("revert-details");
    if (!container) return;

    const instance = state.revert.instance;
    if (!instance) {
        container.innerHTML = `<div class="muted">Select an instance to configure snapshot revert options.</div>`;
        return;
    }

    const volumesHtml = state.revert.volumes.map(vol => {
        const volId = vol.volumeId || vol.volume_id;
        const volSnaps = state.revert.snapshots.filter(s => (s.volumeId || s.volume_id) === volId);
        const selectedSnapId = state.revert.selectedSnapshots[volId];

        const optionsHtml = volSnaps.map(snap => {
            const snapId = snap.snapshotId || snap.snapshot_id;
            const snapDate = formatDate(snap.startTime || snap.start_time);
            const isSelected = snapId === selectedSnapId ? "selected" : "";
            return `<option value="${escapeHtml(snapId)}" ${isSelected}>${escapeHtml(snapId)} (${escapeHtml(snap.description || snapDate)})</option>`;
        }).join("");

        return `
            <div class="revert-volume-row">
                <div>
                    <strong>Volume:</strong> ${escapeHtml(volId)} (${escapeHtml(vol.size || 0)} GB)
                </div>
                <div>
                    <label>Select Snapshot to Revert:</label>
                    <select class="volume-snapshot-select" data-volume-id="${escapeHtml(volId)}" onchange="updateSelectedVolumeSnapshot('${escapeHtml(volId)}', this.value)">
                        <option value="">-- No Snapshot Available --</option>
                        ${optionsHtml}
                    </select>
                </div>
            </div>
        `;
    }).join("");

    container.innerHTML = `
        <div class="revert-summary-card">
            <h4>Target Instance: ${escapeHtml(instance.name || instance.instanceName || instance.instanceId)}</h4>
            <p><strong>Instance ID:</strong> ${escapeHtml(instance.instanceId || instance.instance_id)}</p>
            <p><strong>State:</strong> ${escapeHtml(instance.state || instance.status || "running")}</p>
            <hr />
            <h5>Attached Volumes & Snapshots</h5>
            ${volumesHtml || '<p class="muted">No attached volumes found for this instance.</p>'}
            <button type="button" class="btn-primary" onclick="executeSnapshotRevert()" ${state.revert.restoring ? 'disabled' : ''}>
                ${state.revert.restoring ? 'Restoring...' : 'Execute Snapshot Revert'}
            </button>
        </div>
    `;
}

function updateSelectedVolumeSnapshot(volumeId, snapshotId) {
    if (!volumeId) return;
    state.revert.selectedSnapshots[volumeId] = snapshotId;
}

async function executeSnapshotRevert() {
    const instance = state.revert.instance;
    if (!instance) {
        toast("No instance selected for revert.", "error");
        return;
    }

    if (Object.keys(state.revert.selectedSnapshots).length === 0) {
        toast("Please select at least one snapshot to restore.", "error");
        return;
    }

    if (!confirm(`Are you sure you want to revert volumes for instance ${instance.instanceId || instance.instance_id}? This operation may overwrite existing data.`)) {
        return;
    }

    try {
        state.revert.restoring = true;
        renderRevertDashboardDetails();
        setLoading(true, "Initiating snapshot revert process...");

        const requestPayload = {
            ...getRequestBody(),
            instanceId: instance.instanceId || instance.instance_id,
            restores: state.revert.selectedSnapshots
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
        renderRevertDashboardDetails();
    }
}

/* =========================================================
   CLEANUP
========================================================= */

window.addEventListener(
    "beforeunload",
    () => {
        stopRevertDashboardPolling();
    }
);


/* =========================================================
   SECURE ACCESS-KEY LOGIN + SESSION GUARD
   Backend contract required:
   POST /api/auth/aws-login
   { accountName, accessKeyId, secretAccessKey, sessionToken, region }
   -> { success:true, identity:{accountId,arn,userId}, credentialsExpireAt?:ISO }
   The backend must validate using AWS STS GetCallerIdentity and must
   never persist or log the supplied secret credentials.
========================================================= */
let portalAuthenticated = false;
let portalSessionToken = null;
let portalSessionExpiry = null;
let portalExpiryTimer = null;
let portalIdleTimer = null;
let portalWarningShown = false;
const PORTAL_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const PORTAL_EXPIRY_POLL_MS = 30 * 1000;

function portalSetLoginError(message) {
    const el = $("login-error");
    if (el) el.textContent = message || "";
}
function portalShowLogin() {
    portalAuthenticated = false;
    const shell = $("app-shell");
    const login = $("access-login");
    if (shell) shell.hidden = true;
    if (login) login.classList.remove("is-hidden");
    document.body.classList.add("login-mode");
}
function portalShowApplication() {
    const shell = $("app-shell");
    const login = $("access-login");
    if (shell) shell.hidden = false;
    if (login) login.classList.add("is-hidden");
    document.body.classList.remove("login-mode");
}
function portalSetSessionIndicator(message, warning = false) {
    const el = $("session-status");
    if (!el) return;
    el.innerHTML = `<span class="${warning ? "warning-dot" : "live-dot"}"></span><span>${escapeHtml(message)}</span>`;
    el.classList.toggle("is-warning", warning);
}
function portalClearSecretsFromStorage() {
    try {
        const safeAccounts = (state.accounts || []).map(a => ({
            id: a.id, name: a.name, region: a.region,
            accessKeyHint: a.accessKeyId ? `${String(a.accessKeyId).slice(0,4)}••••` : "",
            credentialsExpireAt: a.credentialsExpireAt || null
        }));
        sessionStorage.setItem("awsSnapshotAccounts", JSON.stringify(safeAccounts));
        sessionStorage.setItem("awsSnapshotActiveAccount", state.activeAccountId || "");
    } catch (e) {
        console.warn("Could not persist account labels.", e);
    }
}
function portalResetIdleTimer() {
    if (!portalAuthenticated) return;
    clearTimeout(portalIdleTimer);
    portalIdleTimer = setTimeout(() => portalLogout("Your portal session expired after 15 minutes of inactivity. Sign in again."), PORTAL_IDLE_TIMEOUT_MS);
}
function portalStartSessionMonitor() {
    clearInterval(portalExpiryTimer);
    ["click", "keydown", "mousemove", "touchstart"].forEach(evt =>
        document.addEventListener(evt, portalResetIdleTimer, { passive: true })
    );
    portalResetIdleTimer();
    portalExpiryTimer = setInterval(() => {
        if (!portalAuthenticated || !portalSessionExpiry) return;
        const remaining = new Date(portalSessionExpiry).getTime() - Date.now();
        if (remaining <= 0) {
            portalLogout("Your temporary AWS credentials have expired. Authenticate again.");
        } else if (remaining <= 5 * 60 * 1000) {
            const mins = Math.max(1, Math.ceil(remaining / 60000));
            portalSetSessionIndicator(`AWS credentials expire in ${mins} min`, true);
            if (!portalWarningShown) {
                toast(`AWS temporary credentials expire in approximately ${mins} minutes. Re-authenticate to avoid interruption.`, "error");
                portalWarningShown = true;
            }
        } else if (remaining <= 15 * 60 * 1000) {
            portalSetSessionIndicator(`AWS credentials expire in ${Math.ceil(remaining / 60000)} min`, true);
        } else {
            portalSetSessionIndicator("AWS session active");
        }
    }, PORTAL_EXPIRY_POLL_MS);
}
function portalLogout(message = "You have signed out.") {
    portalAuthenticated = false;
    portalSessionToken = null;
    clearInterval(portalExpiryTimer);
    clearTimeout(portalIdleTimer);
    portalExpiryTimer = null;
    portalIdleTimer = null;
    portalSessionExpiry = null;
    portalWarningShown = false;
    state.accounts = [];
    state.activeAccountId = null;
    clearAwsData();
    try {
        sessionStorage.removeItem("awsSnapshotAccounts");
        sessionStorage.removeItem("awsSnapshotActiveAccount");
    } catch (_) {}
    ["login-access-key", "login-secret-key", "login-session-token", "login-credentials-expiry"].forEach(id => { if ($(id)) $(id).value = ""; });
    portalShowLogin();
    portalSetLoginError(message);
}
async function portalAwsLogin(event) {
    event.preventDefault();
    portalSetLoginError("");
    const submit = $("aws-login-submit");
    const accountName = $("login-account-name")?.value.trim();
    const accessKeyId = $("login-access-key")?.value.trim();
    const secretAccessKey = $("login-secret-key")?.value;
    const sessionToken = $("login-session-token")?.value.trim() || "";
    const region = $("login-region")?.value || "us-east-1";
    const expiryInput = $("login-credentials-expiry")?.value || "";
    const credentialsExpireAt = expiryInput ? new Date(expiryInput).toISOString() : null;
    if (!accountName || !accessKeyId || !secretAccessKey) {
        portalSetLoginError("Enter an account label, access key ID and secret access key.");
        return;
    }
    if (submit) { submit.disabled = true; submit.classList.add("is-loading"); }
    try {
        const response = await fetch("/api/auth/aws-login", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({ accountName, accessKeyId, secretAccessKey, sessionToken, region, credentialsExpireAt })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success === false) {
            throw new Error(data.error || data.message || `Authentication failed (HTTP ${response.status}).`);
        }
        if (!data.identity || !data.identity.accountId) {
            throw new Error("The authentication service did not return an AWS account identity. Verify the /api/auth/aws-login backend response.");
        }
        portalSessionToken = data.sessionToken || null;
        if (!portalSessionToken) throw new Error("The authentication service did not return a portal session token.");
        const account = {
            id: data.identity.accountId,
            name: accountName,
            accessKeyId, secretAccessKey, sessionToken, region,
            awsAccountId: data.identity.accountId,
            awsArn: data.identity.arn || "",
            credentialsExpireAt: data.credentialsExpireAt || data.expiration || null
        };
        state.accounts = [account];
        state.activeAccountId = account.id;
        portalSessionExpiry = account.credentialsExpireAt;
        portalAuthenticated = true;
        portalClearSecretsFromStorage();
        updateAccountSelector();
        updateRegionFromAccount();
        updateSelectedAccountUI();
        renderAccountList();
        portalShowApplication();
        portalStartSessionMonitor();
        portalSetSessionIndicator("AWS account verified");
        toast(`Authenticated to AWS account ${account.awsAccountId}.`, "success");
        showPage("dashboard");
    } catch (error) {
        console.error("AWS access-key login failed:", error);
        portalSetLoginError(error.message || "Unable to authenticate with AWS.");
    } finally {
        if (submit) { submit.disabled = false; submit.classList.remove("is-loading"); }
    }
}

/* Keep secret credentials in memory only; browser storage receives labels/hints. */
function saveAccounts() { portalClearSecretsFromStorage(); }
function loadAccounts() {
    state.accounts = [];
    state.activeAccountId = null;
    try {
        sessionStorage.removeItem("awsSnapshotAccounts");
        sessionStorage.removeItem("awsSnapshotActiveAccount");
    } catch (_) {}
}

/* Global dashboard filters */
function portalApplySnapshotJobFilter() {
    const q = ($("snapshot-job-search")?.value || "").toLowerCase().trim();
    let visible = 0;
    document.querySelectorAll("#snapshot-jobs-table tbody tr").forEach(row => {
        const match = !q || row.textContent.toLowerCase().includes(q);
        row.hidden = !match;
        if (match) visible++;
    });
    if ($("snapshot-job-count")) $("snapshot-job-count").textContent = `${visible} matching jobs`;
}
function portalApplyRevertJobFilter() {
    const q = ($("revert-job-search")?.value || "").toLowerCase().trim();
    let visible = 0;
    document.querySelectorAll("#revert-jobs-table tbody tr").forEach(row => {
        const match = !q || row.textContent.toLowerCase().includes(q);
        row.hidden = !match;
        if (match) visible++;
    });
    if ($("revert-job-count")) $("revert-job-count").textContent = `${visible} restore jobs`;
}

/* The revert dashboard uses the existing /api/revert-dashboard contract. */
const _portalOriginalRenderRevertDashboard = renderRevertDashboard;
function renderRevertDashboard(data) {
    _portalOriginalRenderRevertDashboard(data);
    portalApplyRevertJobFilter();
}
const _portalOriginalRenderSnapshotJobs = renderSnapshotJobs;
function renderSnapshotJobs(jobs) {
    _portalOriginalRenderSnapshotJobs(jobs);
    portalApplySnapshotJobFilter();
}

document.addEventListener("DOMContentLoaded", () => {
    portalShowLogin();
    $("aws-login-form")?.addEventListener("submit", portalAwsLogin);
    $("portal-logout")?.addEventListener("click", () => portalLogout());
    $("snapshot-job-search")?.addEventListener("input", portalApplySnapshotJobFilter);
    $("revert-job-search")?.addEventListener("input", portalApplyRevertJobFilter);
    $("refresh-revert-dashboard")?.addEventListener("click", loadRevertDashboard);
    portalSetLoginError("");
});

