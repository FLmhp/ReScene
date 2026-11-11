"""Issue a short-lived admin token without exposing the admin password."""

import base64
import json
import urllib.request
from pathlib import Path

body = json.dumps(
    {
        "email": "admin@rescene.xyz",
        "password": Path("/run/secrets/admin_password").read_text(encoding="utf-8").strip(),
    }
).encode()
request = urllib.request.Request(
    "http://127.0.0.1:8000/v1/auth/login",
    data=body,
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(request, timeout=20) as response:
    token = json.loads(response.read())["access_token"].encode()
    print(base64.b64encode(token).decode())
