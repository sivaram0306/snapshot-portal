/* =========================================================
   DEDICATED SNAPSHOT REVERT MODULE (revert-snapshot.js)
   Multi-Account, Multi-Instance, Multi-Volume Queue & Revert
========================================================= */

window.awsAccountsData = window.awsAccountsData || {};

async function getOrCreateAccountClient(accountKey, region) {
    if (!window.awsAccountsData[accountKey]) {
        const inputKey = prompt(`[Account: ${accountKey}] AWS Access Key ID required:`);
        if (!inputKey) return null;
        
        const inputSecret = prompt(`[Account: ${accountKey}] AWS Secret Access Key required:`);
        if (!inputSecret) return null;

        const inputToken = prompt(`[Account: ${accountKey}] AWS Session Token (Optional - leave blank if none):`);

        window.awsAccountsData[accountKey] = {
            accessKeyId: inputKey.trim(),
            secretAccessKey: inputSecret.trim(),
            sessionToken: inputToken ? inputToken.trim() : undefined
        };
    }

    const credentials = window.awsAccountsData[accountKey];
    const EC2Client = window.EC2Client;
    return new EC2Client({ region, credentials });
}

async function fetchAWSDataForAccount(accountKey, region, actionType, payload = {}) {
    const ec2Client = await getOrCreateAccountClient(accountKey, region);
    if (!ec2Client) return [];

    const DescribeInstancesCommand = window.DescribeInstancesCommand;
    const DescribeVolumesCommand = window.DescribeVolumesCommand;
    const DescribeSnapshotsCommand = window.DescribeSnapshotsCommand;

    try {
        if (actionType === 'instances') {
            const response = await ec2Client.send(new DescribeInstancesCommand({}));
            const instances = [];
            response.Reservations?.forEach(res => {
                res.Instances?.forEach(inst => {
                    const nameTag = inst.Tags?.find(t => t.Key === 'Name');
                    instances.push({
                        id: inst.InstanceId,
                        name: nameTag ? nameTag.Value : 'Unnamed',
                        state: inst.State.Name,
                        az: inst.Placement?.AvailabilityZone || `${region}a`
                    });
                });
            });
            return instances;
        }

        if (actionType === 'volumes') {
            if (!payload.instanceId) return [];
            const response = await ec2Client.send(new DescribeVolumesCommand({
                Filters: [{ Name: 'attachment.instance-id', Values: [payload.instanceId] }]
            }));
            return response.Volumes?.map(vol => ({
                id: vol.VolumeId,
                device: vol.Attachments?.[0]?.Device || '/dev/xvda',
                size: `${vol.Size} GiB`,
                status: vol.State,
                availabilityZone: vol.AvailabilityZone
            })) || [];
        }

        if (actionType === 'snapshots') {
            if (!payload.volumeId) return [];
            const response = await ec2Client.send(new DescribeSnapshotsCommand({
                OwnerIds: ['self'],
                Filters: [{ Name: 'volume-id', Values: [payload.volumeId] }]
            }));
            return response.Snapshots?.map(snap => ({
                id: snap.SnapshotId,
                desc: snap.Description || 'No description',
                size: `${snap.VolumeSize} GiB`
            })) || [];
        }
        return [];
    } catch (error) {
        console.error(`Multi-Account Fetch Error (${accountKey}):`, error);
        alert(`AWS Error for account ${accountKey}: ${error.message}`);
        return [];
    }
}

async function executeParallelMultiAccountRestore(tasks) {
    console.log(`Starting parallel cross-account restore for ${tasks.length} task(s)...`);
    
    const promises = tasks.map(async (task) => {
        const { accountKey, region, instanceId, oldVolumeId, snapshotId, deviceName, availabilityZone } = task;
        try {
            const ec2Client = await getOrCreateAccountClient(accountKey, region);
            if (!ec2Client) throw new Error("Could not initialize account credentials.");

            console.log(`[${accountKey} / ${instanceId}] Stopping instance for volume ${oldVolumeId}...`);
            await ec2Client.send(new window.StopInstancesCommand({ InstanceIds: [instanceId] }));
            
            let isStopped = false;
            while (!isStopped) {
                await new Promise(res => setTimeout(res, 5000));
                const instances = await fetchAWSDataForAccount(accountKey, region, 'instances');
                const target = instances.find(i => i.id === instanceId);
                if (target && target.state === 'stopped') isStopped = true;
            }

            console.log(`[${accountKey} / ${instanceId}] Detaching volume ${oldVolumeId}...`);
            await ec2Client.send(new window.DetachVolumeCommand({ VolumeId: oldVolumeId, InstanceId: instanceId }));
            
            let isDetached = false;
            while (!isDetached) {
                await new Promise(res => setTimeout(res, 4000));
                const vols = await fetchAWSDataForAccount(accountKey, region, 'volumes', { instanceId });
                if (!vols.find(v => v.id === oldVolumeId)) isDetached = true;
            }

            console.log(`[${accountKey} / ${instanceId}] Creating volume from snapshot ${snapshotId}...`);
            const createResp = await ec2Client.send(new window.CreateVolumeCommand({
                SnapshotId: snapshotId,
                AvailabilityZone: availabilityZone,
                VolumeType: 'gp3'
            }));
            const newVolumeId = createResp.VolumeId;

            let newVolReady = false;
            while (!newVolReady) {
                await new Promise(res => setTimeout(res, 5000));
                const checkResp = await ec2Client.send(new window.DescribeVolumesCommand({ VolumeIds: [newVolumeId] }));
                if (checkResp.Volumes?.[0]?.State === 'available') newVolReady = true;
            }

            console.log(`[${accountKey} / ${instanceId}] Attaching new volume ${newVolumeId} as ${deviceName}...`);
            await ec2Client.send(new window.AttachVolumeCommand({
                VolumeId: newVolumeId,
                InstanceId: instanceId,
                Device: deviceName
            }));

            console.log(`[${accountKey} / ${instanceId}] Restarting instance...`);
            await ec2Client.send(new window.StartInstancesCommand({ InstanceIds: [instanceId] }));

            return { accountKey, instanceId, volumeId: oldVolumeId, success: true, newVolumeId };
        } catch (error) {
            console.error(`[${accountKey} / ${instanceId}] Volume restore failed:`, error);
            return { accountKey, instanceId, volumeId: oldVolumeId, success: false, error: error.message };
        }
    });

    const results = await Promise.all(promises);
    const successCount = results.filter(r => r.success).length;
    const failures = results.filter(r => !r.success);

    if (failures.length === 0) {
        alert(`Successfully completed all ${successCount} volume restoration tasks in parallel!`);
    } else {
        const errSummary = failures.map(f => `[${f.accountKey}] Inst ${f.instanceId} / Vol ${f.volumeId}: ${f.error}`).join('\n');
        alert(`Finished with errors. Success: ${successCount}, Failed: ${failures.length}\n\n${errSummary}`);
    }
    window.location.reload();
}

function initRevertSnapshotModule() {
    console.log("Queue-Enabled Multi-Volume Revert Module initialized.");
    const accountInput = document.getElementById('restore-account-input') || { value: 'default-account' };
    const regionSelect = document.getElementById('restore-region-select');
    const instanceSelect = document.getElementById('restore-instance-select');
    const volumeSelect = document.getElementById('restore-volume-select');
    const snapshotSelect = document.getElementById('restore-snapshot-select');
    const addToQueueBtn = document.getElementById('add-to-queue-btn');
    const executeButton = document.getElementById('restore-snapshot-button');
    const refreshButton = document.getElementById('refresh-revert-data');
    const queueListContainer = document.getElementById('restore-queue-list');
    const queueCounterBadge = document.getElementById('queue-counter-badge');

    if (!regionSelect) return;

    let multiTaskQueue = [];

    function renderQueueUI() {
        if (!queueListContainer) return;
        queueCounterBadge.textContent = `${multiTaskQueue.length} task(s) queued`;

        if (multiTaskQueue.length === 0) {
            queueListContainer.innerHTML = '<p id="queue-empty-text" style="color: var(--text-muted, #888); font-size: 13px; text-align: center; margin: 10px 0;">No restore tasks added to the queue yet.</p>';
            if (executeButton) executeButton.disabled = true;
            return;
        }

        queueListContainer.innerHTML = '';
        multiTaskQueue.forEach((task, index) => {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'restore-queue-item';
            itemDiv.innerHTML = `
                <span><strong>${task.accountKey}</strong> / Inst: <code>${task.instanceId}</code> / Vol: <code>${task.oldVolumeId}</code> ➔ Snap: <code>${task.snapshotId}</code></span>
                <button type="button" class="restore-queue-remove" data-index="${index}" title="Remove Task">&times;</button>
            `;
            queueListContainer.appendChild(itemDiv);
        });

        // Bind delete triggers
        queueListContainer.querySelectorAll('.restore-queue-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.target.getAttribute('data-index'));
                multiTaskQueue.splice(idx, 1);
                renderQueueUI();
            });
        });

        if (executeButton) executeButton.disabled = false;
    }

    regionSelect.addEventListener('change', async (e) => {
        const region = e.target.value;
        const accountKey = accountInput.value.trim() || 'default-account';
        if (!region) return;

        instanceSelect.innerHTML = '<option value="">Loading instances...</option>';
        instanceSelect.disabled = false;

        const instances = await fetchAWSDataForAccount(accountKey, region, 'instances');
        instanceSelect.innerHTML = '<option value="">Select instance</option>';
        instances.forEach(inst => {
            const opt = document.createElement('option');
            opt.value = inst.id;
            opt.textContent = `${inst.name} (${inst.id}) - [${inst.state}]`;
            opt.dataset.state = inst.state;
            opt.dataset.az = inst.az;
            instanceSelect.appendChild(opt);
        });
    });

    instanceSelect.addEventListener('change', async (e) => {
        const instanceId = e.target.value;
        const region = regionSelect.value;
        const accountKey = accountInput.value.trim() || 'default-account';
        if (!instanceId) return;

        volumeSelect.innerHTML = '<option value="">Loading volumes...</option>';
        volumeSelect.disabled = false;

        const volumes = await fetchAWSDataForAccount(accountKey, region, 'volumes', { instanceId });
        volumeSelect.innerHTML = '';
        volumes.forEach(vol => {
            const opt = document.createElement('option');
            opt.value = vol.id;
            opt.textContent = `${vol.id} (${vol.device} - ${vol.size})`;
            opt.dataset.device = vol.device;
            opt.dataset.az = vol.availabilityZone;
            volumeSelect.appendChild(opt);
        });
    });

    volumeSelect.addEventListener('change', async () => {
        const selectedOptions = Array.from(volumeSelect.selectedOptions);
        const region = regionSelect.value;
        const accountKey = accountInput.value.trim() || 'default-account';
        if (selectedOptions.length === 0) return;

        snapshotSelect.innerHTML = '<option value="">Loading snapshots for all selected volumes...</option>';
        snapshotSelect.disabled = false;

        let allSnapshotsMap = [];
        for (const volOpt of selectedOptions) {
            const volId = volOpt.value;
            const snaps = await fetchAWSDataForAccount(accountKey, region, 'snapshots', { volumeId: volId });
            snaps.forEach(snap => {
                allSnapshotsMap.push({
                    ...snap,
                    targetVolumeId: volId,
                    displayLabel: `[Vol: ${volId}] ${snap.id} - ${snap.desc} (${snap.size})`
                });
            });
        }

        snapshotSelect.innerHTML = '<option value="">Select snapshot mapping</option>';
        if (allSnapshotsMap.length === 0) {
            snapshotSelect.innerHTML = '<option value="">No snapshots found for selected volumes</option>';
            return;
        }

        allSnapshotsMap.forEach(snap => {
            const opt = document.createElement('option');
            opt.value = snap.id;
            opt.textContent = snap.displayLabel;
            opt.dataset.volumeId = snap.targetVolumeId;
            snapshotSelect.appendChild(opt);
        });
    });

    snapshotSelect.addEventListener('change', () => {
        if (snapshotSelect.value && addToQueueBtn) addToQueueBtn.disabled = false;
    });

    if (addToQueueBtn) {
        addToQueueBtn.onclick = () => {
            const accountKey = document.getElementById('restore-account-input')?.value.trim() || 'default-account';
            const region = regionSelect.value;
            const instanceId = instanceSelect.value;
            const selectedSnapshotOpt = snapshotSelect.selectedOptions[0];
            const snapshotId = snapshotSelect.value;

            if (!region || !instanceId || !snapshotId) {
                alert("Please select a region, instance, volume, and snapshot mapping before adding to queue.");
                return;
            }

            const targetVolumeId = selectedSnapshotOpt.dataset.volumeId;
            const targetVolElement = Array.from(volumeSelect.options).find(opt => opt.value === targetVolumeId);

            if (!targetVolElement) {
                alert("Could not map the selected snapshot to a target volume.");
                return;
            }

            multiTaskQueue.push({
                accountKey,
                region,
                instanceId,
                oldVolumeId: targetVolumeId,
                snapshotId,
                deviceName: targetVolElement.dataset.device,
                availabilityZone: targetVolElement.dataset.az
            });

            renderQueueUI();

            // Reset snapshot selection for next add
            snapshotSelect.value = '';
            addToQueueBtn.disabled = true;
        };
    }

    if (executeButton) {
        executeButton.onclick = async () => {
            if (multiTaskQueue.length === 0) {
                alert("No tasks in execution queue.");
                return;
            }

            const confirmExec = confirm(`Are you sure you want to execute ${multiTaskQueue.length} restore task(s) in parallel across your accounts/instances?`);
            if (!confirmExec) return;

            executeButton.disabled = true;
            executeButton.textContent = `Executing ${multiTaskQueue.length} Tasks...`;

            await executeParallelMultiAccountRestore(multiTaskQueue);
        };
    }

    if (refreshButton) {
        refreshButton.addEventListener('click', () => {
            if (regionSelect.value) regionSelect.dispatchEvent(new Event('change'));
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('restore-region-select')) {
        initRevertSnapshotModule();
    }
});
