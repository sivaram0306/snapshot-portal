"use strict";

/* =========================================================
   REVERT SNAPSHOT MODULE
========================================================= */

window.REVERT_SNAPSHOT_MODULE_LOADED = true;
console.log("[DIAGNOSTIC] revert-snapshot.js loaded and executed successfully.");

const revertModuleState = {
    instances: [],
    volumes: [],
    snapshots: [],
    queue: []
};

async function loadRevertPageData() {
    const activeAccount = getActiveAccount();
    const sessionAccountEl = document.getElementById("revert-session-account");
    const sessionRegionEl = document.getElementById("revert-session-region");
    const select = document.getElementById("restore-instance-select") || document.getElementById("revert-instance");

    if (!activeAccount) {
        if (sessionAccountEl) sessionAccountEl.textContent = "No active account session";
        if (sessionRegionEl) sessionRegionEl.textContent = "-";
        if (select) {
            select.innerHTML = `<option value="">Connect an AWS account first</option>`;
            select.disabled = true;
        }
        toast("Please connect an AWS account first.", "error");
        return;
    }

    if (sessionAccountEl) sessionAccountEl.textContent = activeAccount.name || "Default Account";
    if (sessionRegionEl) sessionRegionEl.textContent = activeAccount.region || "us-west-1";

    if (select) {
        select.innerHTML = `<option value="">Loading instances from active session...</option>`;
        select.disabled = true;
    }

    try {
        setLoading(true, "Loading resources for revert pipeline...");
        const requestBody = JSON.stringify(getRequestBody());

        const [instancesRes, volumesRes, snapshotsRes] = await Promise.all([
            api("/api/aws/instances", { method: "POST", body: requestBody }),
            api("/api/aws/volumes", { method: "POST", body: requestBody }),
            api("/api/aws/snapshots", { method: "POST", body: requestBody })
        ]);

        revertModuleState.instances = instancesRes.instances || [];
        revertModuleState.volumes = volumesRes.volumes || [];
        revertModuleState.snapshots = snapshotsRes.snapshots || [];

        renderRevertInstanceDropdown(revertModuleState.instances);
        toast("AWS instances and snapshot catalog ready.", "success");
    } catch (error) {
        console.error("Failed to load revert page data:", error);
        if (select) {
            select.innerHTML = `<option value="">Failed to load instances. Check credentials.</option>`;
        }
        toast(error?.message || "Unable to load revert resources.", "error");
    } finally {
        setLoading(false);
    }
}

function renderRevertInstanceDropdown(instances) {
    const select = document.getElementById("restore-instance-select") || document.getElementById("revert-instance");
    if (!select) return;

    if (!instances.length) {
        select.innerHTML = `<option value="">No instances found in active region</option>`;
        select.disabled = true;
        return;
    }

    select.innerHTML = `<option value="">Select an instance...</option>` +
        instances.map(inst => `
            <option value="${escapeHtml(inst.instanceId || inst.instance_id)}">
                ${escapeHtml(inst.name || "Unnamed")} (${escapeHtml(inst.instanceId || inst.instance_id)})
            </option>
        `).join("");
    select.disabled = false;
}

function loadInstanceVolumesLocally(instanceId) {
    const volumeSelect = document.getElementById("restore-volume-select") || document.getElementById("revert-volumes");
    const snapshotSelect = document.getElementById("restore-snapshot-select");

    if (!volumeSelect) return;

    const instanceVolumes = revertModuleState.volumes.filter(vol => {
        const attachedTo = String(vol.attachedInstance || vol.instanceId || vol.instance_id || "").trim();
        return attachedTo === String(instanceId).trim();
    });

    if (!instanceVolumes.length) {
        volumeSelect.innerHTML = `<option value="">No EBS volumes attached to this instance</option>`;
        volumeSelect.disabled = true;
        toast("No attached EBS volumes found for this instance.", "error");
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

    toast(`${instanceVolumes.length} attached volume(s) loaded.`, "success");
}

function loadSnapshotsForVolumesLocally(volumeIds) {
    const snapshotSelect = document.getElementById("restore-snapshot-select");
    const addToQueueBtn = document.getElementById("add-to-queue-btn");

    if (!snapshotSelect) return;

    const matchingSnapshots = revertModuleState.snapshots.filter(snap => {
        const snapVolId = String(snap.volumeId || snap.volume_id || "").trim();
        return volumeIds.includes(snapVolId);
    });

    if (!matchingSnapshots.length) {
        snapshotSelect.innerHTML = `<option value="">No snapshots found for selected volume(s)</option>`;
        snapshotSelect.disabled = true;
        if (addToQueueBtn) addToQueueBtn.disabled = true;
        toast("No matching snapshots found for selected volume.", "error");
        return;
    }

    snapshotSelect.innerHTML = matchingSnapshots.map(snap => `
        <option value="${escapeHtml(snap.snapshotId || snap.snapshot_id)}">
            [${escapeHtml(snap.volumeId || snap.volume_id)}] ${escapeHtml(snap.snapshotId || snap.snapshot_id)} — ${formatDate(snap.startTime || snap.start_time)} (${escapeHtml(snap.progress || "100%")})
        </option>
    `).join("");

    snapshotSelect.disabled = false;
    if (addToQueueBtn) addToQueueBtn.disabled = false;

    toast(`${matchingSnapshots.length} snapshot(s) available for restore.`, "success");
}

function addRevertTaskToQueue() {
    const instanceSelect = document.getElementById("restore-instance-select") || document.getElementById("revert-instance");
    const volumeSelect = document.getElementById("restore-volume-select") || document.getElementById("revert-volumes");
    const snapshotSelect = document.getElementById("restore-snapshot-select");

    const instanceId = instanceSelect?.value;
    const selectedVolumeOptions = Array.from(volumeSelect?.selectedOptions || []);
    const snapshotId = snapshotSelect?.value;

    if (!instanceId) {
        toast("Please select an EC2 instance first.", "error");
        return;
    }

    if (!selectedVolumeOptions.length) {
        toast("Please select at least one volume to replace.", "error");
        return;
    }

    if (!snapshotId) {
        toast("Please select a target snapshot to restore.", "error");
        return;
    }

    selectedVolumeOptions.forEach(volOpt => {
        const volumeId = volOpt.value;
        const exists = revertModuleState.queue.some(
            task => task.instanceId === instanceId && task.volumeId === volumeId
        );

        if (!exists) {
            revertModuleState.queue.push({
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                instanceId,
                volumeId,
                snapshotId
            });
        }
    });

    renderRevertQueue();
    toast("Task added to restore queue.", "success");
}

function removeTaskFromQueue(taskId) {
    revertModuleState.queue = revertModuleState.queue.filter(task => task.id !== taskId);
    renderRevertQueue();
    toast("Task removed from queue.", "info");
}

function renderRevertQueue() {
    const container = document.getElementById("restore-queue-list");
    const counterBadge = document.getElementById("queue-counter-badge");
    const executeBtn = document.getElementById("revert-snapshot-button") || document.getElementById("restore-snapshot-button");

    if (!container) return;

    if (counterBadge) {
        counterBadge.textContent = `${revertModuleState.queue.length} task${revertModuleState.queue.length === 1 ? "" : "s"} queued`;
    }

    if (!revertModuleState.queue.length) {
        container.innerHTML = `<p style="color: #888; font-size: 12px; text-align: center;">No restore tasks in queue.</p>`;
        if (executeBtn) executeBtn.disabled = true;
        return;
    }

    container.innerHTML = revertModuleState.queue.map(task => `
        <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(15, 23, 42, 0.6); border: 1px solid #334155; padding: 8px 12px; border-radius: 6px; margin-bottom: 6px; font-size: 12px;">
            <div>
                <strong>Instance:</strong> ${escapeHtml(task.instanceId)} | 
                <strong>Vol:</strong> <code>${escapeHtml(task.volumeId)}</code> | 
                <strong>Snap:</strong> <code>${escapeHtml(task.snapshotId)}</code>
            </div>
            <button type="button" onclick="removeTaskFromQueue('${task.id}')" style="background: rgba(248, 113, 113, 0.1); color: #f87171; border: 1px solid #f87171; border-radius: 4px; padding: 2px 6px; cursor: pointer;">Remove</button>
        </div>
    `).join("");

    if (executeBtn) executeBtn.disabled = false;
}

async function executeRevertQueue() {
    if (!revertModuleState.queue.length) {
        const instanceId = document.getElementById("restore-instance-select")?.value || document.getElementById("revert-instance")?.value;
        const volumeId = document.getElementById("restore-volume-select")?.value || document.getElementById("revert-volumes")?.value;
        const snapshotId = document.getElementById("restore-snapshot-select")?.value;

        if (instanceId && volumeId && snapshotId) {
            revertModuleState.queue.push({
                id: `${Date.now()}`,
                instanceId,
                volumeId,
                snapshotId
            });
        } else {
            toast("No tasks in execution queue. Add a mapping first.", "error");
            return;
        }
    }

    if (!confirm(`Execute volume restoration for ${revertModuleState.queue.length} queued task(s)? Target instances will be stopped.`)) {
        return;
    }

    try {
        setLoading(true, "Executing EBS volume restoration pipeline...");

        const requestBody = {
            ...getRequestBody(),
            tasks: revertModuleState.queue
        };

        const data = await api("/api/aws/revert-snapshots", {
            method: "POST",
            body: JSON.stringify(requestBody)
        });

        toast("Restoration pipeline initiated successfully!", "success");
        revertModuleState.queue = [];
        renderRevertQueue();

        if (typeof showPage === "function") {
            showPage("revert-dashboard");
        }

    } catch (error) {
        console.error("Revert execution failed:", error);
        toast(error?.message || "Failed to execute reversion pipeline.", "error");
    } finally {
        setLoading(false);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const instanceSelect = document.getElementById("restore-instance-select") || document.getElementById("revert-instance");
    if (instanceSelect) {
        instanceSelect.addEventListener("change", (e) => {
            if (e.target.value) {
                loadInstanceVolumesLocally(e.target.value);
            }
        });
    }

    const volumeSelect = document.getElementById("restore-volume-select") || document.getElementById("revert-volumes");
    if (volumeSelect) {
        volumeSelect.addEventListener("change", () => {
            const selectedVolumeIds = Array.from(volumeSelect.selectedOptions).map(opt => opt.value);
            if (selectedVolumeIds.length > 0) {
                loadSnapshotsForVolumesLocally(selectedVolumeIds);
            }
        });
    }

    const addToQueueBtn = document.getElementById("add-to-queue-btn");
    if (addToQueueBtn) {
        addToQueueBtn.addEventListener("click", addRevertTaskToQueue);
    }

    const executeBtn = document.getElementById("revert-snapshot-button") || document.getElementById("restore-snapshot-button");
    if (executeBtn) {
        executeBtn.addEventListener("click", executeRevertQueue);
    }
});

window.removeTaskFromQueue = removeTaskFromQueue;
