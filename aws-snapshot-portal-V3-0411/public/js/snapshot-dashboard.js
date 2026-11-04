"use strict";

let dashboardSnapshots = [];
let refreshTimer = null;


/*
 * =========================================================
 * REFRESH DASHBOARD
 * =========================================================
 */

async function refreshDashboard() {

    try {

        const region =
            document.getElementById("region").value;

        const url =
            region === "all"
                ? "/api/snapshot-dashboard"
                : `/api/snapshot-dashboard?region=${encodeURIComponent(region)}`;


        const response =
            await fetch(url);


        const data =
            await response.json();


        if (!response.ok) {

            throw new Error(
                data.message ||
                data.error ||
                "Failed to load snapshot dashboard."
            );
        }


        dashboardSnapshots =
            data.snapshots || [];


        updateSummary(
            dashboardSnapshots
        );


        renderJobProgress(
            dashboardSnapshots
        );


        renderSnapshotTable(
            dashboardSnapshots
        );


        document.getElementById(
            "lastUpdated"
        ).textContent =
            `Last updated: ${new Date().toLocaleTimeString()}`;


    } catch (error) {

        console.error(
            "Dashboard error:",
            error
        );

        document.getElementById(
            "snapshotTable"
        ).innerHTML = `
            <div class="error-box">
                ${escapeHtml(error.message)}
            </div>
        `;
    }
}


/*
 * =========================================================
 * SUMMARY
 * =========================================================
 */

function updateSummary(snapshots) {

    const total =
        snapshots.length;


    const completed =
        snapshots.filter(
            item => item.status === "COMPLETED"
        ).length;


    const pending =
        snapshots.filter(
            item =>
                item.status === "PENDING" ||
                item.status === "PROCESSING" ||
                item.status === "QUEUED"
        ).length;


    const errors =
        snapshots.filter(
            item =>
                item.status === "ERROR" ||
                item.status === "INSTANCE_NOT_FOUND" ||
                item.status === "NO_VOLUMES"
        ).length;


    const instances =
        new Set(
            snapshots
                .map(item => item.instance_id)
                .filter(Boolean)
        ).size;


    const volumes =
        new Set(
            snapshots
                .map(item => item.volume_id)
                .filter(Boolean)
        ).size;


    document.getElementById(
        "snapshotCount"
    ).textContent = total;


    document.getElementById(
        "completedCount"
    ).textContent = completed;


    document.getElementById(
        "pendingCount"
    ).textContent = pending;


    document.getElementById(
        "errorCount"
    ).textContent = errors;


    document.getElementById(
        "instanceCount"
    ).textContent = instances;


    document.getElementById(
        "volumeCount"
    ).textContent = volumes;
}


/*
 * =========================================================
 * JOB PROGRESS
 * =========================================================
 */

function renderJobProgress(snapshots) {

    const container =
        document.getElementById(
            "jobProgress"
        );


    if (!snapshots.length) {

        container.innerHTML = `
            <div class="empty-state">
                No snapshot jobs found.
            </div>
        `;

        return;
    }


    const jobs = {};


    snapshots.forEach(snapshot => {

        if (!jobs[snapshot.job_id]) {

            jobs[snapshot.job_id] = {
                jobId: snapshot.job_id,
                region: snapshot.region,
                createdAt: snapshot.created_at,
                snapshots: []
            };

        }

        jobs[snapshot.job_id]
            .snapshots
            .push(snapshot);

    });


    container.innerHTML =
        Object.values(jobs)
            .map(job => {

                const items =
                    job.snapshots;


                const total =
                    items.length;


                const completed =
                    items.filter(
                        item =>
                            item.status === "COMPLETED"
                    ).length;


                const errors =
                    items.filter(
                        item =>
                            item.status === "ERROR"
                    ).length;


                const averageProgress =
                    total
                        ? Math.round(
                            items.reduce(
                                (sum, item) =>
                                    sum +
                                    Number(
                                        item.progress || 0
                                    ),
                                0
                            ) / total
                        )
                        : 0;


                return `

                    <div class="job-card">

                        <div class="job-header">

                            <div>

                                <strong>
                                    Job ${escapeHtml(job.jobId)}
                                </strong>

                                <div class="muted">
                                    Region:
                                    ${escapeHtml(job.region)}
                                </div>

                            </div>

                            <div>

                                ${completed}/${total}
                                completed

                                ${
                                    errors
                                        ? ` · ${errors} failed`
                                        : ""
                                }

                            </div>

                        </div>


                        <div class="progress">

                            <div
                                class="progress-bar"
                                style="width:${averageProgress}%"
                            ></div>

                        </div>


                        <div class="progress-info">

                            <span>
                                ${averageProgress}%
                            </span>

                            <span>
                                ${completed} completed
                            </span>

                        </div>

                    </div>

                `;

            })
            .join("");
}


/*
 * =========================================================
 * SNAPSHOT TABLE
 * =========================================================
 */

function renderSnapshotTable(snapshots) {

    const container =
        document.getElementById(
            "snapshotTable"
        );


    const filter =
        document.getElementById(
            "statusFilter"
        ).value;


    let filtered =
        snapshots;


    if (filter !== "all") {

        filtered =
            snapshots.filter(
                item =>
                    item.status === filter
            );
    }


    if (!filtered.length) {

        container.innerHTML = `
            <div class="empty-state">
                No snapshots found.
            </div>
        `;

        return;
    }


    container.innerHTML = `

        <table>

            <thead>

                <tr>

                    <th>Job</th>
                    <th>Instance</th>
                    <th>Instance ID</th>
                    <th>Volume</th>
                    <th>Snapshot</th>
                    <th>Region</th>
                    <th>Progress</th>
                    <th>Status</th>
                    <th>Created By</th>
                    <th>Created</th>

                </tr>

            </thead>


            <tbody>

                ${filtered.map(snapshot => `

                    <tr>

                        <td>
                            <code>
                                ${escapeHtml(
                                    snapshot.job_id
                                )}
                            </code>
                        </td>


                        <td>
                            ${escapeHtml(
                                snapshot.instance_name
                            )}
                        </td>


                        <td>
                            <code>
                                ${escapeHtml(
                                    snapshot.instance_id
                                )}
                            </code>
                        </td>


                        <td>
                            <code>
                                ${escapeHtml(
                                    snapshot.volume_id
                                )}
                            </code>
                        </td>


                        <td>
                            <code>
                                ${escapeHtml(
                                    snapshot.snapshot_id
                                )}
                            </code>
                        </td>


                        <td>
                            ${escapeHtml(
                                snapshot.region
                            )}
                        </td>


                        <td>

                            <div class="mini-progress">

                                <div
                                    style="width:${Number(
                                        snapshot.progress || 0
                                    )}%"
                                ></div>

                            </div>

                            <small>
                                ${Number(
                                    snapshot.progress || 0
                                )}%
                            </small>

                        </td>


                        <td>
                            ${statusBadge(
                                snapshot.status
                            )}
                        </td>


                        <td>
                            ${escapeHtml(
                                snapshot.created_by
                            )}
                        </td>


                        <td>
                            ${formatDate(
                                snapshot.created_at
                            )}
                        </td>

                    </tr>

                `).join("")}

            </tbody>

        </table>

    `;
}


/*
 * =========================================================
 * STATUS BADGE
 * =========================================================
 */

function statusBadge(status) {

    const classes = {

        COMPLETED: "completed",
        PENDING: "pending",
        PROCESSING: "processing",
        QUEUED: "queued",
        ERROR: "error",
        INSTANCE_NOT_FOUND: "error",
        NO_VOLUMES: "error"

    };


    return `
        <span class="status ${classes[status] || ""}">
            ${escapeHtml(status)}
        </span>
    `;
}


/*
 * =========================================================
 * FILTER
 * =========================================================
 */

document.addEventListener(
    "DOMContentLoaded",
    () => {

        document
            .getElementById("statusFilter")
            .addEventListener(
                "change",
                () => {

                    renderSnapshotTable(
                        dashboardSnapshots
                    );

                }
            );


        document
            .getElementById("region")
            .addEventListener(
                "change",
                refreshDashboard
            );


        refreshDashboard();


        /*
         * Automatically update dashboard
         * every 10 seconds.
         */

        refreshTimer =
            setInterval(
                refreshDashboard,
                10000
            );

    }
);


/*
 * =========================================================
 * HELPERS
 * =========================================================
 */

function formatDate(value) {

    if (!value) {
        return "-";
    }

    return new Date(value)
        .toLocaleString();
}


function escapeHtml(value) {

    return String(value ?? "")

        .replaceAll("&", "&amp;")

        .replaceAll("<", "&lt;")

        .replaceAll(">", "&gt;")

        .replaceAll('"', "&quot;")

        .replaceAll("'", "&#039;");
}
