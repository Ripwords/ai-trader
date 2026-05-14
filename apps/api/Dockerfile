FROM python:3.12-slim AS base
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv==0.4.20

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

# RSA key shared with OpenD's encrypted trade channel. Local-only image; key
# never leaves dev. The host OpenD must read the same file (-rsa_pri_key_path).
COPY secrets ./secrets
COPY app ./app

EXPOSE 8000
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
