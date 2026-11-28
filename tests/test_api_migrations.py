import os
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.pool import StaticPool

from rescene_api import db
from rescene_api.models import JobLog


@pytest.fixture(params=["sqlite", "postgresql"])
def migration_engine(request, monkeypatch):
    if request.param == "sqlite":
        engine = create_engine("sqlite://", poolclass=StaticPool)
        admin = None
    else:
        url = os.environ.get("RESCENE_TEST_POSTGRES_URL")
        if not url:
            pytest.skip("Set RESCENE_TEST_POSTGRES_URL to run PostgreSQL migration tests")
        if make_url(url).get_backend_name() != "postgresql":
            pytest.fail("RESCENE_TEST_POSTGRES_URL must point to a disposable PostgreSQL database")
        schema = f"rescene_migration_{uuid4().hex}"
        admin = create_engine(url)
        with admin.begin() as connection:
            connection.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
        engine = create_engine(url)

        @event.listens_for(engine, "connect")
        def set_search_path(connection, _):
            with connection.cursor() as cursor:
                cursor.execute(f'SET search_path TO "{schema}"')
            connection.commit()

    monkeypatch.setattr(db, "engine", engine)
    try:
        yield engine
    finally:
        engine.dispose()
        if admin is not None:
            with admin.begin() as connection:
                connection.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')
            admin.dispose()


def migrate(engine, revision):
    with engine.begin() as connection:
        config = Config()
        config.set_main_option("script_location", "rescene_api:migrations")
        config.attributes["connection"] = connection
        command.upgrade(config, revision)


def test_legacy_adoption_preserves_data_and_ignores_unrelated_tables(migration_engine):
    migrate(migration_engine, "0001")
    with migration_engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO users (id, email, password_hash, is_admin, active, created_at) VALUES "
                "('legacy', 'legacy@example.com', 'hash', false, true, CURRENT_TIMESTAMP)"
            )
        )
        connection.execute(text("CREATE TABLE external_table (id INTEGER PRIMARY KEY)"))
        connection.execute(text("DROP TABLE alembic_version"))
    db.init_db()
    db.init_db()
    with migration_engine.connect() as connection:
        assert connection.scalar(text("SELECT email FROM users WHERE id = 'legacy'")) == "legacy@example.com"
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0012"
        assert "external_table" in inspect(connection).get_table_names()
        assert "token_version" in {column["name"] for column in inspect(connection).get_columns("users")}


def test_missing_legacy_index_is_refused_without_stamp(migration_engine):
    migrate(migration_engine, "0001")
    with migration_engine.begin() as connection:
        connection.execute(text("DROP INDEX ix_users_email"))
        connection.execute(text("DROP TABLE alembic_version"))
    with pytest.raises(RuntimeError, match="ix_users_email"):
        db.init_db()
    assert "alembic_version" not in inspect(migration_engine).get_table_names()


def test_missing_legacy_primary_key_is_refused_without_stamp(migration_engine):
    migrate(migration_engine, "0001")
    with migration_engine.begin() as connection:
        cascade = " CASCADE" if connection.dialect.name == "postgresql" else ""
        connection.execute(text(f"DROP TABLE users{cascade}"))
        connection.execute(
            text(
                "CREATE TABLE users (id VARCHAR(36) NOT NULL, email VARCHAR(320) NOT NULL, "
                "password_hash TEXT NOT NULL, is_admin BOOLEAN NOT NULL, active BOOLEAN NOT NULL, "
                "created_at TIMESTAMP NOT NULL)"
            )
        )
        connection.execute(text("CREATE UNIQUE INDEX ix_users_email ON users (email)"))
        connection.execute(text("DROP TABLE alembic_version"))
    with pytest.raises(RuntimeError, match="primary_key"):
        db.init_db()
    assert "alembic_version" not in inspect(migration_engine).get_table_names()


def test_unmarked_head_is_refused_without_stamp(migration_engine):
    migrate(migration_engine, "head")
    with migration_engine.begin() as connection:
        connection.execute(text("DROP TABLE alembic_version"))
    with pytest.raises(RuntimeError, match="revision 0001"):
        db.init_db()
    assert "alembic_version" not in inspect(migration_engine).get_table_names()


def test_versioned_legacy_database_upgrades(migration_engine):
    migrate(migration_engine, "0001")
    db.init_db()
    with migration_engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0012"


def test_job_log_composite_index_upgrades_from_0009(migration_engine):
    migrate(migration_engine, "0009")
    migrate(migration_engine, "head")
    with migration_engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0012"
        indexes = {index["name"]: index["column_names"] for index in inspect(connection).get_indexes("job_logs")}
    assert indexes["ix_job_logs_job_id_id"] == ["job_id", "id"]
    assert any(
        index.name == "ix_job_logs_job_id_id" and [column.name for column in index.columns] == ["job_id", "id"]
        for index in JobLog.__table__.indexes
    )


def test_new_and_versioned_databases_upgrade(migration_engine):
    db.init_db()
    db.init_db()
    with migration_engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0012"
        assert "email_auth_codes" in inspect(connection).get_table_names()
        assert "user_avatars" in inspect(connection).get_table_names()
        assert "notification_email_outbox" in inspect(connection).get_table_names()
        assert "reserved_login_keys" in inspect(connection).get_table_names()


def test_username_and_outbox_migration_from_0011(migration_engine):
    """Upgrade from 0011 preserves historic users/projects/reads and reserves legacy non-@ emails."""
    migrate(migration_engine, "0011")

    with migration_engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO users (id, email, password_hash, is_admin, active, created_at) VALUES "
                "('u1', 'LegacyUser', 'hash', false, true, CURRENT_TIMESTAMP),"
                "('u2', 'with@example.com', 'hash', false, true, CURRENT_TIMESTAMP),"
                "('u3', 'a', 'hash', false, true, CURRENT_TIMESTAMP),"
                "('u4', 'Valid-Legacy_山景', 'hash', false, true, CURRENT_TIMESTAMP)"
            )
        )
        connection.execute(
            text(
                "INSERT INTO projects (id, owner_id, name, created_at) VALUES "
                "('p1', 'u1', 'historic project', CURRENT_TIMESTAMP)"
            )
        )
        connection.execute(
            text(
                "INSERT INTO notifications (id, user_id, kind, title, body, read_at, created_at) VALUES "
                "('n1', 'u1', 'announcement', 'title', 'body', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            )
        )

    migrate(migration_engine, "0012")

    with migration_engine.connect() as connection:
        columns = {column["name"] for column in inspect(connection).get_columns("users")}
        assert "username" in columns
        assert "username_key" in columns
        assert "email_verified_at" in columns
        assert "email_critical_announcements" in columns
        assert "email_job_results" in columns

        tables = set(inspect(connection).get_table_names())
        assert "user_avatars" in tables
        assert "notification_email_outbox" in tables
        assert "reserved_login_keys" in tables

        indexes = {index["name"] for index in inspect(connection).get_indexes("users")}
        assert "ix_users_username_key" in indexes
        outbox_indexes = {
            index["name"]: index["column_names"]
            for index in inspect(connection).get_indexes("notification_email_outbox")
        }
        assert outbox_indexes.get("ix_notification_email_outbox_state_next_attempt_at") == [
            "state",
            "next_attempt_at",
        ]

        reserved = set(connection.execute(text("SELECT key FROM reserved_login_keys")).scalars().all())
        assert "legacyuser" in reserved
        assert "valid-legacy_山景" in reserved
        assert "with@example.com" not in reserved
        assert "a" not in reserved

        assert connection.scalar(text("SELECT email FROM users WHERE id = 'u1'")) == "LegacyUser"
        assert connection.scalar(text("SELECT name FROM projects WHERE id = 'p1'")) == "historic project"
        assert connection.scalar(text("SELECT read_at IS NOT NULL FROM notifications WHERE id = 'n1'"))

    with migration_engine.begin() as connection:
        config = Config()
        config.set_main_option("script_location", "rescene_api:migrations")
        config.attributes["connection"] = connection
        command.downgrade(config, "0011")

    with migration_engine.connect() as connection:
        columns = {column["name"] for column in inspect(connection).get_columns("users")}
        assert "username" not in columns
        assert "username_key" not in columns
        assert "email_verified_at" not in columns
        assert "email_critical_announcements" not in columns
        assert "email_job_results" not in columns

        tables = set(inspect(connection).get_table_names())
        assert "user_avatars" not in tables
        assert "notification_email_outbox" not in tables
        assert "reserved_login_keys" not in tables

        assert connection.scalar(text("SELECT email FROM users WHERE id = 'u1'")) == "LegacyUser"
        assert connection.scalar(text("SELECT name FROM projects WHERE id = 'p1'")) == "historic project"
        assert connection.scalar(text("SELECT read_at IS NOT NULL FROM notifications WHERE id = 'n1'"))

    migrate(migration_engine, "0012")
    with migration_engine.connect() as connection:
        reserved = set(connection.execute(text("SELECT key FROM reserved_login_keys")).scalars().all())
        assert "legacyuser" in reserved
        assert "valid-legacy_山景" in reserved
