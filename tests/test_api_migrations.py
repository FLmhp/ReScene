import os
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.pool import StaticPool

from rescene_api import db


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
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0009"
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
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0009"


def test_new_and_versioned_databases_upgrade(migration_engine):
    db.init_db()
    db.init_db()
    with migration_engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0009"
