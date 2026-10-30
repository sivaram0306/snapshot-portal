"use strict";

require("dotenv").config();

const express = require("express");
const path = require("path");
const mysql = require("mysql2/promise");

const {
    EC2Client,
    DescribeInstancesCommand,
    DescribeVolumesCommand,
    DescribeSnapshotsCommand,
    CreateSnapshotCommand,
    CreateTagsCommand,
    StopInstancesCommand,
    StartInstancesCommand,
    DetachVolumeCommand,
    AttachVolumeCommand,
    CreateVolumeCommand,
    waitUntilInstanceStopped,
    waitUntilInstanceRunning,
    waitUntilVolumeAvailable,
    waitUntilVolumeInUse
} = require("@aws-sdk/client-ec2");

const {
    STSClient,
    GetCallerIdentityCommand
} = require("@aws-sdk/client-sts");


/* =========================================================
   CONFIGURATION
========================================================= */

const app = express();

const PORT =
    Number(process.env.PORT || 3000);

const DEFAULT_TEAM =
    process.env.SNAPSHOT_TEAM ||
    "SRE-Server-OPS-T2";

const DEFAULT_DELETE_AFTER =
    process.env.SNAPSHOT_DELETE_AFTER ||
    "3Days";

const SNAPSHOT_TIMEOUT_HOURS =
    Number(
        process.env.SNAPSHOT_TIMEOUT_HOURS || 24
    );

const POLL_INTERVAL_MS =
    Number(
        process.env.SNAPSHOT_POLL_INTERVAL_MS || 60000
    );

const REVERT_TIMEOUT_HOURS =
    Number(
        process.env.REVERT_TIMEOUT_HOURS ||
        SNAPSHOT_TIMEOUT_HOURS ||
        24
    );

const AWS_WAITER_TIMEOUT_SECONDS =
    Math.max(
        60,
        REVERT_TIMEOUT_HOURS * 60 * 60
    );


/* =========================================================
   MYSQL
========================================================= */

const pool =
    mysql.createPool({

        host:
            process.env.MYSQL_HOST ||
            "127.0.0.1",

        port:
            Number(
                process.env.MYSQL_PORT ||
                3306
            ),

        user:
            process.env.MYSQL_USER ||
            "snapshot_user",

        password:
            process.env.MYSQL_PASSWORD ||
            "",

        database:
            process.env.MYSQL_DATABASE ||
            "aws_snapshot_portal",

        waitForConnections:
            true,

        connectionLimit:
            10,

        queueLimit:
            0,

        timezone:
            "Z"
    });


/* =========================================================
   EXPRESS
========================================================= */

app.use(
    express.json({
        limit: "2mb"
    })
);

app.use(
    express.urlencoded({
        extended: true
    })
);

app.use(
    express.static(
        path.join(
            __dirname,
            "public"
        )
    )
);


/* =========================================================
   MYSQL INITIALIZATION
========================================================= */

async function initializeDatabase() {

    const connection =
        await pool.getConnection();

    try {

        /*
         * -----------------------------------------------------
         * SNAPSHOT PARENT TABLE
         * -----------------------------------------------------
         */
        await connection.query(`
            CREATE TABLE IF NOT EXISTS snapshot_jobs (

                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

                job_id VARCHAR(100) NOT NULL,

                account_name VARCHAR(255) NULL,

                region VARCHAR(50) NOT NULL,

                created_by VARCHAR(255) NULL,

                description TEXT NULL,

                status VARCHAR(50)
                    NOT NULL
                    DEFAULT 'running',

                total_instances INT
                    NOT NULL
                    DEFAULT 0,

                total_volumes INT
                    NOT NULL
                    DEFAULT 0,

                total_snapshots INT
                    NOT NULL
                    DEFAULT 0,

                completed_snapshots INT
                    NOT NULL
                    DEFAULT 0,

                failed_snapshots INT
                    NOT NULL
                    DEFAULT 0,

                progress DECIMAL(6,2)
                    NOT NULL
                    DEFAULT 0.00,

                error_message TEXT NULL,

                started_at DATETIME
                    NOT NULL
                    DEFAULT CURRENT_TIMESTAMP,

                completed_at DATETIME NULL,

                updated_at DATETIME
                    NOT NULL
                    DEFAULT CURRENT_TIMESTAMP
                    ON UPDATE CURRENT_TIMESTAMP,

                PRIMARY KEY (id),

                UNIQUE KEY uq_snapshot_jobs_job_id
                    (job_id),

                KEY idx_job_status
                    (status),

                KEY idx_job_started
                    (started_at),

                KEY idx_job_region
                    (region)

            ) ENGINE=InnoDB
              DEFAULT CHARSET=utf8mb4
              COLLATE=utf8mb4_unicode_ci
        `);


        /*
         * -----------------------------------------------------
         * SNAPSHOT CHILD TABLE
         * -----------------------------------------------------
         */
        await connection.query(`
            CREATE TABLE IF NOT EXISTS snapshot_items (

                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

                job_id VARCHAR(100) NOT NULL,

                input_value VARCHAR(255) NULL,

                instance_name VARCHAR(255) NULL,

                instance_id VARCHAR(100) NULL,

                volume_id VARCHAR(100) NULL,

                snapshot_id VARCHAR(100) NULL,

                description TEXT NULL,

                created_by VARCHAR(255) NULL,

                created_on VARCHAR(100) NULL,

                delete_after VARCHAR(100) NULL,

                team VARCHAR(255) NULL,

                status VARCHAR(50)
                    NOT NULL
                    DEFAULT 'pending',

                progress INT
                    NOT NULL
                    DEFAULT 0,

                error_message TEXT NULL,

                created_at DATETIME
                    NOT NULL
                    DEFAULT CURRENT_TIMESTAMP,

                updated_at DATETIME
                    NOT NULL
                    DEFAULT CURRENT_TIMESTAMP
                    ON UPDATE CURRENT_TIMESTAMP,

                PRIMARY KEY (id),

                KEY idx_item_job
                    (job_id),

                KEY idx_item_snapshot
                    (snapshot_id),

                KEY idx_item_instance
                    (instance_id),

                KEY idx_item_volume
                    (volume_id),

                KEY idx_item_status
                    (status),

                CONSTRAINT fk_snapshot_job
                    FOREIGN KEY (job_id)
                    REFERENCES snapshot_jobs(job_id)
                    ON DELETE CASCADE

            ) ENGINE=InnoDB
              DEFAULT CHARSET=utf8mb4
              COLLATE=utf8mb4_unicode_ci
        `);


        /*
         * -----------------------------------------------------
         * REVERT PARENT TABLE
         * -----------------------------------------------------
         */
        await connection.query(`
            CREATE TABLE IF NOT EXISTS revert_jobs (

                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

                job_id VARCHAR(100) NOT NULL,

                status VARCHAR(50)
                    NOT NULL
                    DEFAULT 'running',

                reverted_by VARCHAR(255) NULL,

                account_name VARCHAR(255) NULL,

                region VARCHAR(50) NULL,

                instance_name VARCHAR(255) NULL,

                instance_id VARCHAR(100) NULL,

                total_volumes INT
                    NOT NULL
                    DEFAULT 0,

                total_snapshots INT
                    NOT NULL
                    DEFAULT 0,

                completed_volumes INT
                    NOT NULL
                    DEFAULT 0,

                failed_volumes INT
                    NOT NULL
                    DEFAULT 0,

                progress DECIMAL(6,2)
                    NOT NULL
                    DEFAULT 0.00,

                error_message TEXT NULL,

                started_at DATETIME
                    NOT NULL
                    DEFAULT CURRENT_TIMESTAMP,

                completed_at DATETIME NULL,

                updated_at DATETIME
                    NOT NULL
                    DEFAULT CURRENT_TIMESTAMP
                    ON UPDATE CURRENT_TIMESTAMP,

                PRIMARY KEY (id),

                UNIQUE KEY uq_revert_jobs_job_id
                    (job_id),

                KEY idx_revert_job_status
                    (status),

                KEY idx_revert_job_started
                    (started_at),

                KEY idx_revert_job_instance
                    (instance_id)

            ) ENGINE=InnoDB
              DEFAULT CHARSET=utf8mb4
              COLLATE=utf8mb4_unicode_ci
        `);


        /*
         * -----------------------------------------------------
         * REVERT CHILD TABLE
         * -----------------------------------------------------
         */
        await connection.query(`
            CREATE TABLE IF NOT EXISTS revert_job_items (

                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

                job_id VARCHAR(100) NOT NULL,

                original_volume_id VARCHAR(100) NULL,

                snapshot_id VARCHAR(100) NULL,

                new_volume_id VARCHAR(100) NULL,

                instance_name VARCHAR(255) NULL,

                instance_id VARCHAR(100) NULL,

                device_name VARCHAR(255) NULL,

                availability_zone VARCHAR(100) NULL,

                size INT NULL,

                volume_type VARCHAR(50) NULL,

                status VARCHAR(50)
                    NOT NULL
                    DEFAULT 'pending',

                progress INT
                    NOT NULL
                    DEFAULT 0,

                error_message TEXT NULL,

                reverted_by VARCHAR(255) NULL,

                reverted_at DATETIME NULL,

                created_at DATETIME
                    NOT NULL
                    DEFAULT CURRENT_TIMESTAMP,

                updated_at DATETIME
                    NOT NULL
                    DEFAULT CURRENT_TIMESTAMP
                    ON UPDATE CURRENT_TIMESTAMP,

                PRIMARY KEY (id),

                KEY idx_revert_item_job
                    (job_id),

                KEY idx_revert_item_original_volume
                    (original_volume_id),

                KEY idx_revert_item_snapshot
                    (snapshot_id),

                KEY idx_revert_item_new_volume
                    (new_volume_id),

                KEY idx_revert_item_status
                    (status),

                CONSTRAINT fk_revert_job
                    FOREIGN KEY (job_id)
                    REFERENCES revert_jobs(job_id)
                    ON DELETE CASCADE

            ) ENGINE=InnoDB
              DEFAULT CHARSET=utf8mb4
              COLLATE=utf8mb4_unicode_ci
        `);

    } finally {

        connection.release();
    }
}


/* =========================================================
   HELPERS
========================================================= */

function generateJobId() {

    return (
        "JOB-" +
        Date.now() +
        "-" +
        Math.random()
            .toString(36)
            .substring(2, 8)
            .toUpperCase()
    );
}


function generateRevertJobId() {

    return (
        "REVERT-" +
        Date.now() +
        "-" +
        Math.random()
            .toString(36)
            .substring(2, 8)
            .toUpperCase()
    );
}


function normalizeProgress(value) {

    if (
        value === null ||
        value === undefined
    ) {
        return 0;
    }

    let text =
        String(value)
            .trim();

    if (!text) {
        return 0;
    }

    text =
        text.replace(
            "%",
            ""
        );

    const number =
        Number(text);

    if (
        !Number.isFinite(number)
    ) {
        return 0;
    }

    return Math.max(
        0,
        Math.min(
            100,
            number
        )
    );
}


function normalizeInput(value) {

    return String(
        value || ""
    ).trim();
}


function isInstanceId(value) {

    return /^i-[a-zA-Z0-9]+$/.test(
        value
    );
}


function nowTimestamp() {

    const date =
        new Date();

    const pad =
        value =>
            String(value)
                .padStart(2, "0");

    return (
        date.getUTCFullYear() +
        "-" +
        pad(
            date.getUTCMonth() + 1
        ) +
        "-" +
        pad(
            date.getUTCDate()
        ) +
        "_" +
        pad(
            date.getUTCHours()
        ) +
        "-" +
        pad(
            date.getUTCMinutes()
        ) +
        "-" +
        pad(
            date.getUTCSeconds()
        )
    );
}


function sleep(milliseconds) {

    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                milliseconds
            )
    );
}


function getAwsConfig(body) {

    if (!body) {

        throw new Error(
            "AWS request body is required."
        );
    }


    const accessKeyId =
        String(
            body.accessKeyId || ""
        ).trim();

    const secretAccessKey =
        String(
            body.secretAccessKey || ""
        ).trim();

    const sessionToken =
        String(
            body.sessionToken || ""
        ).trim();

    const region =
        String(
            body.region || ""
        ).trim();


    if (!accessKeyId) {

        throw new Error(
            "AWS Access Key ID is required."
        );
    }


    if (!secretAccessKey) {

        throw new Error(
            "AWS Secret Access Key is required."
        );
    }


    if (!region) {

        throw new Error(
            "AWS region is required."
        );
    }


    return {

        region,

        credentials: {

            accessKeyId,

            secretAccessKey,

            ...(sessionToken
                ? {
                    sessionToken
                }
                : {})

        }
    };
}


function createEc2Client(body) {

    return new EC2Client(
        getAwsConfig(body)
    );
}


function createStsClient(body) {

    return new STSClient(
        getAwsConfig(body)
    );
}


function getTagValue(
    resource,
    key
) {

    return (
        (
            resource?.Tags ||
            []
        ).find(
            tag =>
                tag.Key === key
        )?.Value ||
        ""
    );
}


/* =========================================================
   AWS CALLER IDENTITY
========================================================= */

async function getCreatedBy(body) {

    try {

        const sts =
            createStsClient(body);

        const result =
            await sts.send(
                new GetCallerIdentityCommand({})
            );

        const arn =
            result.Arn || "";

        const parts =
            arn.split("/");

        return (
            parts[
                parts.length - 1
            ] ||
            result.UserId ||
            "Unknown"
        );

    } catch (error) {

        console.error(
            "Unable to get AWS caller identity:",
            error.message
        );

        return "Unknown";
    }
}


/* =========================================================
   INSTANCE LOOKUP
========================================================= */

async function findInstance(
    ec2,
    input
) {

    const value =
        normalizeInput(input);


    if (!value) {
        return null;
    }


    if (
        isInstanceId(value)
    ) {

        const result =
            await ec2.send(
                new DescribeInstancesCommand({

                    InstanceIds: [
                        value
                    ]

                })
            );


        for (
            const reservation
            of result.Reservations || []
        ) {

            for (
                const instance
                of reservation.Instances || []
            ) {

                return instance;
            }
        }

        return null;
    }


    const result =
        await ec2.send(
            new DescribeInstancesCommand({

                Filters: [

                    {
                        Name:
                            "tag:Name",

                        Values: [
                            value
                        ]
                    },

                    {
                        Name:
                            "instance-state-name",

                        Values: [
                            "running",
                            "stopped"
                        ]
                    }

                ]

            })
        );


    for (
        const reservation
        of result.Reservations || []
    ) {

        for (
            const instance
            of reservation.Instances || []
        ) {

            return instance;
        }
    }


    return null;
}


function getInstanceName(
    instance
) {

    return (
        getTagValue(
            instance,
            "Name"
        ) ||
        instance?.InstanceId ||
        "Unnamed"
    );
}


/* =========================================================
   INSTANCE VOLUMES
========================================================= */

async function getInstanceVolumes(
    ec2,
    instance
) {

    const volumeIds = [];


    for (
        const mapping
        of instance.BlockDeviceMappings || []
    ) {

        const volumeId =
            mapping?.Ebs?.VolumeId;

        if (volumeId) {

            volumeIds.push(
                volumeId
            );
        }
    }


    if (!volumeIds.length) {
        return [];
    }


    const result =
        await ec2.send(
            new DescribeVolumesCommand({

                VolumeIds:
                    volumeIds

            })
        );


    const volumes =
        result.Volumes ||
        [];


    return volumes.map(
        volume => {

            const mapping =
                (
                    instance.BlockDeviceMappings ||
                    []
                ).find(
                    value =>
                        value?.Ebs?.VolumeId ===
                        volume.VolumeId
                );


            return {

                ...volume,

                DeviceName:
                    mapping?.DeviceName ||
                    "",

                IsRoot:
                    mapping?.DeviceName ===
                    instance.RootDeviceName

            };

        }
    );
}


/* =========================================================
   SNAPSHOT TAGS
========================================================= */

async function createSnapshotTags(
    ec2,
    snapshotId,
    item
) {

    await ec2.send(
        new CreateTagsCommand({

            Resources: [
                snapshotId
            ],

            Tags: [

                {
                    Key:
                        "InstanceName",

                    Value:
                        String(
                            item.instanceName ||
                            ""
                        )
                },

                {
                    Key:
                        "InstanceId",

                    Value:
                        String(
                            item.instanceId ||
                            ""
                        )
                },

                {
                    Key:
                        "VolumeId",

                    Value:
                        String(
                            item.volumeId ||
                            ""
                        )
                },

                {
                    Key:
                        "CreatedBy",

                    Value:
                        String(
                            item.createdBy ||
                            ""
                        )
                },

                {
                    Key:
                        "CreatedOn",

                    Value:
                        String(
                            item.createdOn ||
                            ""
                        )
                },

                {
                    Key:
                        "DeleteAfter",

                    Value:
                        DEFAULT_DELETE_AFTER
                },

                {
                    Key:
                        "Team",

                    Value:
                        DEFAULT_TEAM
                }

            ]

        })
    );
}


/* =========================================================
   UPDATE SNAPSHOT JOB PROGRESS
========================================================= */

async function updateJobProgress(
    jobId
) {

    const [items] =
        await pool.query(
            `
            SELECT
                id,
                status,
                progress
            FROM snapshot_items
            WHERE job_id = ?
            `,
            [jobId]
        );


    if (!items.length) {
        return;
    }


    const total =
        items.length;


    const completed =
        items.filter(
            item =>
                item.status ===
                "completed"
        ).length;


    const failed =
        items.filter(
            item =>
                item.status ===
                    "failed" ||
                item.status ===
                    "error"
        ).length;


    const progressTotal =
        items.reduce(
            (
                totalProgress,
                item
            ) => {

                return (
                    totalProgress +
                    normalizeProgress(
                        item.progress
                    )
                );

            },
            0
        );


    const calculatedProgress =
        progressTotal /
        total;


    const safeProgress =
        Number.isFinite(
            calculatedProgress
        )
            ? Math.max(
                0,
                Math.min(
                    100,
                    calculatedProgress
                )
            )
            : 0;


    let jobStatus =
        "running";


    if (
        completed + failed ===
        total
    ) {

        if (
            failed === total
        ) {

            jobStatus =
                "failed";

        } else if (
            failed > 0
        ) {

            jobStatus =
                "completed_with_errors";

        } else {

            jobStatus =
                "completed";
        }
    }


    await pool.query(
        `
        UPDATE snapshot_jobs
        SET
            status = ?,

            total_snapshots = ?,

            completed_snapshots = ?,

            failed_snapshots = ?,

            progress = ?,

            completed_at =
                CASE
                    WHEN ? IN (
                        'completed',
                        'completed_with_errors',
                        'failed'
                    )
                    THEN COALESCE(
                        completed_at,
                        UTC_TIMESTAMP()
                    )
                    ELSE completed_at
                END

        WHERE job_id = ?
        `,
        [

            jobStatus,

            total,

            completed,

            failed,

            safeProgress.toFixed(2),

            jobStatus,

            jobId

        ]
    );
}


/* =========================================================
   SYNC SNAPSHOT STATUS WITH AWS
========================================================= */

async function syncJobSnapshots(
    body,
    jobId
) {

    const [items] =
        await pool.query(
            `
            SELECT *
            FROM snapshot_items
            WHERE job_id = ?

              AND snapshot_id IS NOT NULL

              AND snapshot_id <> ''

              AND status NOT IN (
                  'completed',
                  'failed',
                  'error'
              )
            `,
            [jobId]
        );


    if (!items.length) {

        await updateJobProgress(
            jobId
        );

        return;
    }


    const ec2 =
        createEc2Client(body);


    const snapshotIds =
        items
            .map(
                item =>
                    item.snapshot_id
            )
            .filter(
                Boolean
            );


    if (!snapshotIds.length) {

        await updateJobProgress(
            jobId
        );

        return;
    }


    let snapshots = [];


    try {

        const result =
            await ec2.send(
                new DescribeSnapshotsCommand({

                    SnapshotIds:
                        snapshotIds

                })
            );


        snapshots =
            result.Snapshots ||
            [];

    } catch (error) {

        console.error(
            "Snapshot status error:",
            error
        );

        return;
    }


    for (
        const item
        of items
    ) {

        const snapshot =
            snapshots.find(
                value =>
                    value.SnapshotId ===
                    item.snapshot_id
            );


        if (!snapshot) {
            continue;
        }


        const state =
            snapshot.State ||
            "pending";


        const progress =
            normalizeProgress(
                snapshot.Progress
            );


        let status =
            "pending";


        if (
            state ===
            "completed"
        ) {

            status =
                "completed";

        } else if (
            state ===
            "error"
        ) {

            status =
                "failed";

        } else {

            status =
                "running";
        }


        await pool.query(
            `
            UPDATE snapshot_items
            SET
                status = ?,

                progress = ?,

                error_message = ?

            WHERE id = ?
            `,
            [

                status,

                progress,

                state === "error"
                    ? "AWS snapshot entered error state."
                    : null,

                item.id

            ]
        );
    }


    await updateJobProgress(
        jobId
    );
}


/* =========================================================
   HEALTH
========================================================= */

app.get(
    "/api/health",
    async (
        req,
        res
    ) => {

        try {

            await pool.query(
                "SELECT 1"
            );


            res.json({

                success:
                    true,

                mysql:
                    "connected",

                time:
                    new Date()
                        .toISOString()

            });

        } catch (error) {

            res.status(500)
                .json({

                    success:
                        false,

                    mysql:
                        "error",

                    error:
                        error.message

                });
        }
    }
);


/* =========================================================
   GET INSTANCES
========================================================= */

app.post(
    "/api/aws/instances",
    async (
        req,
        res
    ) => {

        try {

            const ec2 =
                createEc2Client(
                    req.body
                );


            const result =
                await ec2.send(
                    new DescribeInstancesCommand({

                        Filters: [

                            {
                                Name:
                                    "instance-state-name",

                                Values: [
                                    "running",
                                    "stopped"
                                ]
                            }

                        ]

                    })
                );


            const instances = [];


            for (
                const reservation
                of result.Reservations || []
            ) {

                for (
                    const instance
                    of reservation.Instances || []
                ) {

                    const volumes =
                        (
                            instance.BlockDeviceMappings ||
                            []
                        ).filter(
                            mapping =>
                                mapping?.Ebs?.VolumeId
                        );


                    instances.push({

                        name:
                            getInstanceName(
                                instance
                            ),

                        instanceId:
                            instance.InstanceId,

                        state:
                            instance.State?.Name ||
                            "unknown",

                        instanceType:
                            instance.InstanceType ||
                            "",

                        privateIp:
                            instance.PrivateIpAddress ||
                            "",

                        publicIp:
                            instance.PublicIpAddress ||
                            "",

                        availabilityZone:
                            instance.Placement
                                ?.AvailabilityZone ||
                            "",

                        volumeCount:
                            volumes.length

                    });
                }
            }


            res.json({

                success:
                    true,

                count:
                    instances.length,

                instances

            });

        } catch (error) {

            console.error(
                "Get instances error:",
                error
            );


            res.status(500)
                .json({

                    success:
                        false,

                    error:
                        error.message

                });
        }
    }
);


/* =========================================================
   GET VOLUMES
========================================================= */

app.post(
    "/api/aws/volumes",
    async (
        req,
        res
    ) => {

        try {

            const ec2 =
                createEc2Client(
                    req.body
                );


            const result =
                await ec2.send(
                    new DescribeVolumesCommand({

                        Filters: [

                            {
                                Name:
                                    "status",

                                Values: [
                                    "creating",
                                    "available",
                                    "in-use"
                                ]
                            }

                        ]

                    })
                );


            const volumes =
                (
                    result.Volumes ||
                    []
                ).map(
                    volume => {

                        const nameTag =
                            (
                                volume.Tags ||
                                []
                            ).find(
                                tag =>
                                    tag.Key ===
                                    "Name"
                            );


                        return {

                            name:
                                nameTag?.Value ||
                                "",

                            volumeId:
                                volume.VolumeId,

                            size:
                                volume.Size,

                            type:
                                volume.VolumeType,

                            state:
                                volume.State,

                            attachedInstance:
                                volume.Attachments?.[0]
                                    ?.InstanceId ||
                                "",

                            encrypted:
                                Boolean(
                                    volume.Encrypted
                                )

                        };
                    }
                );


            res.json({

                success:
                    true,

                count:
                    volumes.length,

                volumes

            });

        } catch (error) {

            console.error(
                "Get volumes error:",
                error
            );


            res.status(500)
                .json({

                    success:
                        false,

                    error:
                        error.message

                });
        }
    }
);


/* =========================================================
   GET SNAPSHOTS FROM AWS
========================================================= */

app.post(
    "/api/aws/snapshots",
    async (
        req,
        res
    ) => {

        try {

            const ec2 =
                createEc2Client(
                    req.body
                );


            const result =
                await ec2.send(
                    new DescribeSnapshotsCommand({

                        OwnerIds: [
                            "self"
                        ]

                    })
                );


            const snapshots =
                (
                    result.Snapshots ||
                    []
                ).map(
                    snapshot => {

                        const tags =
                            snapshot.Tags ||
                            [];


                        const getTag =
                            key =>
                                tags.find(
                                    tag =>
                                        tag.Key ===
                                        key
                                )?.Value ||
                                "";


                        return {

                            snapshotId:
                                snapshot.SnapshotId,

                            volumeId:
                                snapshot.VolumeId,

                            state:
                                snapshot.State,

                            progress:
                                normalizeProgress(
                                    snapshot.Progress
                                ),

                            size:
                                snapshot.VolumeSize,

                            startTime:
                                snapshot.StartTime,

                            description:
                                snapshot.Description ||
                                "",

                            instanceName:
                                getTag(
                                    "InstanceName"
                                ),

                            instanceId:
                                getTag(
                                    "InstanceId"
                                ),

                            createdBy:
                                getTag(
                                    "CreatedBy"
                                ),

                            team:
                                getTag(
                                    "Team"
                                )

                        };
                    }
                );


            res.json({

                success:
                    true,

                count:
                    snapshots.length,

                snapshots

            });

        } catch (error) {

            console.error(
                "Get snapshots error:",
                error
            );


            res.status(500)
                .json({

                    success:
                        false,

                    error:
                        error.message

                });
        }
    }
);


/* =========================================================
   CREATE MULTI-INSTANCE SNAPSHOTS
========================================================= */

app.post(
    "/api/aws/create-instance-snapshots",
    async (
        req,
        res
    ) => {

        try {

            const {

                instances,

                description,

                accountName

            } = req.body;


            if (
                !Array.isArray(instances) ||
                !instances.length
            ) {

                return res.status(400)
                    .json({

                        success:
                            false,

                        error:
                            "At least one instance name or ID is required."

                    });
            }


            const ec2 =
                createEc2Client(
                    req.body
                );


            const region =
                String(
                    req.body.region ||
                    ""
                ).trim();


            const createdBy =
                await getCreatedBy(
                    req.body
                );


            const jobId =
                generateJobId();


            await pool.query(
                `
                INSERT INTO snapshot_jobs (
                    job_id,
                    account_name,
                    region,
                    created_by,
                    description,
                    status,
                    total_instances
                )
                VALUES (
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    'running',
                    ?
                )
                `,
                [

                    jobId,

                    accountName || "",

                    region,

                    createdBy,

                    description || "",

                    instances.length

                ]
            );


            let totalVolumes =
                0;

            let totalSnapshots =
                0;


            const results = [];


            for (
                const rawInput
                of instances
            ) {

                const input =
                    normalizeInput(
                        rawInput
                    );


                if (!input) {
                    continue;
                }


                let instance;


                try {

                    instance =
                        await findInstance(
                            ec2,
                            input
                        );

                } catch (error) {

                    results.push({

                        input,

                        status:
                            "Error",

                        error:
                            error.message

                    });

                    continue;
                }


                if (!instance) {

                    results.push({

                        input,

                        status:
                            "InstanceNotFound",

                        instanceName:
                            input,

                        instanceId:
                            "N/A",

                        volumeId:
                            "N/A",

                        snapshotId:
                            "N/A"

                    });

                    continue;
                }


                const instanceId =
                    instance.InstanceId;


                const instanceName =
                    getInstanceName(
                        instance
                    );


                let volumes;


                try {

                    volumes =
                        await getInstanceVolumes(
                            ec2,
                            instance
                        );

                } catch (error) {

                    results.push({

                        input,

                        instanceName,

                        instanceId,

                        status:
                            "VolumeLookupFailed",

                        error:
                            error.message

                    });

                    continue;
                }


                if (!volumes.length) {

                    results.push({

                        input,

                        instanceName,

                        instanceId,

                        volumeId:
                            "N/A",

                        snapshotId:
                            "N/A",

                        status:
                            "NoVolumesFound"

                    });

                    continue;
                }


                totalVolumes +=
                    volumes.length;


                for (
                    const volume
                    of volumes
                ) {

                    const volumeId =
                        volume.VolumeId;


                    const timestamp =
                        nowTimestamp();


                    const snapshotDescription =
                        description &&
                        String(
                            description
                        ).trim()
                            ? String(
                                description
                            ).trim()
                            : (
                                `Volume snapshot of ` +
                                `${instanceName} ` +
                                `(${instanceId}) - ` +
                                `${volumeId} - ` +
                                `${timestamp}`
                            );


                    const item = {

                        jobId,

                        input,

                        instanceName,

                        instanceId,

                        volumeId,

                        createdBy,

                        createdOn:
                            timestamp,

                        description:
                            snapshotDescription

                    };


                    try {

                        const snapshotResult =
                            await ec2.send(
                                new CreateSnapshotCommand({

                                    VolumeId:
                                        volumeId,

                                    Description:
                                        snapshotDescription

                                })
                            );


                        const snapshotId =
                            snapshotResult
                                .SnapshotId;


                        if (!snapshotId) {

                            throw new Error(
                                "AWS did not return a SnapshotId."
                            );
                        }


                        await createSnapshotTags(
                            ec2,
                            snapshotId,
                            item
                        );


                        await pool.query(
                            `
                            INSERT INTO snapshot_items (

                                job_id,

                                input_value,

                                instance_name,

                                instance_id,

                                volume_id,

                                snapshot_id,

                                description,

                                created_by,

                                created_on,

                                delete_after,

                                team,

                                status,

                                progress

                            )
                            VALUES (
                                ?,
                                ?,
                                ?,
                                ?,
                                ?,
                                ?,
                                ?,
                                ?,
                                ?,
                                ?,
                                ?,
                                'running',
                                0
                            )
                            `,
                            [

                                jobId,

                                input,

                                instanceName,

                                instanceId,

                                volumeId,

                                snapshotId,

                                snapshotDescription,

                                createdBy,

                                timestamp,

                                DEFAULT_DELETE_AFTER,

                                DEFAULT_TEAM

                            ]
                        );


                        totalSnapshots++;


                        results.push({

                            input,

                            instanceName,

                            instanceId,

                            volumeId,

                            snapshotId,

                            status:
                                "SnapshotCreated",

                            progress:
                                0

                        });

                    } catch (error) {

                        console.error(
                            `Snapshot failed for ${volumeId}:`,
                            error
                        );


                        await pool.query(
                            `
                            INSERT INTO snapshot_items (

                                job_id,

                                input_value,

                                instance_name,

                                instance_id,

                                volume_id,

                                description,

                                created_by,

                                created_on,

                                delete_after,

                                team,

                                status,

                                progress,

                                error_message

                            )
                            VALUES (
                                ?,
                                ?,
                                ?,
                                ?,
                                ?,
                                ?,
                                ?,
                                ?,
                                ?,
                                ?,
                                'failed',
                                0,
                                ?
                            )
                            `,
                            [

                                jobId,

                                input,

                                instanceName,

                                instanceId,

                                volumeId,

                                snapshotDescription,

                                createdBy,

                                timestamp,

                                DEFAULT_DELETE_AFTER,

                                DEFAULT_TEAM,

                                error.message

                            ]
                        );


                        results.push({

                            input,

                            instanceName,

                            instanceId,

                            volumeId,

                            snapshotId:
                                "N/A",

                            status:
                                "SnapshotCreationFailed",

                            error:
                                error.message

                        });
                    }
                }
            }


            await pool.query(
                `
                UPDATE snapshot_jobs
                SET

                    total_volumes = ?,

                    total_snapshots = ?,

                    status = 'running'

                WHERE job_id = ?
                `,
                [

                    totalVolumes,

                    totalSnapshots,

                    jobId

                ]
            );


            await updateJobProgress(
                jobId
            );


            res.json({

                success:
                    true,

                jobId,

                createdBy,

                instanceCount:
                    instances.length,

                volumeCount:
                    totalVolumes,

                snapshotCount:
                    totalSnapshots,

                results

            });

        } catch (error) {

            console.error(
                "Create snapshot error:",
                error
            );


            res.status(500)
                .json({

                    success:
                        false,

                    error:
                        error.message

                });
        }
    }
);


/* =========================================================
   SNAPSHOT JOBS
========================================================= */

app.get(
    "/api/snapshot-jobs",
    async (
        req,
        res
    ) => {

        try {

            let limit =
                Number(
                    req.query.limit ||
                    100
                );


            if (
                !Number.isFinite(limit)
            ) {
                limit = 100;
            }


            limit =
                Math.max(
                    1,
                    Math.min(
                        limit,
                        500
                    )
                );


            const [jobs] =
                await pool.query(
                    `
                    SELECT

                        id,

                        job_id,

                        account_name,

                        region,

                        created_by,

                        description,

                        status,

                        total_instances,

                        total_volumes,

                        total_snapshots,

                        completed_snapshots,

                        failed_snapshots,

                        progress,

                        error_message,

                        started_at,

                        completed_at,

                        updated_at

                    FROM snapshot_jobs

                    ORDER BY
                        started_at DESC

                    LIMIT ?
                    `,
                    [limit]
                );


            res.json({

                success:
                    true,

                jobs

            });

        } catch (error) {

            console.error(
                "Get snapshot jobs error:",
                error
            );


            res.status(500)
                .json({

                    success:
                        false,

                    error:
                        error.message

                });
        }
    }
);


/* =========================================================
   SNAPSHOT JOB DETAILS
========================================================= */

app.get(
    "/api/snapshot-jobs/:jobId",
    async (
        req,
        res
    ) => {

        try {

            const jobId =
                req.params.jobId;


            const [jobs] =
                await pool.query(
                    `
                    SELECT *
                    FROM snapshot_jobs
                    WHERE job_id = ?
                    LIMIT 1
                    `,
                    [jobId]
                );


            if (!jobs.length) {

                return res.status(404)
                    .json({

                        success:
                            false,

                        error:
                            "Snapshot job not found."

                    });
            }


            const [items] =
                await pool.query(
                    `
                    SELECT *
                    FROM snapshot_items
                    WHERE job_id = ?
                    ORDER BY id ASC
                    `,
                    [jobId]
                );


            res.json({

                success:
                    true,

                job:
                    jobs[0],

                items

            });

        } catch (error) {

            console.error(
                "Get snapshot job details error:",
                error
            );


            res.status(500)
                .json({

                    success:
                        false,

                    error:
                        error.message

                });
        }
    }
);


/* =========================================================
   SYNC SNAPSHOT JOB
========================================================= */

app.post(
    "/api/snapshot-jobs/:jobId/sync",
    async (
        req,
        res
    ) => {

        try {

            const jobId =
                req.params.jobId;


            const [jobs] =
                await pool.query(
                    `
                    SELECT *
                    FROM snapshot_jobs
                    WHERE job_id = ?
                    LIMIT 1
                    `,
                    [jobId]
                );


            if (!jobs.length) {

                return res.status(404)
                    .json({

                        success:
                            false,

                        error:
                            "Snapshot job not found."

                    });
            }


            await syncJobSnapshots(
                req.body,
                jobId
            );


            const [updatedJobs] =
                await pool.query(
                    `
                    SELECT *
                    FROM snapshot_jobs
                    WHERE job_id = ?
                    LIMIT 1
                    `,
                    [jobId]
                );


            const [items] =
                await pool.query(
                    `
                    SELECT *
                    FROM snapshot_items
                    WHERE job_id = ?
                    ORDER BY id ASC
                    `,
                    [jobId]
                );


            res.json({

                success:
                    true,

                job:
                    updatedJobs[0],

                items

            });

        } catch (error) {

            console.error(
                "Sync snapshot job error:",
                error
            );


            res.status(500)
                .json({

                    success:
                        false,

                    error:
                        error.message

                });
        }
    }
);


/* =========================================================
   SNAPSHOT DASHBOARD
========================================================= */

app.get(
    "/api/snapshot-dashboard",
    async (
        req,
        res
    ) => {

        try {

            const [summaryRows] =
                await pool.query(
                    `
                    SELECT

                        COUNT(*) AS total_jobs,

                        COALESCE(
                            SUM(
                                CASE
                                    WHEN status =
                                        'running'
                                    THEN 1
                                    ELSE 0
                                END
                            ),
                            0
                        ) AS running_jobs,

                        COALESCE(
                            SUM(
                                CASE
                                    WHEN status =
                                        'completed'
                                    THEN 1
                                    ELSE 0
                                END
                            ),
                            0
                        ) AS completed_jobs,

                        COALESCE(
                            SUM(
                                CASE
                                    WHEN status IN (
                                        'failed',
                                        'completed_with_errors'
                                    )
                                    THEN 1
                                    ELSE 0
                                END
                            ),
                            0
                        ) AS failed_jobs,

                        COALESCE(
                            SUM(
                                total_snapshots
                            ),
                            0
                        ) AS total_snapshots,

                        COALESCE(
                            SUM(
                                completed_snapshots
                            ),
                            0
                        ) AS completed_snapshots,

                        COALESCE(
                            SUM(
                                failed_snapshots
                            ),
                            0
                        ) AS failed_snapshots

                    FROM snapshot_jobs
                    `
                );


            const [recentJobs] =
                await pool.query(
                    `
                    SELECT

                        job_id,

                        account_name,

                        region,

                        status,

                        total_instances,

                        total_volumes,

                        total_snapshots,

                        completed_snapshots,

                        failed_snapshots,

                        progress,

                        created_by,

                        started_at,

                        completed_at

                    FROM snapshot_jobs

                    ORDER BY
                        started_at DESC

                    LIMIT 50
                    `
                );


            res.json({

                success:
                    true,

                summary:
                    summaryRows[0],

                jobs:
                    recentJobs

            });

        } catch (error) {

            console.error(
                "Snapshot dashboard error:",
                error
            );


            res.status(500)
                .json({

                    success:
                        false,

                    error:
                        error.message

                });
        }
    }
);


/* =========================================================
   OPTIONAL SNAPSHOT JOB REFRESH
========================================================= */

app.post(
    "/api/snapshot-jobs/:jobId/refresh",
    async (
        req,
        res
    ) => {

        try {

            const jobId =
                req.params.jobId;


            const [jobs] =
                await pool.query(
                    `
                    SELECT *
                    FROM snapshot_jobs
                    WHERE job_id = ?
                    LIMIT 1
                    `,
                    [jobId]
                );


            if (!jobs.length) {

                return res.status(404)
                    .json({

                        success:
                            false,

                        error:
                            "Snapshot job not found."

                    });
            }


            await syncJobSnapshots(
                req.body,
                jobId
            );


            const [jobRows] =
                await pool.query(
                    `
                    SELECT *
                    FROM snapshot_jobs
                    WHERE job_id = ?
                    LIMIT 1
                    `,
                    [jobId]
                );


            const [itemRows] =
                await pool.query(
                    `
                    SELECT *
                    FROM snapshot_items
                    WHERE job_id = ?
                    ORDER BY id ASC
                    `,
                    [jobId]
                );


            res.json({

                success:
                    true,

                job:
                    jobRows[0],

                items:
                    itemRows

            });

        } catch (error) {

            console.error(
                "Refresh snapshot job error:",
                error
            );


            res.status(500)
                .json({

                    success:
                        false,

                    error:
                        error.message

                });
        }
    }
);


/* =========================================================
   REVERT HELPERS
========================================================= */


/*
 * Update a single revert item.
 */
async function updateRevertItem(
    itemId,
    fields
) {

    const allowedFields = [

        "new_volume_id",

        "device_name",

        "availability_zone",

        "size",

        "volume_type",

        "status",

        "progress",

        "error_message",

        "reverted_by",

        "reverted_at"

    ];


    const updates = [];
    const values = [];


    for (
        const field
        of allowedFields
    ) {

        if (
            Object.prototype.hasOwnProperty.call(
                fields,
                field
            )
        ) {

            updates.push(
                `${field} = ?`
            );

            values.push(
                fields[field]
            );
        }
    }


    if (!updates.length) {
        return;
    }


    values.push(
        itemId
    );


    await pool.query(
        `
        UPDATE revert_job_items
        SET
            ${updates.join(", ")}
        WHERE id = ?
        `,
        values
    );
}


/*
 * Update aggregate revert job progress.
 */
async function updateRevertJobProgress(
    jobId
) {

    const [items] =
        await pool.query(
            `
            SELECT
                status,
                progress
            FROM revert_job_items
            WHERE job_id = ?
            `,
            [jobId]
        );


    if (!items.length) {
        return;
    }


    const total =
        items.length;


    const completed =
        items.filter(
            item =>
                item.status ===
                "completed"
        ).length;


    const failed =
        items.filter(
            item =>
                item.status ===
                    "failed" ||
                item.status ===
                    "error"
        ).length;


    const progressSum =
        items.reduce(
            (
                totalProgress,
                item
            ) =>
                totalProgress +
                normalizeProgress(
                    item.progress
                ),
            0
        );


    const progress =
        Math.max(
            0,
            Math.min(
                100,
                progressSum / total
            )
        );


    let status =
        "running";


    if (
        completed + failed ===
        total
    ) {

        if (
            failed === total
        ) {

            status =
                "failed";

        } else if (
            failed > 0
        ) {

            status =
                "completed_with_errors";

        } else {

            status =
                "completed";
        }
    }


    await pool.query(
        `
        UPDATE revert_jobs
        SET

            status = ?,

            completed_volumes = ?,

            failed_volumes = ?,

            progress = ?,

            completed_at =
                CASE
                    WHEN ? IN (
                        'completed',
                        'completed_with_errors',
                        'failed'
                    )
                    THEN COALESCE(
                        completed_at,
                        UTC_TIMESTAMP()
                    )
                    ELSE completed_at
                END

        WHERE job_id = ?
        `,
        [

            status,

            completed,

            failed,

            progress.toFixed(2),

            status,

            jobId

        ]
    );
}


/*
 * Fetch an EC2 instance and its attached volumes.
 */
async function getRevertInstanceContext(
    ec2,
    instanceId
) {

    const result =
        await ec2.send(
            new DescribeInstancesCommand({

                InstanceIds: [
                    instanceId
                ]

            })
        );


    let instance = null;


    for (
        const reservation
        of result.Reservations || []
    ) {

        for (
            const candidate
            of reservation.Instances || []
        ) {

            instance =
                candidate;

            break;
        }

        if (instance) {
            break;
        }
    }


    if (!instance) {

        throw new Error(
            `EC2 instance ${instanceId} was not found.`
        );
    }


    const state =
        instance.State?.Name ||
        "unknown";


    if (
        ![
            "running",
            "stopped",
            "stopping"
        ].includes(state)
    ) {

        throw new Error(
            `Instance ${instanceId} is in state "${state}" and cannot be reverted.`
        );
    }


    const volumes =
        await getInstanceVolumes(
            ec2,
            instance
        );


    return {

        instance,

        volumes,

        instanceName:
            getInstanceName(
                instance
            ),

        availabilityZone:
            instance.Placement
                ?.AvailabilityZone ||
            "",

        rootDeviceName:
            instance.RootDeviceName ||
            ""

    };
}


/*
 * Wait for a volume to become available.
 */
async function waitForVolumeAvailable(
    ec2,
    volumeId
) {

    await waitUntilVolumeAvailable(
        {
            client:
                ec2,

            maxWaitTime:
                AWS_WAITER_TIMEOUT_SECONDS

        },
        {
            VolumeIds: [
                volumeId
            ]
        }
    );
}


/*
 * Wait for a volume to become attached.
 */
async function waitForVolumeInUse(
    ec2,
    volumeId
) {

    await waitUntilVolumeInUse(
        {
            client:
                ec2,

            maxWaitTime:
                AWS_WAITER_TIMEOUT_SECONDS

        },
        {
            VolumeIds: [
                volumeId
            ]
        }
    );
}


/*
 * Stop the instance if required.
 *
 * Returns true when this function actually initiated
 * a stop operation.
 */
async function ensureInstanceStopped(
    ec2,
    instanceId
) {

    const result =
        await ec2.send(
            new DescribeInstancesCommand({

                InstanceIds: [
                    instanceId
                ]

            })
        );


    const instance =
        result.Reservations?.[0]
            ?.Instances?.[0];


    const state =
        instance?.State?.Name ||
        "unknown";


    if (
        state ===
        "stopped"
    ) {

        return false;
    }


    if (
        state ===
        "stopping"
    ) {

        await waitUntilInstanceStopped(
            {
                client:
                    ec2,

                maxWaitTime:
                    AWS_WAITER_TIMEOUT_SECONDS

            },
            {
                InstanceIds: [
                    instanceId
                ]
            }
        );

        return true;
    }


    if (
        state !==
        "running"
    ) {

        throw new Error(
            `Cannot stop instance ${instanceId} from state "${state}".`
        );
    }


    await ec2.send(
        new StopInstancesCommand({

            InstanceIds: [
                instanceId
            ]

        })
    );


    await waitUntilInstanceStopped(
        {
            client:
                ec2,

            maxWaitTime:
                AWS_WAITER_TIMEOUT_SECONDS

        },
        {
            InstanceIds: [
                instanceId
            ]
        }
    );


    return true;
}


/*
 * Start the instance and wait until it is running.
 */
async function startInstanceAndWait(
    ec2,
    instanceId
) {

    await ec2.send(
        new StartInstancesCommand({

            InstanceIds: [
                instanceId
            ]

        })
    );


    await waitUntilInstanceRunning(
        {
            client:
                ec2,

            maxWaitTime:
                AWS_WAITER_TIMEOUT_SECONDS

        },
        {
            InstanceIds: [
                instanceId
            ]
        }
    );
}


/*
 * Attempt to reattach the original volume if the replacement
 * operation fails after the old volume was detached.
 */
async function attemptOriginalVolumeRecovery(
    ec2,
    instanceId,
    volumeId,
    deviceName
) {

    try {

        const result =
            await ec2.send(
                new DescribeVolumesCommand({

                    VolumeIds: [
                        volumeId
                    ]

                })
            );


        const volume =
            result.Volumes?.[0];


        if (!volume) {

            console.error(
                `Original volume ${volumeId} no longer exists.`
            );

            return false;
        }


        if (
            volume.State ===
            "in-use"
        ) {

            return true;
        }


        if (
            volume.State !==
            "available"
        ) {

            await waitForVolumeAvailable(
                ec2,
                volumeId
            );
        }


        await ec2.send(
            new AttachVolumeCommand({

                VolumeId:
                    volumeId,

                InstanceId:
                    instanceId,

                Device:
                    deviceName

            })
        );


        await waitForVolumeInUse(
            ec2,
            volumeId
        );


        console.log(
            `Original volume ${volumeId} reattached to ${instanceId} as ${deviceName}.`
        );


        return true;

    } catch (error) {

        console.error(
            `Unable to recover original volume ${volumeId}:`,
            error.message
        );

        return false;
    }
}


/*
 * Tag the newly-created replacement volume.
 */
async function tagReplacementVolume(
    ec2,
    volumeId,
    context
) {

    const tags = [

        {
            Key:
                "Name",

            Value:
                `revert-${context.instanceName}-${volumeId}`
        },

        {
            Key:
                "RevertJobId",

            Value:
                context.jobId
        },

        {
            Key:
                "RevertedFromVolume",

            Value:
                context.originalVolumeId
        },

        {
            Key:
                "SourceSnapshotId",

            Value:
                context.snapshotId
        },

        {
            Key:
                "InstanceName",

            Value:
                context.instanceName
        },

        {
            Key:
                "InstanceId",

            Value:
                context.instanceId
        },

        {
            Key:
                "DeviceName",

            Value:
                context.deviceName
        },

        {
            Key:
                "RevertedBy",

            Value:
                context.revertedBy
        },

        {
            Key:
                "Team",

            Value:
                DEFAULT_TEAM
        },

        {
            Key:
                "CreatedOn",

            Value:
                nowTimestamp()
        }

    ];


    await ec2.send(
        new CreateTagsCommand({

            Resources: [
                volumeId
            ],

            Tags:
                tags

        })
    );
}


/* =========================================================
   START REVERT API
========================================================= */

app.post(
    "/api/aws/snapshots/revert",
    async (
        req,
        res
    ) => {

        const body =
            req.body || {};


        const {

            accountName,

            region,

            instanceId,

            restores

        } = body;


        if (!instanceId) {

            return res.status(400)
                .json({

                    success:
                        false,

                    error:
                        "instanceId is required."

                });
        }


        if (
            !restores ||
            typeof restores !== "object" ||
            Array.isArray(restores) ||
            !Object.keys(restores).length
        ) {

            return res.status(400)
                .json({

                    success:
                        false,

                    error:
                        "At least one restore mapping is required."

                });
        }


        /*
         * Validate AWS credentials before creating
         * a database job.
         */
        try {

            getAwsConfig(
                body
            );

        } catch (error) {

            return res.status(400)
                .json({

                    success:
                        false,

                    error:
                        error.message

                });
        }


        const restoreEntries =
            Object.entries(
                restores
            );


        /*
         * Basic ID validation.
         */
        for (
            const [
                volumeId,
                snapshotId
            ]
            of restoreEntries
        ) {

            if (
                !/^vol-[a-zA-Z0-9]+$/.test(
                    String(
                        volumeId
                    )
                )
            ) {

                return res.status(400)
                    .json({

                        success:
                            false,

                        error:
                            `Invalid EBS volume ID: ${volumeId}`

                    });
            }


            if (
                !/^snap-[a-zA-Z0-9]+$/.test(
                    String(
                        snapshotId
                    )
                )
            ) {

                return res.status(400)
                    .json({

                        success:
                            false,

                        error:
                            `Invalid snapshot ID for ${volumeId}: ${snapshotId}`

                    });
            }
        }


        let ec2;


        try {

            ec2 =
                createEc2Client(
                    body
                );

        } catch (error) {

            return res.status(400)
                .json({

                    success:
                        false,

                    error:
                        error.message

                });
        }


        let context;


        try {

            context =
                await getRevertInstanceContext(
                    ec2,
                    instanceId
                );

        } catch (error) {

            console.error(
                "Revert instance lookup failed:",
                error
            );


            return res.status(400)
                .json({

                    success:
                        false,

                    error:
                        error.message

                });
        }


        /*
         * Verify every selected volume is actually attached
         * to the requested instance.
         */
        for (
            const [
                originalVolumeId
            ]
            of restoreEntries
        ) {

            const volume =
                context.volumes.find(
                    value =>
                        value.VolumeId ===
                        originalVolumeId
                );


            if (!volume) {

                return res.status(400)
                    .json({

                        success:
                            false,

                        error:
                            `Volume ${originalVolumeId} is not attached to instance ${instanceId}.`

                    });
            }


            if (
                !volume.DeviceName
            ) {

                return res.status(400)
                    .json({

                        success:
                            false,

                        error:
                            `Unable to determine device name for ${originalVolumeId}.`

                    });
            }
        }


        /*
         * Verify that every selected snapshot exists and is completed.
         */
        let snapshots;


        try {

            const result =
                await ec2.send(
                    new DescribeSnapshotsCommand({

                        SnapshotIds:
                            restoreEntries.map(
                                ([
                                    ,
                                    snapshotId
                                ]) =>
                                    snapshotId
                            )

                    })
                );


            snapshots =
                result.Snapshots ||
                [];

        } catch (error) {

            return res.status(400)
                .json({

                    success:
                        false,

                    error:
                        `Unable to validate snapshots: ${error.message}`

                });
        }


        for (
            const [
                volumeId,
                snapshotId
            ]
            of restoreEntries
        ) {

            const snapshot =
                snapshots.find(
                    value =>
                        value.SnapshotId ===
                        snapshotId
                );


            if (!snapshot) {

                return res.status(400)
                    .json({

                        success:
                            false,

                        error:
                            `Snapshot ${snapshotId} was not found.`

                    });
            }


            if (
                snapshot.State !==
                "completed"
            ) {

                return res.status(400)
                    .json({

                        success:
                            false,

                        error:
                            `Snapshot ${snapshotId} is not completed. Current state: ${snapshot.State}.`

                    });
            }


            /*
             * Prevent an obvious accidental mismatch.
             *
             * The selected snapshot should normally correspond
             * to the original volume being restored.
             */
            if (
                snapshot.VolumeId &&
                snapshot.VolumeId !==
                    volumeId
            ) {

                console.warn(
                    `Snapshot ${snapshotId} originated from ${snapshot.VolumeId}, requested for ${volumeId}.`
                );
            }
        }


        const jobId =
            generateRevertJobId();


        const revertedBy =
            String(
                body.revertedBy ||
                ""
            ).trim() ||
            await getCreatedBy(
                body
            );


        const instanceName =
            context.instanceName;


        const availabilityZone =
            context.availabilityZone;


        /*
         * Record the job before returning.
         */
        const connection =
            await pool.getConnection();


        try {

            await connection.beginTransaction();


            await connection.query(
                `
                INSERT INTO revert_jobs (

                    job_id,

                    status,

                    reverted_by,

                    account_name,

                    region,

                    instance_name,

                    instance_id,

                    total_volumes,

                    total_snapshots,

                    progress

                )
                VALUES (
                    ?,
                    'running',
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    0
                )
                `,
                [

                    jobId,

                    revertedBy,

                    accountName ||
                        null,

                    region ||
                        null,

                    instanceName,

                    instanceId,

                    restoreEntries.length,

                    restoreEntries.length

                ]
            );


            for (
                const [
                    originalVolumeId,
                    snapshotId
                ]
                of restoreEntries
            ) {

                const volume =
                    context.volumes.find(
                        value =>
                            value.VolumeId ===
                            originalVolumeId
                    );


                await connection.query(
                    `
                    INSERT INTO revert_job_items (

                        job_id,

                        original_volume_id,

                        snapshot_id,

                        instance_name,

                        instance_id,

                        device_name,

                        availability_zone,

                        size,

                        volume_type,

                        status,

                        progress,

                        reverted_by

                    )
                    VALUES (
                        ?,
                        ?,
                        ?,
                        ?,
                        ?,
                        ?,
                        ?,
                        ?,
                        ?,
                        'pending',
                        0,
                        ?
                    )
                    `,
                    [

                        jobId,

                        originalVolumeId,

                        snapshotId,

                        instanceName,

                        instanceId,

                        volume.DeviceName,

                        availabilityZone,

                        volume.Size ||
                            null,

                        volume.VolumeType ||
                            null,

                        revertedBy

                    ]
                );
            }


            await connection.commit();

        } catch (error) {

            try {
                await connection.rollback();
            } catch (_) {
                // Ignore rollback errors.
            }


            console.error(
                "Failed to create revert job:",
                error
            );


            return res.status(500)
                .json({

                    success:
                        false,

                    error:
                        "Unable to create revert job."

                });

        } finally {

            connection.release();
        }


        /*
         * Return immediately.
         */
        res.json({

            success:
                true,

            jobId,

            message:
                `Revert job ${jobId} started for ${restoreEntries.length} volume(s).`,

            instanceId,

            instanceName,

            volumeCount:
                restoreEntries.length

        });


        /*
         * Continue AWS work asynchronously.
         */
        performRevertInBackground(
            jobId,
            body
        ).catch(
            error => {

                console.error(
                    `Background revert failed for ${jobId}:`,
                    error
                );

            }
        );
    }
);


/* =========================================================
   BACKGROUND REVERT WORKER
========================================================= */

async function performRevertInBackground(
    jobId,
    requestBody
) {

    const {

        instanceId,

        restores

    } = requestBody;


    const revertedBy =
        String(
            requestBody.revertedBy ||
            ""
        ).trim() ||
        "Unknown";


    const ec2 =
        createEc2Client(
            requestBody
        );


    let instanceWasStoppedByUs =
        false;


    /*
     * Track original attachments so failed operations
     * can attempt recovery.
     */
    const originalAttachments = {};


    try {

        /*
         * -----------------------------------------------------
         * STEP 1: Get current instance information
         * -----------------------------------------------------
         */
        const context =
            await getRevertInstanceContext(
                ec2,
                instanceId
            );


        /*
         * Capture device mapping before any detach operation.
         */
        for (
            const volume
            of context.volumes
        ) {

            originalAttachments[
                volume.VolumeId
            ] = {

                deviceName:
                    volume.DeviceName,

                size:
                    volume.Size,

                volumeType:
                    volume.VolumeType

            };
        }


        /*
         * -----------------------------------------------------
         * STEP 2: Stop instance
         * -----------------------------------------------------
         */
        instanceWasStoppedByUs =
            await ensureInstanceStopped(
                ec2,
                instanceId
            );


        console.log(
            `[${jobId}] Instance ${instanceId} is stopped.`
        );


        /*
         * -----------------------------------------------------
         * STEP 3: Process each selected volume
         * -----------------------------------------------------
         */
        const [items] =
            await pool.query(
                `
                SELECT *
                FROM revert_job_items
                WHERE job_id = ?
                ORDER BY id ASC
                `,
                [jobId]
            );


        for (
            const item
            of items
        ) {

            let replacementVolumeId =
                null;

            let originalDetached =
                false;


            try {

                await updateRevertItem(
                    item.id,
                    {
                        status:
                            "running",

                        progress:
                            5,

                        error_message:
                            null
                    }
                );


                /*
                 * -------------------------------------------------
                 * STEP 3A: Refresh original volume information
                 * -------------------------------------------------
                 */
                const volumeResult =
                    await ec2.send(
                        new DescribeVolumesCommand({

                            VolumeIds: [
                                item.original_volume_id
                            ]

                        })
                    );


                const originalVolume =
                    volumeResult.Volumes?.[0];


                if (!originalVolume) {

                    throw new Error(
                        `Original volume ${item.original_volume_id} was not found.`
                    );
                }


                const deviceName =
                    originalAttachments[
                        item.original_volume_id
                    ]?.deviceName ||
                    item.device_name;


                if (!deviceName) {

                    throw new Error(
                        `Device name for ${item.original_volume_id} could not be determined.`
                    );
                }


                /*
                 * -------------------------------------------------
                 * STEP 3B: Verify selected snapshot
                 * -------------------------------------------------
                 */
                const snapshotResult =
                    await ec2.send(
                        new DescribeSnapshotsCommand({

                            SnapshotIds: [
                                item.snapshot_id
                            ]

                        })
                    );


                const snapshot =
                    snapshotResult.Snapshots?.[0];


                if (!snapshot) {

                    throw new Error(
                        `Snapshot ${item.snapshot_id} was not found.`
                    );
                }


                if (
                    snapshot.State !==
                    "completed"
                ) {

                    throw new Error(
                        `Snapshot ${item.snapshot_id} is not completed. Current state: ${snapshot.State}.`
                    );
                }


                await updateRevertItem(
                    item.id,
                    {
                        device_name:
                            deviceName,

                        progress:
                            10
                    }
                );


                /*
                 * -------------------------------------------------
                 * STEP 3C: Detach original volume
                 * -------------------------------------------------
                 */
                if (
                    originalVolume.State ===
                    "in-use"
                ) {

                    await ec2.send(
                        new DetachVolumeCommand({

                            VolumeId:
                                item.original_volume_id,

                            InstanceId:
                                instanceId,

                            Device:
                                deviceName

                        })
                    );


                    originalDetached =
                        true;


                    await waitForVolumeAvailable(
                        ec2,
                        item.original_volume_id
                    );

                } else if (
                    originalVolume.State !==
                    "available"
                ) {

                    await waitForVolumeAvailable(
                        ec2,
                        item.original_volume_id
                    );
                }


                await updateRevertItem(
                    item.id,
                    {
                        progress:
                            25
                    }
                );


                /*
                 * -------------------------------------------------
                 * STEP 3D: Create replacement volume
                 * -------------------------------------------------
                 *
                 * The replacement is explicitly created in the
                 * instance Availability Zone.
                 */
                const createVolumeResult =
                    await ec2.send(
                        new CreateVolumeCommand({

                            SnapshotId:
                                item.snapshot_id,

                            AvailabilityZone:
                                context.availabilityZone,

                            VolumeType:
                                originalVolume.VolumeType ||
                                undefined,

                            Iops:
                                originalVolume.Iops ||
                                undefined,

                            Throughput:
                                originalVolume.Throughput ||
                                undefined,

                            Encrypted:
                                Boolean(
                                    snapshot.Encrypted
                                ),

                            TagSpecifications: [

                                {
                                    ResourceType:
                                        "volume",

                                    Tags: [

                                        {
                                            Key:
                                                "Name",

                                            Value:
                                                `revert-${context.instanceName}-${item.original_volume_id}`
                                        },

                                        {
                                            Key:
                                                "RevertJobId",

                                            Value:
                                                jobId
                                        },

                                        {
                                            Key:
                                                "RevertedFromVolume",

                                            Value:
                                                item.original_volume_id
                                        },

                                        {
                                            Key:
                                                "SourceSnapshotId",

                                            Value:
                                                item.snapshot_id
                                        },

                                        {
                                            Key:
                                                "InstanceName",

                                            Value:
                                                context.instanceName
                                        },

                                        {
                                            Key:
                                                "InstanceId",

                                            Value:
                                                instanceId
                                        },

                                        {
                                            Key:
                                                "DeviceName",

                                            Value:
                                                deviceName
                                        },

                                        {
                                            Key:
                                                "RevertedBy",

                                            Value:
                                                revertedBy
                                        },

                                        {
                                            Key:
                                                "Team",

                                            Value:
                                                DEFAULT_TEAM
                                        }

                                    ]

                                }

                            ]

                        })
                    );


                replacementVolumeId =
                    createVolumeResult
                        .VolumeId;


                if (!replacementVolumeId) {

                    throw new Error(
                        `AWS did not return a replacement volume ID for snapshot ${item.snapshot_id}.`
                    );
                }


                await updateRevertItem(
                    item.id,
                    {
                        new_volume_id:
                            replacementVolumeId,

                        progress:
                            45
                    }
                );


                /*
                 * -------------------------------------------------
                 * STEP 3E: Wait for replacement volume
                 * -------------------------------------------------
                 */
                await waitForVolumeAvailable(
                    ec2,
                    replacementVolumeId
                );


                await updateRevertItem(
                    item.id,
                    {
                        progress:
                            60
                    }
                );


                /*
                 * -------------------------------------------------
                 * STEP 3F: Attach replacement volume
                 * -------------------------------------------------
                 */
                await ec2.send(
                    new AttachVolumeCommand({

                        VolumeId:
                            replacementVolumeId,

                        InstanceId:
                            instanceId,

                        Device:
                            deviceName

                    })
                );


                await waitForVolumeInUse(
                    ec2,
                    replacementVolumeId
                );


                await updateRevertItem(
                    item.id,
                    {
                        new_volume_id:
                            replacementVolumeId,

                        device_name:
                            deviceName,

                        availability_zone:
                            context.availabilityZone,

                        progress:
                            90
                    }
                );


                /*
                 * -------------------------------------------------
                 * STEP 3G: Mark completed
                 * -------------------------------------------------
                 */
                await updateRevertItem(
                    item.id,
                    {
                        status:
                            "completed",

                        progress:
                            100,

                        error_message:
                            null,

                        reverted_by:
                            revertedBy,

                        reverted_at:
                            new Date()
                    }
                );


                console.log(
                    `[${jobId}] Reverted ${item.original_volume_id} -> ${replacementVolumeId} on ${deviceName}.`
                );


                await updateRevertJobProgress(
                    jobId
                );

            } catch (error) {

                console.error(
                    `[${jobId}] Revert failed for ${item.original_volume_id}:`,
                    error
                );


                /*
                 * If the original volume was detached and the
                 * replacement could not be attached, attempt to
                 * restore the original attachment.
                 */
                if (
                    originalDetached
                ) {

                    const deviceName =
                        originalAttachments[
                            item.original_volume_id
                        ]?.deviceName ||
                        item.device_name;


                    if (deviceName) {

                        await attemptOriginalVolumeRecovery(
                            ec2,
                            instanceId,
                            item.original_volume_id,
                            deviceName
                        );
                    }
                }


                await updateRevertItem(
                    item.id,
                    {
                        status:
                            "failed",

                        progress:
                            0,

                        error_message:
                            String(
                                error?.message ||
                                error
                            ),

                        reverted_by:
                            revertedBy
                    }
                );


                await updateRevertJobProgress(
                    jobId
                );
            }
        }


        /*
         * -----------------------------------------------------
         * STEP 4: Start instance
         * -----------------------------------------------------
         */
        await startInstanceAndWait(
            ec2,
            instanceId
        );


        console.log(
            `[${jobId}] Instance ${instanceId} started.`
        );


        /*
         * Final aggregate status.
         */
        await updateRevertJobProgress(
            jobId
        );


        /*
         * If all volumes completed, explicitly make sure the
         * job has the completed timestamp.
         */
        const [finalItems] =
            await pool.query(
                `
                SELECT
                    status
                FROM revert_job_items
                WHERE job_id = ?
                `,
                [jobId]
            );


        const failed =
            finalItems.filter(
                item =>
                    item.status ===
                    "failed"
            ).length;


        const completed =
            finalItems.filter(
                item =>
                    item.status ===
                    "completed"
            ).length;


        let finalStatus =
            "running";


        if (
            completed +
            failed ===
            finalItems.length
        ) {

            if (
                failed ===
                finalItems.length
            ) {

                finalStatus =
                    "failed";

            } else if (
                failed > 0
            ) {

                finalStatus =
                    "completed_with_errors";

            } else {

                finalStatus =
                    "completed";
            }
        }


        await pool.query(
            `
            UPDATE revert_jobs
            SET

                status = ?,

                completed_volumes = ?,

                failed_volumes = ?,

                progress = ?,

                completed_at =
                    CASE
                        WHEN ? IN (
                            'completed',
                            'completed_with_errors',
                            'failed'
                        )
                        THEN COALESCE(
                            completed_at,
                            UTC_TIMESTAMP()
                        )
                        ELSE completed_at
                    END

            WHERE job_id = ?
            `,
            [

                finalStatus,

                completed,

                failed,

                finalItems.length
                    ? (
                        (
                            completed +
                            failed
                        ) /
                        finalItems.length
                    ) *
                    100
                    : 100,

                finalStatus,

                jobId

            ]
        );


        console.log(
            `[${jobId}] Revert workflow completed with status: ${finalStatus}.`
        );

    } catch (error) {

        console.error(
            `[${jobId}] Fatal revert error:`,
            error
        );


        /*
         * Try to start the instance even if the overall workflow
         * failed. This is important because the instance should
         * not remain stopped indefinitely because of an API error.
         */
        try {

            const result =
                await ec2.send(
                    new DescribeInstancesCommand({

                        InstanceIds: [
                            instanceId
                        ]

                    })
                );


            const state =
                result.Reservations?.[0]
                    ?.Instances?.[0]
                    ?.State?.Name;


            if (
                state ===
                "stopped"
            ) {

                await startInstanceAndWait(
                    ec2,
                    instanceId
                );

                console.log(
                    `[${jobId}] Instance ${instanceId} was started after fatal revert failure.`
                );
            }

        } catch (startError) {

            console.error(
                `[${jobId}] Unable to restart instance ${instanceId}:`,
                startError
            );
        }


        await pool.query(
            `
            UPDATE revert_jobs
            SET

                status =
                    'failed',

                error_message = ?,

                completed_at =
                    COALESCE(
                        completed_at,
                        UTC_TIMESTAMP()
                    )

            WHERE job_id = ?
            `,
            [

                String(
                    error?.message ||
                    error
                ),

                jobId

            ]
        );


        await pool.query(
            `
            UPDATE revert_job_items
            SET

                status =
                    CASE
                        WHEN status = 'completed'
                        THEN status
                        ELSE 'failed'
                    END,

                error_message =
                    CASE
                        WHEN status = 'completed'
                        THEN error_message
                        ELSE COALESCE(
                            error_message,
                            ?
                        )
                    END

            WHERE job_id = ?

              AND status NOT IN (
                  'completed',
                  'failed'
              )
            `,
            [

                String(
                    error?.message ||
                    error
                ),

                jobId

            ]
        );
    }
}


/* =========================================================
   REVERT DASHBOARD
========================================================= */

app.get(
    "/api/revert-dashboard",
    async (
        req,
        res
    ) => {

        try {

            const [summaryRows] =
                await pool.query(
                    `
                    SELECT

                        COUNT(*) AS total_jobs,

                        COALESCE(
                            SUM(
                                CASE
                                    WHEN status =
                                        'running'
                                    THEN 1
                                    ELSE 0
                                END
                            ),
                            0
                        ) AS running_jobs,

                        COALESCE(
                            SUM(
                                CASE
                                    WHEN status =
                                        'completed'
                                    THEN 1
                                    ELSE 0
                                END
                            ),
                            0
                        ) AS completed_jobs,

                        COALESCE(
                            SUM(
                                CASE
                                    WHEN status IN (
                                        'failed',
                                        'completed_with_errors'
                                    )
                                    THEN 1
                                    ELSE 0
                                END
                            ),
                            0
                        ) AS failed_jobs,

                        COALESCE(
                            SUM(
                                total_volumes
                            ),
                            0
                        ) AS total_volumes,

                        COALESCE(
                            SUM(
                                completed_volumes
                            ),
                            0
                        ) AS completed_volumes,

                        COALESCE(
                            SUM(
                                failed_volumes
                            ),
                            0
                        ) AS failed_volumes

                    FROM revert_jobs
                    `
                );


            const [jobRows] =
                await pool.query(
                    `
                    SELECT

                        job_id,

                        status,

                        reverted_by,

                        account_name,

                        region,

                        instance_name,

                        instance_id,

                        total_volumes,

                        total_snapshots,

                        completed_volumes,

                        failed_volumes,

                        progress,

                        error_message,

                        started_at,

                        completed_at,

                        updated_at

                    FROM revert_jobs

                    ORDER BY
                        started_at DESC

                    LIMIT 200
                    `
                );


            res.json({

                success:
                    true,

                summary:
                    summaryRows[0] || {

                        total_jobs:
                            0,

                        running_jobs:
                            0,

                        completed_jobs:
                            0,

                        failed_jobs:
                            0,

                        total_volumes:
                            0,

                        completed_volumes:
                            0,

                        failed_volumes:
                            0

                    },

                jobs:
                    jobRows

            });

        } catch (error) {

            console.error(
                "Get revert dashboard error:",
                error
            );


            res.status(500)
                .json({

                    success:
                        false,

                    error:
                        "Unable to load revert history."

                });
        }
    }
);


/* =========================================================
   REVERT JOB DETAILS
========================================================= */

app.get(
    "/api/revert-jobs/:jobId",
    async (
        req,
        res
    ) => {

        const jobId =
            req.params.jobId;


        try {

            const [jobRows] =
                await pool.query(
                    `
                    SELECT *
                    FROM revert_jobs
                    WHERE job_id = ?
                    LIMIT 1
                    `,
                    [jobId]
                );


            if (!jobRows.length) {

                return res.status(404)
                    .json({

                        success:
                            false,

                        error:
                            `Revert job ${jobId} not found.`

                    });
            }


            const [itemRows] =
                await pool.query(
                    `
                    SELECT

                        id,

                        job_id,

                        original_volume_id,

                        snapshot_id,

                        new_volume_id,

                        instance_name,

                        instance_id,

                        device_name,

                        availability_zone,

                        size,

                        volume_type,

                        status,

                        progress,

                        error_message,

                        reverted_by,

                        reverted_at,

                        created_at,

                        updated_at

                    FROM revert_job_items

                    WHERE job_id = ?

                    ORDER BY
                        id ASC
                    `,
                    [jobId]
                );


            res.json({

                success:
                    true,

                job:
                    jobRows[0],

                items:
                    itemRows

            });

        } catch (error) {

            console.error(
                `Get revert job ${jobId} error:`,
                error
            );


            res.status(500)
                .json({

                    success:
                        false,

                    error:
                        "Unable to load revert job details."

                });
        }
    }
);


/* =========================================================
   REVERT JOB REFRESH
========================================================= */

app.post(
    "/api/revert-jobs/:jobId/refresh",
    async (
        req,
        res
    ) => {

        const jobId =
            req.params.jobId;


        try {

            const [jobs] =
                await pool.query(
                    `
                    SELECT *
                    FROM revert_jobs
                    WHERE job_id = ?
                    LIMIT 1
                    `,
                    [jobId]
                );


            if (!jobs.length) {

                return res.status(404)
                    .json({

                        success:
                            false,

                        error:
                            "Revert job not found."

                    });
            }


            /*
             * The actual revert worker updates the database.
             * Refresh simply returns the current database state.
             */
            await updateRevertJobProgress(
                jobId
            );


            const [jobRows] =
                await pool.query(
                    `
                    SELECT *
                    FROM revert_jobs
                    WHERE job_id = ?
                    LIMIT 1
                    `,
                    [jobId]
                );


            const [itemRows] =
                await pool.query(
                    `
                    SELECT *
                    FROM revert_job_items
                    WHERE job_id = ?
                    ORDER BY id ASC
                    `,
                    [jobId]
                );


            res.json({

                success:
                    true,

                job:
                    jobRows[0],

                items:
                    itemRows

            });

        } catch (error) {

            console.error(
                `Refresh revert job ${jobId} error:`,
                error
            );


            res.status(500)
                .json({

                    success:
                        false,

                    error:
                        "Unable to refresh revert job."

                });
        }
    }
);


/* =========================================================
   CATCH-ALL
========================================================= */

app.get(
    "*",
    (
        req,
        res
    ) => {

        res.sendFile(
            path.join(
                __dirname,
                "public",
                "index.html"
            )
        );
    }
);


/* =========================================================
   START
========================================================= */

async function start() {

    try {

        await initializeDatabase();


        console.log(
            "MySQL database initialized."
        );


        console.log(
            "Snapshot timeout:",
            SNAPSHOT_TIMEOUT_HOURS,
            "hours"
        );


        console.log(
            "Snapshot poll interval:",
            POLL_INTERVAL_MS,
            "ms"
        );


        console.log(
            "Revert timeout:",
            REVERT_TIMEOUT_HOURS,
            "hours"
        );


        app.listen(
            PORT,
            "127.0.0.1",
            () => {

                console.log(
                    `AWS Snapshot Portal running on port ${PORT}`
                );

                console.log(
                    `http://127.0.0.1:${PORT}`
                );

            }
        );

    } catch (error) {

        console.error(
            "Failed to start application:"
        );

        console.error(
            error
        );

        process.exit(1);
    }
}


start();

