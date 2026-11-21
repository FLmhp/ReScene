from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from rescene_api.main import app, db_session


def test_liveness_reports_the_process_without_touching_the_database():
    with TestClient(app) as client:
        response = client.get("/health/live")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_readiness_checks_the_database_connection():
    with TestClient(app) as client:
        response = client.get("/health/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ready"}


def test_readiness_fails_when_the_database_is_unreachable(tmp_path):
    unreachable = create_engine(f"sqlite:///{tmp_path / 'missing-directory' / 'rescene.db'}")

    def unavailable_database():
        with Session(unreachable) as session:
            yield session

    app.dependency_overrides[db_session] = unavailable_database
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            response = client.get("/health/ready")
    finally:
        app.dependency_overrides.pop(db_session, None)
        unreachable.dispose()
    assert response.status_code == 500
