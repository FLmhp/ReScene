from __future__ import annotations

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from sqlalchemy.pool import StaticPool

from rescene_api.config import settings


class Base(DeclarativeBase):
    pass


def _engine():
    url = settings().database_url
    options = {"pool_pre_ping": True}
    if url.startswith("sqlite"):
        options = {"connect_args": {"check_same_thread": False}}
        if ":memory:" in url:
            options["poolclass"] = StaticPool
    return create_engine(url, **options)


engine = _engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def init_db() -> None:
    """Apply migrations and adopt a verified legacy installation in place."""
    from rescene_api import models  # noqa: F401

    with engine.begin() as connection:
        if connection.dialect.name == "postgresql":
            connection.execute(text("SELECT pg_advisory_xact_lock(52492372)"))
        migration = Config()
        migration.set_main_option("script_location", "rescene_api:migrations")
        migration.attributes["connection"] = connection
        tables = set(inspect(connection).get_table_names())
        if "alembic_version" not in tables and tables.intersection(Base.metadata.tables):
            diffs = compare_metadata(MigrationContext.configure(connection), Base.metadata)
            if len(diffs) != 1 or diffs[0][0:3] != ("add_column", None, "users") or diffs[0][3].name != "token_version":
                raise RuntimeError("Existing ReScene schema differs from the migration baseline")
            command.stamp(migration, "0001")
        command.upgrade(migration, "head")
