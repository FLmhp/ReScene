import os

import pytest

# Set these before any API module is imported during test collection. PostgreSQL
# smoke tests use a separate, explicitly configured engine and temporary schema.
os.environ["RESCENE_DATABASE_URL"] = "sqlite+pysqlite:///:memory:"
os.environ["RESCENE_JWT_SECRET"] = "test-secret-that-is-at-least-32-bytes"


@pytest.fixture(autouse=True)
def isolate_api_database(request):
    if not request.node.path.name.startswith("test_api"):
        yield
        return

    from rescene_api.config import settings
    from rescene_api.db import Base, engine, init_db
    from rescene_api.ratelimit import limiter

    settings.cache_clear()
    init_db()
    limiter.reset()

    def clear():
        with engine.begin() as connection:
            for table in reversed(Base.metadata.sorted_tables):
                connection.execute(table.delete())

    clear()
    yield
    clear()
    limiter.reset()
    settings.cache_clear()
