# syntax=docker/dockerfile:1
FROM python:3.12-slim

# git: the integration is installed straight from the repo, not PyPI.
# ca-certificates: the harness talks to the model over HTTPS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# /data is the Render disk: the agent's workspace and its saved trajectories.
# Declared so the image still runs without one mounted.
RUN mkdir -p /data/ws /data/save
ENV AGENT_WORKSPACE=/data/ws \
    AGENT_SAVE_DIR=/data/save \
    PYTHONUNBUFFERED=1

# Render injects PORT (10000 by default) and routes the service's internal
# address to it. Bind that rather than a fixed port, or the internal hostname
# resolves to a port nothing is listening on.
ENV PORT=8027
EXPOSE 8027
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8027}"]
