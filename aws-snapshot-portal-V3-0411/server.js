use strict";

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
    CreateVolumeCommand,
    DetachVolumeCommand,
    AttachVolumeCommand,
    StopInstancesCommand,
    StartInstancesCommand
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
         * Parent table.
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
         * Child table.
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
         * Revert tasks table.
         */
        await connection.query(`
            CREATE TABLE IF NOT EXISTS revert_jobs (

                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

                job_id VARCHAR(100) NOT NULL,

                instance_id VARCHAR(100) NOT NULL,

                volume_id VARCHAR(100) NOT NULL,

                snapshot_id VARCHAR(100) NOT NULL,

                status VARCHAR(50) NOT NULL DEFAULT 'running',

                started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

                PRIMARY KEY (id),

                KEY idx_revert_job_id (job_id)

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
        "REV-" +
        Date.now() +
        "-" +
        Math.random()
            .toString(36)
            .substring(2, 6)
            .toUpperCase()
    );
}


/*
 * AWS returns snapshot progress as values such as:
 *
 * "0%"
 * "25%"
 * "50%"
 * "100%"
 *
 * Number("50%") returns NaN.
 *
 * This function safely converts all supported
 * values into a number between 0 and 100.
 */
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


/* =========================================================
   AWS CONFIG
========================================================= */

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


    /*
     * Direct instance ID.
     */
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


    /*
     * Instance Name tag.
     */
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


/* =========================================================
   INSTANCE NAME
========================================================= */

function getInstanceName(
    instance
) {

    const tag =
        (
            instance.Tags ||
            []
        ).find(
            item =>
                item.Key ===
                "Name"
        );

    return (
        tag?.Value ||
        instance.InstanceId ||
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


    return (
        result.Volumes ||
        []
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
   UPDATE JOB PROGRESS
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


        /*
         * IMPORTANT:
         *
         * AWS may return:
         *
         * "0%"
         * "20%"
         * "75%"
         * "100%"
         *
         * Never use Number("20%").
         */
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


            /*
             * Create parent job first.
             */
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


            /*
             * Process every input instance.
             */
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


                /*
                 * One snapshot per EBS volume.
                 */
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


                        /*
                         * Apply AWS tags.
                         */
                        await createSnapshotTags(
                            ec2,
                            snapshotId,
                            item
                        );


                        /*
                         * Store successful snapshot.
                         */
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


                        /*
                         * Store failed snapshot item.
                         */
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


            /*
             * Update parent job counters.
             */
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


            /*
             * Calculate initial job status.
             */
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
   REVERT / RESTORE SNAPSHOTS (PARALLEL WORKFLOW EXECUTION)
========================================================= */

app.post(
    "/api/aws/revert-snapshots",
    async (req, res) => {
        try {
            const { tasks } = req.body;

            if (!Array.isArray(tasks) || !tasks.length) {
                return res.status(400).json({
                    success: false,
                    error: "No restoration tasks provided."
                });
            }

            const revertJobId = generateRevertJobId();
            const firstTask = tasks[0];

            // Insert job into database as running
            await pool.query(
                `
                INSERT INTO revert_jobs (job_id, instance_id, volume_id, snapshot_id, status)
                VALUES (?, ?, ?, ?, 'running')
                `,
                [revertJobId, firstTask.instanceId, firstTask.volumeId, firstTask.snapshotId]
            );

            // Respond immediately to client so UI navigates smoothly without hanging
            res.json({
                success: true,
                message: "Reversion pipeline dispatched successfully.",
                jobId: revertJobId
            });

            // Execute AWS orchestration in background worker function
            processRevertJobBackground(req.body, revertJobId, tasks).catch(err => {
                console.error(`Background revert job ${revertJobId} failed:`, err);
            });

        } catch (error) {
            console.error("Revert snapshots error:", error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
);

async function processRevertJobBackground(body, revertJobId, tasks) {
    const ec2 = createEc2Client(body);

    for (const task of tasks) {
        const { instanceId, volumeId, snapshotId } = task;
        try {
            const volDesc = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
            const targetVolume = volDesc.Volumes?.[0];
            if (!targetVolume) throw new Error(`Volume ${volumeId} not found.`);

            const availabilityZone = targetVolume.AvailabilityZone;
            const attachment = targetVolume.Attachments?.[0];
            const deviceName = attachment ? attachment.Device : "/dev/sda1";

            // 1. Stop Instance
            console.log(`Stopping instance ${instanceId}...`);
            await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
            await new Promise(r => setTimeout(r, 10000)); // buffer for stop state

            // 2. Detach old volume
            if (attachment) {
                console.log(`Detaching volume ${volumeId}...`);
                await ec2.send(new DetachVolumeCommand({ VolumeId: volumeId, InstanceId: instanceId }));
                await new Promise(r => setTimeout(r, 8000));
            }

            // 3. Create volume from snapshot
            console.log(`Creating volume from snapshot ${snapshotId}...`);
            const newVol = await ec2.send(new CreateVolumeCommand({
                SnapshotId: snapshotId,
                AvailabilityZone: availabilityZone,
                VolumeType: targetVolume.VolumeType || "gp3"
            }));
            const newVolumeId = newVol.VolumeId;
            await new Promise(r => setTimeout(r, 8000));

            // 4. Attach new volume
            console.log(`Attaching new volume ${newVolumeId} to ${instanceId}...`);
            await ec2.send(new AttachVolumeCommand({
                VolumeId: newVolumeId,
                InstanceId: instanceId,
                Device: deviceName
            }));

            // 5. Start instance
            console.log(`Starting instance ${instanceId}...`);
            await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));

            await pool.query(
                `UPDATE revert_jobs SET status = 'completed', volume_id = ? WHERE job_id = ?`,
                [newVolumeId, revertJobId]
            );
        } catch (err) {
            console.error(`Task error for instance ${instanceId}:`, err);
            await pool.query(
                `UPDATE revert_jobs SET status = 'failed' WHERE job_id = ?`,
                [revertJobId]
            );
        }
    }
}
/* =========================================================
   REVERT DASHBOARD JOBS ENDPOINT
========================================================= */

app.get(
    "/api/revert-dashboard",
    async (req, res) => {
        try {
            const [jobs] = await pool.query(
                `SELECT job_id, instance_id, volume_id, snapshot_id, status, started_at
                 FROM revert_jobs
                 ORDER BY started_at DESC LIMIT 50`
            );

            const [summaryRows] = await pool.query(
                `SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
                    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
                    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
                 FROM revert_jobs`
            );

            const summary = summaryRows[0] || { total: 0, running: 0, completed: 0, failed: 0 };

            res.json({
                success: true,
                summary: {
                    total: Number(summary.total || 0),
                    running: Number(summary.running || 0),
                    completed: Number(summary.completed || 0),
                    failed: Number(summary.failed || 0)
                },
                jobs
            });
        } catch (error) {
            console.error("Revert dashboard error:", error);
            res.status(500).json({ success: false, error: error.message });
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
   OPTIONAL: MANUAL SNAPSHOT JOB SYNC
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
function createEc2Client(body) {
    return new EC2Client({
        region: body.region,
        credentials: {
            accessKeyId: body.accessKeyId,
            secretAccessKey: body.secretAccessKey,
            sessionToken: body.sessionToken || ""
        }
    });
}

function generateRevertJobId() {
    return "REV-" + Date.now() + "-" + Math.random().toString(36).substring(2, 6).toUpperCase();
}

/* =========================================================
   ASYNCHRONOUS REVERT SNAPSHOTS ENDPOINT
========================================================= */

app.post("/api/aws/revert-snapshots", async (req, res) => {
    try {
        const { tasks } = req.body;
        if (!Array.isArray(tasks) || !tasks.length) {
            return res.status(400).json({ success: false, error: "No tasks provided." });
        }

        const dispatchedJobs = [];

        for (const task of tasks) {
            const { instanceId, volumeId, snapshotId } = task;
            const jobId = generateRevertJobId();

            await pool.query(
                `INSERT INTO revert_jobs (job_id, instance_id, volume_id, snapshot_id, status) VALUES (?, ?, ?, ?, 'running')`,
                [jobId, instanceId, volumeId, snapshotId]
            );

            dispatchedJobs.push({ jobId, instanceId, volumeId, snapshotId });

            // Run AWS orchestration in background
            processRevertJob(req.body, jobId, instanceId, volumeId, snapshotId).catch(err => {
                console.error(`Job ${jobId} failed:`, err);
            });
        }

        res.json({
            success: true,
            message: "Revert pipeline dispatched successfully.",
            jobs: dispatchedJobs
        });
    } catch (error) {
        console.error("Revert route error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

async function processRevertJob(body, jobId, instanceId, volumeId, snapshotId) {
    const ec2 = createEc2Client(body);
    try {
        const volDesc = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
        const targetVolume = volDesc.Volumes?.[0];
        if (!targetVolume) throw new Error(`Original volume ${volumeId} not found.`);

        const availabilityZone = targetVolume.AvailabilityZone;
        const attachment = targetVolume.Attachments?.[0];
        const deviceName = attachment ? attachment.Device : "/dev/sda1";

        // Step 1: Stop EC2 Instance
        await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
        await new Promise(r => setTimeout(r, 8000));

        // Step 2: Detach volume
        if (attachment) {
            await ec2.send(new DetachVolumeCommand({ VolumeId: volumeId, InstanceId: instanceId }));
            await new Promise(r => setTimeout(r, 6000));
        }

        // Step 3: Create new volume from snapshot
        const newVol = await ec2.send(new CreateVolumeCommand({
            SnapshotId: snapshotId,
            AvailabilityZone: availabilityZone,
            VolumeType: targetVolume.VolumeType || "gp3"
        }));
        await new Promise(r => setTimeout(r, 6000));

        // Step 4: Attach new volume
        await ec2.send(new AttachVolumeCommand({
            VolumeId: newVol.VolumeId,
            InstanceId: instanceId,
            Device: deviceName
        }));

        // Step 5: Start Instance
        await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));

        await pool.query(`UPDATE revert_jobs SET status = 'completed', volume_id = ? WHERE job_id = ?`, [newVol.VolumeId, jobId]);
    } catch (err) {
        await pool.query(`UPDATE revert_jobs SET status = 'failed' WHERE job_id = ?`, [jobId]);
    }
}
/* =========================================================
   CENTRALIZED MULTI-ACCOUNT DASHBOARD ENDPOINT
========================================================= */
app.post(
    "/api/aws/centralized-dashboard",
    async (req, res) => {
        try {
            const { accounts } = req.body;
            if (!Array.isArray(accounts) || !accounts.length) {
                return res.json({ success: true, summary: { instances: 0, volumes: 0, snapshots: 0, storageGB: 0 }, accountsData: [] });
            }

            let totalInstances = 0;
            let totalVolumes = 0;
            let totalSnapshots = 0;
            let totalStorageGB = 0;
            const accountsData = [];

            for (const acc of accounts) {
                try {
                    const ec2 = createEc2Client({
                        accessKeyId: acc.accessKeyId,
                        secretAccessKey: acc.secretAccessKey,
                        sessionToken: acc.sessionToken || "",
                        region: acc.region || "us-west-1"
                    });

                    const [instRes, volRes, snapRes] = await Promise.all([
                        ec2.send(new DescribeInstancesCommand({ Filters: [{ Name: "instance-state-name", Values: ["running", "stopped"] }] })),
                        ec2.send(new DescribeVolumesCommand({})),
                        ec2.send(new DescribeSnapshotsCommand({ OwnerIds: ["self"] }))
                    ]);

                    let accStorage = 0;
                    (volRes.Volumes || []).forEach(v => { accStorage += (v.Size || 0); });

                    const instCount = (instRes.Reservations || []).reduce((accSum, r) => accSum + (r.Instances?.length || 0), 0);
                    const volCount = (volRes.Volumes || []).length;
                    const snapCount = (snapRes.Snapshots || []).length;

                    totalInstances += instCount;
                    totalVolumes += volCount;
                    totalSnapshots += snapCount;
                    totalStorageGB += accStorage;

                    accountsData.push({
                        id: acc.id,
                        name: acc.name,
                        region: acc.region || "us-west-1",
                        status: "connected",
                        instances: instCount,
                        volumes: volCount,
                        snapshots: snapCount,
                        storageGB: accStorage
                    });
                } catch (err) {
                    accountsData.push({
                        id: acc.id,
                        name: acc.name,
                        region: acc.region || "us-west-1",
                        status: "error",
                        error: err.message,
                        instances: 0,
                        volumes: 0,
                        snapshots: 0,
                        storageGB: 0
                    });
                }
            }

            res.json({
                success: true,
                summary: {
                    instances: totalInstances,
                    volumes: totalVolumes,
                    snapshots: totalSnapshots,
                    storageGB: totalStorageGB,
                    accountCount: accounts.length
                },
                accountsData
            });
        } catch (error) {
            console.error("Centralized dashboard error:", error);
            res.status(500).json({ success: false, error: error.message });
        }
    }
);
start();
