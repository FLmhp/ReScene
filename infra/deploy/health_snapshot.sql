BEGIN TRANSACTION READ ONLY;

SELECT json_build_object(
    'queued', (SELECT count(*) FROM reconstruction_jobs WHERE status = 'QUEUED'),
    'oldest_queue_wait_seconds', (
        SELECT floor(extract(epoch FROM (now() - min(updated_at))))
        FROM reconstruction_jobs WHERE status = 'QUEUED'
    ),
    'active', (SELECT count(*) FROM reconstruction_jobs WHERE status IN ('LEASED', 'RUNNING')),
    'latest_worker_heartbeat', (SELECT max(last_seen_at) FROM worker_nodes),
    'failures_last_24h', coalesce((
        SELECT json_object_agg(failure, total) FROM (
            SELECT coalesce(error_code, 'UNKNOWN') AS failure, count(*) AS total
            FROM reconstruction_jobs
            WHERE status = 'FAILED' AND updated_at >= now() - interval '24 hours'
            GROUP BY 1
        ) AS counts
    ), '{}'::json)
);

ROLLBACK;
