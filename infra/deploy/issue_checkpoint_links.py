"""Issue short-lived links to successful Job checkpoints for an operator."""

import json
import sys

from rescene_api.config import settings
from rescene_api.db import SessionLocal
from rescene_api.models import ReconstructionJob
from rescene_api.storage import OssStorage

with SessionLocal() as db:
    store = OssStorage(settings())
    results = {}
    for job_id in sys.argv[1:]:
        job = db.get(ReconstructionJob, job_id)
        assert job and job.status == "SUCCEEDED" and job.resume_artifact_key
        assert job.resume_artifact_key.startswith(f"projects/{job.project_id}/jobs/{job.id}/")
        results[job_id] = store.signed_get(job.resume_artifact_key, expires=1800)
    print(json.dumps(results))
