from types import SimpleNamespace
from unittest.mock import Mock, patch

from aliyunsdkcore.acs_exception.exceptions import ClientException

from rescene_api.storage import OssStorage, TemporaryCredentials


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


def test_delete_uses_sts_scoped_to_one_object() -> None:
    storage = object.__new__(OssStorage)
    storage.config = SimpleNamespace(oss_bucket="bucket", oss_endpoint="https://oss-cn-beijing.aliyuncs.com")
    storage.assume = Mock(return_value=TemporaryCredentials("id", "secret", "token", "later"))
    key = "projects/project/assets/asset/original/image.png"

    with patch("rescene_api.storage.oss2.StsAuth") as auth, patch("rescene_api.storage.oss2.Bucket") as bucket:
        storage.delete(key)

    assert storage.assume.call_args.args[1] == [
        {"Effect": "Allow", "Resource": [f"acs:oss:*:*:bucket/{key}"], "Action": ["oss:DeleteObject"]}
    ]
    auth.assert_called_once_with("id", "secret", "token")
    bucket.assert_called_once_with(auth.return_value, storage.config.oss_endpoint, storage.config.oss_bucket)
    bucket.return_value.delete_object.assert_called_once_with(key)


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


def test_preview_scopes_read_and_signs_fixed_small_image() -> None:
    storage = object.__new__(OssStorage)
    storage.config = SimpleNamespace(oss_bucket="bucket", oss_endpoint="https://oss-cn-beijing.aliyuncs.com")
    storage.assume = Mock(return_value=TemporaryCredentials("id", "secret", "token", "later"))
    key = "projects/p/assets/a/original/image.jpg"
    with patch("rescene_api.storage.oss2.StsAuth") as auth, patch("rescene_api.storage.oss2.Bucket") as bucket:
        storage.signed_preview(key)
    auth.assert_called_once_with("id", "secret", "token")
    assert storage.assume.call_args.args[1] == [
        {"Effect": "Allow", "Action": ["oss:GetObject"], "Resource": [f"acs:oss:*:*:bucket/{key}"]}
    ]
    bucket.return_value.sign_url.assert_called_once_with(
        "GET", key, 300, params={"x-oss-process": "image/resize,m_lfit,w_320,h_320/auto-orient,1"}
    )
