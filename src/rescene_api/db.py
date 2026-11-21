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
            from rescene_api.migrations.legacy_0001 import metadata as legacy_metadata

            project_tables = set(Base.metadata.tables) | set(legacy_metadata.tables)
            context = MigrationContext.configure(
                connection,
                opts={
                    "compare_server_default": True,
                    "include_name": lambda name, type_, parent: type_ != "table" or name in project_tables,
                },
            )
            diffs = compare_metadata(context, legacy_metadata)
            inspector = inspect(connection)
            for name in sorted(tables & set(legacy_metadata.tables)):
                actual_pk = inspector.get_pk_constraint(name).get("constrained_columns") or []
                expected_pk = [column.name for column in legacy_metadata.tables[name].primary_key.columns]
                if actual_pk != expected_pk:
                    diffs.append(("primary_key", name, expected_pk, actual_pk))
                checks = inspector.get_check_constraints(name)
                if checks:
                    diffs.append(("unexpected_check_constraints", name, checks))
            if diffs:
                raise RuntimeError(f"Existing ReScene schema differs from revision 0001: {diffs}")
            command.stamp(migration, "0001")
        command.upgrade(migration, "head")
