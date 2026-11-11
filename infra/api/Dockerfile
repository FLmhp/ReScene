FROM python:3.11-slim@sha256:65bd3d9f1d7fa268dd1909973ba7eb4bdf41f6dcf2cfbe76ba9528b170f3fd79
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY pyproject.toml README.md VERSION ./
COPY infra/api/constraints.txt ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/pip pip install -c constraints.txt '.[api]'
USER 65532:65532
EXPOSE 8000
CMD ["uvicorn", "rescene_api.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]
