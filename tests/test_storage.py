from types import SimpleNamespace
from unittest.mock import Mock, patch

from aliyunsdkcore.acs_exception.exceptions import ClientException

from rescene_api.storage import OssStorage


def test_worker_policy_cannot_write_input_assets() -> None:
    storage = object.__new__(OssStorage)
    storage.config = SimpleNamespace(oss_bucket="bucket")
    storage.assume = Mock(return_value="credentials")

    assert storage.worker_credentials("project", "job", 2) == "credentials"
    statements = storage.assume.call_args.args[1]
    assert statements[0]["Action"] == ["oss:GetObject"]
    assert statements[0]["Resource"] == [
        "acs:oss:*:*:bucket/projects/project/assets/*",
        "acs:oss:*:*:bucket/projects/project/jobs/job/*",
    ]
    assert statements[1]["Resource"] == ["acs:oss:*:*:bucket/projects/project/jobs/job/attempts/2/*"]
    assert "oss:PutObject" in statements[1]["Action"]


def test_sts_retries_transient_http_error() -> None:
    storage = object.__new__(OssStorage)
    storage.config = SimpleNamespace(oss_role_arn="acs:ram::1:role/test")
    storage.client = Mock()
    storage.client.do_action_with_exception.side_effect = [
        ClientException("SDK.HttpError", "reset"),
        b'{"Credentials":{"AccessKeyId":"id","AccessKeySecret":"secret","SecurityToken":"token","Expiration":"later"}}',
    ]

    with patch("rescene_api.storage.time.sleep"):
        credentials = storage.assume("test", [])

    assert credentials.access_key_id == "id"
    assert storage.client.do_action_with_exception.call_count == 2
