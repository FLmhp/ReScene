from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import oss2
from aliyunsdkcore.acs_exception.exceptions import ClientException
from aliyunsdkcore.client import AcsClient
from aliyunsdksts.request.v20150401.AssumeRoleRequest import AssumeRoleRequest

from rescene_api.config import Settings

POST_OBJECT_LIMIT = 5 * 1024**3
POST_OBJECT_TTL_SECONDS = 3600


@dataclass(frozen=True)
class TemporaryCredentials:
    access_key_id: str
    access_key_secret: str
    security_token: str
    expiration: str


class OssStorage:
    def __init__(self, config: Settings) -> None:
        required = (
            config.oss_endpoint,
            config.oss_bucket,
            config.oss_access_key_id,
            config.oss_access_key_secret,
            config.oss_role_arn,
        )
        if not all(required):
            raise RuntimeError("OSS is not configured")
        self.config = config
        region = config.oss_endpoint.split("oss-")[1].split(".")[0] if "oss-" in config.oss_endpoint else "cn-beijing"
        self.client = AcsClient(config.oss_access_key_id, config.oss_access_key_secret, region)

    def assume(self, session_name: str, statements: list[dict[str, object]]) -> TemporaryCredentials:
        request = AssumeRoleRequest()
        request.set_accept_format("json")
        request.set_RoleArn(self.config.oss_role_arn)
        request.set_RoleSessionName(session_name[:64])
        request.set_DurationSeconds(3600)
        request.set_Policy(
            json.dumps(
                {
                    "Version": "1",
                    "Statement": statements,
                }
            )
        )
        for attempt in range(3):
            try:
                response = json.loads(self.client.do_action_with_exception(request))
                break
            except ClientException as error:
                if error.get_error_code() != "SDK.HttpError" or attempt == 2:
                    raise
                time.sleep(2**attempt)
        else:
            raise AssertionError("STS retry loop exhausted")
        item = response["Credentials"]
        return TemporaryCredentials(
            access_key_id=item["AccessKeyId"],
            access_key_secret=item["AccessKeySecret"],
            security_token=item["SecurityToken"],
            expiration=item["Expiration"],
        )

    def upload_credentials(self, object_key: str, session_name: str) -> TemporaryCredentials:
        resource = f"acs:oss:*:*:{self.config.oss_bucket}/{object_key}"
        return self.assume(
            session_name,
            [
                {
                    "Effect": "Allow",
                    "Resource": [resource],
                    "Action": [
                        "oss:PutObject",
                        "oss:InitiateMultipartUpload",
                        "oss:UploadPart",
                        "oss:CompleteMultipartUpload",
                        "oss:AbortMultipartUpload",
                        "oss:ListParts",
                    ],
                }
            ],
        )

    def worker_credentials(self, project_id: str, job_id: str, attempt: int) -> TemporaryCredentials:
        """Permit project input and checkpoint reads, with writes scoped to one attempt."""
        input_resource = f"acs:oss:*:*:{self.config.oss_bucket}/projects/{project_id}/assets/*"
        job_resource = f"acs:oss:*:*:{self.config.oss_bucket}/projects/{project_id}/jobs/{job_id}"
        return self.assume(
            f"worker-{job_id}",
            [
                {"Effect": "Allow", "Resource": [input_resource, f"{job_resource}/*"], "Action": ["oss:GetObject"]},
                {
                    "Effect": "Allow",
                    "Resource": [f"{job_resource}/attempts/{attempt}/*"],
                    "Action": [
                        "oss:PutObject",
                        "oss:InitiateMultipartUpload",
                        "oss:UploadPart",
                        "oss:CompleteMultipartUpload",
                        "oss:AbortMultipartUpload",
                        "oss:ListParts",
                    ],
                },
            ],
        )

    def post_target(self) -> str:
        """Public form action for a browser or Mini Program PostObject upload."""
        endpoint = str(self.config.oss_endpoint).split("://", 1)[-1].rstrip("/")
        return f"https://{self.config.oss_bucket}.{endpoint}"

    def post_fields(self, object_key: str, max_size: int, credentials: TemporaryCredentials) -> dict[str, str]:
        """Sign a one-key policy with the STS credentials granted for that object."""
        policy = base64.b64encode(
            json.dumps(
                {
                    "expiration": (datetime.now(UTC) + timedelta(seconds=POST_OBJECT_TTL_SECONDS)).strftime(
                        "%Y-%m-%dT%H:%M:%SZ"
                    ),
                    "conditions": [
                        {"bucket": self.config.oss_bucket},
                        ["eq", "$key", object_key],
                        ["content-length-range", 1, min(max_size, POST_OBJECT_LIMIT)],
                    ],
                }
            ).encode()
        ).decode()
        signature = base64.b64encode(
            hmac.new(credentials.access_key_secret.encode(), policy.encode(), hashlib.sha1).digest()
        ).decode()
        return {
            "key": object_key,
            "policy": policy,
            "OSSAccessKeyId": credentials.access_key_id,
            "signature": signature,
            "x-oss-security-token": credentials.security_token,
            "success_action_status": "200",
        }

    def head(self, object_key: str) -> tuple[int, str]:
        auth = oss2.Auth(self.config.oss_access_key_id, self.config.oss_access_key_secret)
        bucket = oss2.Bucket(auth, self.config.oss_endpoint, self.config.oss_bucket)
        result = bucket.head_object(object_key)
        return int(result.content_length), str(result.content_type or "application/octet-stream")

    def delete(self, object_key: str) -> None:
        """Remove one object; callers tolerate NotFound for never-written uploads."""
        auth = oss2.Auth(self.config.oss_access_key_id, self.config.oss_access_key_secret)
        bucket = oss2.Bucket(auth, self.config.oss_endpoint, self.config.oss_bucket)
        bucket.delete_object(object_key)

    def signed_get(self, object_key: str, expires: int = 900) -> str:
        auth = oss2.Auth(self.config.oss_access_key_id, self.config.oss_access_key_secret)
        bucket = oss2.Bucket(auth, self.config.oss_endpoint, self.config.oss_bucket)
        return bucket.sign_url("GET", object_key, expires)


def credentials_dict(credentials: TemporaryCredentials, config: Settings) -> dict[str, str]:
    return {
        "access_key_id": credentials.access_key_id,
        "access_key_secret": credentials.access_key_secret,
        "security_token": credentials.security_token,
        "expiration": credentials.expiration,
        "endpoint": str(config.oss_endpoint),
        "region": config.oss_region,
        "bucket": str(config.oss_bucket),
        "issued_at": datetime.now(UTC).isoformat(),
    }
