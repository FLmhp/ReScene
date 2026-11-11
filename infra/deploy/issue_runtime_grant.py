"""Issue a private OSS runtime-bundle grant from the API container."""

import json
import sys

from rescene_api.config import settings
from rescene_api.storage import OssStorage, credentials_dict

config = settings()
prefix = f"acs:oss:*:*:{config.oss_bucket}/projects/system/runtime-bundles/5090-cu130-v1/*"
actions = ["oss:GetObject"]
if sys.argv[1:] == ["publish"]:
    actions.extend([
        "oss:PutObject", "oss:InitiateMultipartUpload", "oss:UploadPart", "oss:ListParts",
        "oss:CompleteMultipartUpload", "oss:AbortMultipartUpload",
    ])
grant = OssStorage(config).assume("rescene-runtime-bundle", [
    {"Effect": "Allow", "Resource": [prefix], "Action": actions},
])
print(json.dumps(credentials_dict(grant, config)))
