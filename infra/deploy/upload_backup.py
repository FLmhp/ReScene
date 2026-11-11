"""Upload the newest PostgreSQL backup with a narrowly scoped STS session."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import oss2
from aliyunsdkcore.acs_exception.exceptions import ClientException
from aliyunsdkcore.client import AcsClient
from aliyunsdksts.request.v20150401.AssumeRoleRequest import AssumeRoleRequest

backup = max(Path("/backups").glob("rescene-*.dump"), key=lambda path: path.stat().st_mtime)
bucket_name = os.environ["RESCENE_OSS_BUCKET"]
endpoint = os.environ["RESCENE_OSS_ENDPOINT"]
access_key_id = os.environ["RESCENE_OSS_ACCESS_KEY_ID"]
access_key_secret = Path(os.environ["RESCENE_OSS_ACCESS_KEY_SECRET_FILE"]).read_text().strip()
role_arn = os.environ["RESCENE_OSS_ROLE_ARN"]
object_key = f"projects/system/backups/postgresql/weekly/{backup.name}"

client = AcsClient(access_key_id, access_key_secret, "cn-beijing")
request = AssumeRoleRequest()
request.set_protocol_type("https")
request.set_RoleArn(role_arn)
request.set_RoleSessionName("rescene-postgres-backup")
request.set_DurationSeconds(900)
request.set_Policy(
    json.dumps(
        {
            "Version": "1",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Action": ["oss:GetObject", "oss:PutObject"],
                    "Resource": [f"acs:oss:*:*:{bucket_name}/{object_key}"],
                }
            ],
        }
    )
)
for attempt in range(3):
    try:
        response = json.loads(client.do_action_with_exception(request))
        break
    except ClientException as error:
        if error.get_error_code() != "SDK.HttpError" or attempt == 2:
            raise
        time.sleep(2**attempt)
else:
    raise AssertionError("STS retry loop exhausted")
credentials = response["Credentials"]
auth = oss2.StsAuth(
    credentials["AccessKeyId"],
    credentials["AccessKeySecret"],
    credentials["SecurityToken"],
)
bucket = oss2.Bucket(auth, endpoint, bucket_name)
bucket.put_object_from_file(object_key, str(backup))
result = bucket.head_object(object_key)
if result.content_length != backup.stat().st_size:
    raise RuntimeError("OSS backup size verification failed")
print(json.dumps({"object_key": object_key, "size": result.content_length}, sort_keys=True))
